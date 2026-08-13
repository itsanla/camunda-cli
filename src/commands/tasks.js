import { Client, parseVariableFlags } from '../client.js';
import { requireConfig } from '../config.js';
import { readProcess } from '../bpmn.js';
import { reportNextState, suggestCompletion } from '../followup.js';
import { unwrapError, explain } from '../errors.js';
import * as out from '../output.js';

export async function tasksCommand(options) {
  const client = new Client(requireConfig());
  const query = { maxResults: options.limit ?? 50 };
  if (options.assignee) query.assignee = options.assignee;
  if (options.instance) query.processInstanceId = options.instance;
  // The business key is the handle you chose when starting, so it is the natural way back
  // to a task without first looking the instance id up.
  if (options.businessKey) query.processInstanceBusinessKey = options.businessKey;
  if (options.key) query.processDefinitionKey = options.key;
  if (options.tenant) query.tenantIdIn = options.tenant;
  if (options.unassigned) query.unassigned = true;

  const tasks = await client.tasks(query);
  if (out.isJsonMode()) return out.json(tasks);
  if (tasks.length === 0) return out.note('No open tasks match.');

  out.table(
    ['ID', 'NAME', 'ASSIGNEE', 'CREATED', 'INSTANCE'],
    tasks.map((t) => [t.id, out.truncate(t.name, 34), t.assignee ?? 'unassigned', out.formatDateTime(t.created), t.processInstanceId])
  );
  out.note(`\n${tasks.length} open task(s)`);
}

// Shows what completing this task actually requires. The form fields come from the
// deployed model, because AlurKerja keeps its form definition in an extension attribute
// that the engine's own form endpoints do not read.
export async function taskCommand(id) {
  const client = new Client(requireConfig());
  const task = await client.task(id);

  const [variables, definition] = await Promise.all([
    client.taskVariables(id).catch(() => ({})),
    client.processDefinitionXml(task.processDefinitionId).catch(() => null),
  ]);

  let fields = [];
  if (definition) {
    try {
      const model = readProcess(definition.bpmn20Xml);
      fields = model.nodes.find((n) => n.id === task.taskDefinitionKey)?.formFields ?? [];
    } catch {
      /* an unparsable model should not stop the task from being shown */
    }
  }

  if (out.isJsonMode()) return out.json({ task, variables, formFields: fields });

  out.heading(`Task ${task.id}: ${task.name}`);
  out.kv([
    ['element', task.taskDefinitionKey],
    ['assignee', task.assignee ?? 'unassigned'],
    ['instance', task.processInstanceId],
    ['definition', task.processDefinitionId],
    ['created', out.formatDateTime(task.created)],
    ['due', out.formatDateTime(task.due)],
    ['tenant', task.tenantId ?? '-'],
  ]);

  if (fields.length > 0) {
    out.line('\nForm fields');
    out.table(
      ['NAME', 'TYPE', 'REQUIRED', 'LABEL'],
      fields.map((f) => [f.name, f.type, f.required ? 'yes' : '', f.disabled ? `${f.label} (read-only)` : f.label])
    );
    const writable = fields.filter((f) => !f.disabled);
    if (writable.length > 0) {
      out.note(`\ncamunda complete ${id} ${writable.map((f) => `--var ${f.name}=<value>`).join(' ')}`);
    }
  } else {
    out.note('\nNo form fields declared on this element.');
  }

  const names = Object.keys(variables);
  if (names.length > 0) {
    out.line('\nVisible variables');
    out.table(null, names.map((n) => [`  ${n}`, variables[n].type, out.truncate(JSON.stringify(variables[n].value), 60)]));
  }
}

export async function completeCommand(id, options) {
  const client = new Client(requireConfig());
  const variables = parseVariableFlags(options.var);

  // The task is gone once it completes, so its instance has to be noted beforehand for
  // the follow-up to have something to report on.
  const instanceId = await client
    .task(id)
    .then((t) => t.processInstanceId)
    .catch(() => null);

  try {
    await client.completeTask(id, variables);
  } catch (err) {
    // Anything the task triggers synchronously fails here rather than becoming an
    // incident, so this response is the only place the cause is ever recorded.
    const unwrapped = unwrapError(err.body?.message || err.message);
    out.problem(`Could not complete task ${id}.`);
    out.line(`\n${unwrapped.message}`);
    for (const layer of unwrapped.layers) {
      const text = typeof layer.value === 'string' ? layer.value : JSON.stringify(layer.value, null, 2);
      out.note(`\n${layer.label}:`);
      for (const l of text.split('\n')) out.note(`  ${l}`);
    }
    const hint = explain(err.body?.message || err.message);
    if (hint) {
      out.line('');
      for (const l of out.wrap(hint, 92)) out.line(l);
    }
    out.note('\nThe task is untouched; the whole completion rolled back.');
    process.exitCode = 1;
    return;
  }

  out.line(`Task ${id} completed.`);
  if (options.noWait || !instanceId) return;

  const next = await reportNextState(client, instanceId, { wait: options.wait ?? 1000 });
  if (next.failed) process.exitCode = 1;
  else if (next.tasks.length === 1) {
    out.note(await suggestCompletion(client, next.tasks[0], readProcess));
  }
}

export async function claimCommand(id, options) {
  const client = new Client(requireConfig());
  if (options.unclaim) {
    await client.unclaimTask(id);
    return out.line(`Task ${id} unassigned.`);
  }
  const config = requireConfig();
  const user = options.user || config.username;
  await client.setTaskAssignee(id, user);
  out.line(`Task ${id} assigned to ${user}.`);
}
