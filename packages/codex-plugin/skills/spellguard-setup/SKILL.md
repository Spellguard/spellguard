---
name: spellguard-setup
description: Bootstrap a Spellguard-issued GitHub credential. Use when the user runs @spellguard-setup, asks to set up Spellguard in Codex, or needs to authorize the plugin's GitHub access for the first time on this machine.
---

# Spellguard Setup (Codex)

This skill bootstraps a Spellguard credential for the current Codex
session. It opens a WebSocket to the Spellguard broker, surfaces a
setup URL the user follows in their browser, and waits for the broker
to push a scoped GitHub token back to the plugin.

## How to invoke

Run the wrapper with the Bash tool:

```bash
"$(dirname "$(realpath "$0")")/../bin/skill-spellguard-setup"
```

Or — equivalently and more reliably from inside a Codex session — ask
the assistant to run the bundled script:

```bash
bash "$CODEX_PLUGIN_DIR/bin/skill-spellguard-setup"
```

`$CODEX_PLUGIN_DIR` is set by the Codex hooks runtime when this skill
is launched from a hook context. When the user invokes the skill
directly (via `@spellguard-setup`), the wrapper resolves its own
location through `$0` and works without any environment variable.

The wrapper writes interactive prompts and the URL to stderr; it
returns a JSON summary on stdout when complete.

## What it does

1. Generates a fresh nonce.
2. Calls the broker to mint a channel token tied to that nonce.
3. Prints a setup URL containing the nonce — the user opens it in a
   browser and completes the agent authorization there.
4. The broker pushes the agent identity (id + secret) back via WebSocket;
   the wrapper writes it into `~/.config/spellguard/config.json`
   (mode 0600).
5. The wrapper starts the persistent credential daemon (it does NOT wait
   for the next session start — see the incident note below).
6. The wrapper waits up to 5 minutes for the user to complete the
   dashboard "Connect GitHub" step; the daemon writes the delivered
   GitHub credential into the config. Timing out here is safe — the
   daemon keeps listening and the credential lands whenever the dashboard
   step completes.

The JSON summary reports what happened, e.g.
`{"ok":true,"daemon":"spawned","githubCredential":"delivered"}`.
`githubCredential:"pending"` is NOT an error — it means the dashboard
GitHub connect hasn't completed yet. The wrapper can legitimately run
for ~15 minutes (10 for browser approval + 5 for the GitHub connect),
so prefer running it in the background and relay the setup URL to the
user as soon as it appears in the output.

## When the user says "run @spellguard-setup"

Just execute the wrapper and surface its output. Don't try to
reimplement the flow in the conversation — the wrapper is the source
of truth.

## After successful setup

Tell the user to restart their Codex session so the session-start hook
finishes the git-credential wiring for their session (the credential
itself is already on disk).

## Incident note (why the daemon spawn lives here)

Session-start hooks do not run between a mid-session plugin install and
the next session boundary, so setup must leave a daemon running or the
pushed GitHub credential has no consumer (2026-06-11 incident).
