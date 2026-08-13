#!/usr/bin/env node
import { Command, Option } from 'commander';
import { configureOutput, isJsonMode } from '../src/output.js';
import { unwrapError, explain } from '../src/errors.js';
import { loginCommand, logoutCommand, whoamiCommand } from '../src/commands/session.js';
import { definitionsCommand, inspectCommand, lintCommand, xmlCommand, statsCommand } from '../src/commands/definitions.js';
import { instancesCommand, instanceCommand, startCommand, cancelCommand, varsCommand } from '../src/commands/instances.js';
import { diagnoseCommand, incidentsCommand, jobsCommand, stacktraceCommand, traceCommand } from '../src/commands/diagnose.js';
import { tasksCommand, taskCommand, completeCommand, claimCommand } from '../src/commands/tasks.js';
import { deploymentsCommand, deployCommand, undeployCommand } from '../src/commands/deploy.js';
import {
  retryCommand, runJobCommand, setVarCommand, messageCommand, subscriptionsCommand,
  usersCommand, groupsCommand, tenantsCommand,
} from '../src/commands/ops.js';

const program = new Command();
const int = (v) => parseInt(v, 10);
const collect = (v, prev) => [...prev, v];

program
  .name('camunda')
  .description(
    'Command-line client for self-hosted Camunda 7.\n\n' +
      'Start with "camunda inspect <key>" to read a deployed model, and\n' +
      '"camunda diagnose <instanceId>" when an instance misbehaves.'
  )
  .version('0.4.2')
  .option('--json', 'print the raw API payload instead of a formatted view')
  .option('--no-color', 'never emit colour, even on a terminal')
  .showHelpAfterError()
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts();
    configureOutput({ json: opts.json, color: opts.color });
  });

// Shared option shapes. Multi-tenancy is not optional in practice: the same process key
// lives under many tenants in a shared engine, and every key-based lookup needs it.
const withTenant = (cmd) => cmd.option('-t, --tenant <tenantId>', 'restrict to one tenant');
const withVersion = (cmd) => cmd.option('--pd-version <n>', 'a specific definition version instead of the latest', int);

// --- session ---------------------------------------------------------------
program
  .command('login <url>')
  .description('Store credentials for an engine (the URL may omit /engine-rest)')
  .option('-u, --username <username>', 'prompted for if omitted')
  .option('-p, --password <password>', 'prompted for if omitted, which keeps it out of your shell history')
  .option('--no-suffix', 'use the URL exactly as given')
  .action(loginCommand);

program.command('logout').description('Forget the stored credentials').action(logoutCommand);
program.command('whoami').description('Which engine is configured, and its current totals').action(whoamiCommand);

// --- reading models --------------------------------------------------------
withTenant(
  program
    .command('definitions')
    .alias('defs')
    .description('List deployed process definitions')
    .option('-k, --key <substring>', 'match the definition key')
    .option('-n, --name <substring>', 'match the definition name')
    .option('-l, --latest', 'only the newest version of each')
    .option('--limit <n>', 'maximum rows', int)
).action(definitionsCommand);

withVersion(
  withTenant(
    program
      .command('inspect <keyOrId>')
      .description('Structure of a model: elements, flow conditions, forms, integrations. Accepts a deployed key or a local .bpmn file')
      .option('--no-lint', 'skip the static-check summary at the end')
  )
).action(inspectCommand);

withVersion(
  withTenant(
    program
      .command('lint <keyOrId>')
      .description('Static checks over a model, before an instance has to find the bugs. Accepts a deployed key or a local .bpmn file')
      .option('-a, --all', 'include informational findings')
      .addOption(new Option('-s, --severity <level>', 'only one severity').choices(['error', 'warning', 'info']))
  )
).action(lintCommand);

withVersion(
  withTenant(program.command('xml <keyOrId>').description('The deployed BPMN XML').option('-o, --output <file>', 'write to a file'))
).action(xmlCommand);

withVersion(
  withTenant(program.command('stats <keyOrId>').description('How many instances sit at each element, and what is failing there'))
).action(statsCommand);

// --- instances -------------------------------------------------------------
withTenant(
  program
    .command('instances')
    .alias('ps')
    .description('Running instances, or finished ones with --history')
    .option('-k, --key <definitionKey>')
    .option('-b, --business-key <key>')
    .option('-i, --with-incident', 'only instances that have an incident')
    .option('-H, --history', 'search history instead of running instances')
    .addOption(new Option('--state <state>', 'with --history').choices(['finished', 'unfinished', 'completed', 'externallyTerminated', 'internallyTerminated']))
    .option('--limit <n>', 'maximum rows', int)
).action(instancesCommand);

program
  .command('instance <id>')
  .description('One instance: state, where it currently sits, tasks, variables')
  .action(instanceCommand);

withVersion(
  withTenant(
    program
      .command('start <keyOrId>')
      .description('Start an instance, then check whether it failed immediately afterwards')
      .option('-b, --business-key <key>')
      .option('--var <name=value>', 'repeatable; name=value, name=value:Type, or name:=<json>', collect, [])
      .option('--no-wait', 'do not look for asynchronous failures after starting')
      .option('--wait <ms>', 'how long to wait before that check', int)
  )
).action(startCommand);

withTenant(
  program
    .command('cancel [id]')
    .description('Force-terminate one instance, or every instance of a process with --key')
    .option('-k, --key <definitionKey>', 'cancel every running instance of this process')
    .option('-b, --business-key <key>', 'with --key, only instances carrying this business key')
    .option('-r, --reason <text>', 'recorded against the instances')
    .option('-y, --yes', 'skip the confirmation prompt')
).action(cancelCommand);

program
  .command('vars <instanceId>')
  .description('Variables on an instance, or every write to them with --history')
  .option('-H, --history', 'each individual update, oldest first')
  .option('--limit <n>', 'maximum rows', int)
  .action(varsCommand);

program
  .command('set-var <instanceId> <name=value>')
  .description('Overwrite a variable on a running instance')
  .addOption(new Option('--type <type>').choices(['String', 'Integer', 'Long', 'Double', 'Boolean', 'Json']).default('String'))
  .action(setVarCommand);

// --- diagnosis -------------------------------------------------------------
program
  .command('diagnose <instanceId>')
  .alias('why')
  .description('Why an instance is stuck or failed, with the nested integration errors unpacked')
  .option('--stacktrace', 'include the Java frames behind each failure')
  .action(diagnoseCommand);

program
  .command('trace <instanceId>')
  .description('Every activity this instance has been through, in order')
  .option('--limit <n>', 'maximum rows', int)
  .action(traceCommand);

withTenant(
  program
    .command('incidents')
    .description('Open incidents, or every recorded one with --history')
    .option('-i, --instance <processInstanceId>')
    .option('-k, --key <definitionKey>')
    .option('-H, --history', 'include incidents that were already resolved')
    .option('--limit <n>', 'maximum rows', int)
).action(incidentsCommand);

program
  .command('jobs')
  .description('Pending and failed jobs')
  .option('-i, --instance <processInstanceId>')
  .option('-k, --key <definitionKey>')
  .option('-f, --failed', 'only jobs carrying an exception')
  .option('--limit <n>', 'maximum rows', int)
  .action(jobsCommand);

program
  .command('stacktrace <jobId>')
  .description('The stack trace behind a failed job, engine internals filtered out')
  .option('--full', 'every frame, unfiltered')
  .action(stacktraceCommand);

// --- tasks -----------------------------------------------------------------
withTenant(
  program
    .command('tasks')
    .description('Open human tasks')
    .option('-a, --assignee <userId>')
    .option('-i, --instance <processInstanceId>')
    .option('-b, --business-key <key>', 'tasks of the instance started with this business key')
    .option('-k, --key <definitionKey>')
    .option('-u, --unassigned')
    .option('--limit <n>', 'maximum rows', int)
).action(tasksCommand);

program.command('task <id>').description('One task, with the form fields needed to complete it').action(taskCommand);

program
  .command('complete <taskId>')
  .description('Complete a task; anything it triggers synchronously is reported here')
  .option('--var <name=value>', 'repeatable; name=value, name=value:Type, or name:=<json>', collect, [])
  .option('--no-wait', 'skip the follow-up check')
  .action(completeCommand);

program
  .command('claim <taskId>')
  .description('Assign a task to yourself or someone else')
  .option('-u, --user <userId>', 'defaults to the logged-in user')
  .option('--unclaim', 'remove the assignee instead')
  .action(claimCommand);

// --- deployment ------------------------------------------------------------
withTenant(
  program
    .command('deployments')
    .description('Recent deployments')
    .option('-n, --name <substring>')
    .option('--limit <n>', 'maximum rows', int)
).action(deploymentsCommand);

withTenant(
  program
    .command('deploy <files...>')
    .description('Deploy BPMN or DMN files, refusing models with blocking issues')
    .option('-n, --name <name>', 'deployment name')
    .option('--skip-lint', 'deploy without the static checks')
).action(deployCommand);

program
  .command('undeploy <deploymentId>')
  .description('Delete a deployment')
  .option('--cascade', 'also delete its instances and their history')
  .action(undeployCommand);

// --- events ----------------------------------------------------------------
program
  .command('message <name>')
  .description('Correlate a message to whatever is waiting for it')
  .option('-i, --instance <processInstanceId>')
  .option('-b, --business-key <key>')
  .option('--all', 'correlate to every match rather than requiring exactly one')
  .action(messageCommand);

program
  .command('subscriptions')
  .description('What is currently waiting on a message or signal')
  .option('-i, --instance <processInstanceId>')
  .addOption(new Option('--type <type>').choices(['message', 'signal', 'compensate', 'conditional']))
  .option('--limit <n>', 'maximum rows', int)
  .action(subscriptionsCommand);

// --- repair ----------------------------------------------------------------
program
  .command('retry <jobId>')
  .description('Give a failed job its retries back so it runs again')
  .option('-r, --retries <n>', 'defaults to 1', int)
  .option('--now', 'run it immediately instead of waiting for the scheduler')
  .action(retryCommand);

program.command('run-job <jobId>').description('Execute a pending job right now').action(runJobCommand);

// --- identity --------------------------------------------------------------
program
  .command('users')
  .description('Engine-local users (these are not your business users when an identity provider is in front)')
  .option('-s, --search <substring>')
  .option('--limit <n>', 'maximum rows', int)
  .action(usersCommand);

program.command('groups').description('Engine-local groups').option('--limit <n>', 'maximum rows', int).action(groupsCommand);

program
  .command('tenants')
  .description('Tenants known to the engine')
  .option('-s, --search <substring>')
  .option('--limit <n>', 'maximum rows', int)
  .action(tenantsCommand);

program.parseAsync(process.argv).catch((err) => {
  if (isJsonMode()) {
    console.error(JSON.stringify({ error: err.message, status: err.status ?? null, body: err.body ?? null }, null, 2));
    process.exit(1);
  }
  const unwrapped = unwrapError(err.body?.message || err.message);
  console.error(unwrapped.message);
  for (const layer of unwrapped.layers) {
    const text = typeof layer.value === 'string' ? layer.value : JSON.stringify(layer.value, null, 2);
    console.error(`\n${layer.label}:`);
    for (const l of text.split('\n')) console.error(`  ${l}`);
  }
  const hint = explain(err.body?.message || err.message);
  if (hint) console.error(`\n${hint}`);
  process.exit(1);
});
