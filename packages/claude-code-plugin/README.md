# @spellguard/claude-code-plugin

Spellguard's plugin for Claude Code. It tracks the git activity you do through
Claude Code (pushes, branch creates, PRs, commits), manages a Spellguard-issued,
repo-scoped git credential so your commits are attributable, and surfaces the
**deviation signal** when work is pushed *outside* Spellguard's credential. The
Codex equivalent is [`@spellguard/codex-plugin`](../codex-plugin/README.md); both
speak the same agent-control protocol.

## Prerequisites

- Claude Code (current version — uses the `/plugin` marketplace flow).
- `git` ≥ 2.31, with **HTTPS** GitHub remotes (the plugin refuses SSH remotes;
  run `git remote set-url origin https://github.com/<owner>/<repo>.git`, or see
  [Using SSH git remotes](#using-ssh-git-remotes)).

## Install

In Claude Code, run the two `/plugin` commands:

```
/plugin marketplace add Spellguard/spellguard
/plugin install spellguard@spellguard
```

- **Native module note:** finer commit↔edit *correlation* uses a native module
  (`better-sqlite3`) that isn't bundled into a marketplace install. When it's
  absent that one correlation is skipped (you'll see a single stderr note) —
  **all core tracking (pushes, branches, PRs, commits) and credential
  management work regardless.** For full fidelity, clone the repo and
  `pnpm install` before adding it as a local marketplace.

## Authenticate

In a Claude Code session:

```
/spellguard-setup
```

1. The skill prints a one-time setup URL and waits (up to 10 min).
2. Open it in your browser and **log in to the Spellguard dashboard as
   yourself**.
3. Name your agent and pick the repos to grant — this is the scope of repos
   Spellguard will manage credentials for and track activity on.
4. Complete the GitHub App install on those repos.
5. Setup leaves the credential daemon running, so the scoped GitHub token lands
   in `~/.config/spellguard/config.json` **automatically** the moment you finish
   the dashboard install — no session restart is needed for the credential to
   arrive. Git-credential protection for the session you ran setup in finishes
   wiring at the next session boundary (restart or `/clear`); any new session is
   fully wired from the start.

Config is written to `~/.config/spellguard/config.json` (mode 0600).

## Configuration

The plugin requires the `SPELLGUARD_BASE_URL` environment variable — set it to
your Spellguard console URL before running `/spellguard-setup` (or pass `--base-url` to
the setup command). There is no built-in default:

```bash
export SPELLGUARD_BASE_URL=https://your-spellguard-console.example.com
# …then run /spellguard-setup.
```

## What to expect once configured

| Hook | What it does |
|---|---|
| `SessionStart` | Validates your credential, injects the git credential helper (via `CLAUDE_ENV_FILE`) so in-scope `github.com` pushes use the Spellguard-issued scoped token, and spawns the background credential daemon. |
| `PreToolUse` (Bash) | On `git push` / branch-create / `gh pr create`: checks the credential isn't revoked, then emits a scope-filtered observation. |
| `PostToolUse` | On `git commit`: records the commit and emits a commit observation. |

Your activity shows up in the dashboard's **Activity** view, attributed to you.
Because in-scope commits route through the Spellguard credential, work pushed a
different way (your own credential, outside Claude Code) is flagged as a
**deviation** — that bypass visibility is the point of the platform.

## Scoping what's tracked

Only repos in your **granted scope** are observed — a personal repo you never
granted is never tracked. To narrow further (e.g. track only a subset, or add
explicit repos that are also in your granted scope), create
`~/.config/spellguard/observation.yaml`:

```yaml
allowlist:
  - owner: my-org
    repo: some-service
```

The allowlist only **narrows** the granted scope (intersection) — it can't add
repos your credential wasn't granted. With no file, all granted-scope repos are
tracked.

## When the dashboard terminates or revokes your agent

Terminating, disconnecting, or deleting the agent in the Spellguard dashboard
**propagates to this machine within seconds**: the running credential daemon
receives the revocation over its socket and marks the local credential revoked
(or does so on its next reconnect). After that:

- The next session's `SessionStart` surfaces a re-auth notice. Claude Code has
  no dedicated banner channel, so the hook relays it through the model, which
  leads its first reply with *"Spellguard: this credential has been revoked. Run
  `/spellguard-setup` to provision a new one."*
- Any `git` operation that needs the token fails closed, and the Spellguard
  credential helper prints the same actionable line to stderr (git surfaces
  helper stderr) — so a manual `git push` tells you exactly why it stopped and
  what to run.

A related state — *"your agent is no longer recognized by the server (HTTP
401/404)"* — appears when the stored credential points at an agent the server
no longer knows (revoked, or the environment was reset). In every case the fix
is the same: run `/spellguard-setup` to reconnect. (A transient network/server
blip shows a *"couldn't verify your credential … usually transient"* message
instead and does **not** require re-setup.) Re-authorizing re-binds the same
agent identity — only the secret rotates — so re-running setup never conflicts
with the agent's own name.

## Resetting or removing this machine — `/spellguard-reset`

To tear down Spellguard on a machine yourself, run:

```
/spellguard-reset
```

It deregisters the agent server-side (soft-delete), stops the credential daemon,
and deletes the local credential file. The next session then reads as cleanly
**unconfigured** — run `/spellguard-setup` to provision fresh. (Setup also probes
the stored identity server-side before offering its existing-credential menu, so
a stale local config never shows a menu for an agent that's already gone.)

## Using SSH git remotes

The plugin injects an **HTTPS** credential (a scoped token), so your git
operations must transport over HTTPS — it refuses raw SSH remotes
(`git@github.com:…`). You don't have to abandon your SSH keys. Add a one-time,
**org-scoped** URL rewrite so only your work org goes over HTTPS, leaving
personal SSH untouched:

```bash
git config --global url."https://github.com/<org>/".insteadOf "git@github.com:<org>/"
```

Git then transports those repos over HTTPS (so `git remote -v` shows the HTTPS
URL and the plugin's SSH check passes) and the Spellguard credential helper
serves the scoped token. Alternatives: rewrite all of github.com
(`url."https://github.com/".insteadOf "git@github.com:"` — also affects personal
repos), or switch a single repo with
`git remote set-url origin https://github.com/<owner>/<repo>.git`.

## Troubleshooting

- **"Spellguard requires HTTPS git remotes"** — switch your remote with
  `git remote set-url origin https://github.com/<owner>/<repo>.git`.
- **"CLAUDE_ENV_FILE not set"** — your Claude Code version didn't provide the
  per-session env file; update Claude Code.
- **"GitHub not yet connected"** — bootstrap completed but you haven't finished
  the dashboard GitHub App install; complete it and the daemon picks up the
  token automatically.

---

## Reference

| Export | Description |
|--------|-------------|
| `runSpellguardSetup` | `/spellguard-setup` skill — nonce bootstrap over the agent-control socket, writes config |
| `runSessionStart` | SessionStart hook — validates the credential, injects the git credential helper, spawns the daemon |
| `runPreToolUse` | PreToolUse — status-check probe (block on revoked/401/410) then scope-filtered observation |
| `observeGitOperation` | Core pipeline: canonicalize remote → scope check → build event → emit/queue |
| `detectGitOperation` | Stateless helper mapping `(toolName, args[])` → `'push' \| 'branch_create' \| 'pr_open' \| null` |

### GitHub App permissions

The required permission set lives in `src/lib/github-app-permissions.ts` as
`GITHUB_APP_REQUIRED_PERMISSIONS`: `contents` write, `pull_requests` write,
`issues` write, `metadata` read, `members` read, `administration` read. **This
constant is metadata only** — the App's effective permissions live at github.com
and must be updated there to match.
