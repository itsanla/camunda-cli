import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { Client } from '../client.js';
import { requireConfig } from '../config.js';
import { readProcess } from '../bpmn.js';
import { lintProcess } from '../lint.js';
import * as out from '../output.js';

export async function deploymentsCommand(options) {
  const client = new Client(requireConfig());
  const query = { maxResults: options.limit ?? 20, sortBy: 'deploymentTime', sortOrder: 'desc' };
  if (options.tenant) query.tenantIdIn = options.tenant;
  if (options.name) query.nameLike = `%${options.name}%`;

  const deployments = await client.deployments(query);
  if (out.isJsonMode()) return out.json(deployments);
  if (deployments.length === 0) return out.note('No deployments found.');

  out.table(
    ['ID', 'NAME', 'DEPLOYED', 'TENANT'],
    deployments.map((d) => [d.id, out.truncate(d.name ?? '-', 34), out.formatDateTime(d.deploymentTime), d.tenantId ?? '-'])
  );
}

// Lints before deploying by default. Pushing a model whose gateway conditions cannot all
// be satisfied only moves the failure to the first instance that runs it, and by then the
// stack trace is much further from the cause.
export async function deployCommand(files, options) {
  const client = new Client(requireConfig());

  const payload = files.map((file) => ({ filename: basename(file), buffer: readFileSync(file), path: file }));

  if (!options.skipLint) {
    let blocking = 0;
    for (const f of payload) {
      if (!/\.bpmn$/i.test(f.filename)) continue;
      let findings;
      try {
        findings = lintProcess(readProcess(f.buffer.toString('utf8')));
      } catch (err) {
        out.warn(`${f.filename}: could not be parsed for checks (${err.message})`);
        continue;
      }
      const errors = findings.filter((x) => x.severity === 'error');
      if (errors.length === 0) continue;
      blocking += errors.length;
      out.problem(`${f.filename}`);
      for (const e of errors) {
        out.line(`  ${e.rule}  ${e.element}`);
        for (const l of out.wrap(e.message, 90)) out.note(`    ${l}`);
      }
    }
    if (blocking > 0) {
      out.line('');
      out.problem(`${blocking} blocking issue(s). Deploy anyway with --skip-lint.`);
      process.exitCode = 1;
      return;
    }
  }

  const name = options.name || payload.map((p) => p.filename).join(', ');
  const result = await client.deploy(name, payload, { tenantId: options.tenant });

  if (out.isJsonMode()) return out.json(result);

  out.line(`Deployed "${name}" as deployment ${result.id}`);
  const defs = Object.values(result.deployedProcessDefinitions ?? {});
  if (defs.length === 0) {
    out.note('No new process definition version was created: the content is identical to what is already deployed.');
    return;
  }
  out.table(
    ['KEY', 'VERSION', 'ID'],
    defs.map((d) => [d.key, String(d.version), d.id])
  );
}

export async function undeployCommand(id, options) {
  const client = new Client(requireConfig());
  await client.deleteDeployment(id, { cascade: options.cascade });
  out.line(`Deployment ${id} deleted${options.cascade ? ' along with its instances and history' : ''}.`);
}
