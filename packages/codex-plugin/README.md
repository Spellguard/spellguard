# @spellguard/codex-plugin

OpenAI Codex plugin for the Spellguard agent control plane. It runs inside
your Codex environment to enforce credential scope, detect git-mutating
operations, and emit observations to the Spellguard backend.

This plugin is the Codex counterpart of `@spellguard/claude-code-plugin` (the
Claude Code plugin); both speak the same agent-control protocol defined in
`docs/reference/credential-socket-protocol.md`.

## Prerequisites

- Codex CLI (≥ 0.40).
- Codex's plugin + hook system enabled. On current Codex (verified against
  `codex-cli 0.132.0`) the `plugins`, `hooks`, and `plugin_hooks` features are
  **stable and enabled by default** — installing the plugin is enough, no
  config change needed.

  Only if you're on an older build (or have explicitly disabled them) set them
  in `~/.codex/config.toml`:

  ```toml
  [features]
  plugins = true
  hooks = true        # legacy Codex builds called this `codex_hooks`
  ```

  Without the hook feature, the `SessionStart` / `PreToolUse` / `PostToolUse`
  hooks never fire and the plugin is inert.

  > **On the plugin-root variable:** `hooks/hooks.json` references the plugin
  > directory via `${CLAUDE_PLUGIN_ROOT}`. This is intentional and correct —
  > Codex sets `CLAUDE_PLUGIN_ROOT` (and `CLAUDE_PLUGIN_DATA`) for plugin
  > compatibility alongside its native `PLUGIN_ROOT`/`PLUGIN_DATA`, so the
  > hooks resolve and fire under Codex. (Source: Codex *Build plugins* docs.)

## Install or upgrade

Install through Codex's own plugin mechanism from the public repo
`Spellguard/spellguard`:

```bash
codex plugin marketplace add Spellguard/spellguard
codex plugin add spellguard@spellguard
```


To upgrade an existing install after a new plugin version lands on the
marketplace branch, refresh the marketplace snapshot, then reinstall the plugin
from that marketplace:

```bash
codex plugin marketplace upgrade spellguard
codex plugin add spellguard@spellguard
codex plugin list --json
```

`codex plugin list --json` should report `spellguard@spellguard` with the new
version. Start a new Codex session after reinstalling so Codex loads the updated
plugin hooks and skills.

When upgrading from `0.2.0` specifically, start one additional new Codex session
before testing `git` or `gh` operations. The first `0.2.1` `SessionStart` rewrites
`~/.codex/config.toml` from the old versioned git-helper path to Spellguard's
stable helper path; the following Codex process is the one that reads and uses
that rewritten `[shell_environment_policy]`.

## Setup

In a Codex session, invoke the setup skill:

```
@spellguard-setup
```

1. The skill prints a one-time setup URL and waits.
2. Open it in your browser and **log in to the Spellguard dashboard as
   yourself** so your activity is attributed to you.
3. Name your agent and pick the repos to grant — that set is the scope
   Spellguard manages credentials for and tracks activity on.
4. Complete the GitHub App install on those repos.
5. Setup leaves the credential daemon running, so the scoped GitHub token lands
   in `~/.config/spellguard/config.json` **automatically** the moment you finish
   the dashboard install. The git **and** `gh` credential helpers are wired via a
   Codex-scoped `[shell_environment_policy]` block in `~/.codex/config.toml`
   (never your machine-global `~/.gitconfig`), which Codex reads only at
   **startup** — so **restart your Codex session once** after setup for the
   helpers to take effect. After that one restart, token rotation is picked up by
   the next git/`gh` call with no further restarts.

## Configuration

The plugin requires the `SPELLGUARD_BASE_URL` environment variable — set it to
your Spellguard console URL before running `@spellguard-setup` (or pass `--base-url` to
the setup command). There is no built-in default:

```bash
export SPELLGUARD_BASE_URL=https://your-spellguard-console.example.com
# …then run @spellguard-setup.
```

| File | Purpose |
|---|---|
| `~/.config/spellguard/config.json` | Local credential + agent metadata (mode 0600) |
| `~/.config/spellguard/agents/<agentId>.pid` | Daemon PID file |
| `~/.config/spellguard/agents/<agentId>.log` | Daemon log file |
| `~/.config/spellguard/gh/<agentId>/hosts.yml` | Session `gh` CLI token (`GH_CONFIG_DIR` points here; daemon refreshes it on rotation) |
| `~/.codex/config.toml` | Codex-scoped `[shell_environment_policy]` block: `GIT_CONFIG_*`→helper + `GH_CONFIG_DIR`. **Your machine-global `~/.gitconfig` is never touched.** |

## What happens in a session

| Hook | Action |
|---|---|
| `SessionStart` | Validates the local credential, injects the git + `gh` credential helpers via the Codex-scoped `~/.codex/config.toml` `[shell_environment_policy]` block (takes effect on the next Codex start), spawns the persistent agent-control daemon. |
| `PreToolUse` (Bash) | On every `git push` / branch-create / `gh pr create`: probes the credential's revocation state and emits a Codex `permissionDecision: 'deny'` if revoked. Also emits a scope-filtered observation to the Spellguard backend. |
| `PostToolUse` (Bash) | On `git commit`: captures the new SHA + branch + message and emits a commit observation. |

The agent-control daemon runs detached and maintains a WebSocket to the
Spellguard broker. It receives push events for credential rotations,
revocations, and admin config updates without polling.

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

## When the dashboard terminates or revokes your agent

Terminating, disconnecting, or deleting the agent in the Spellguard dashboard
**propagates to this machine within seconds**: the persistent credential daemon
receives the revocation over its socket and marks the local credential revoked
(or does so on its next reconnect). After that:

- The next session's `SessionStart` surfaces a re-auth notice via Codex's
  `additionalContext` channel, so the model leads its first reply with
  *"Spellguard: this credential has been revoked. Run `@spellguard-setup` to
  provision a new one."*
- Any `git` operation that needs the token fails closed, and the Spellguard
  credential helper prints the same actionable line to stderr — so a manual
  `git push` tells you exactly why it stopped and what to run.

A related state — *"your agent is no longer recognized by the server (HTTP
401/404)"* — appears when the stored credential points at an agent the server
no longer knows (revoked, or the environment was reset). In every case the fix
is the same: run `@spellguard-setup` to reconnect. (A transient network/server
blip shows a *"couldn't verify … usually transient"* message instead and does
**not** require re-setup.)

## Resetting or removing this machine — `@spellguard-reset`

To tear down Spellguard on a machine yourself, run:

```
@spellguard-reset
```

It deregisters the agent server-side (soft-delete), stops the credential daemon,
and deletes the local credential file. The next session then reads as cleanly
**unconfigured** — run `@spellguard-setup` to provision fresh.

## Differences from `@spellguard/claude-code-plugin` (Claude Code)

| Feature | Claude Code | Codex |
|---|---|---|
| Manifest path | `.claude-plugin/plugin.json` | `.codex-plugin/plugin.json` |
| Hook registration | embedded in `plugin.json#hooks` | separate `hooks/hooks.json` file |
| Skill invocation | `/spellguard-setup` slash command | `@spellguard-setup` |
| Credential helper install | `CLAUDE_ENV_FILE` exports | `~/.codex/config.toml` `[shell_environment_policy]` block (one-time restart; never `~/.gitconfig`) |
| Block decision shape | `{decision: 'block', message}` | `{hookSpecificOutput: {hookEventName, permissionDecision: 'deny', permissionDecisionReason}}` |
| Framework value reported to plugin-sync | `framework: 'claude_code'` | `framework: 'codex'` |

The protocol module, the partysocket client, the credential daemon, and
every `lib/` utility is structurally identical between the two plugins.

## Reference

- Protocol: `docs/reference/credential-socket-protocol.md`
- Claude Code plugin (reference): `packages/claude-code-plugin/README.md`
- Codex plugin docs: <https://developers.openai.com/codex/plugins>
- Codex hooks docs: <https://developers.openai.com/codex/hooks>
