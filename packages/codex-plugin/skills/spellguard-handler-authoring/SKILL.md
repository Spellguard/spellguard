---
name: spellguard-handler-authoring
description: "Write, debug, or repair a Spellguard task handler — the single executable a managed box runs for a task type. Use when asked to 'write a handler', 'add a task type', 'make my agent do X when Y happens', 'why did my handler fail', 'my task timed out', 'the handler isn't running', 'inspect the handlers on this box', 'restore a handler', or when editing anything under ~/.config/spellguard/handlers. Teaches the handler ABI (stdin envelope, the three environment variables, the result-file contract, exit semantics), the heartbeat obligation that keeps a long task alive, how to report progress and completion without credentials, and how to read handler inventory and divergence states."
---

# Writing a Spellguard task handler

A handler is **one executable file** at `~/.config/spellguard/handlers/<task-type>`
on a managed box. Spellguard runs it when a task of that type is routed to the
agent. That is the entire integration surface: there is no SDK, no library to
import, and nothing to register.

Read the shipped `issue_label` handler first — it is written to be read, and it
documents this contract in place.

## The contract

**The daemon executes your file directly** (`argv = [path]`), so the **shebang
picks the language**. Python via `uv run`, a bash script, a compiled Go binary —
anything the box can execute. Shipped handlers are single-file Python with
pinned PEP 723 dependencies; nothing in the platform requires that.

**stdin** is one UTF-8 JSON object with exactly two members:

```json
{"event": {…}, "config": {…}}
```

The split is provenance, not taste, and getting it backwards is the most common
authoring mistake:

- **`event` is PER-DISPATCH** — what happened, resolved server-side and
  delivered on this dispatch: `taskId`, `taskType`, `origin` (`send` or
  `webhook`), `sender` (`kind` + a stable platform `identity`, never a display
  name), `input` (the caller's document verbatim, or the normalized provider
  payload), `framework`, and optionally `prompt`, `disposition`, `provider`,
  `delivery_id`.
- **`config` is AGENT-WIDE** — how this box is set up: `workingDir`,
  `agentName`, `repos` (`{"<owner/repo>": {"workingDir", "seedGlobs"}}`), and
  `filters` (your routing row's filters, forwarded verbatim; the platform does
  not interpret them for a custom type — matching is by task type alone).

A handler that needs no configuration simply ignores `config`.

**Environment.** Exactly three variables are guaranteed:
`SPELLGUARD_TASK_ID`, `SPELLGUARD_TASK_TYPE`, `SPELLGUARD_RESULT_FILE`.

**There is deliberately no credential in your environment.** Handlers never
receive tokens. If your work needs to talk to Spellguard, run the `spellguard`
CLI: on a managed box it authenticates over a local peer-credentialed socket
with no token at all.

**The result file.** Write JSON to `$SPELLGUARD_RESULT_FILE` to attach output:

| You write | You get |
|---|---|
| `{"result": {...}}` | stored verbatim as the result |
| `{"note": "hi"}` | no `result` key, so the whole object IS the result |
| `{"result": {...}, "note": "hi"}` | `result` wins; unknown siblings move to **diagnostics** — never merged |
| `{"artifacts": [...]}` | typed outputs attached to the task |
| `{"deferred": true}` | exit 0 but stay `WORKING` — something you spawned finishes it later |
| `{"review": {...}}` | the publish seam's slot — interpreted **only** for a task type the daemon publishes for (today `pr_review`); anywhere else it is an ordinary unknown key |

The two-case unknown-key rule is frozen ABI. There is no third case that merges
unknown keys into a present `result`: that created a silent collision with no
defined winner.

**Keep the file under 1 MiB.** Past that the daemon discards the object
ENTIRELY — you get a `result_too_large` diagnostic and *no* result, so a handler
that exits 0 with an oversized file reports `COMPLETED` with nothing attached.
Bound anything you generate from a model's output rather than hoping; the
shipped `pr_review` bounds its review fields for exactly this reason.

**Exit status is the lifecycle signal.** `0` → `COMPLETED`, nonzero → `FAILED`
with the exit code and a bounded tail (8 KiB) of your combined output recorded
as diagnostics. Three qualifications: a task that already reached a terminal
state reconciles as a no-op (first terminal report wins); `deferred: true` with
exit 0 leaves the task `WORKING`; and a deferral is honoured **only on a clean
exit** — a handler that already blew its inactivity timeout and only then exits
0 with `deferred: true` still fails, because deferral must never buy a second
timeout window.

**Say WHY you failed, or the platform can only say that you did.** A nonzero
exit alone reports the generic `handler_nonzero_exit`. Write
`{"result": {"reason": "<code>", "detail": "<one line>"}}` before you exit and
the daemon lifts it onto the terminal report as `<code>: <detail>` — the string
the server's author-facing failure copy is chosen from. The code must match
`^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$`; free text is ignored and you keep the
generic reason. The equivalent on the reporting CLI is a `reason` member on the
completion body, which additionally records that a HANDLER named the failure —
something the result file cannot assert, because the daemon shares that slot
with its own dispatch rejections:

```sh
printf '{"state":"FAILED","reason":"%s"}' 'invalid_result: no verdict in pane output' |
  spellguard tasks complete "$SPELLGUARD_TASK_ID" --input -
```

**The same code shape applies on that body, not just in the result file.** Both
slots take `<code>` or `<code>: <detail>`, and both refuse a leading segment that
is not a code — `"reason": "rate limited by upstream, see log"` is ignored on
either path and you keep the generic reason. When it is refused you get a typed
`malformed_reason` diagnostic on the task naming exactly what you wrote, so put
the prose after the colon: `"reason": "rate_limited: upstream returned 429"`.
(`tasks complete` is BODY-ONLY. `--input <file|->` and `--skeleton` are its
whole flag surface — there is no `--reason` or `--artifact` flag.)

**`reason` is a RESERVED member of `result`.** It is lifted whenever your result
file has a `result` slot, and reported as the failure reason if you then exit
nonzero. Do not use `reason` as a domain field (an `issue_triage` verdict, a
classification label) — name that key something else, or a later crash reports
your verdict as the failure cause.

**Some codes are the platform's to say, not yours.** A reason naming the
daemon's own vocabulary — `daemon_restart`, `tmux_missing`,
`framework_not_installed`, `handler_not_installed`, `config_revision_stale`, a
route rejection like `routing_not_configured` — is refused, recorded as a
`reason_not_claimable` diagnostic, and your failure keeps the generic reason.
Its copy blames Spellguard on a public PR and sends the operator to the wrong
fix. Codes that describe YOUR work are yours to claim: `invalid_result`,
`workspace_failed`, `publish_failed`, `no_credential_for_owner`, `pr_closed`,
`stale_head` — or any code of your own. `timeout` is claimable too: the box uses
it for its own inactivity kill, but a handler enforcing a cap of its own (the
shipped `pr_review` caps one review at 15 minutes) is the more common producer,
and both render the same way to the PR author.

Nor are the platform's BOOKKEEPING codes yours — `report_normalized`,
`result_unreadable`, `unknown_artifact_keys`, `diagnostic_budget_exceeded`,
`malformed_json` and the rest. Those are the platform's record of what it did to
your report, not a cause; claiming one renders as a claim rather than as its
copy, because "the box could not read the handler's result file" is false when
what actually happened is that you said so.

## When the daemon publishes for you (the publish seam)

Some task types have a daemon-side **publish seam**: the daemon owns a
credentialed write that finishes the job, and your handler hands it a payload
instead of doing the write itself. Today that is `pr_review` — the daemon posts
the `review` slot to GitHub with the box's own credential, which is precisely
why the handler never needs a token.

Three consequences, in the order they bite:

- **The seam runs BEFORE the terminal report**, so the reported state is the
  composite of your exit status *and* the publish outcome. A clean exit can
  still surface as `FAILED` with a typed publish reason
  (`no_credential_for_owner`, `pr_closed`, `stale_head`, `publish_failed`).
- **`review` is interpreted only for a seam-bearing type.** Write it from any
  other handler and it is an ordinary unknown key, routed by the two-case rule
  above — never published, never silently dropped.
- **Deferral forfeits the seam.** A deferred handler emits no terminal report,
  so there is no report for the seam to precede and the slot is never
  published. The daemon records a typed diagnostic saying so rather than
  letting it vanish. A deferred task that must publish has to publish itself
  and report the artifact via `tasks complete`.

## What "no credential" actually promises — and what it does not

Read this before you route a task type whose content comes from outside your
team. It is the one place the platform's guarantee is narrower than it sounds.

**The guarantee is about your ENVIRONMENT, and only that.** No token is placed
in the handler's environment variables, and the machine-checked contract field
below (`credentialsInEnvironment: false`) says exactly that much. It is not a
filesystem claim. Your handler runs as the box's own user with `HOME`
inherited, so everything that user can already read — the framework's on-disk
model auth, the git credential helper, `~/.config`, the workspace — is
reachable from inside the handler and from anything it spawns.

**That matters most for the two reference handlers that seed a coding agent.**
`dispatch` opens a Claude Code / Codex session, and `pr_review` drives one
hands-off; both run the agent with its guardrails deliberately down
(`--sandbox danger-full-access`, bypass mode), because the whole point is an
agent that can do real work on the box. The seed content is not always yours:
an issue title and body routed as `issue_label`, or a pull request head under
review, are written by whoever opened them. A prompt-injection payload in that
content is executing against a full-access agent with your on-disk credentials
within reach. Nothing detects that for you.

**This is the documented trust model, not an oversight.** A routing row is the
box's opt-in: nothing is dispatched to an agent until its owner adds one, and
the owner is the one who decides which repos, labels and senders can reach
their own box. Trust is placed in the BOX, and execution — not rendering — is
what that trust governs.

So if you are authoring for a hostile-ish source, treat it as one:

- Prefer a handler that does the work itself over one that hands an unbounded
  prompt to a full-access agent. A narrow handler is a narrow blast radius.
- Give the task its own `HOME` (a per-task directory, seeded with only what the
  work needs) so the session cannot read the box's model auth or git
  credentials at all. You pay for it in re-authorization.
- Failing that, tighten the file permissions on the model-auth files and the
  git credential helper so a session running as another user cannot read them.
- Keep the *content* of an untrusted event out of the instruction position of
  the prompt where you can — quote it as data the agent is asked to examine.
- Route untrusted sources to a box you are willing to lose, not the one holding
  your production credentials.

## The one rule that silently kills long handlers

**A task fails after 30 minutes with no progress report.** Exactly two things
reset that clock: a `spellguard tasks update`, and declaring `deferred: true`
(which restarts the window once, at the deferral). Nothing else — not a
`tasks message`, not your process merely being alive, not the daemon's own
keepalive (that only stops the *watchdog* firing first).

So if your handler runs long, or waits for a human to answer a question:

```sh
printf '{"text":"still analysing 40/120 files"}' |
  spellguard tasks update "$SPELLGUARD_TASK_ID" --input -
```

Call it periodically. It is also how a human sees what you are doing.

**Every `tasks` mutation takes its body on `--input`** — a file path, or `-` for
stdin. There are no per-field flags; `spellguard tasks <verb> --skeleton` prints
a starter body for the verb you are about to call.

**From the box, and only from the box.** The reset happens because the CLI on a
managed box routes `tasks update` over the daemon's local task-IPC socket. With
no such socket the same command goes to the REST API instead: it resets the
server's watchdog, but never reaches the recipient's daemon. You cannot nurse a
supervised handler along from your laptop.

**A handler that asks a question and blocks without heartbeating will be killed
at the timeout**, and the failure will say a question was pending and
unanswered. If your work is genuinely carried on by something else — a session
you spawned — use `deferred: true` and exit instead of blocking; supervision
still applies, but nothing needs to heartbeat.

## Reporting

```sh
# resets the inactivity clock
printf '{"text":"progress"}' |
  spellguard tasks update   "$SPELLGUARD_TASK_ID" --input -
# routes to the originator (does NOT reset the clock)
# `uuidgen` is NOT installed on a managed box; these two always are.
printf '{"messageId":"%s","text":"a question"}' "$(cat /proc/sys/kernel/random/uuid)" |
  spellguard tasks message  "$SPELLGUARD_TASK_ID" --input -
# explicit terminal
printf '{"state":"COMPLETED"}' |
  spellguard tasks complete "$SPELLGUARD_TASK_ID" --input -
```

None of these need a credential.

## Inspecting and repairing handlers on a box

```sh
spellguard handlers inspect              # this box's files: state, hashes, repair action
spellguard handlers restore <task-type>  # rewrite from the shipped reference
```

`inspect` reports one of five states per task type:

- `current` — matches the shipped reference.
- `example_scaffold` — matches the shipped reference, and that reference is a
  SCAFFOLD rather than a working implementation (`issue_label` today). It runs
  and reports, but it does not do the job you want yet — this state exists so an
  untouched example is never mistaken for a finished handler.
- `owner_modified` — you edited it. **Yours wins**; the shipped bytes sit beside
  it as `<task-type>.dist` so you can diff.
- `missing_deleted` — we ship it, this box does not have it. Restorable.
- `custom_no_reference` — a type you authored. Never overwritten, never
  restorable (there is nothing to restore from).

An update never clobbers your edit, and `restore` preserves your current file as
`<task-type>.local` first — so recovering is itself undoable.

Do not re-derive these states by comparing hashes yourself; `inspect` is the one
implementation.

## Designing a new handler

1. Add a routing row for the task type on the recipient agent (a routing row is
   the box's opt-in — without one nothing is dispatched).
2. Copy `issue_label` to `~/.config/spellguard/handlers/<your-type>` and make it
   executable (`chmod 0700`).
3. Run one real task and read the result. The scaffold echoes the event back, so
   your first task shows exactly what your handler received and which fields
   your routing row actually populated.
4. Replace the body with your work. Heartbeat if it runs long.
5. `spellguard handlers inspect` to confirm the box sees it.

## Contract data (machine-checked — do not hand-edit)

This block is compared against the shipped implementation by
`tests/unit/skills/handler-authoring-contract.test.ts` — every field against the
daemon, CLI and supervisor SOURCE, never against another copy of the same
literal. It spans the ABI (invocation, stdin members, the event/config
provenance split, environment, the result-file envelope and its two-case
unknown-key routing, exit and deferred semantics, the publish seam) and the
heartbeat obligation (the inactivity timeout, which verb resets its clock, and
which ones deliberately do not). If the platform changes, that test fails and
this block — and the prose above — must be updated together.

```json spellguard-handler-contract
{
  "handlerRoot": "~/.config/spellguard/handlers",
  "execStyleInvocationOnly": true,
  "stdinMembers": ["event", "config"],
  "eventFields": [
    "taskId",
    "taskType",
    "origin",
    "sender",
    "input",
    "framework",
    "prompt",
    "disposition",
    "provider",
    "delivery_id"
  ],
  "configFields": ["workingDir", "agentName", "repos", "filters"],
  "configRepoEntryFields": ["workingDir", "seedGlobs"],
  "envVars": [
    "SPELLGUARD_TASK_ID",
    "SPELLGUARD_TASK_TYPE",
    "SPELLGUARD_RESULT_FILE"
  ],
  "credentialsInEnvironment": false,
  "resultFileReservedKeys": ["result", "artifacts", "deferred", "review"],
  "maxResultFileBytes": 1048576,
  "unknownKeyRouting": {
    "resultPresent": "diagnostics",
    "resultAbsent": "result"
  },
  "outputTailBytes": 8192,
  "exitZeroState": "COMPLETED",
  "exitNonZeroState": "FAILED",
  "deferredState": "WORKING",
  "deferredRequiresCleanExit": true,
  "deferredForfeitsPublishSeam": true,
  "publishSeamTaskTypes": ["pr_review"],
  "publishSeamResultKey": "review",
  "publishSeamRunsBeforeTerminalReport": true,
  "inactivityTimeoutSeconds": 1800,
  "heartbeatCommand": "spellguard tasks update",
  "heartbeatIpcOperation": "task.update",
  "heartbeatRequiresBoxContext": true,
  "inactivityClockResetSources": ["spellguard tasks update", "deferred: true"],
  "keepaliveResetsInactivityClock": false,
  "nonResettingCommands": ["spellguard tasks message"],
  "reportingCommands": [
    "spellguard tasks update",
    "spellguard tasks message",
    "spellguard tasks complete"
  ],
  "referenceHandlers": ["issue_label", "dispatch", "pr_review"],
  "inventoryStates": [
    "current",
    "example_scaffold",
    "owner_modified",
    "missing_deleted",
    "custom_no_reference"
  ],
  "inventoryCommand": "spellguard handlers inspect",
  "restoreCommand": "spellguard handlers restore",
  "divergenceSidecarSuffix": ".dist",
  "restoreBackupSuffix": ".local"
}
```
