// Minimal BPMN 2.0 reader.
//
// Everything here comes from the deployed XML rather than the REST API, because the
// things a developer actually needs while debugging a model — which variable a gateway
// condition reads, whether a service task is wired to an addon, whether a step is async —
// are not exposed as REST resources at all. Camunda will hand you the XML and nothing more.
//
// The tokenizer is hand-rolled but quote-aware, so attribute values containing '>' (legal
// in XML, and produced by some modellers) don't truncate a tag.

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeXml(s) {
  if (!s) return '';
  return String(s).replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos|nbsp);/g, (m, g) => {
    if (g[0] === '#') {
      const code = g[1] === 'x' || g[1] === 'X' ? parseInt(g.slice(2), 16) : parseInt(g.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[g] ?? m;
  });
}

// Parses into a tree of { name, local, attrs, children, text }.
export function parseXml(xml) {
  const root = { name: '#root', local: '#root', attrs: {}, children: [], text: '' };
  const stack = [root];
  let i = 0;
  const n = xml.length;

  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;

    if (lt > i) {
      const text = xml.slice(i, lt);
      // Element text carries the entity-escaped form of conditions such as
      // ${a &gt; 300}; decoding here is what makes them readable downstream.
      if (text.trim()) stack[stack.length - 1].text += decodeXml(text);
    }

    // Comments, CDATA, processing instructions, doctype.
    if (xml.startsWith('<!--', lt)) {
      i = xml.indexOf('-->', lt) + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt);
      stack[stack.length - 1].text += xml.slice(lt + 9, end);
      i = end + 3;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      i = xml.indexOf('>', lt) + 1;
      continue;
    }

    // Closing tag.
    if (xml[lt + 1] === '/') {
      const end = xml.indexOf('>', lt);
      if (stack.length > 1) stack.pop();
      i = end + 1;
      continue;
    }

    // Opening tag: walk to the matching '>' while respecting quoted attribute values.
    let j = lt + 1;
    let quote = null;
    while (j < n) {
      const c = xml[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
      j++;
    }
    const rawTag = xml.slice(lt + 1, j);
    const selfClosing = rawTag.endsWith('/');
    const body = selfClosing ? rawTag.slice(0, -1) : rawTag;

    const nameMatch = body.match(/^([^\s/>]+)/);
    const name = nameMatch ? nameMatch[1] : '';
    const attrs = {};
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
    let am;
    while ((am = attrRe.exec(body)) !== null) {
      attrs[am[1]] = decodeXml(am[3] !== undefined ? am[3] : am[4]);
    }

    const node = { name, local: name.includes(':') ? name.split(':')[1] : name, attrs, children: [], text: '' };
    stack[stack.length - 1].children.push(node);
    if (!selfClosing) stack.push(node);
    i = j + 1;
  }
  return root;
}

export function findAll(node, localName, out = []) {
  for (const c of node.children) {
    if (c.local === localName) out.push(c);
    findAll(c, localName, out);
  }
  return out;
}

const FLOW_NODE_TYPES = new Set([
  'startEvent', 'endEvent', 'userTask', 'serviceTask', 'scriptTask', 'sendTask', 'receiveTask',
  'manualTask', 'businessRuleTask', 'task', 'callActivity', 'subProcess', 'transaction',
  'exclusiveGateway', 'parallelGateway', 'inclusiveGateway', 'eventBasedGateway', 'complexGateway',
  'intermediateCatchEvent', 'intermediateThrowEvent', 'boundaryEvent',
]);

// Pulls the AlurKerja integration call out of a listener expression. These are always
// shaped as integrationContext.getInstance(..).addonName("x").addonAction("y").config("n")...
function parseAddonCall(expression) {
  if (!expression || !expression.includes('addonName')) return null;
  const pick = (fn) => {
    const m = expression.match(new RegExp(`${fn}\\(\\s*["']([^"']*)["']`));
    return m ? m[1] : null;
  };
  const payload = pick('payload');
  let decodedPayload = null;
  if (payload) {
    try {
      decodedPayload = Buffer.from(payload, 'base64').toString('utf8');
    } catch {
      decodedPayload = null;
    }
  }
  return {
    addon: pick('addonName'),
    action: pick('addonAction'),
    config: pick('config'),
    saveResult: pick('saveResult'),
    payload: decodedPayload,
  };
}

function readListeners(node) {
  const out = [];
  for (const kind of ['executionListener', 'taskListener']) {
    for (const l of findAll(node, kind)) {
      // expression and delegateExpression are not interchangeable: the first is
      // evaluated against process variables, the second must resolve to a registered
      // bean. Keeping them apart stops a bean name being reported as a missing variable.
      const expression = l.attrs.expression || '';
      const delegateExpression = l.attrs.delegateExpression || '';
      out.push({
        kind,
        event: l.attrs.event || null,
        expression,
        delegateExpression,
        class: l.attrs.class || null,
        addon: parseAddonCall(expression || delegateExpression),
      });
    }
  }
  return out;
}

// AlurKerja stores its form definition as a JSON blob in an alurkerja:form attribute.
// Camunda's own camunda:formData is also read, since plain Camunda models use that.
function readFormFields(node) {
  const fields = [];

  const raw = node.attrs['alurkerja:form'];
  if (raw) {
    try {
      const walk = (nodes) => {
        for (const f of nodes || []) {
          if (f.name) {
            const label = typeof f.label === 'object' && f.label ? f.label.id || f.label.en : f.label;
            fields.push({
              name: f.name,
              type: f.form_field_type || f.ui_type || '',
              label: label || '',
              required: Boolean(f.constraints?.required),
              disabled: Boolean(f.disabled),
              source: 'alurkerja',
            });
          }
          walk(f.children);
        }
      };
      walk(JSON.parse(raw));
    } catch {
      /* malformed form JSON is reported by lint, not thrown here */
    }
  }

  for (const fd of findAll(node, 'formField')) {
    fields.push({
      name: fd.attrs.id,
      type: fd.attrs.type || '',
      label: fd.attrs.label || '',
      required: false,
      disabled: false,
      source: 'camunda',
    });
  }
  return fields;
}

function readTimer(node) {
  for (const kind of ['timeCycle', 'timeDuration', 'timeDate']) {
    const [t] = findAll(node, kind);
    if (t) return { kind, value: (t.text || '').trim() };
  }
  return null;
}

function eventDetail(node) {
  const defs = node.children.filter((c) => c.local.endsWith('EventDefinition'));
  if (defs.length === 0) return null;
  const d = defs[0];
  const type = d.local.replace('EventDefinition', '');
  const detail = { type };
  if (type === 'timer') detail.timer = readTimer(d);
  if (type === 'message') detail.ref = d.attrs.messageRef || null;
  if (type === 'signal') detail.ref = d.attrs.signalRef || null;
  if (type === 'error') detail.ref = d.attrs.errorRef || null;
  if (type === 'conditional') {
    const [c] = findAll(d, 'condition');
    detail.condition = c ? (c.text || '').trim() : null;
  }
  return detail;
}

// Builds a flat, tool-friendly model of one process definition.
export function readProcess(xml) {
  const root = parseXml(xml);
  const processes = findAll(root, 'process');
  if (processes.length === 0) throw new Error('No <process> element found in this XML.');

  // A collaboration can hold several processes; the executable one is what runs.
  const proc = processes.find((p) => p.attrs.isExecutable === 'true') || processes[0];

  const nodes = [];
  const collect = (parent, scope) => {
    for (const c of parent.children) {
      if (FLOW_NODE_TYPES.has(c.local)) {
        const isSubProcess = c.local === 'subProcess' || c.local === 'transaction';
        const [mi] = findAll(c, 'multiInstanceLoopCharacteristics');
        nodes.push({
          id: c.attrs.id,
          name: c.attrs.name || '',
          type: c.local,
          scope,
          async:
            c.attrs['camunda:asyncBefore'] === 'true'
              ? 'before'
              : c.attrs['camunda:asyncAfter'] === 'true'
                ? 'after'
                : null,
          assignee: c.attrs['camunda:assignee'] || null,
          candidateGroups: c.attrs['camunda:candidateGroups'] || null,
          expression: c.attrs['camunda:expression'] || null,
          delegateExpression: c.attrs['camunda:delegateExpression'] || null,
          class: c.attrs['camunda:class'] || null,
          topic: c.attrs['camunda:topic'] || null,
          calledElement: c.attrs.calledElement || null,
          defaultFlow: c.attrs.default || null,
          multiInstance: mi ? (mi.attrs.isSequential === 'true' ? 'sequential' : 'parallel') : null,
          attachedTo: c.attrs.attachedToRef || null,
          event: eventDetail(c),
          listeners: readListeners(c),
          formFields: readFormFields(c),
          raw: c,
        });
        if (isSubProcess) collect(c, c.attrs.id);
      } else if (c.local === 'laneSet' || c.local === 'subProcess') {
        collect(c, scope);
      }
    }
  };
  collect(proc, null);

  const flows = findAll(proc, 'sequenceFlow').map((f) => {
    const [cond] = findAll(f, 'conditionExpression');
    return {
      id: f.attrs.id,
      name: f.attrs.name || '',
      source: f.attrs.sourceRef,
      target: f.attrs.targetRef,
      condition: cond ? (cond.text || '').trim() : null,
    };
  });

  const lanes = findAll(proc, 'lane').map((l) => ({
    id: l.attrs.id,
    name: l.attrs.name || '',
    nodeRefs: findAll(l, 'flowNodeRef').map((r) => (r.text || '').trim()),
  }));

  return {
    id: proc.attrs.id,
    name: proc.attrs.name || '',
    executable: proc.attrs.isExecutable === 'true',
    versionTag: proc.attrs['camunda:versionTag'] || null,
    historyTTL: proc.attrs['camunda:historyTimeToLive'] || null,
    nodes,
    flows,
    lanes,
    processListeners: readListeners(proc).filter((l) => !nodes.some((nd) => findAll(nd.raw, l.kind).length)),
  };
}

// Every ${...} expression in the model, with where it came from. This is what makes it
// possible to tell which variables a process reads before it is ever run.
export function collectExpressions(model) {
  const out = [];
  for (const f of model.flows) {
    if (f.condition) out.push({ where: `flow ${f.id}${f.name ? ` (${f.name})` : ''}`, expression: f.condition, kind: 'condition' });
  }
  for (const n of model.nodes) {
    if (n.assignee) out.push({ where: `${n.id} assignee`, expression: n.assignee, kind: 'assignee' });
    if (n.candidateGroups) out.push({ where: `${n.id} candidateGroups`, expression: n.candidateGroups, kind: 'assignee' });
    if (n.expression) out.push({ where: `${n.id} expression`, expression: n.expression, kind: 'implementation' });
    if (n.event?.condition) out.push({ where: `${n.id} condition event`, expression: n.event.condition, kind: 'condition' });
    for (const l of n.listeners) {
      if (l.expression) out.push({ where: `${n.id} ${l.kind}[${l.event}]`, expression: l.expression, kind: 'listener' });
    }
  }
  return out;
}

// Identifiers read directly (${foo}) versus defensively (${execution.getVariable('foo')}).
// The distinction matters: the first throws when unset, the second yields null.
const SAFE_ACCESS = /execution\.getVariable\(\s*['"]([^'"]+)['"]\s*\)/g;
const RESERVED = new Set([
  'execution', 'task', 'authenticatedUserId', 'true', 'false', 'null', 'empty', 'now',
  'currentUser', 'currentUserGroups', 'dateTime', 'alurkerjaParams', 'integrationContext',
  'and', 'or', 'not', 'div', 'mod', 'instanceof', 'eq', 'ne', 'lt', 'gt', 'le', 'ge',
]);

export function readVariables(expression) {
  const direct = new Set();
  const safe = new Set();
  const text = String(expression || '');

  // Plenty of these attributes hold plain literals rather than expressions; an assignee
  // of "me@example.com" is not three variables called me, example and com.
  if (!text.includes('${') && !text.includes('#{')) return { direct: [], safe: [] };

  let m;
  const safeRe = new RegExp(SAFE_ACCESS);
  while ((m = safeRe.exec(text)) !== null) safe.add(m[1]);

  // Strip the safe accessors and string literals, then take what is left that looks
  // like a bare identifier not followed by '(' (which would make it a function call).
  const stripped = text.replace(SAFE_ACCESS, ' ').replace(/'[^']*'|"[^"]*"/g, ' ');
  const idRe = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b(\s*\()?/g;
  while ((m = idRe.exec(stripped)) !== null) {
    const [, id, isCall] = m;
    if (isCall || RESERVED.has(id)) continue;
    // Property access (a.b) reads `a`, not `b`.
    const before = stripped[m.index - 1];
    if (before === '.') continue;
    // A method call somewhere down the chain means this is a bean, not a variable:
    // ${myBean.doThing()} resolves through the bean resolver, ${order.total} does not.
    const after = stripped.slice(m.index + id.length);
    if (/^\s*\.[A-Za-z_$][\w$]*\s*\(/.test(after)) continue;
    direct.add(id);
  }
  return { direct: [...direct], safe: [...safe] };
}

// Variables the process itself writes: form fields submitted by users, and addon
// results saved back onto the instance.
export function collectWrittenVariables(model) {
  const written = new Map();
  const add = (name, source) => {
    if (!name) return;
    if (!written.has(name)) written.set(name, []);
    written.get(name).push(source);
  };
  for (const n of model.nodes) {
    for (const f of n.formFields) add(f.name, `${n.id} form`);
    for (const l of n.listeners) {
      if (l.addon?.saveResult === 'true') add(`${l.addon.action} result`, `${n.id} addon`);
    }
  }
  return written;
}
