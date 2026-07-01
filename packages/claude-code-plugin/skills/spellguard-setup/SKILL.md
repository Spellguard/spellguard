---
name: spellguard-setup
description: Bootstrap a Spellguard-issued GitHub credential. Use when the user runs /spellguard-setup, asks to set up Spellguard, or needs to authorize the plugin's GitHub access for the first time on this machine.
---

# Spellguard Setup

This skill bootstraps a Spellguard credential for the current Claude Code
session. It opens a WebSocket to the Spellguard broker, surfaces a setup
URL the user follows in their browser, starts the persistent credential
daemon, and waits (bounded) for the broker to push a scoped GitHub token
back to the plugin.

## How to invoke

Run the wrapper with the BashTool:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/skill-spellguard-setup
```

The wrapper writes interactive prompts and the URL to stderr; it returns
a JSON summary on stdout when complete. It can legitimately run for
~15 minutes (up to 10 waiting for the browser approval, then up to 5
waiting for the dashboard GitHub connect), so prefer running it in the
background and relay the setup URL to the user as soon as it appears in
the output.

## What it does

1. Generates a fresh nonce.
2. Calls the broker to mint a channel token tied to that nonce.
3. Prints a setup URL containing the nonce — the user opens it in a
   browser and completes the agent authorization there.
4. The broker pushes the agent identity (id + secret) back via WebSocket;
   the wrapper writes it into `~/.config/spellguard/config.json`.
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
GitHub connect hasn't completed yet.

Git-credential protection for the CURRENT session still finishes wiring
at the next session start (restart or /clear) — the env-file injection is
performed by the SessionStart hook.

## When the user says "run /spellguard-setup"

Just execute the wrapper and surface its output. Don't try to reimplement
the flow in the conversation — the wrapper is the source of truth.

## When a credential already exists

The wrapper runs non-interactively under the skill, so it cannot show its
menu. If it reports an existing identity, ASK THE USER which action they
want, then re-run the wrapper with the matching flag:

- `--choice print` — show the current identity (default behavior)
- `--choice additional` — provision an additional agent (replaces the
  credential stored on this machine; the server keeps the existing agent)
- `--choice reauthorize` — re-authorize this machine (re-binds the same
  agent identity; only the secret rotates)
- `/spellguard-reset` — disconnect this machine: deregister server-side
  (tolerates an already-deleted agent), stop the local credential daemon,
  and delete the stored credential. Use before a from-scratch test.

If the wrapper reports the agent is "no longer recognized by the server",
it has already fallen through to fresh setup — just surface the new URL.

## Incident note (why the daemon spawn lives here)

SessionStart hooks fire only on startup/resume/clear/compact — never on
`/reload-plugins` — so on a fresh mid-session install nothing else can
start the daemon before the user's next session. Setup must leave one
running or the pushed GitHub credential has no consumer (2026-06-11
incident).
