import { writeFileSync, readFileSync, existsSync, statSync } from 'node:fs';
import { Client, resolveDefinition } from '../client.js';
import { requireConfig } from '../config.js';
import { readProcess } from '../bpmn.js';
import { lintProcess } from '../lint.js';
import * as out from '../output.js';

// inspect and lint accept a local .bpmn file as well as a deployed key, because the point
// of checking a model is to do it while editing, before it reaches an engine. A local file
// needs no credentials either, so the config lookup only happens for the remote path.
function isLocalFile(target) {
  return /\.(bpmn|xml|dmn)$/i.test(target) && existsSync(target) && statSync(target).isFile();
}

async function loadModel(target, options) {
  if (isLocalFile(target)) {
    const xml = readFileSync(target, 'utf8');
    return { model: readProcess(xml), xml, source: { local: target } };
  }
  const client = new Client(requireConfig());
  const def = await resolveDefinition(client, target, options);
  const { bpmn20Xml } = await client.processDefinitionXml(def.id);
  return { model: readProcess(bpmn20Xml), xml: bpmn20Xml, source: { definition: def }, client };
}

export async function definitionsCommand(options) {
  const client = new Client(requireConfig());
  const query = { maxResults: options.limit ?? 50, sortBy: 'key', sortOrder: 'asc' };
  if (options.key) query.keyLike = `%${options.key}%`;
  if (options.name) query.nameLike = `%${options.name}%`;
  if (options.tenant) query.tenantIdIn = options.tenant;
  if (options.latest) query.latestVersion = true;

  const defs = await client.processDefinitions(query);
  if (out.isJsonMode()) return out.json(defs);
  if (defs.length === 0) return out.note('No process definitions match.');

  out.table(
    ['KEY', 'NAME', 'VER', 'TENANT', 'ID'],
    defs.map((d) => [d.key, out.truncate(d.name ?? '', 34), String(d.version), d.tenantId ?? '-', d.id])
  );
  out.note(`\n${defs.length} definition(s)${options.latest ? ', latest version only' : ''}`);
}

// Structural view of a deployed model. None of this is available as a REST resource:
// it is read out of the deployed BPMN XML, which is the only place the engine keeps it.
export async function inspectCommand(keyOrId, options) {
  const { model, source, client } = await loadModel(keyOrId, options);
  const def = source.definition;

  let stats = [];
  if (client && def) {
    try {
      stats = await client.processDefinitionStatistics(def.id);
    } catch {
      /* statistics are optional context, not worth failing the command over */
    }
  }
  const liveByActivity = new Map(stats.map((s) => [s.id, s]));

  if (out.isJsonMode()) {
    return out.json({ definition: def ?? { file: source.local }, process: stripRaw(model), statistics: stats });
  }

  out.heading(def ? def.name || def.key : model.name || model.id);
  out.kv(
    def
      ? [
          ['key', def.key],
          ['id', def.id],
          ['version', def.version],
          ['tenant', def.tenantId ?? '-'],
          ['suspended', def.suspended ? 'yes' : 'no'],
          ['executable', model.executable ? 'yes' : 'no'],
        ]
      : [
          ['file', source.local],
          ['process id', model.id],
          ['executable', model.executable ? 'yes' : 'no'],
          ['status', 'not deployed, read from disk'],
        ]
  );

  if (model.lanes.length > 0) {
    out.line('\nLanes');
    out.table(null, model.lanes.map((l) => [l.name || l.id, `${l.nodeRefs.length} element(s)`]));
  }

  out.line('\nFlow nodes');
  const rows = model.nodes.map((n) => {
    const live = liveByActivity.get(n.id);
    const marks = [];
    if (n.async) marks.push(`async:${n.async}`);
    if (n.multiInstance) marks.push(`multi:${n.multiInstance}`);
    if (n.event?.type) marks.push(n.event.timer ? `${n.event.type}:${n.event.timer.value}` : n.event.type);
    if (n.assignee) marks.push(`assignee=${n.assignee}`);
    if (n.calledElement) marks.push(`calls=${n.calledElement}`);
    const addon = n.listeners.find((l) => l.addon)?.addon;
    if (addon) marks.push(`addon=${addon.addon}/${addon.action}${addon.config ? `#${addon.config}` : ''}`);
    if (n.formFields.length) marks.push(`${n.formFields.length} field(s)`);
    return [n.type, n.id, out.truncate(n.name, 30), live?.instances ? `[${live.instances} here]` : '', marks.join(' ')];
  });
  out.table(['TYPE', 'ID', 'NAME', 'LIVE', 'DETAIL'], rows);

  out.line('\nSequence flows');
  out.table(
    ['FROM', 'TO', 'LABEL', 'CONDITION'],
    model.flows.map((f) => [f.source, f.target, out.truncate(f.name, 14), f.condition ?? ''])
  );

  const withForms = model.nodes.filter((n) => n.formFields.length > 0);
  if (withForms.length > 0) {
    out.line('\nForm fields');
    for (const n of withForms) {
      out.line(`  ${n.id} (${n.name || n.type})`);
      out.table(
        null,
        n.formFields.map((f) => [`    ${f.name}`, f.type, f.required ? 'required' : '', f.disabled ? 'read-only' : '']),
        { indent: '' }
      );
    }
  }

  const addons = model.nodes.flatMap((n) => n.listeners.filter((l) => l.addon).map((l) => ({ node: n, l })));
  if (addons.length > 0) {
    out.line('\nIntegrations');
    out.table(
      ['ELEMENT', 'EVENT', 'ADDON', 'ACTION', 'CONFIG'],
      addons.map(({ node, l }) => [node.id, `${l.kind}[${l.event}]`, l.addon.addon ?? '-', l.addon.action ?? '-', l.addon.config ?? '-'])
    );
  }

  if (!options.noLint) {
    const findings = lintProcess(model);
    const errors = findings.filter((f) => f.severity === 'error').length;
    const warnings = findings.filter((f) => f.severity === 'warning').length;
    if (findings.length > 0) {
      out.note(`\n${errors} error(s), ${warnings} warning(s) from static checks. Run "camunda lint ${keyOrId}" for detail.`);
    }
  }
}

export async function lintCommand(keyOrId, options) {
  const { model, source } = await loadModel(keyOrId, options);
  const label = source.definition ? `${source.definition.key} v${source.definition.version}` : source.local;
  const findings = lintProcess(model);

  const wanted = options.severity
    ? findings.filter((f) => f.severity === options.severity)
    : findings.filter((f) => options.all || f.severity !== 'info');

  if (out.isJsonMode()) return out.json({ source: label, findings: wanted });

  if (wanted.length === 0) {
    out.line(`${label}: nothing to report.`);
    return;
  }

  out.heading(label);
  for (const f of wanted) {
    const tag = f.severity === 'error' ? 'ERROR  ' : f.severity === 'warning' ? 'WARNING' : 'INFO   ';
    out.line(`\n${tag} ${f.rule}  ${f.element}`);
    for (const l of out.wrap(f.message, 88)) out.line(`        ${l}`);
  }

  const errors = wanted.filter((f) => f.severity === 'error').length;
  out.note(`\n${wanted.length} finding(s)${options.all ? '' : ', info suppressed (use --all)'}`);
  if (errors > 0) process.exitCode = 1;
}

export async function xmlCommand(keyOrId, options) {
  const client = new Client(requireConfig());
  const def = await resolveDefinition(client, keyOrId, options);
  const { bpmn20Xml } = await client.processDefinitionXml(def.id);

  if (options.output) {
    writeFileSync(options.output, bpmn20Xml);
    out.note(`Saved ${def.id} to ${options.output} (${bpmn20Xml.length} bytes).`);
  } else {
    console.log(bpmn20Xml);
  }
}

// Answers "where are all the instances of this process sitting, and what is broken",
// which is the diagram-badge view in Cockpit expressed as a table.
export async function statsCommand(keyOrId, options) {
  const client = new Client(requireConfig());
  const def = await resolveDefinition(client, keyOrId, options);
  const [stats, xmlRes] = await Promise.all([
    client.processDefinitionStatistics(def.id),
    client.processDefinitionXml(def.id),
  ]);
  const model = readProcess(xmlRes.bpmn20Xml);
  const names = new Map(model.nodes.map((n) => [n.id, n.name || n.id]));

  if (out.isJsonMode()) return out.json(stats);
  if (stats.length === 0) {
    out.note(`No running instances of ${def.key} v${def.version}.`);
    return;
  }

  out.heading(`${def.key} v${def.version}`);
  out.table(
    ['ACTIVITY', 'NAME', 'INSTANCES', 'FAILED JOBS', 'INCIDENTS'],
    stats.map((s) => [
      s.id,
      out.truncate(names.get(s.id) ?? '', 30),
      String(s.instances),
      String(s.failedJobs ?? 0),
      String((s.incidents ?? []).reduce((a, i) => a + i.incidentCount, 0)),
    ])
  );
  const total = stats.reduce((a, s) => a + s.instances, 0);
  out.note(`\n${total} instance(s) across ${stats.length} activity/activities`);
}

function stripRaw(model) {
  return { ...model, nodes: model.nodes.map(({ raw, ...rest }) => rest) };
}
