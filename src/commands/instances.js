import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { Client, parseVariableFlags, resolveDefinition } from '../client.js';
import { requireConfig } from '../config.js';
import { readProcess } from '../bpmn.js';
import { reportNextState, suggestCompletion } from '../followup.js';
import * as out from '../output.js';

export async function instancesCommand(options) {
  const client = new Client(requireConfig());

  if (options.history) {
    const query = { maxResults: options.limit ?? 30, sortBy: 'startTime', sortOrder: 'desc' };
    if (options.key) query.processDefinitionKey = options.key;
    if (options.tenant) query.tenantIdIn = options.tenant;
    if (options.businessKey) query.processInstanceBusinessKey = options.businessKey;
    if (options.state) query[options.state] = true;

    const rows = await client.historyProcessInstances(query);
    if (out.isJsonMode()) return out.json(rows);
    if (rows.length === 0) return out.note('No instances match.');
    out.table(
      ['ID', 'DEFINITION', 'STARTED', 'DURATION', 'STATE'],
      rows.map((i) => [
        i.id,
        out.truncate(i.processDefinitionKey, 34),
        out.formatDateTime(i.startTime),
        out.formatDuration(i.durationInMillis),
        out.stateLabel(i.state),
      ])
    );
    return out.note(`\n${rows.length} instance(s), history`);
  }

  const query = { maxResults: options.limit ?? 50 };
  if (options.key) query.processDefinitionKey = options.key;
  if (options.businessKey) query.businessKey = options.businessKey;
  if (options.tenant) query.tenantIdIn = options.tenant;
  if (options.withIncident) query.withIncident = true;

  const instances = await client.processInstances(query);
  if (out.isJsonMode()) return out.json(instances);
  if (instances.length === 0) return out.note('No running instances match.');

  out.table(
    ['ID', 'DEFINITION', 'BUSINESS KEY', 'TENANT'],
    instances.map((i) => [i.id, i.definitionId.split(':')[0], i.businessKey ?? '-', i.tenantId ?? '-'])
  );
  out.note(`\n${instances.length} running instance(s)`);
}

// Shows where the instance is now rather than only what it is. The activity-instance
// tree is the live token position; history alone cannot tell you that.
export async function instanceCommand(id, options) {
  const client = new Client(requireConfig());

  const [historic, variables, tree, incidents, tasks] = await Promise.all([
    client.historyProcessInstance(id),
    client.historyVariableInstances({ processInstanceId: id, maxResults: 200 }),
    client.activityInstanceTree(id).catch(() => null),
    client.incidents({ processInstanceId: id }).catch(() => []),
    client.tasks({ processInstanceId: id }).catch(() => []),
  ]);

  if (out.isJsonMode()) return out.json({ instance: historic, variables, activityTree: tree, incidents, tasks });

  out.heading(`Instance ${historic.id}`);
  out.kv([
    ['definition', `${historic.processDefinitionKey} v${historic.processDefinitionVersion}`],
    ['state', out.stateLabel(historic.state)],
    ['business key', historic.businessKey ?? '-'],
    ['tenant', historic.tenantId ?? '-'],
    ['started', out.formatDateTime(historic.startTime)],
    ['ended', historic.endTime ? out.formatDateTime(historic.endTime) : '-'],
    ['duration', out.formatDuration(historic.durationInMillis)],
    ['started by', historic.startUserId ?? '-'],
    ['delete reason', historic.deleteReason ?? ''],
  ]);

  const waiting = tree ? flattenTree(tree).filter((n) => n.activityType !== 'processDefinition') : [];
  if (waiting.length > 0) {
    out.line('\nCurrently at');
    out.table(
      null,
      waiting.map((n) => [`  ${n.activityId}`, n.activityType, n.activityName ?? '', (n.incidentIds ?? []).length ? 'has incident' : ''])
    );
  } else if (historic.state === 'ACTIVE') {
    out.note('\nActive but not sitting at any activity (it may be between transitions).');
  }

  if (tasks.length > 0) {
    out.line('\nOpen tasks');
    out.table(null, tasks.map((t) => [`  ${t.id}`, out.truncate(t.name, 34), t.assignee ?? 'unassigned']));
  }

  if (incidents.length > 0) {
    out.line('');
    out.problem(`${incidents.length} open incident(s). Run: camunda diagnose ${id}`);
  }

  if (variables.length > 0) {
    out.line('\nVariables');
    out.table(
      null,
      variables.map((v) => [`  ${v.name}`, v.type, out.truncate(JSON.stringify(v.value), 70)])
    );
  } else {
    out.note('\nNo variables set on this instance.');
  }
}

export async function startCommand(keyOrId, options) {
  const client = new Client(requireConfig());
  const def = await resolveDefinition(client, keyOrId, options);
  const variables = parseVariableFlags(options.var);

  const result = await client.startByDefinitionId(def.id, {
    businessKey: options.businessKey,
    variables,
  });

  if (out.isJsonMode() && options.noWait) return out.json(result);

  out.line(`Started ${def.key} v${def.version} as instance ${result.id}`);
  if (result.businessKey) out.note(`business key ${result.businessKey}`);
  if (options.noWait) return;

  // A start returning 200 only means the engine accepted it. Anything marked async runs
  // after the response, so both a failure and the first user task appear a moment later
  // rather than in this reply.
  const next = await reportNextState(client, result.id, { wait: options.wait ?? 1200 });
  if (next.failed) process.exitCode = 1;
  else if (next.tasks.length === 1) {
    out.note(await suggestCompletion(client, next.tasks[0], readProcess));
  }
}

// Takes either one id or a whole definition's worth of instances. Testing a model leaves
// a trail of instances behind, and clearing them one confirmation at a time is enough
// friction that they tend to get left running instead.
export async function cancelCommand(id, options) {
  const client = new Client(requireConfig());

  if (!id && !options.key) {
    throw new Error('Give an instance id, or --key <definitionKey> to cancel every running instance of one process.');
  }

  let targets;
  if (id) {
    targets = [id];
  } else {
    const query = { processDefinitionKey: options.key, maxResults: 1000 };
    if (options.tenant) query.tenantIdIn = options.tenant;
    if (options.businessKey) query.businessKey = options.businessKey;
    const found = await client.processInstances(query);
    targets = found.map((i) => i.id);
    if (targets.length === 0) return out.note(`No running instances of ${options.key}.`);
  }

  if (!options.yes) {
    const rl = createInterface({ input: stdin, output: stdout });
    const what =
      targets.length === 1
        ? `Force-terminating ${targets[0]}`
        : `Force-terminating all ${targets.length} running instances of ${options.key}`;
    const expect = targets.length === 1 ? targets[0] : String(targets.length);
    const answer = await rl.question(
      `${what} cannot be undone (they end as EXTERNALLY_TERMINATED, not COMPLETED).\nType "${expect}" to confirm: `
    );
    rl.close();
    if (answer.trim() !== expect) return out.note('Aborted, that did not match.');
  }

  let done = 0;
  const failures = [];
  for (const target of targets) {
    try {
      await client.deleteProcessInstance(target, { reason: options.reason });
      done++;
    } catch (err) {
      failures.push(`${target}: ${err.message}`);
    }
  }

  out.line(`Terminated ${done} instance(s).`);
  for (const f of failures) out.problem(`  ${f}`);
  if (failures.length > 0) process.exitCode = 1;
}

export async function varsCommand(id, options) {
  const client = new Client(requireConfig());

  if (options.history) {
    const details = await client.historyDetails({
      processInstanceId: id,
      type: 'variableUpdate',
      maxResults: options.limit ?? 200,
      sortBy: 'time',
      sortOrder: 'asc',
    });
    if (out.isJsonMode()) return out.json(details);
    if (details.length === 0) {
      out.note('No variable updates recorded. This needs the engine history level at FULL.');
      return;
    }
    out.table(
      ['TIME', 'VARIABLE', 'TYPE', 'REV', 'VALUE'],
      details.map((d) => [
        out.formatDateTime(d.time),
        d.variableName,
        d.variableType,
        String(d.revision ?? ''),
        out.truncate(JSON.stringify(d.value), 50),
      ])
    );
    return;
  }

  const variables = await client.historyVariableInstances({ processInstanceId: id, maxResults: 500 });
  if (out.isJsonMode()) return out.json(variables);
  if (variables.length === 0) return out.note('No variables on this instance.');
  out.table(
    ['NAME', 'TYPE', 'VALUE'],
    variables.map((v) => [v.name, v.type, out.truncate(JSON.stringify(v.value), 80)])
  );
}

function flattenTree(node, acc = []) {
  acc.push(node);
  for (const c of node.childActivityInstances ?? []) flattenTree(c, acc);
  for (const t of node.childTransitionInstances ?? []) acc.push({ ...t, activityType: 'transition' });
  return acc;
}
