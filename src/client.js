// Camunda 7 Engine REST API client.
//
// Auth is plain HTTP Basic on every request; the engine REST API has no session or token
// exchange to reuse. Verified against a live 7.24 multi-tenant deployment.
//
// Two behaviours here are not obvious from the API docs and were added after watching a
// real deployment misbehave:
//   * Transient 401/403 responses. A load-balanced engine will intermittently reject a
//     perfectly good credential while a replica is unhealthy; observed five consecutive
//     401s followed by five 200s, same credential, half a second apart. Without a retry a
//     caller concludes "the password is wrong" and goes looking in the wrong place.
//   * Accept headers. Most endpoints speak JSON, but /job/{id}/stacktrace returns
//     text/plain and answers 406 to an Accept: application/json request.

const RETRYABLE = new Set([401, 403, 500, 502, 503, 504]);

function normalizeBaseUrl(url) {
  return String(url).replace(/\/+$/, '');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class Client {
  constructor({ baseUrl, username, password, retries = 3, timeout = 60000 }) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.authHeader =
      username || password ? 'Basic ' + Buffer.from(`${username ?? ''}:${password ?? ''}`).toString('base64') : null;
    this.retries = retries;
    this.timeout = timeout;
    this.lastRetried = 0;
  }

  buildUrl(path, query) {
    let url = this.baseUrl + path;
    if (query) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(query)) {
        if (v === undefined || v === null || v === '') continue;
        params.set(k, String(v));
      }
      const qs = params.toString();
      if (qs) url += '?' + qs;
    }
    return url;
  }

  async request(method, path, { query, body, accept = 'application/json' } = {}) {
    const url = this.buildUrl(path, query);
    const headers = { Accept: accept };
    if (this.authHeader) headers.Authorization = this.authHeader;
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      let res;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(this.timeout),
        });
      } catch (err) {
        lastError = new Error(`${method} ${path} -> ${err.message}`);
        if (attempt === this.retries) throw lastError;
        await sleep(300 * (attempt + 1));
        continue;
      }

      if (res.ok) {
        if (attempt > 0) this.lastRetried = attempt;
        if (res.status === 204) return null;
        const text = await res.text();
        if (accept !== 'application/json') return text;
        return text ? JSON.parse(text) : null;
      }

      // A 4xx that carries a Camunda error body is a real answer, not a flaky replica:
      // retrying it just delays the report. Bodyless 401/403 from a proxy is retryable.
      const raw = await res.text();
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* html or empty */
      }
      const isDefinitive = parsed && (parsed.message || parsed.type);
      const err = new Error(`${method} ${path} -> ${parsed?.message || `HTTP ${res.status}`}`);
      err.status = res.status;
      err.body = parsed ?? raw;

      if (isDefinitive || !RETRYABLE.has(res.status) || attempt === this.retries) throw err;
      lastError = err;
      await sleep(300 * (attempt + 1));
    }
    throw lastError;
  }

  get(path, query, opts) {
    return this.request('GET', path, { query, ...opts });
  }

  // --- engine ---------------------------------------------------------------
  engines() {
    return this.get('/engine');
  }
  version() {
    return this.get('/version');
  }

  // --- process definitions --------------------------------------------------
  processDefinitions(query) {
    return this.get('/process-definition', query);
  }
  processDefinitionCount(query) {
    return this.get('/process-definition/count', query);
  }
  processDefinition(id) {
    return this.get(`/process-definition/${encodeURIComponent(id)}`);
  }
  processDefinitionXml(id) {
    return this.get(`/process-definition/${encodeURIComponent(id)}/xml`);
  }
  // Instance and incident counts per activity: the data behind Cockpit's diagram badges,
  // and the quickest answer to "where is everything piling up".
  processDefinitionStatistics(id, query) {
    return this.get(`/process-definition/${encodeURIComponent(id)}/statistics`, {
      incidents: true,
      failedJobs: true,
      ...query,
    });
  }
  calledProcessDefinitions(id) {
    return this.get(`/process-definition/${encodeURIComponent(id)}/static-called-process-definitions`);
  }
  startByDefinitionId(id, body) {
    return this.request('POST', `/process-definition/${encodeURIComponent(id)}/start`, { body });
  }
  suspendDefinition(id, suspended) {
    return this.request('PUT', `/process-definition/${encodeURIComponent(id)}/suspended`, {
      body: { suspended, includeProcessInstances: false },
    });
  }

  // --- process instances ----------------------------------------------------
  processInstances(query) {
    return this.get('/process-instance', query);
  }
  processInstance(id) {
    return this.get(`/process-instance/${id}`);
  }
  processInstanceVariables(id) {
    return this.get(`/process-instance/${id}/variables`);
  }
  setProcessInstanceVariable(id, name, value) {
    return this.request('PUT', `/process-instance/${id}/variables/${encodeURIComponent(name)}`, { body: value });
  }
  // Where the tokens are *right now*, as a tree. History tells you where they have been.
  activityInstanceTree(id) {
    return this.get(`/process-instance/${id}/activity-instances`);
  }
  deleteProcessInstance(id, { reason, skipCustomListeners = true, skipIoMappings = true } = {}) {
    return this.request('DELETE', `/process-instance/${id}`, {
      query: { skipCustomListeners, skipIoMappings, deleteReason: reason },
    });
  }
  suspendProcessInstance(id, suspended) {
    return this.request('PUT', `/process-instance/${id}/suspended`, { body: { suspended } });
  }

  // --- history --------------------------------------------------------------
  historyProcessInstances(query) {
    return this.get('/history/process-instance', query);
  }
  historyProcessInstance(id) {
    return this.get(`/history/process-instance/${id}`);
  }
  historyActivityInstances(query) {
    return this.get('/history/activity-instance', query);
  }
  historyVariableInstances(query) {
    return this.get('/history/variable-instance', query);
  }
  // Each individual write to a variable, with revision and timestamp. Requires the engine
  // history level to be FULL; returns an empty list on lower levels rather than failing.
  historyDetails(query) {
    return this.get('/history/detail', query);
  }
  historyTasks(query) {
    return this.get('/history/task', query);
  }
  // Survives the job itself. A failed job that was later deleted or retried away still has
  // its exception recorded here, which /job alone cannot tell you.
  historyJobLog(query) {
    return this.get('/history/job-log', query);
  }
  historyJobLogStacktrace(id) {
    return this.get(`/history/job-log/${id}/stacktrace`, undefined, { accept: 'text/plain' });
  }
  // Includes resolved incidents; /incident only lists open ones.
  historyIncidents(query) {
    return this.get('/history/incident', query);
  }
  historyUserOperations(query) {
    return this.get('/history/user-operation', query);
  }
  historyExternalTaskLog(query) {
    return this.get('/history/external-task-log', query);
  }

  // --- incidents and jobs ---------------------------------------------------
  incidents(query) {
    return this.get('/incident', query);
  }
  jobs(query) {
    return this.get('/job', query);
  }
  job(id) {
    return this.get(`/job/${id}`);
  }
  jobStacktrace(id) {
    return this.get(`/job/${id}/stacktrace`, undefined, { accept: 'text/plain' });
  }
  setJobRetries(id, retries) {
    return this.request('PUT', `/job/${id}/retries`, { body: { retries } });
  }
  executeJob(id) {
    return this.request('POST', `/job/${id}/execute`);
  }
  jobDefinitions(query) {
    return this.get('/job-definition', query);
  }
  externalTasks(query) {
    return this.get('/external-task', query);
  }

  // --- deployments ----------------------------------------------------------
  deployments(query) {
    return this.get('/deployment', query);
  }
  deploymentResources(id) {
    return this.get(`/deployment/${id}/resources`);
  }
  deleteDeployment(id, { cascade = false } = {}) {
    return this.request('DELETE', `/deployment/${id}`, { query: { cascade } });
  }
  async deploy(name, files, { tenantId } = {}) {
    const form = new FormData();
    form.set('deployment-name', name);
    form.set('deploy-changed-only', 'true');
    if (tenantId) form.set('tenant-id', tenantId);
    for (const { filename, buffer } of files) {
      form.set(filename, new Blob([buffer]), filename);
    }
    const headers = { Accept: 'application/json' };
    if (this.authHeader) headers.Authorization = this.authHeader;
    const res = await fetch(`${this.baseUrl}/deployment/create`, { method: 'POST', headers, body: form });
    if (!res.ok) {
      const raw = await res.text();
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* ignore */
      }
      const err = new Error(`POST /deployment/create -> ${parsed?.message || `HTTP ${res.status}`}`);
      err.status = res.status;
      err.body = parsed ?? raw;
      throw err;
    }
    return res.json();
  }

  // --- tasks ----------------------------------------------------------------
  tasks(query) {
    return this.get('/task', query);
  }
  task(id) {
    return this.get(`/task/${id}`);
  }
  taskVariables(id) {
    return this.get(`/task/${id}/variables`);
  }
  taskIdentityLinks(id) {
    return this.get(`/task/${id}/identity-links`);
  }
  completeTask(id, variables) {
    return this.request('POST', `/task/${id}/complete`, { body: { variables } });
  }
  claimTask(id, userId) {
    return this.request('POST', `/task/${id}/claim`, { body: { userId } });
  }
  unclaimTask(id) {
    return this.request('POST', `/task/${id}/unclaim`);
  }
  setTaskAssignee(id, userId) {
    return this.request('POST', `/task/${id}/assignee`, { body: { userId } });
  }

  // --- messages and signals -------------------------------------------------
  correlateMessage(body) {
    return this.request('POST', '/message', { body });
  }
  throwSignal(body) {
    return this.request('POST', '/signal', { body });
  }
  eventSubscriptions(query) {
    return this.get('/event-subscription', query);
  }

  // --- identity -------------------------------------------------------------
  users(query) {
    return this.get('/user', query);
  }
  groups(query) {
    return this.get('/group', query);
  }
  tenants(query) {
    return this.get('/tenant', query);
  }
}

const VARIABLE_TYPES = ['String', 'Integer', 'Long', 'Short', 'Double', 'Boolean', 'Date', 'Json', 'Null'];

// Accepts name=value, name=value:Type, or name:=<json>. Type defaults to String, which is
// what Camunda assumes too, but an explicit type matters for gateway conditions that
// compare numerically: "300" > 200 is false as a string comparison.
export function parseVariableFlags(varArgs = []) {
  const variables = {};
  for (const raw of varArgs) {
    const jsonEq = raw.indexOf(':=');
    if (jsonEq > 0) {
      const name = raw.slice(0, jsonEq);
      variables[name] = { value: JSON.parse(raw.slice(jsonEq + 2)), type: 'Json' };
      continue;
    }

    const eq = raw.indexOf('=');
    if (eq === -1) throw new Error(`Invalid --var "${raw}". Use name=value, name=value:Type, or name:=<json>.`);
    const name = raw.slice(0, eq);
    let rest = raw.slice(eq + 1);
    let type = 'String';

    const colon = rest.lastIndexOf(':');
    if (colon !== -1) {
      const candidate = rest.slice(colon + 1);
      const match = VARIABLE_TYPES.find((t) => t.toLowerCase() === candidate.toLowerCase());
      if (match) {
        type = match;
        rest = rest.slice(0, colon);
      }
    }

    let value = rest;
    if (type === 'Integer' || type === 'Long' || type === 'Short') {
      value = parseInt(rest, 10);
      if (Number.isNaN(value)) throw new Error(`--var ${name}: "${rest}" is not a whole number.`);
    } else if (type === 'Double') {
      value = parseFloat(rest);
      if (Number.isNaN(value)) throw new Error(`--var ${name}: "${rest}" is not a number.`);
    } else if (type === 'Boolean') {
      if (rest !== 'true' && rest !== 'false') throw new Error(`--var ${name}: expected true or false, got "${rest}".`);
      value = rest === 'true';
    } else if (type === 'Null') {
      value = null;
    }
    variables[name] = { value, type };
  }
  return variables;
}

// Resolves a bare process definition key to a single definition, taking tenancy into
// account. A key repeated across tenants is the normal case in AlurKerja, and the engine's
// own key-based endpoints answer "no matching process definition ... and no tenant-id"
// in that situation, which reads like the process is missing when it is not.
export async function resolveDefinition(client, keyOrId, { tenant, version } = {}) {
  if (keyOrId.includes(':')) return client.processDefinition(keyOrId);

  const query = { key: keyOrId };
  if (tenant) query.tenantIdIn = tenant;
  if (version) query.version = version;
  else query.latestVersion = true;

  const matches = await client.processDefinitions(query);
  if (matches.length === 0) {
    const anywhere = await client.processDefinitions({ key: keyOrId, latestVersion: true });
    if (anywhere.length > 0) {
      const tenants = anywhere.map((d) => d.tenantId ?? '(no tenant)').join(', ');
      throw new Error(`No definition "${keyOrId}" for tenant ${tenant}. It exists under: ${tenants}.`);
    }
    throw new Error(`No process definition with key "${keyOrId}".`);
  }
  if (matches.length > 1) {
    const list = matches.map((d) => `  ${d.id}  tenant=${d.tenantId ?? '-'}  version=${d.version}`).join('\n');
    throw new Error(
      `"${keyOrId}" exists in ${matches.length} tenants. Narrow it with --tenant <id>, or pass the full definition id:\n${list}`
    );
  }
  return matches[0];
}
