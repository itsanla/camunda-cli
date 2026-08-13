import { Client } from '../client.js';
import { requireConfig } from '../config.js';
import { unwrapError } from '../errors.js';
import * as out from '../output.js';

// Repair operations. A job that ran out of retries stays put until its retry count is
// raised, which is how you re-run a step after fixing the addon behind it without
// starting the whole instance over.
export async function retryCommand(jobId, options) {
  const client = new Client(requireConfig());
  const retries = options.retries ?? 1;
  await client.setJobRetries(jobId, retries);
  out.line(`Job ${jobId} set to ${retries} retry/retries.`);

  if (options.now) {
    try {
      await client.executeJob(jobId);
      out.line('Executed immediately, it succeeded.');
    } catch (err) {
      const unwrapped = unwrapError(err.body?.message || err.message);
      out.problem(`Ran it now and it failed again: ${unwrapped.message}`);
      process.exitCode = 1;
    }
  } else {
    out.note('The job runner will pick it up shortly. Use --now to run it immediately instead.');
  }
}

// Runs a pending job at once rather than waiting for the scheduler. Useful for testing a
// step marked async without sitting through the poll interval.
export async function runJobCommand(jobId) {
  const client = new Client(requireConfig());
  try {
    await client.executeJob(jobId);
    out.line(`Job ${jobId} executed.`);
  } catch (err) {
    const unwrapped = unwrapError(err.body?.message || err.message);
    out.problem(`Job ${jobId} failed: ${unwrapped.message}`);
    process.exitCode = 1;
  }
}

export async function setVarCommand(instanceId, assignment, options) {
  const client = new Client(requireConfig());
  const eq = assignment.indexOf('=');
  if (eq === -1) throw new Error('Expected name=value.');
  const name = assignment.slice(0, eq);
  const raw = assignment.slice(eq + 1);
  const type = options.type ?? 'String';

  let value = raw;
  if (type === 'Integer' || type === 'Long') value = parseInt(raw, 10);
  else if (type === 'Double') value = parseFloat(raw);
  else if (type === 'Boolean') value = raw === 'true';
  else if (type === 'Json') value = JSON.parse(raw);

  await client.setProcessInstanceVariable(instanceId, name, { value, type });
  out.line(`Set ${name} (${type}) on instance ${instanceId}.`);
}

export async function messageCommand(name, options) {
  const client = new Client(requireConfig());
  const body = { messageName: name, resultEnabled: true };
  if (options.instance) body.processInstanceId = options.instance;
  if (options.businessKey) body.businessKey = options.businessKey;
  if (options.all) body.all = true;

  // Camunda answers a message that matches nothing with an exception rather than an empty
  // result, so the ordinary case of getting the name or business key wrong arrives as a
  // Java class name unless it is caught here.
  let result;
  try {
    result = await client.correlateMessage(body);
  } catch (err) {
    const raw = err.body?.message || err.message || '';
    if (/MismatchingMessageCorrelation|No process definition or execution matches/.test(raw)) {
      out.warn(`Nothing is waiting for a message called "${name}"${options.instance ? ` on instance ${options.instance}` : ''}${options.businessKey ? ` with business key ${options.businessKey}` : ''}.`);
      out.note('camunda subscriptions   shows what is currently waiting, and under which name.');
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  if (out.isJsonMode()) return out.json(result);

  if (!result || result.length === 0) {
    out.warn(`Message "${name}" correlated with nothing. No instance is waiting for it.`);
    process.exitCode = 1;
    return;
  }
  for (const r of result) {
    out.line(`Correlated with ${r.resultType === 'ProcessDefinition' ? 'new instance' : 'instance'} ${r.processInstance?.id ?? r.execution?.processInstanceId}`);
  }
}

export async function subscriptionsCommand(options) {
  const client = new Client(requireConfig());
  const query = { maxResults: options.limit ?? 50 };
  if (options.instance) query.processInstanceId = options.instance;
  if (options.type) query.eventType = options.type;

  const subs = await client.eventSubscriptions(query);
  if (out.isJsonMode()) return out.json(subs);
  if (subs.length === 0) return out.note('Nothing is waiting on a message or signal.');

  out.table(
    ['TYPE', 'NAME', 'ELEMENT', 'INSTANCE', 'SINCE'],
    subs.map((s) => [s.eventType, s.eventName ?? '-', s.activityId ?? '-', s.processInstanceId ?? '-', out.formatDateTime(s.createdDate)])
  );
}

export async function usersCommand(options) {
  const client = new Client(requireConfig());
  const query = { maxResults: options.limit ?? 50 };
  if (options.search) query.idLike = `%${options.search}%`;
  const users = await client.users(query);
  if (out.isJsonMode()) return out.json(users);
  if (users.length === 0) return out.note('No users found.');
  out.table(
    ['ID', 'FIRST', 'LAST', 'EMAIL'],
    users.map((u) => [u.id, u.firstName ?? '', u.lastName ?? '', u.email ?? ''])
  );
}

export async function groupsCommand(options) {
  const client = new Client(requireConfig());
  const groups = await client.groups({ maxResults: options.limit ?? 50 });
  if (out.isJsonMode()) return out.json(groups);
  if (groups.length === 0) return out.note('No groups found.');
  out.table(['ID', 'NAME', 'TYPE'], groups.map((g) => [g.id, g.name ?? '', g.type ?? '']));
}

export async function tenantsCommand(options) {
  const client = new Client(requireConfig());
  const query = { maxResults: options.limit ?? 200 };
  if (options.search) query.nameLike = `%${options.search}%`;
  const tenants = await client.tenants(query);
  if (out.isJsonMode()) return out.json(tenants);
  if (tenants.length === 0) return out.note('No tenants found.');
  out.table(['ID', 'NAME'], tenants.map((t) => [t.id, t.name ?? '']));
  out.note(`\n${tenants.length} tenant(s)`);
}
