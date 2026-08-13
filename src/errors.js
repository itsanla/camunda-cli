// Camunda surfaces failures as one long string with the real cause buried several
// layers deep. Observed against a live AlurKerja deployment, an addon script failure
// arrives as: a REST message, containing a Java exception, containing `body: {json}`,
// whose `output` field is itself a JSON *string* holding the message that actually
// tells you what went wrong. This module peels that apart and, where the error is a
// well-known Camunda one, says what usually causes it.

const NESTED_BODY = /body:\s*(\{[\s\S]*)$/;

// Pulls out every layer we can parse. Returns { raw, layers[], message } where
// `message` is the deepest human-readable sentence found.
export function unwrapError(raw) {
  const text = typeof raw === 'string' ? raw : raw?.message || String(raw);
  const layers = [];
  let deepest = text;

  const bodyMatch = text.match(NESTED_BODY);
  if (bodyMatch) {
    const parsed = tryParse(bodyMatch[1]);
    if (parsed) {
      layers.push({ label: 'integration response', value: parsed });
      if (typeof parsed.output === 'string') {
        const inner = tryParse(parsed.output);
        if (inner) {
          layers.push({ label: 'script output', value: inner });
          if (inner.message) deepest = inner.message;
        } else if (parsed.output.trim()) {
          layers.push({ label: 'script output', value: parsed.output.trim() });
          deepest = parsed.output.trim();
        }
      } else if (parsed.message) {
        deepest = parsed.message;
      } else if (parsed.error) {
        deepest = parsed.error;
      }
    }
  }

  return { raw: text, layers, message: deepest };
}

function tryParse(s) {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : null;
  } catch {
    return null;
  }
}

// Known Camunda failure signatures, each with the cause we actually observed in
// practice rather than a restatement of the message.
const HINTS = [
  {
    match: /Cannot resolve identifier 'initiator'/,
    hint: () =>
      `The variable "initiator" is injected by AlurKerja when a process is started through its own API. ` +
      `Starting the same process straight through the Camunda REST API skips that, so any element using ` +
      `\${initiator} (usually a task assignee) fails as soon as it is reached. Start it with ` +
      `--var initiator=<userId> to stand in for the real caller.`,
  },
  {
    match: /Unknown property used in expression: \$\{([^}]*)\}.*Cannot resolve identifier '([^']+)'/,
    hint: (m) =>
      `Nothing has ever set the variable "${m[2]}" on this instance, and the expression reads it directly, ` +
      `so the engine throws instead of treating it as null. Either set it before this point, or rewrite the ` +
      `expression as \${execution.getVariable('${m[2]}')} which yields null instead of throwing. ` +
      `Check for a name mismatch first: a form field named slightly differently is the usual cause.`,
  },
  {
    match: /ENGINE-02004 No outgoing sequence flow for the element with id '([^']+)'/,
    hint: (m) =>
      `Gateway "${m[1]}" evaluated every outgoing flow condition to false and has no default flow, ` +
      `so the token has nowhere to go. Either make the conditions exhaustive (a > and a < leave the ` +
      `equal case uncovered) or mark one flow as the gateway's default.`,
  },
  {
    match: /ENGINE-02001 .*more than one outgoing sequence flow/,
    hint: () =>
      `Several conditions on an exclusive gateway were true at once. Exclusive gateways take exactly one ` +
      `path, so tighten the conditions until they are mutually exclusive.`,
  },
  {
    match: /Alurkerja Integration failed/,
    hint: () =>
      `The addon behind this service task returned an error. The script's own message is shown above under ` +
      `"script output"; the service task itself is fine, the failure is inside the addon action.`,
  },
  {
    match: /ENGINE-13030|correlat\w+ .*ambiguous|more than one .*subscription/i,
    hint: () =>
      `A message matched more than one waiting subscription. This is usually several versions of the ` +
      `receiving process still deployed and active at once, not a modelling mistake in the sender.`,
  },
  {
    match: /OptimisticLockingException/,
    hint: () =>
      `Two transactions touched the same row at once. Camunda normally retries this by itself; if it keeps ` +
      `surfacing, something outside the engine is writing to the same instance concurrently.`,
  },
  {
    match: /no processes deployed with key '([^']+)'|No matching process definition with key: ([^\s]+) and no tenant-id/,
    hint: (m) =>
      `The key exists under a tenant, not at the root. Pass --tenant <tenantId>; "camunda definitions -k ${m[1] || m[2]}" ` +
      `lists which tenant holds it.`,
  },
];

export function explain(message) {
  for (const { match, hint } of HINTS) {
    const m = String(message || '').match(match);
    if (m) return hint(m);
  }
  return null;
}

// Camunda stacktraces are ~90 lines of engine internals. The frames worth reading are
// the exception header and anything that is not org.camunda.bpm.engine.impl.*.
export function condenseStacktrace(trace, { keep = 12 } = {}) {
  const lines = String(trace || '').split('\n');
  const header = [];
  const interesting = [];
  for (const l of lines) {
    const t = l.trim();
    if (!t) continue;
    if (!t.startsWith('at ')) {
      header.push(t);
      continue;
    }
    if (/^at (org\.camunda\.bpm\.engine\.impl|java\.|jakarta\.|javax\.|sun\.|jdk\.)/.test(t)) continue;
    interesting.push(t);
  }
  return {
    header,
    frames: interesting.slice(0, keep),
    omitted: lines.filter((l) => l.trim().startsWith('at ')).length - Math.min(interesting.length, keep),
  };
}
