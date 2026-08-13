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

function similarNames(target, candidates) {
  const prefix = target.includes('_') ? target.slice(0, target.indexOf('_') + 1) : null;
  return candidates.filter((c) => {
    if (c === target) return false;
    if (prefix && c.startsWith(prefix)) return true;
    return levenshtein(c.toLowerCase(), target.toLowerCase()) <= 3;
  });
}

// Reads `${x > 300}` style comparisons so a gateway's branches can be checked for gaps.
function parseComparison(expression) {
  const m = String(expression || '').match(
    /\$\{\s*([A-Za-z_$][\w$]*)\s*(==|!=|>=|<=|>|<)\s*(-?\d+(?:\.\d+)?)\s*\}/
  );
  if (!m) return null;
  return { variable: m[1], op: m[2], value: Number(m[3]) };
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

  const reachable = new Set();
  const queue = starts.map((s) => s.id);
  while (queue.length) {
    const id = queue.shift();
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const f of outgoing.get(id) || []) queue.push(f.target);
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
      add(
        'error',
        'no-default-flow',
        n.id,
        `Every outgoing flow of "${n.name || n.id}" has a condition and there is no default flow. ` +
          `If they all evaluate false at runtime the engine raises ENGINE-02004 and the instance stops. ` +
          `Mark one flow as the default.`
      );

      // Numeric gap: a > N and a < N leave a == N with nowhere to go.
      const comparisons = conditional.map((f) => ({ flow: f, cmp: parseComparison(f.condition) })).filter((c) => c.cmp);
      const byVar = new Map();
      for (const c of comparisons) {
        if (!byVar.has(c.cmp.variable)) byVar.set(c.cmp.variable, []);
        byVar.get(c.cmp.variable).push(c.cmp);
      }
      for (const [variable, cmps] of byVar) {
        if (cmps.length !== conditional.length) continue;
        const gt = cmps.find((c) => c.op === '>');
        const lt = cmps.find((c) => c.op === '<');
        if (gt && lt && gt.value === lt.value && !cmps.some((c) => ['==', '>=', '<='].includes(c.op))) {
          add(
            'error',
            'uncovered-value',
            n.id,
            `"${n.name || n.id}" branches on ${variable} > ${gt.value} and ${variable} < ${lt.value}, ` +
              `so ${variable} == ${gt.value} matches neither branch and the instance will fail there.`
          );
        }
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

  for (const { where, expression, kind } of collectExpressions(model)) {
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
      if (near.length > 0) {
        add(
          'error',
          'variable-name-mismatch',
          where,
          `Reads "${v}", which nothing in this process writes, while a form here writes ${near.map((s) => `"${s}"`).join(', ')}. ` +
            `These names look related, so this is most likely a typo: the expression throws ` +
            `"Cannot resolve identifier '${v}'" the moment it is evaluated.`
        );
      } else {
        add(
          'warning',
          'unwritten-variable',
          where,
          `Reads "${v}" directly and nothing in this process writes it. If it is not supplied at start time the ` +
            `expression throws rather than treating it as null. Use \${execution.getVariable('${v}')} if absent is a valid state.`
        );
      }
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
