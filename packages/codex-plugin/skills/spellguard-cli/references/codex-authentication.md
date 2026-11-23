# Diagnose Codex daemon and authentication failures

Use this procedure for GitHub authentication failures in a Codex session. Keep
the installed plugin state intact until you identify whether the process, the
control-plane transport, or the credential is failing.

Do not run setup or reset during diagnosis. Do not request another credential
or configure a personal GitHub credential as a fallback.

## Inspect the installed process

1. Check the installed plugin version:

   ```bash
   codex plugin list --json
   ```

2. Read the daemon PID and inspect the operating system's process record. These
   commands print process metadata, not credentials.

   ```bash
   PID=$(cat ~/.config/spellguard/codex/agents/<agentId>.pid)
   ps -p "$PID" -o pid=,lstart=,command=
   cat ~/.config/spellguard/codex/agents/<agentId>.health.json
   ```

   The process arguments and the health record must name the same agent ID and
   config directory. A recent `heartbeatAt` proves that the daemon event loop is
   responding. It does not prove that the control-plane transport or provider
   credential works.

   `transportState: "error"` means that the daemon is alive but its
   control-plane connection is failing. Codex hooks compare `artifactId` with
   the daemon in the installed plugin.

   On Linux, an operating system advisory lock serializes automatic replacement.
   Spellguard verifies the `/proc` start time, arguments, and environment before
   it signals a process. On macOS, Spellguard records health, leaves a matching
   current daemon untouched, and starts a missing or dead daemon on a
   best-effort basis. Spellguard does not automatically replace a live obsolete
   or unhealthy daemon on macOS. Other platforms and ambiguous process records
   fail closed without signaling the process.

## Inspect credential state

Print expiry and renewal metadata without printing the token:

```bash
node -e 'const fs=require("fs");const p=process.env.HOME+"/.config/spellguard/codex/config.json";const c=JSON.parse(fs.readFileSync(p,"utf8"));console.log({agentId:c.agentId,expiresAt:c.expiresAt,revoked:c.revoked===true,renewalPending:c.githubReissue?.pending===true})'
```

The health record derives credential expiry from the active V5 generation,
then the keyed organization store, then legacy fields when neither exists.
An empty or unreadable V5 generation never falls back to a legacy token.
For multiple credentials, the report uses the earliest expiry. It does not
prove provider acceptance or renewal success. An expired credential and a
failed transport are separate conditions. Neither makes a responsive daemon
obsolete.

## Verify the consuming applications

Run both checks. They suppress credential output.

```bash
git -C /absolute/path/to/repo ls-remote --exit-code origin HEAD >/dev/null
GH_CONFIG_DIR=~/.config/spellguard/codex/gh/<agentId> gh api user --jq .login
```

If the process record, health record, and credential state disagree, retain the
daemon log and installed plugin version for diagnosis. Do not assume that the
credential is missing. Do not request reissue, run a host reset or setup, or
bypass Spellguard with a personal credential.
