---
name: spellguard-reset
description: Disconnect this machine from Spellguard. Use when the user runs /spellguard-reset, wants a from-scratch setup test, or needs to cleanly tear down the agent on this machine (deregister server-side, stop the daemon, delete the local credential).
---

# Spellguard Reset

Cleanly disconnects this machine: deregisters the agent server-side
(tolerates an already-deleted agent), stops the local credential daemon,
and deletes the stored credential. Use before a from-scratch setup test,
or when this machine should no longer hold a Spellguard identity.

## How to invoke

Run the wrapper with the BashTool:

```bash
${CLAUDE_PLUGIN_ROOT}/bin/skill-spellguard-reset
```

It returns a JSON summary on stdout, e.g.
`{"ok":true,"deregistered":true,"stoppedDaemons":[12345]}`.

- `deregistered:false` is NOT an error — it means the server no longer
  knew the agent (e.g. it was already deleted in the dashboard) or was
  unreachable; local cleanup completed regardless.
- `reason:"no_config"` means there was nothing to reset.

## After reset

Run `/spellguard-setup` to reconnect the machine as a fresh agent.
