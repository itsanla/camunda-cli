import { Client } from '../client.js';
import { requireConfig } from '../config.js';
import { unwrapError, explain, condenseStacktrace } from '../errors.js';
import * as out from '../output.js';

// One command for "this instance is broken, why".
//
// It reads more than the obvious /incident, because several real failure shapes are
// invisible there:
//   * A step that fails inside the caller's transaction rolls the transaction back, so no
//     incident and no job survive; the only record is the historic job log, or nothing at
//     all if the failure happened synchronously in an API call.
//   * An incident carries both activityId (where the job hangs) and failedActivityId
//     (where the error actually came from). Reporting only the first points at the wrong
//     element, which is exactly what you do not want while hunting a bug.
export async function diagnoseCommand(id, options) {
  const client = new Client(requireConfig());

  const [historic, tree, incidents, jobs, jobLog, histIncidents, tasks, externalLog] = await Promise.all([
    client.historyProcessInstance(id),
    client.activityInstanceTree(id).catch(() => null),
    client.incidents({ processInstanceId: id }).catch(() => []),
    client.jobs({ processInstanceId: id }).catch(() => []),
    client.historyJobLog({ processInstanceId: id, failureLog: true, sortBy: 'timestamp', sortOrder: 'desc', maxResults: 10 }).catch(() => []),
    client.historyIncidents({ processInstanceId: id, sortBy: 'createTime', sortOrder: 'desc', maxResults: 10 }).catch(() => []),
    client.tasks({ processInstanceId: id }).catch(() => []),
    client.historyExternalTaskLog({ processInstanceId: id, failureLog: true, maxResults: 5 }).catch(() => []),
  ]);

  if (out.isJsonMode()) {
    return out.json({ instance: historic, activityTree: tree, incidents, jobs, jobLog, historicIncidents: histIncidents, tasks, externalTaskLog: externalLog });
  }

  out.heading(`Instance ${id}`);
  out.kv([
    ['definition', `${historic.processDefinitionKey} v${historic.processDefinitionVersion}`],
    ['state', out.stateLabel(historic.state)],
    ['started', out.formatDateTime(historic.startTime)],
    ['ended', historic.endTime ? out.formatDateTime(historic.endTime) : '-'],
    ['tenant', historic.tenantId ?? '-'],
  ]);

  const waiting = tree ? flatten(tree).filter((n) => n.activityType !== 'processDefinition') : [];
  if (waiting.length > 0) {
    out.line('\nStopped at');
    out.table(null, waiting.map((n) => [`  ${n.activityId}`, n.activityType, n.activityName ?? '']));
  }

  const problems = [];

  for (const inc of incidents) {
    problems.push({
      source: 'open incident',
      when: inc.incidentTimestamp,
      activity: inc.failedActivityId || inc.activityId,
      attachedAt: inc.activityId,
      message: inc.incidentMessage,
      jobId: inc.configuration,
    });
  }

  for (const job of jobs.filter((j) => j.exceptionMessage)) {
    if (incidents.some((i) => i.configuration === job.id)) continue;
    problems.push({
      source: `job (retries left ${job.retries})`,
      when: job.createTime,
      activity: job.failedActivityId,
      message: job.exceptionMessage,
      jobId: job.id,
    });
  }

  // Only surface the historic log when nothing live explains the failure, otherwise the
  // same error is reported three times over.
  if (problems.length === 0) {
    for (const entry of jobLog) {
      problems.push({
        source: 'historic job failure',
        when: entry.timestamp,
        activity: entry.failedActivityId || entry.activityId,
        attachedAt: entry.activityId,
        message: entry.jobExceptionMessage,
        historicJobLogId: entry.id,
      });
    }
    for (const inc of histIncidents.filter((i) => i.endTime)) {
      problems.push({
        source: `resolved incident (${out.formatDateTime(inc.endTime)})`,
        when: inc.createTime,
        activity: inc.failedActivityId || inc.activityId,
        message: inc.incidentMessage,
      });
    }
  }

  for (const entry of externalLog) {
    problems.push({ source: 'external task failure', when: entry.timestamp, activity: entry.activityId, message: entry.errorMessage });
  }

  if (problems.length === 0) {
    if (historic.state === 'ACTIVE') {
      out.line('\nNothing is failing. This instance is simply waiting.');
      if (tasks.length > 0) {
        out.table(null, tasks.map((t) => [`  task ${t.id}`, out.truncate(t.name, 34), t.assignee ?? 'unassigned']));
        out.note(`\nMove it along with: camunda complete <taskId> --var name=value`);
      }
    } else {
      out.line(`\nNothing is failing; the instance finished as ${historic.state}.`);
      if (historic.state === 'EXTERNALLY_TERMINATED') {
        out.note(`It was force-terminated${historic.deleteReason ? `: ${historic.deleteReason}` : ''}, not completed normally.`);
      }
    }
    return;
  }

  out.line('');
  out.problem(`${problems.length} problem(s)`);
  for (const p of problems) {
    out.line(`\n  ${p.source} at ${out.formatDateTime(p.when)}`);
    if (p.activity) out.line(`  failing element: ${p.activity}`);
    if (p.attachedAt && p.attachedAt !== p.activity) {
      out.line(`  job attached to:  ${p.attachedAt}  (the async marker sits here, the error came from the element above)`);
    }

    const unwrapped = unwrapError(p.message);
    out.line(`  ${unwrapped.message}`);

    for (const layer of unwrapped.layers) {
      const text = typeof layer.value === 'string' ? layer.value : JSON.stringify(layer.value, null, 2);
      out.note(`  ${layer.label}:`);
      for (const l of text.split('\n')) out.note(`    ${l}`);
    }

    const hint = explain(p.message);
    if (hint) {
      out.line('');
      for (const l of out.wrap(hint, 92)) out.line(`  ${l}`);
    }

    if (options.stacktrace && (p.jobId || p.historicJobLogId)) {
      try {
        const trace = p.jobId ? await client.jobStacktrace(p.jobId) : await client.historyJobLogStacktrace(p.historicJobLogId);
        const { header, frames, omitted } = condenseStacktrace(trace);
        out.line('');
        for (const h of header.slice(0, 3)) out.note(`  ${h}`);
        for (const f of frames) out.note(`    ${f}`);
        if (omitted > 0) out.note(`    ... ${omitted} engine-internal frame(s) hidden`);
      } catch {
        /* the job may already be gone */
      }
    }
  }

  if (!options.stacktrace) out.note('\nAdd --stacktrace for the Java frames behind these.');
  process.exitCode = 1;
}

// The activity-instance tree nests scopes (a subprocess holds its children); flattening
// it gives the plain list of places a token is currently sitting.
function flatten(node, acc = []) {
  acc.push(node);
  for (const c of node.childActivityInstances ?? []) flatten(c, acc);
  for (const t of node.childTransitionInstances ?? []) acc.push({ ...t, activityType: 'transition' });
  return acc;
}

export async function incidentsCommand(options) {
  const client = new Client(requireConfig());
  const query = { maxResults: options.limit ?? 50 };
  if (options.instance) query.processInstanceId = options.instance;
  if (options.key) query.processDefinitionKeyIn = options.key;
  if (options.tenant) query.tenantIdIn = options.tenant;

  const rows = options.history
    ? await client.historyIncidents({ ...query, sortBy: 'createTime', sortOrder: 'desc' })
    : await client.incidents(query);

  if (out.isJsonMode()) return out.json(rows);
  if (rows.length === 0) return out.note(options.history ? 'No incidents recorded.' : 'No open incidents.');

  out.table(
    ['INSTANCE', 'FAILING ELEMENT', 'TYPE', 'SINCE', 'MESSAGE'],
    rows.map((i) => [
      i.processInstanceId,
      i.failedActivityId || i.activityId || '-',
      i.incidentType,
      out.formatDateTime(i.incidentTimestamp || i.createTime),
      out.truncate(unwrapError(i.incidentMessage).message, 60),
    ])
  );
  out.note(`\n${rows.length} incident(s). Detail: camunda diagnose <instanceId>`);
}

export async function jobsCommand(options) {
  const client = new Client(requireConfig());
  const query = { maxResults: options.limit ?? 50 };
  if (options.instance) query.processInstanceId = options.instance;
  if (options.key) query.processDefinitionKey = options.key;
  if (options.failed) query.withException = true;

  const jobs = await client.jobs(query);
  if (out.isJsonMode()) return out.json(jobs);
  if (jobs.length === 0) return out.note('No jobs match.');

  out.table(
    ['ID', 'INSTANCE', 'ELEMENT', 'RETRIES', 'DUE', 'ERROR'],
    jobs.map((j) => [
      j.id,
      j.processInstanceId,
      j.failedActivityId || '-',
      String(j.retries),
      out.formatDateTime(j.dueDate),
      out.truncate(unwrapError(j.exceptionMessage || '').message, 50),
    ])
  );
}

export async function stacktraceCommand(jobId, options) {
  const client = new Client(requireConfig());
  const trace = await client.jobStacktrace(jobId);
  if (options.full) return console.log(trace);
  const { header, frames, omitted } = condenseStacktrace(trace, { keep: 20 });
  for (const h of header) out.line(h);
  for (const f of frames) out.note(`  ${f}`);
  if (omitted > 0) out.note(`  ... ${omitted} engine-internal frame(s) hidden, use --full for everything`);
}

// The execution trace, in the order the engine actually took the steps.
//
// Sorting by startTime looks right and is not: a gateway and the events either side of it
// routinely share a millisecond, and the resulting order is arbitrary within that tie, so
// a start event can appear halfway down the list. `occurrence` is the engine's own
// execution sequence and is the only field that reflects real order.
export async function traceCommand(id, options) {
  const client = new Client(requireConfig());
  const activities = await client.historyActivityInstances({
    processInstanceId: id,
    maxResults: options.limit ?? 200,
    sortBy: 'occurrence',
    sortOrder: 'asc',
  });

  if (out.isJsonMode()) return out.json(activities);
  if (activities.length === 0) return out.note('No activity recorded for this instance.');

  const rows = activities.map((a) => [
    out.formatDateTime(a.startTime),
    a.activityType,
    a.activityId,
    out.truncate(a.activityName ?? '', 32),
    out.formatDuration(a.durationInMillis),
    a.canceled ? 'canceled' : a.endTime ? '' : 'running',
  ]);
  out.table(['TIME', 'TYPE', 'ID', 'NAME', 'TOOK', ''], rows);

  const running = activities.filter((a) => !a.endTime);
  if (running.length > 0) {
    out.note(`\nStill open: ${running.map((a) => a.activityId).join(', ')}`);
  }
}
