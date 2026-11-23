# @spellguard/mcp-guard

A Spellguard policy guard for MCP servers. Your MCP host (a coding agent, Claude
Desktop, Cursor, Codex, and so on) talks to `mcp-guard` over stdio, and
`mcp-guard` talks to the real MCP server. For every tool call:

1. **The call is checked before it runs.** Its whole argument object goes to
   your Spellguard Verifier. The server only sees calls your policies allow.
2. **The result is checked before your agent reads it.** A result that carries
   a prompt injection, a secret or anything else your policies block is
   withheld.
3. **Only approved tools are listed.** If the agent has an approved-tools
   policy (an action allowlist), tools it doesn't name are hidden from the
   tool list, and calling one anyway is blocked.

Every decision appears in the agent's activity feed in the Spellguard console.

## Requirements

- Node.js 20 or later.
- A Spellguard agent: its ID (or UUID) and its agent secret. The secret is
  shown once when you create the agent; rotate it on the agent's Settings tab
  for a new one.
- Your Spellguard console address, for example `https://console.spellguard.ai`.
- A Spellguard server recent enough to send Verifier keys when the guard
  connects. The guard refuses to start against an older one, and says so.

The console's **Connections → Add connection** guide fills these in for you.

## Guard a local MCP server

Put the server's command after `--`:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@spellguard/mcp-guard",
        "--",
        "npx",
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/path/to/dir"
      ],
      "env": {
        "SPELLGUARD_BASE_URL": "https://console.spellguard.ai",
        "SPELLGUARD_AGENT_ID": "<agent-id>",
        "SPELLGUARD_AGENT_SECRET": "<agent-secret>"
      }
    }
  }
}
```

The server starts with only `PATH`, `HOME`, the user and shell names, locale,
time zone, proxy and CA settings from the environment. It never sees the
guard's own `SPELLGUARD_*` settings. If it needs its own credentials, put them
in `env` and name them with `--pass-env`:

```json
"args": [
  "-y", "@spellguard/mcp-guard",
  "--pass-env", "SLACK_BOT_TOKEN,SLACK_TEAM_ID",
  "--", "npx", "-y", "@modelcontextprotocol/server-slack"
],
"env": {
  "SPELLGUARD_BASE_URL": "https://console.spellguard.ai",
  "SPELLGUARD_AGENT_ID": "<agent-id>",
  "SPELLGUARD_AGENT_SECRET": "<agent-secret>",
  "SLACK_BOT_TOKEN": "xoxb-...",
  "SLACK_TEAM_ID": "T..."
}
```

## Guard a remote MCP server

```json
{
  "mcpServers": {
    "my-server": {
      "command": "npx",
      "args": [
        "-y",
        "@spellguard/mcp-guard",
        "--upstream",
        "https://your-mcp-server.example.com/mcp"
      ],
      "env": {
        "SPELLGUARD_BASE_URL": "https://console.spellguard.ai",
        "SPELLGUARD_AGENT_ID": "<agent-id>",
        "SPELLGUARD_AGENT_SECRET": "<agent-secret>",
        "SPELLGUARD_UPSTREAM_TOKEN": "<optional bearer token for the upstream>"
      }
    }
  }
}
```

The upstream is tried over Streamable HTTP first, then SSE.

## Options

| Flag | Environment variable | Meaning |
| --- | --- | --- |
| `--base-url <url>` | `SPELLGUARD_BASE_URL` | Required. Your Spellguard console address. A URL ending in `/v1` also works. |
|  | `SPELLGUARD_AGENT_ID` | Required. The agent this guard acts for: its ID or UUID. |
|  | `SPELLGUARD_AGENT_SECRET` | Required. That agent's secret. |
| `-- <command> [args...]` |  | Run and guard a local stdio MCP server. |
| `--upstream <url>` |  | Guard a remote MCP server. |
| `--upstream-token <token>` | `SPELLGUARD_UPSTREAM_TOKEN` | Bearer token sent to the upstream. |
| `--pass-env <NAME[,NAME]>` | `SPELLGUARD_PASS_ENV` | Environment variables the local server may see. Repeatable. |
| `--wrap "<command>"` |  | Older form of `-- <command>`. Split on spaces, so no spaces inside arguments. |
| `--workspace <name>` | `SPELLGUARD_WORKSPACE` | Workspace label recorded on the connection. |
| `--verifier-timeout <ms>` |  | Verifier request timeout. Default 5000. |
| `--fail-open` |  | Let calls through unscanned when the Verifier can't be reached. Also needs `SPELLGUARD_ALLOW_FAIL_OPEN=true`. Off by default. |
| `-h`, `--help` |  | Show usage. |
| `-v`, `--version` |  | Show the version. |

Use exactly one of `--`, `--wrap` and `--upstream`.

## What is blocked

The guard fails closed. A call is blocked, and a result withheld, when:

- your policies block it, or it needs a redaction (span rewriting isn't
  supported yet, so the content isn't forwarded);
- it's larger than 512 KiB, the most the guard sends for one check;
- the Verifier can't be reached, refuses the check, or answers with something
  that isn't a verdict (unless `--fail-open` covers the unreachable case);
- the answer isn't signed by a Verifier your Spellguard server attests. That is
  what something answering in the Verifier's place looks like, so `--fail-open`
  never covers it.

The agent sees an MCP error that names the policy. Image and audio content in
results carries no text and isn't checked. The guard proxies tools only; an
upstream's resources and prompts aren't exposed.

## Verified answers

The guard sends a fresh random nonce with every check. The Verifier signs its
answer, the nonce and its own id with its session key, and the guard acts on the
answer only when that signature matches a key Spellguard gave it. Spellguard
hands out the keys of the Verifiers it has attested when the guard connects and
each time the guard refreshes its token. A replayed answer fails the check
because its nonce is wrong.

A Verifier changes its session key once a day. When a signature matches none of
the keys the guard holds, the guard asks Spellguard for the current keys and
checks again before it blocks. It asks at most once every 10 seconds. A call made
in the few seconds before Spellguard has attested a Verifier's new key is
blocked.

## Lifecycle

If the guard can't authenticate with Spellguard at startup, it exits and the
MCP host shows the server as failed, with the reason on stderr. It exits, and
stops the server it started, when the host closes its connection, when it gets
SIGINT, SIGTERM or SIGHUP, or when the wrapped server exits. When its token
can't be refreshed (after the machine sleeps, say), it reconnects with the
agent secret.

## License

Apache-2.0
