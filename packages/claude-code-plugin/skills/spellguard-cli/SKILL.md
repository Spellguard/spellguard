---
name: spellguard-cli
description: Use when an agent needs to inspect, script, or operate the Spellguard CLI for auth, managed agents, provisioning, setup, diagnostics, operations, connection, or JSON/YAML/table output contracts.
---

# Spellguard CLI

Use the installed `spellguard` CLI as the source of truth for Spellguard account state, managed coding agents, setup, and diagnostics. Prefer `spellguard schema` when scripting because it exposes auth, prompt, mutation, destructive, arguments, flags, environment, output, and result-field metadata.

## Command Map

| Need | Command family | Reference |
| --- | --- | --- |
| Current user, login state, profiles, config resolution | `whoami`, `login`, `logout`, `profile`, `config` | [identity.md](references/identity.md) |
| Managed agent inventory and per-framework login state | `agents`, `agents login` | [agents.md](references/agents.md) |
| SSH/connect readiness and connection next steps | `connect` | [connect.md](references/connect.md) |
| Create or terminate managed coding agents | `provision`, `deprovision` | [provision.md](references/provision.md) |
| Wait for async work | `operations wait` | [operations.md](references/operations.md) |
| Install or repair Claude Code/Codex plugin wiring | `setup`, `reset` | [setup.md](references/setup.md) |
| Health, version, schema, updates | `doctor`, `version`, `schema`, `update` | [diagnostics.md](references/diagnostics.md) |
| **Any other domain command** (credentials, policies, orgs, members, byok, providers, spend-limits, visibility, activity, audit, integrations, …) — the full curated surface (~250 commands) | *see the index* | [index.md](references/index.md) |
| Any management-API operation with no dedicated command anywhere (uncurated raw passthrough) — prefer a curated command when one exists | `api` | [api.md](references/api.md) |

The rows above are the human-facing shortcuts; **[index.md](references/index.md) lists EVERY curated command family** (the wide agent surface is hidden from `--help` but fully available). If no shortcut row fits, consult the index BEFORE reaching for `api`. Prefer a curated command whenever one covers your task: only those carry field projection, typed remediation, `--skeleton`, and `next_steps`. Reach for `api` only for an operation with no curated command in the index (the ~47 known gaps) — or run `spellguard schema` for the exhaustive catalog. Mutating methods (`POST`/`PUT`/`PATCH`/`DELETE`) require `--yes`; `GET`/`HEAD` never do. The server — not the CLI — enforces permissions on the target operation.

## Common Invocations

Use machine output for automation:

```bash
spellguard whoami --format json
spellguard agents --format json
spellguard agents --fields framework,provider,region --format json
spellguard connect my-agent --format json
spellguard operations wait op_123 --format json
spellguard schema agents --compact
```

Use `--non-interactive` in scripts when a prompt would be wrong. Use `--yes` only when the user has already confirmed a destructive action.

**Request bodies: write to a temp file, pass the path.** `--input` takes a *file path*, or `-` to read stdin — never inline JSON (an inline `--input '{"k":"v"}'` is opened as a filename and fails with `body_unreadable`). Writing the body to a temp file avoids shell-quoting failures entirely; `--skeleton` prints a starter body to fill in.

```bash
spellguard agents create --skeleton > /tmp/body.json   # starter body
# edit /tmp/body.json
spellguard agents create --input /tmp/body.json --yes --format json

printf '%s' '{"nonce":"abc"}' | spellguard github app complete-install --input -   # or pipe via -
```

## Output Contract

JSON/YAML success output uses an envelope with `data`, `page`, `request_id`, and `warnings`. Errors use `error.code`, `error.message`, `error.remediation`, and `error.request_id` on stderr. List commands may include `page.truncated`; if true, treat the list as partial.

Semantic exit codes are stable and add-only: `0` ok, `1` general, `2` usage, `3` authn, `4` authz, `5` not-found, `6` conflict, `7` network, `8` timeout, `9` confirmation-required (a machine-mode mutation refused without `--yes`). Signal exits pass through as `128+N` such as Ctrl-C `130`.

For compact command metadata, run:

```bash
spellguard schema <command> --compact
```

For full command metadata with descriptions, omit `--compact`.

## Gotchas

- For local Codex GitHub authentication failures, follow the plugin's
  [daemon and authentication diagnostic procedure](references/codex-authentication.md)
  before setup, reset, credential reissue, or a personal-token fallback.
- `SPELLGUARD_TOKEN` takes precedence over stored login. If auth fails while that variable is set, replace or unset it before retrying.
- `agents` defaults to a stable minimal projection. Add optional fields with `--fields`; unknown field names are usage errors and list valid options.
- `connect` re-resolves detail before using display hostnames from `agents`; do not build SSH targets from list output alone.
- `deprovision` and `reset` are destructive. Confirm intent before adding `--yes`.
- `setup claude-code` and `setup codex` are the supported plugin setup paths. Do not edit agent settings files directly.
- Do not fetch an ad hoc CLI when the installed signed `spellguard` binary is available.
- Unknown commands or flags return `usage_error` with valid alternatives and remediation.
- Agent-mode detection is automatic in Claude Code/Codex environments. Force machine behavior with `--format json`; disable ambient agent mode only with `SPELLGUARD_NO_AGENT_MODE` when debugging.

## Reference Files

The files under `references/` are generated from `spellguard schema` by `pnpm run gen:cli-skill`. When command metadata matters, read only the reference family needed for the task.
