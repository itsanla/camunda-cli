// What happened after an action that moves a process forward.
//
// Both starting an instance and completing a task leave the caller needing the same three
// answers: did it break, did it finish, and what is waiting now. Without them every step of
// driving a process costs an extra round trip to work out where it went, which is most of
// the effort in testing a model with more than two steps.

import { unwrapError } from './errors.js';
import * as out from './output.js';

export async function reportNextState(client, instanceId, { wait = 1000 } = {}) {
  if (wait) await new Promise((r) => setTimeout(r, wait));

  const [historic, incidents, jobs, tasks] = await Promise.all([
    client.historyProcessInstance(instanceId).catch(() => null),
    client.incidents({ processInstanceId: instanceId }).catch(() => []),
    client.jobs({ processInstanceId: instanceId, withException: true }).catch(() => []),
    client.tasks({ processInstanceId: instanceId }).catch(() => []),
  ]);

  const failure = incidents[0]?.incidentMessage || jobs[0]?.exceptionMessage || null;
  const state = historic?.state ?? null;

  if (failure) {
    out.problem(`\nIt failed after this step: ${unwrapError(failure).message}`);
    out.note(`camunda diagnose ${instanceId}`);
    return { state, failed: true, tasks };
  }

  if (state && state !== 'ACTIVE') {
    const label = state === 'COMPLETED' ? 'finished' : `ended as ${state}`;
    out.line(`Instance ${instanceId} ${label}${historic.durationInMillis ? ` in ${out.formatDuration(historic.durationInMillis)}` : ''}.`);
    return { state, failed: false, tasks: [] };
  }

  if (tasks.length > 0) {
    out.line(tasks.length === 1 ? '\nNow waiting at:' : `\nNow waiting at ${tasks.length} tasks:`);
    out.table(null, tasks.map((t) => [`  ${t.id}`, out.truncate(t.name, 34), t.assignee ?? 'unassigned']));
    return { state, failed: false, tasks };
  }

  out.note(`\nStill running, not sitting at a user task. camunda instance ${instanceId}`);
  return { state, failed: false, tasks: [] };
}

// The form fields a task needs, read from the deployed model. AlurKerja keeps its form in
// an extension attribute the engine's own form endpoints do not read, so this goes through
// the XML instead.
export async function suggestCompletion(client, task, readProcess) {
  try {
    const { bpmn20Xml } = await client.processDefinitionXml(task.processDefinitionId);
    const model = readProcess(bpmn20Xml);
    const node = model.nodes.find((n) => n.id === task.taskDefinitionKey);
    const writable = (node?.formFields ?? []).filter((f) => !f.disabled);
    if (writable.length === 0) return `camunda complete ${task.id}`;
    return `camunda complete ${task.id} ${writable.map((f) => `--var ${f.name}=<value>`).join(' ')}`;
  } catch {
    return `camunda complete ${task.id}`;
  }
}
