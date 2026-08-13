# camunda-cli

Command-line client for **self-hosted Camunda 7**, aimed at the two things that take the
most time when developing BPMN: understanding a model that is already deployed, and working
out why an instance is stuck. Not affiliated with Camunda GmbH.

Built and verified against Camunda 7.24 on a live multi-tenant deployment.

```
$ camunda lint order-process

ERROR   uncovered-value  Gateway_1jk90v6
        "amount check" branches on amount > 300 and amount < 300, so amount == 300 matches
        neither branch and the instance will fail there.

ERROR   variable-name-mismatch  flow Flow_0jpsuir (retry)
        Reads "input_huruf", which nothing in this process writes, while a form here writes
        "input_9ltnt". These names look related, so this is most likely a typo: the
        expression throws "Cannot resolve identifier 'input_huruf'" the moment it is evaluated.
```

## Install

```bash
npm install -g camunda-cli
camunda login https://your-host/engine-rest
```

`login` prompts for a username and password and stores them in
`~/.config/camunda-cli/config.json` with mode `0600`. Camunda 7's REST API authenticates
with HTTP Basic on every request and has no token to exchange, so the password is kept
rather than a session. It is sent only to the engine you configured.

Installing globally without root:

```bash
npm config set prefix ~/.npm-global
export PATH="$HOME/.npm-global/bin:$PATH"
npm install -g camunda-cli
```

## What it is for

**Read a deployed model.** Much of what you need while debugging — which variable a gateway
condition reads, whether a step is async, what a service task is actually wired to — is only
in the deployed XML, not behind any REST resource. `inspect` reads it out and lays it flat.

```bash
camunda inspect order-process
```

```
Flow nodes
  TYPE              ID                NAME              LIVE      DETAIL
  startEvent        StartEvent_1      order received              1 field(s)
  userTask          Activity_11j96l5  check stock       [3 here]  assignee=ops 2 field(s)
  serviceTask       Activity_0dfmi5x  charge card                 async:before addon=payments/charge#98
  exclusiveGateway  Gateway_1jk90v6   paid?

Sequence flows
  FROM              TO                LABEL  CONDITION
  Gateway_1jk90v6   Event_0ufajup     yes    ${paid == true}
  Gateway_1jk90v6   Activity_retry    no     ${paid == false}
```

**Find the bugs before an instance does.** `lint` checks a model statically. It takes a
deployed key or a local file, so the usual loop is to check while editing and only then
deploy:

```bash
camunda lint ./order-process.bpmn     # no engine and no login needed
camunda lint order-process            # or the deployed version
```

Every rule exists because that failure was reproduced against a real engine first:

| Rule | What it catches |
|---|---|
| `uncovered-value` | `> N` and `< N` branches that leave `== N` with nowhere to go (`ENGINE-02004`) |
| `no-default-flow` | Every branch conditional, no default: any instance where they all fail stops dead |
| `variable-name-mismatch` | A condition reads `foo` while the form writes `foo_2`, so the expression throws |
| `unwritten-variable` | A direct `${x}` read where nothing sets `x`; throws instead of yielding null |
| `initiator-expression` | `${initiator}`, which exists only when started through AlurKerja's API |
| `no-op-service-task` | A service task with no implementation behind it |
| `addon-without-config` | An integration call with no config bound |
| `unreachable`, `dead-end`, `dangling-flow` | Structural mistakes |

`deploy` runs the same checks and refuses to push a model with blocking issues, unless you
pass `--skip-lint`.

**Work out why an instance is stuck.** `diagnose` gathers what is scattered across several
endpoints and unpacks it:

```bash
camunda diagnose 3426894
```

```
Stopped at
    Activity_CekSisaKuota  transition  Check Remaining Quota

1 problem(s)

  open incident at 2026-08-13 08:19:33
  failing element: Activity_TinjauPengajuan
  job attached to:  Activity_CekSisaKuota  (the async marker sits here, the error came from
                    the element above)
  Unknown property used in expression: ${initiator}. Cause: Cannot resolve identifier 'initiator'
```

It reads more than `/incident`, because several real failures are invisible there. A step
that fails inside the caller's transaction leaves no incident and no job behind at all; an
incident points at the activity holding the job, which is often not the activity that
failed; and a resolved incident disappears from `/incident` entirely.

It also unpacks nested integration errors. An addon failure arrives as a REST message
wrapping a Java exception wrapping a JSON body whose `output` field is itself JSON. The
sentence you need is at the bottom, so that is what gets printed first.

## Commands

```
Session      login  logout  whoami
Models       definitions  inspect  lint  xml  stats
Instances    instances  instance  start  cancel  vars  set-var
Diagnosis    diagnose  trace  incidents  jobs  stacktrace
Tasks        tasks  task  complete  claim
Deployment   deployments  deploy  undeploy
Events       message  subscriptions
Repair       retry  run-job
Identity     users  groups  tenants
```

`camunda <command> --help` for the options on any of them.

## Notes that save time

**Tenants.** On a shared engine the same process key exists under many tenants, and the
engine's key-based endpoints answer *"no matching process definition ... and no tenant-id"*,
which reads like the process is missing when it is not. Every command taking a key accepts
`--tenant`, and an ambiguous key lists the candidates rather than guessing.

**`start` and `complete` report what happened next.** A start returning HTTP 200 only means
the engine accepted it; anything marked async runs after the response. Both commands wait a
moment, then say whether it failed, whether the instance finished, or which task is now
waiting, along with the exact command to complete it:

```
$ camunda start order-process --var amount=700:Integer
Started order-process v9 as instance 3435051

Now waiting at:
    3435058  check stock  ops
camunda complete 3435058 --var quantity=<value>

$ camunda complete 3435058 --var quantity=3
Task 3435058 completed.
Instance 3435051 finished in 8.0s.
```

`--no-wait` skips the follow-up.

**Cleaning up after a test run.** `cancel --key <key>` terminates every running instance of
a process in one go, which matters because testing a model leaves a trail of them behind.

**Variable types matter.** `--var n=300` sends a string, and `"300" > 200` is a string
comparison. Use `--var n=300:Integer` where a gateway compares numerically, or `name:=<json>`
for structured values.

**Transient 401s are retried.** A load-balanced engine will intermittently reject a valid
credential while a replica is unhealthy: five consecutive 401s followed by five 200s, same
credential, seconds apart, is a real pattern observed in production. Requests are retried so
this does not get misread as a wrong password. A 4xx carrying a real Camunda error body is
never retried.

**Output is meant to be piped.** No box-drawing characters, and no colour unless stdout is a
terminal. Every command takes `--json` for the raw API payload.

## Requirements

- Node.js 18+
- A Camunda 7 engine with its REST API enabled

## Not covered

DMN evaluation, batch operations, instance migration and modification, and authorization
management. These are deliberate omissions rather than oversights: the command surface here
covers what came up repeatedly while developing and debugging processes, not all 300-odd
REST endpoints. Pull requests welcome.

## License

MIT
