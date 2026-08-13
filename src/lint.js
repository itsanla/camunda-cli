// Static checks over a deployed BPMN model.
//
// Every rule here exists because the failure it describes was reproduced against a real
// engine first, not because it seemed plausible. The messages name the specific element
// and say what to change, since the output is mostly read by tooling that will act on it.

import { collectExpressions, readVariables, collectWrittenVariables } from './bpmn.js';

const GATEWAYS = new Set(['exclusiveGateway', 'inclusiveGateway', 'complexGateway']);
const START_TYPES = new Set(['startEvent']);
const END_TYPES = new Set(['endEvent']);

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 4) return 99;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return d[m][n];
}

// Deliberately narrow. An earlier version also treated a shared prefix as evidence, which
// made every model using a naming convention look broken: in a process where a form writes
// gr_number, gr_date and gr_amount, reading an unrelated gr_recorded was reported as a typo
// of gr_number. A near-identical spelling is the only similarity worth mentioning, and even
// that is offered as a candidate rather than a conclusion.
function similarNames(target, candidates) {
  return candidates.filter((c) => {
    if (c === target) return false;
    const a = c.toLowerCase().replace(/[_-]/g, '');
    const b = target.toLowerCase().replace(/[_-]/g, '');
    if (a === b) return true;
    if (Math.min(a.length, b.length) < 4) return false;
    return levenshtein(a, b) <= 2;
  });
}

// Evidence that a form and the expression reading it were never lined up, independent of
// how the two names are spelled: an element whose form writes exactly one variable that
// nothing anywhere reads, immediately followed by a flow reading a variable nothing writes.
// Both halves are dead on their own, and they sit either side of the same element.
// Field types whose name is a mount point rather than a variable. An embedded micro
// frontend writes whatever it likes and the model has no way to declare that, so a form
// containing one tells you nothing about which variables the element sets. Reasoning about
// unwritten variables around these produced a confident, wrong error on a process that had
// been running correctly for months.
const OPAQUE_FIELD_TYPES = new Set([
  'EXTERNAL_MICRO_FRONTEND_FORM',
  'HTML_CUSTOM_FORM',
  'VARIABLE_RENDERER',
  'EXPRESSION_INPUT',
]);

function findStrandedFormField(model, node, byId, outgoing, readEverywhere, written) {
  if (node.formFields.some((f) => OPAQUE_FIELD_TYPES.has(f.type))) return null;
  const writable = node.formFields.filter((f) => !f.disabled && f.name);
  if (writable.length !== 1) return null;
  const field = writable[0].name;
  if (readEverywhere.has(field)) return null;

  // The conditions that act on a user task's input usually sit on the flows out of the
  // gateway after it rather than on the task's own flow, so pass through gateways. Nothing
  // else is followed: once a real activity intervenes, the value could have come from there.
  const seen = new Set([node.id]);
  const frontier = [node.id];
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const next = [];
    for (const id of frontier) {
      for (const flow of outgoing.get(id) ?? []) {
        if (flow.condition) {
          const { direct } = readVariables(flow.condition);
          const orphan = direct.find((v) => !written.has(v) && v !== 'initiator');
          if (orphan) return { field, orphan, flow };
        }
        const target = byId.get(flow.target);
        if (target && GATEWAYS.has(target.type) && !seen.has(target.id)) {
          seen.add(target.id);
          next.push(target.id);
        }
      }
    }
    frontier.length = 0;
    frontier.push(...next);
  }
  return null;
}

// Reads `${x > 300}` and `${x == 'draft'}` style comparisons so a gateway's branches can be
// checked for gaps. Values stay as written: a numeric gap is only meaningful between numbers.
function parseComparison(expression) {
  const m = String(expression || '').match(
    /^\s*\$\{\s*([A-Za-z_$][\w$]*)\s*(==|!=|>=|<=|>|<)\s*('[^']*'|"[^"]*"|-?\d+(?:\.\d+)?|true|false)\s*\}\s*$/
  );
  if (!m) return null;
  const raw = m[3];
  const numeric = /^-?\d/.test(raw);
  return {
    variable: m[1],
    op: m[2],
    value: numeric ? Number(raw) : raw.replace(/^['"]|['"]$/g, ''),
    numeric,
  };
}

// Two branches that between them cover every value need no default flow. Recognising the
// common complementary pairs keeps the check off models that are already exhaustive, which
// would otherwise be a third of them.
const COMPLEMENTARY = [
  ['==', '!='],
  ['>', '<='],
  ['<', '>='],
];

function coversEverything(comparisons) {
  if (comparisons.length !== 2) return false;
  const [a, b] = comparisons;
  if (a.variable !== b.variable) return false;
  if (a.numeric !== b.numeric || String(a.value) !== String(b.value)) return false;
  return COMPLEMENTARY.some(([x, y]) => (a.op === x && b.op === y) || (a.op === y && b.op === x));
}

export function lintProcess(model, { engineVariables = [] } = {}) {
  const findings = [];
  const add = (severity, rule, element, message) => findings.push({ severity, rule, element, message });

  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const outgoing = new Map();
  const incoming = new Map();
  for (const f of model.flows) {
    if (!outgoing.has(f.source)) outgoing.set(f.source, []);
    if (!incoming.has(f.target)) incoming.set(f.target, []);
    outgoing.get(f.source).push(f);
    incoming.get(f.target).push(f);
  }

  // --- dangling references -------------------------------------------------
  for (const f of model.flows) {
    if (!byId.has(f.source)) add('error', 'dangling-flow', f.id, `Sequence flow starts at "${f.source}", which is not an element in this process.`);
    if (!byId.has(f.target)) add('error', 'dangling-flow', f.id, `Sequence flow ends at "${f.target}", which is not an element in this process.`);
  }
  for (const n of model.nodes) {
    if (n.attachedTo && !byId.has(n.attachedTo)) {
      add('error', 'dangling-boundary', n.id, `Boundary event is attached to "${n.attachedTo}", which does not exist.`);
    }
  }

  // --- reachability --------------------------------------------------------
  const starts = model.nodes.filter((n) => START_TYPES.has(n.type) && !n.scope);
  if (starts.length === 0) add('error', 'no-start-event', model.id, 'The process has no start event, so nothing can ever begin it.');

  // A boundary event has no incoming sequence flow: it fires because the activity it is
  // attached to is running. So whatever hangs off a boundary event is reachable exactly
  // when its host activity is, and walking sequence flows alone would report every error
  // and timeout handler in the model as unreachable.
  const boundaryByHost = new Map();
  for (const n of model.nodes) {
    if (!n.attachedTo) continue;
    if (!boundaryByHost.has(n.attachedTo)) boundaryByHost.set(n.attachedTo, []);
    boundaryByHost.get(n.attachedTo).push(n.id);
  }

  const reachable = new Set();
  const queue = starts.map((s) => s.id);
  while (queue.length) {
    const id = queue.shift();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const f of outgoing.get(id) || []) queue.push(f.target);
    for (const b of boundaryByHost.get(id) || []) queue.push(b);
  }
  for (const n of model.nodes) {
    if (n.scope || n.attachedTo || START_TYPES.has(n.type)) continue;
    if (!reachable.has(n.id)) {
      add('warning', 'unreachable', n.id, `"${n.name || n.id}" cannot be reached from any start event.`);
    }
  }
  for (const n of model.nodes) {
    if (n.scope || n.attachedTo) continue;
    if (!END_TYPES.has(n.type) && (outgoing.get(n.id) || []).length === 0) {
      add('warning', 'dead-end', n.id, `"${n.name || n.id}" has no outgoing sequence flow, so the token stops there without reaching an end event.`);
    }
  }

  // --- gateway branching ---------------------------------------------------
  for (const n of model.nodes) {
    if (!GATEWAYS.has(n.type)) continue;
    const outs = outgoing.get(n.id) || [];
    if (outs.length < 2) continue;

    const conditional = outs.filter((f) => f.condition);
    const unconditional = outs.filter((f) => !f.condition && f.id !== n.defaultFlow);

    if (conditional.length === outs.length && !n.defaultFlow) {
      const comparisons = conditional.map((f) => parseComparison(f.condition)).filter(Boolean);
      const exhaustive = comparisons.length === conditional.length && coversEverything(comparisons);

      // A provable gap: `> N` and `< N` between them never match `== N`. This one is
      // certain, so it is an error even though the general case below is not.
      const gt = comparisons.find((c) => c.op === '>' && c.numeric);
      const lt = comparisons.find((c) => c.op === '<' && c.numeric);
      const sameVar = gt && lt && gt.variable === lt.variable && gt.value === lt.value;

      if (sameVar && comparisons.length === conditional.length) {
        add(
          'error',
          'uncovered-value',
          n.id,
          `"${n.name || n.id}" branches on ${gt.variable} > ${gt.value} and ${lt.variable} < ${lt.value}, ` +
            `so ${gt.variable} == ${gt.value} matches neither branch. The engine raises ENGINE-02004 and the ` +
            `instance stops there.`
        );
      } else if (!exhaustive) {
        // Not provably broken: the conditions may well cover every case in a way that
        // cannot be read off the expressions. Worth flagging, not worth blocking a deploy.
        add(
          'warning',
          'no-default-flow',
          n.id,
          `Every outgoing flow of "${n.name || n.id}" has a condition and there is no default flow. If a case ever ` +
            `arises where they all evaluate false, the engine raises ENGINE-02004 and the instance stops. Marking ` +
            `one flow as the default removes that risk; a default flow must not carry a condition itself, or the ` +
            `model is rejected at deploy time with ENGINE-09005.`
        );
      }
    }

    // The engine refuses to parse this rather than failing at runtime, so a model that is
    // otherwise fine is rejected outright at deploy time.
    if (n.defaultFlow) {
      const target = outs.find((f) => f.id === n.defaultFlow);
      if (!target) {
        add(
          'error',
          'default-flow-missing',
          n.id,
          `"${n.name || n.id}" names "${n.defaultFlow}" as its default flow, but that is not one of its outgoing flows.`
        );
      } else if (target.condition) {
        add(
          'error',
          'default-flow-with-condition',
          n.id,
          `The default flow of "${n.name || n.id}" ("${target.name || target.id}") also carries the condition ` +
            `${target.condition}. A default flow is the branch taken when nothing else matches, so it cannot have ` +
            `one: the engine rejects this at deploy time with ENGINE-09005. Remove the condition from that flow.`
        );
      }
    }

    if (n.type === 'exclusiveGateway' && unconditional.length > 1) {
      add(
        'warning',
        'ambiguous-branch',
        n.id,
        `"${n.name || n.id}" has ${unconditional.length} outgoing flows with no condition. An exclusive gateway ` +
          `takes the first one it finds, which makes the path taken depend on document order rather than intent.`
      );
    }
  }

  // --- variables read but never written ------------------------------------
  const written = collectWrittenVariables(model);
  const knownNames = new Set([...written.keys(), ...engineVariables]);
  const formFieldNames = [...written.keys()];

  const hasOpaqueForms = model.nodes.some((n) => n.formFields.some((f) => OPAQUE_FIELD_TYPES.has(f.type)));
  const expressions = collectExpressions(model);
  const readEverywhere = new Set();
  for (const e of expressions) {
    const { direct, safe } = readVariables(e.expression);
    for (const v of [...direct, ...safe]) readEverywhere.add(v);
  }

  // Structural mismatch first: a form field nothing reads sitting directly upstream of a
  // condition reading something nothing writes. This holds whatever the two are called,
  // so it is the only case reported as an error.
  for (const n of model.nodes) {
    if (n.formFields.length === 0) continue;
    const stranded = findStrandedFormField(model, n, byId, outgoing, readEverywhere, written);
    if (!stranded) continue;
    add(
      'error',
      'variable-name-mismatch',
      n.id,
      `The form on "${n.name || n.id}" writes only "${stranded.field}", which nothing in this process reads, ` +
        `while the flow leaving it ("${stranded.flow.name || stranded.flow.id}") reads "${stranded.orphan}", which ` +
        `nothing writes. Completing this element therefore cannot satisfy the condition, and evaluating it throws ` +
        `"Cannot resolve identifier '${stranded.orphan}'". One of the two names needs to change.`
    );
  }

  for (const { where, expression, kind } of expressions) {
    const { direct } = readVariables(expression);
    for (const v of direct) {
      if (knownNames.has(v)) continue;

      if (v === 'initiator') {
        add(
          'warning',
          'initiator-expression',
          where,
          `Reads \${initiator}. AlurKerja sets that variable when a process is started through its own API, ` +
            `but starting the same process straight through the Camunda REST API does not, and the step fails ` +
            `asynchronously with "Cannot resolve identifier 'initiator'". Pass --var initiator=<user> when starting from the CLI.`
        );
        continue;
      }

      const near = similarNames(v, formFieldNames);
      add(
        'warning',
        'unwritten-variable',
        where,
        `Reads "${v}" directly and nothing in this process writes it. That is fine if it always arrives with the ` +
          `start payload; otherwise the expression throws "Cannot resolve identifier '${v}'" rather than treating ` +
          `it as null, and \${execution.getVariable('${v}')} would yield null instead.` +
          (near.length > 0 ? ` A form here writes ${near.map((s) => `"${s}"`).join(', ')}, which is spelled almost the same.` : '') +
          (hasOpaqueForms ? ` This process embeds an external form, which can set variables the model does not declare, so "${v}" may well be one of those.` : '')
      );
    }
  }

  // --- integration wiring --------------------------------------------------
  for (const n of model.nodes) {
    const addonListeners = n.listeners.filter((l) => l.addon);
    for (const l of addonListeners) {
      if (!l.addon.config) {
        add(
          'warning',
          'addon-without-config',
          n.id,
          `Calls addon "${l.addon.addon}" action "${l.addon.action}" without a config id, so the addon runs with no ` +
            `Integration Config bound. That is only correct if the addon holds its settings internally.`
        );
      }
    }
    if (n.type === 'serviceTask' && addonListeners.length > 0 && !n.async) {
      add(
        'info',
        'sync-integration',
        n.id,
        `Calls addon "${addonListeners[0].addon.addon}" with no async marker, so the call runs inside the caller's ` +
          `transaction. A failure here rolls back and surfaces in the HTTP response only: no incident and no job ` +
          `record is left behind, so "camunda incidents" will show nothing afterwards.`
      );
    }
    if (n.type === 'serviceTask' && addonListeners.length === 0 && !n.class && !n.topic) {
      const expr = (n.expression || '').trim();
      if (!expr || expr === '${true}' || expr === 'true') {
        add(
          'warning',
          'no-op-service-task',
          n.id,
          `"${n.name || n.id}" is a service task with no implementation behind it (expression ${expr || 'empty'} and no ` +
            `listener), so it does nothing at runtime beyond passing the token along.`
        );
      }
    }
  }

  // --- user tasks ----------------------------------------------------------
  for (const n of model.nodes) {
    if (n.type !== 'userTask') continue;
    if (!n.assignee && !n.candidateGroups) {
      add('info', 'unassigned-user-task', n.id, `"${n.name || n.id}" has neither an assignee nor candidate groups, so it lands in nobody's list until it is claimed.`);
    }
    if (n.formFields.length === 0) {
      add('info', 'no-form', n.id, `"${n.name || n.id}" has no form fields, so completing it submits nothing.`);
    }
  }

  const order = { error: 0, warning: 1, info: 2 };
  findings.sort((a, b) => order[a.severity] - order[b.severity]);
  return findings;
}
