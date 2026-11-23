# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
once it reaches `1.0.0`. Pre-`1.0.0` releases may contain breaking changes
in any minor version bump — see the release notes for details.

## [0.3.1] - 2026-11-23

### Fixed

- **`spellguard-client` (Python)** — on a host that booted less than a minute
  earlier, a delivery signed by a rotated Verifier key was refused
  (`401`, `unknown_key`) instead of making the client re-attest the Verifier
  once. The once-a-minute throttle started at 0, and `time.monotonic()` counts
  from boot on Linux. The first re-attestation now always runs. The TypeScript
  client was not affected.

## [0.3.0] - 2026-11-23

In this release **`@spellguard/mcp-guard`** (version 0.2.0 on npm) checks that
each Verifier answer is genuine before acting on it. Before, anything that
could answer at the guard's Verifier URL could allow a tool call. This is a
breaking change: the guard needs a Spellguard server that sends Verifier keys.
The `audit-verify` docs now call the program that checks an audit export "the
audit checker", so it can't be confused with the Verifier, and its README
explains a check with two diagrams. See
[Migrating from 0.2.0](#migrating-from-020) at the end of this section.

### Security

- **`@spellguard/mcp-guard`** — **BREAKING:** the guard acts on a Verifier
  answer only when a Verifier your Spellguard server attests signed it, for the
  fresh nonce the guard sent with that request. Before, anything that could
  answer at the guard's Verifier URL (a rogue endpoint, a compromised hop, a DNS
  or proxy mistake) could allow a call. Each `/v1/mcp/evaluate` and
  `/v1/mcp/tools` request now carries `X-Spellguard-Verdict-Nonce`, and the
  guard checks the answer's `X-Spellguard-Verdict-Signature` (Ed25519 over the
  verifier id, the nonce, the time and the SHA-256 of the exact body) against
  the keys Spellguard handed it. An unsigned or wrongly signed answer blocks the
  call as `unverified-verdict`, even with `--fail-open`. An unverified
  approved-tools list shows every tool, and each call is still checked. When a
  signature matches no key the guard holds, it asks Spellguard for the current
  keys (at most once every 10 seconds) and checks again before blocking, so a
  Verifier's daily key rotation doesn't interrupt it. The guard refuses to
  start against a Spellguard server that sends no Verifier keys, and says why.

### Changed

- **Management API** — proxy-connect and its token refresh return
  `verifierKeys`: the verifier id and attested session key of every Verifier
  that management currently attests (`AttestedVerifierKey` on
  `ProxyConnectResponse` and `ProxyConnectRefreshResponse` in
  `@spellguard/management-api-types`).
- **`@spellguard/audit-verify`** — the docs call the program that checks an
  export against its checkpoints "the audit checker". "Verifier" now means only
  the Spellguard service that enforces policy and signs the records being
  checked. `README.md` gains "How a check works": two diagrams
  (`docs/inputs-and-output.svg`, `docs/one-record.svg`), the six checks in
  order, and what each record status means. `SPEC.md` defines both terms. One
  finding message changes in the Go and TypeScript implementations: "…but no
  checkpoint the audit checker read does." The package path, the
  `spellguard-audit-verify` command and every identifier are unchanged.

### Migrating from 0.2.0

1. **mcp-guard.** Upgrade to `@spellguard/mcp-guard` 0.2.0 only against a
   Spellguard server that returns `verifierKeys` from proxy-connect. Against an
   older server it refuses to start ("sent no Verifier keys"); keep 0.1.0 there
   until the server is upgraded. A proxy or TLS-inspecting middlebox that
   rewrites Verifier response bodies or strips the
   `X-Spellguard-Verdict-Signature` header now makes every tool call block as
   `unverified-verdict`.
2. **audit-verify.** If you match on finding messages rather than codes, update
   the `record_unlisted` text ("the audit checker read" instead of "the
   verifier read").

## [0.2.0] - 2026-11-22

This release adds **`@spellguard/audit-verify`**, which checks an audit export
against its locked checkpoints and Verifier signatures without trusting
Spellguard. **`@spellguard/mcp-guard`** is now on npm and checks every tool call
and every result. The client SDKs now **fail closed**: a tool check that can't
complete blocks the tool, and attestation refuses a Verifier it can't verify.
The agent-control protocol moves to version 5, with per-repository GitHub grant
sets in the coding-agent plugins. Several of these are breaking changes: see
[Migrating from 0.1.0](#migrating-from-010) at the end of this section.

### Added

- **`@spellguard/audit-verify`** — a new verifier, with no dependencies, that
  checks a Spellguard audit export (`manifest.json` + `records.jsonl`) on your
  own machine. Spellguard writes an hourly checkpoint per organization, stored
  in S3 Object Lock in compliance mode: the SHA-256 of every new audit record,
  chained to the previous checkpoint. The verifier reports any record changed
  after its checkpoint and any deletion that was not announced. Records a
  Verifier reported also carry its Ed25519 signature over the decision, the
  policy checks, the sender, the recipient and the time, checked against the
  Verifier keys published in the same locked bucket. A Go CLI
  (`go run ./cmd/spellguard-audit-verify <export-dir>` from
  `packages/audit-verify/go`; `--json`, `--allow-bucket`, `--state`) and a
  TypeScript library for browsers and Node 20+ (`verify()`) implement the same
  checks. Both offer a session replay that checks each archived message of one
  `correlation_id` against its signed hash. `SPEC.md` documents the formats and
  every check, and both implementations run the shared vectors in `testdata/`.
- **`@spellguard/mcp-guard`** — published to npm (`npx -y @spellguard/mcp-guard`,
  Node 20+). The Verifier now checks the full argument object of every tool call
  before it reaches the server, and every result before the agent reads it,
  whatever the tool. If the agent has an approved-tools (action allowlist)
  policy, tools it doesn't name are hidden from `tools/list`, and calling one
  anyway is blocked. A local server's command goes after `--`, with its
  arguments passed as given (`--wrap` remains as the older, space-split form).
  New options: `--pass-env`, `-h/--help` and `-v/--version`. `--base-url` accepts
  a plain origin or a `/v1` URL, and `SPELLGUARD_AGENT_ID` may be the agent's
  UUID. The guard exits, stopping the server it started, when the host
  disconnects, on SIGINT, SIGTERM or SIGHUP, or when the wrapped server exits.
- **`@spellguard/client`** (TypeScript and Python) — signed deliveries.
  `/_spellguard/receive` verifies each delivery's signature over the raw body,
  against the Verifier session key from the agent's own attested registration,
  never a key the delivery supplies. Replays are caught by a nonce cache; pass a
  shared store (`deliveryAuth.nonceStore` / `delivery_nonce_store`) when several
  receivers serve one agent. When the registration advertised
  `deliveryAuth: 'v1'`, a missing, stale, replayed or invalid signature is
  refused with 401; otherwise the check only reports. Refused or unverified
  deliveries are reported to the management server, rate-limited. The Python
  client now also matches the TypeScript client's gateway-opaque encryption: it
  registers an X25519 key derived from the agent secret, decrypts deliveries and
  encrypts replies.
- **`@spellguard/client`** — smaller additions. `createSpellguard({ attestationState })`
  and `runWithAttestationState` let code outside a request (a scheduled job, say)
  share the agent's Verifier channel. `runWithWaitUntil` and
  `withRequestWaitUntil` keep background reports alive on Cloudflare Workers.
  `MessageAttachment` / `WithAttachments` describe PDF attachments on a
  `channel.send` payload (at most 4 per message, 1 MB each), which the Verifier
  extracts and checks on the recipient's inbound leg. `channel.send()` takes an
  optional `{ timeoutMs }`, and a tool check made while handling a message sends
  that message's correlation id.
- **`@spellguard/claude-code-plugin`, `@spellguard/codex-plugin`** —
  per-repository GitHub grant sets. The credential daemons accept a complete,
  revisioned grant set from the management server, stage it as a new generation
  under `~/.config/spellguard/<framework>/github-grants/`, switch it in with a
  single symlink swap, and acknowledge it only once it is durable, so readers
  see the old set or the new one, never a mix. `spellguard-git-helper` picks a
  token by owner and repository. Setup and SessionStart print the grant as all
  repositories in the organization or as the repository list.
- **`@spellguard/claude-code-plugin`, `@spellguard/codex-plugin`** — each
  credential daemon writes a health record (`agents/<agentId>.health.json`: PID,
  heartbeat, transport and credential state, no credential values). The Codex
  plugin's hooks use it to replace a daemon left over from an older plugin
  version, or one that stopped responding, after verifying the process's
  identity.
- **`@spellguard/claude-code-plugin`, `@spellguard/codex-plugin`** — a bundled
  `spellguard-cli` skill that teaches the agent to drive the `spellguard` CLI in
  machine mode: `--format json`, `spellguard schema`, stable exit codes, request
  bodies passed through `--input`, and a reference for each command family.
- **`@spellguard/codex-plugin`** — `apply_patch` attribution. PreToolUse and
  PostToolUse now match `apply_patch` (and PreToolUse `Edit` and `Write`), so
  file changes made through `apply_patch` are attributed alongside Bash-authored
  ones.
- **`@spellguard/agent-control`** — protocol version 5 client hooks:
  `onGithubGrantsBundle` (the client acknowledges only after the hook resolves)
  and `onGithubGrantsCommitConfirmed`; `onSuspended` for agent suspension (close
  code `4423`: drop placed credentials, keep the identity, reconnect on a 30 s
  backoff doubling to 5 min); `onCredentialRevokeSettled`, which runs after a
  revoke is applied, persisted and acknowledged; and `onRelayEvent` for
  transient Slack and Teams relay frames on the same socket. Also new:
  `isGithubCredentialScope`, `describeGithubCredentialScope`, `frameFamily`,
  `frameQos`, and the non-fatal close code `4410` (`STALE_SOCKET`).
- **`@spellguard/verifier`** — an LLM gateway. `POST /v1/chat/completions` is an
  OpenAI-compatible endpoint that puts the Verifier on the model-inference path:
  the prompt is checked against the agent's policies, the request is forwarded
  with the caller's own `Authorization` header, and the completion is checked
  before it is returned (a denied response gets 403, or 429 for a rate limit,
  with error code `spellguard_policy_block`). `stream: true` works; by default
  the whole stream is checked before it is replayed, so no tokens leak, and a
  binding with `config.streaming: "buffer"` streams live behind a bounded buffer
  instead. Policies target the new `llm` scope. Callers send
  `X-Spellguard-Agent-Id`, plus `X-Spellguard-Agent-Secret` when a management
  server is configured. The upstream defaults to OpenRouter
  (`SPELLGUARD_LLM_UPSTREAM_BASE_URL`).
- **`@spellguard/verifier`** — evaluate-only endpoints. `POST /v1/content/evaluate`
  returns `allow`, `flag` or `block` for content a caller already carries (a
  sandbox egress proxy, say) without forwarding it, and never returns matched
  text. `POST /v1/mcp/tools` returns the tool names an agent's `action-allowlist`
  policies allow, which `mcp-guard` uses to hide the rest.
- **`@spellguard/verifier`** — session policies. A per-conversation ledger, keyed
  by the correlation id (`/v1/tools/check` and `/v1/mcp/evaluate` accept
  `correlationId`), records what an agent received and sent. Three new policy
  types judge against it: `session-invariant` (a constrained tool parameter must
  be a value a source in the conversation states), `semantic-consistency` (a
  decision model judges which values the sources intend, and whether they carry
  an instruction aimed at the agent) and `agent-conduct` (each output the agent
  makes is judged against a profile its owner wrote, with `exact`, `judge`,
  `limit` or `ignore` checks). `createVerifierApp` takes new `sessionStore`,
  `decisionModel`, `documentExtractor` and `documentReader` options; with an
  extractor, inbound policies also check the text of message attachments. The
  Node server provides an in-memory store only in development mode; without a
  store these policies report `session_unavailable`.
- **`@spellguard/verifier`** — `action-allowlist` parameter rules. Each parameter
  in an `actionConstraints` entry can set `enum`, `min`, `max`, `maxLength` and
  `pattern`, and an entry can declare computed values
  (`"$computed": { "order_total": "quantity * unit_price" }`) and limit them like
  parameters. Expressions allow numbers, parameter names, `+ - * /` and
  parentheses, and are parsed, never passed to `eval`.
- **`@spellguard/ctls`, `@spellguard/verifier`** — signed traffic. New Ed25519
  helpers in `@spellguard/ctls`: `signDelivery` / `verifyDelivery` /
  `DeliveryNonceCache` (the new `@spellguard/ctls/delivery` subpath, and
  `spellguard_ctls.delivery` in Python), `signVerdict` / `verifyVerdict`,
  `signVerifierRequest` / `verifyVerifierRequest`, and the shared
  `signEnvelope` / `verifyEnvelope`. The Verifier signs every delivery to an
  agent with its attested session key and advertises this as
  `deliveryAuth: "v1"`; signs `/admin/evaluate`, `/v1/mcp/evaluate` and
  `/v1/mcp/tools` responses when the request carries
  `X-Spellguard-Verdict-Nonce`; and, with `VERIFIER_AUDIT_SIGNING_KEY` set, signs
  each audit record it reports, including the SHA-256 of the archived object, so
  `audit-verify` can check it.
- **`@spellguard/amp`** — shared modules, also exported as the subpaths
  `./policy-types`, `./agent-conduct`, `./document-limits` and
  `./policy-outcomes`: the policy type registry, decision-model and
  document-reader registries, the `agent-conduct` profile reader, computed-value
  expressions, attachment document limits and policy-outcome helpers. A `none`
  commitment backend (`COMMITMENT_BACKEND=none`) stores nothing, and the
  Verifier's example env files now use it instead of `rekor`. `archiveDigestFor`
  returns the SHA-256 of each archived object, and Python gains
  `derive_agent_key_pair`.
- **`@spellguard/policy-catalog`** — opt-in recommended policies for the `llm`
  leg: `llm-prompt-injection`, `llm-secrets-egress` (prompt and completion), and
  `llm-pii-egress` and `llm-toxicity-egress` (flag only, regular expressions
  only). Also supply-chain templates: a tool allowlist with parameter rules,
  denied-party and embargoed-destination blocks, a release that must cite a
  screening, and a `session-invariant` / `semantic-consistency` pair for an order
  tool. Their ids, limits and party lists are examples to replace.

### Changed

- **BREAKING — the Verifier now fails closed when no archive-encryption key is
  configured.** Previously a missing (or unparseable) management public key
  logged a warning and *disabled archive encryption*, so a single unset or
  misspelled variable silently produced **plaintext message archives** with
  nothing but a log line as evidence. The Verifier now refuses to start.

  If your deployment currently starts without a management public key, it will
  stop starting after this upgrade. Either configure a key (below), or opt out
  deliberately with `SPELLGUARD_ALLOW_UNENCRYPTED_ARCHIVES=true` — intended for
  local development, and never for anything retaining real message content.

- **The management key is split into two independent keypairs.** One Ed25519 key
  was serving two cryptographically distinct roles: EdDSA *signing* (policy
  bundles, discovery responses, agent-binding tokens, admin requests) and, after
  conversion to X25519, *archive encryption*. That coupling meant rotating the
  signing key silently broke decryption of every existing archive.

  - `MANAGEMENT_SIGNING_PUBLIC_KEY` (Ed25519) — verifies management JWTs and
    admin request signatures. Rotate freely.
  - `MANAGEMENT_ARCHIVE_PUBLIC_KEY` (X25519) — the archive-encryption recipient.
    A genuinely separate keypair, **never** derived from the signing key. Accepts
    SPKI PEM, 64-char hex, or base64:

    ```sh
    openssl genpkey -algorithm X25519 -out archive.pem
    openssl pkey -in archive.pem -pubout   # -> MANAGEMENT_ARCHIVE_PUBLIC_KEY
    ```

  `MANAGEMENT_PUBLIC_KEY` still works as a deprecated fallback — it satisfies the
  signing role directly and is converted to X25519 for archives, exactly as
  before — so **the rename alone is not breaking** and existing archives stay
  readable. Only the fail-closed behaviour above is. Migrate at your own pace;
  set `MANAGEMENT_ARCHIVE_PUBLIC_KEY` only alongside a matching
  `MANAGEMENT_ARCHIVE_PRIVATE_KEY` on the management server, or archives written
  with the new key will not be decryptable.

  Pasting an Ed25519 key into `MANAGEMENT_ARCHIVE_PUBLIC_KEY` is rejected with an
  explicit error rather than accepted as 32 opaque bytes.

- **`@spellguard/verifier`** — **BREAKING: registration must prove identity**
  when a management server is configured. `POST /agents/register` needs an
  `X-Spellguard-Agent-Secret` that management verifies or an
  `X-Spellguard-Management-Token` that names the agent, and returns 401 without
  one, or 503 when management can't be reached (it used to register the agent
  anyway). Development mode keeps the unauthenticated path. Rate limits are per
  agent and per source address, and the source address comes from
  `cf-connecting-ip` or the last `X-Forwarded-For` hop, not a value the client
  writes. An agent id with a live registration that can't prove its identity
  gets 409.
- **`@spellguard/verifier`** — **BREAKING: safer defaults.** A binding with no
  `failBehavior` now blocks when its engine is missing, a `dsl` or `external`
  engine fails, or any engine throws (reported as an `engine-error` detection
  with no content); set `failBehavior: "allow"` or `"warn"` to keep the old
  behaviour. An unknown response level resolves to block. Development mode is
  opt-in: the reset and invalidation routes, the relaxed rate limits and the
  `/logs/*` routes used to be on whenever `NODE_ENV` was not `production`, and
  now need `VERIFIER_DEV_MODE=true` (or `VERIFIER_MOCK_MODE=true`).
- **`@spellguard/verifier`** — **BREAKING:** requests to the management server
  are signed in a new format. One `X-Spellguard-Verifier-Signature` header (an
  Ed25519 signature by the attested session key over the method, path and query,
  timestamp and body hash) replaces `X-Verifier-Signature`,
  `X-Verifier-Timestamp` and `X-Verifier-Public-Key`. There is no unsigned
  fallback, and `signRequest` now takes `(method, url, body)`.
- **`@spellguard/verifier`** — enforcement changes. A bilateral reply caught by a
  block, quarantine or rate-limit policy, on the responder's outbound or the
  requester's inbound bindings, is withheld from the requester.
  `/v1/tools/check` blocks a call a rate-limit policy denies (it used to allow
  it) and returns `retryAfter`. `/v1/mcp/evaluate` treats an evaluation with no
  tool name as message traffic and checks `action-allowlist` parameter rules;
  `/admin/evaluate` applies only `messages`-scoped bindings. Message sends over
  32 MiB get 413 (`maxMessageBodyBytes`). A policy fetch that fails on a timeout,
  network error or 5xx is retried once before the delivery is blocked. The
  `schema` engine uses a bundled JSON Schema Draft 7 validator instead of Ajv and
  rejects other dialects and unknown keywords. On the AGNTCY profile, the
  Verifier warms its SLIM sender at boot and re-subscribes every agent when the
  gateway restarts.
- **`@spellguard/ctls`** — stricter attestation and registration.
  `verifyVerifierAttestation` and `fetchAndVerifyVerifier` (TypeScript and
  Python) refuse an empty `expectedImageHash` before fetching anything, every
  failure carries a machine-readable `reason`, and `expectedPublicKey` pins the
  session key the management server attested. A Nitro document is matched
  against the pinned image hash through PCR0 in the hardware document instead of
  its self-reported `imageHash`, and its `user_data` must bind the session key,
  timestamp and nonce. `registerAgent` refuses any re-registration over a live
  record unless `allowEndpointUpdate` is passed (it used to refuse only an
  endpoint change), and an expired record no longer blocks a new registration.
- **`@spellguard/policy-catalog`** — every built-in `tool-*` policy's default
  binding is scoped `tools`, so they no longer run on message or model traffic.
  The schema accepts `scope` (`all`, `messages`, `tools` or `llm`), reads policy
  types from `@spellguard/amp`, makes `defaultBinding` optional, and rejects
  `config.categories: []`. `injection-web-payloads` checks every injection
  category again, `injection-direct-override` gains four patterns,
  `output-size-limit-baseline` flags instead of blocking, `url-baseline` no
  longer flags bare domain names, and `toxicity-baseline` uses keywords only.
  `sync` reads and writes the `policies.config` and `policies.default_binding`
  columns instead of packing both into `dsl_source`.
- **`@spellguard/client`** — **BREAKING: tool policy checks fail closed.**
  `checkToolPolicy()` / `check_tool_policy()` no longer throws: when the check
  can't complete it returns `effect: 'block'` with a `reason`
  (`channel_unavailable`, `verifier_unreachable`, `verifier_refused`,
  `malformed_response` or `check_failed`), and the wrapped tool does not run.
  From a non-2xx response only `block` or `redact` is honoured, so the
  Verifier's own `503 { effect: 'block' }` now blocks instead of becoming an
  allow. `spellguardTool` and the LangChain, OpenAI and CrewAI wrappers no
  longer swallow errors and run the tool; they inherit this. To opt out, set
  `failOpen: true` / `fail_open=True` on the config (the only way on Cloudflare
  Workers), or `SPELLGUARD_TOOL_POLICY_FAIL_OPEN=true`. An explicit Verifier
  denial still blocks with the opt-out.
- **`@spellguard/client`** — **BREAKING: attestation fails closed.** A
  placeholder image hash no longer turns on mock attestation, and discovery no
  longer fills one in: channel creation refuses with
  `verifier_image_hash_unconfigured`. The client pins the Verifier session key
  the management server attested; discovery must return `verifierPublicKey`, and
  both the attestation document and the registration response must carry it. On
  a key or image-hash mismatch the client re-runs discovery once (at most once a
  minute) before failing. To skip attestation for local work, set
  `SPELLGUARD_ALLOW_MOCK_ATTESTATION=true`; it is honoured only when every URL
  the agent talks to is local or a throwaway development stack, and raises
  `mock_attestation_forbidden_in_production` anywhere else.
- **`@spellguard/client`, `@spellguard/langchain`** — **BREAKING:** the client
  moves to Vercel AI SDK 7 (`ai@^7`; the `@openrouter/ai-sdk-provider` peer is
  now `>=3.0.0`). `@spellguard/langchain` is built against `@langchain/core` 1.x
  and needs a `zod` 4 peer.
- **`@spellguard/client`** — the peer fan-out tolerates partial failure. Each
  mentioned agent settles on its own; one that fails transiently or can't be
  found comes back as `{ agent, response: '', unreachable: true }` instead of
  failing the turn, and the model is told plainly which agents it couldn't
  reach, so it doesn't invent their answers. A policy or rate-limit block still
  stops the turn. The fan-out has a 45-second budget (25 s per peer) and runs one
  peer at a time by default (`SPELLGUARD_FANOUT_CONCURRENCY`).
- **`@spellguard/mcp-guard`** — **BREAKING:** a wrapped local server no longer
  inherits the guard's whole environment, which included
  `SPELLGUARD_AGENT_SECRET`. It starts with `PATH`, `HOME`, user, shell, locale,
  time zone, temp-directory, proxy and CA settings, plus the variables you name
  with `--pass-env NAME[,NAME]` (or `SPELLGUARD_PASS_ENV`); `SPELLGUARD_*`
  variables are never passed. `--fail-open` now also needs
  `SPELLGUARD_ALLOW_FAIL_OPEN=true`. Arguments are parsed strictly: an unknown
  flag, a stray positional argument, or more than one of `--` / `--wrap` /
  `--upstream` exits with status 2 and a usage hint.
- **`@spellguard/agent-control`** — **BREAKING:** `AGENT_CONTROL_PROTOCOL_VERSION`
  is now `'5'` (was `'2'`). GitHub `scope_summary` is no longer
  `{ repos: string[] }` but `{ mode: 'all' } | { mode: 'selected', repos }`, with
  `repos` never empty; a missing scope means unknown and must be treated as no
  access. `onCredentialRevoked` must not end the process (the server would
  replay the revoke on every connect); exit from `onCredentialRevokeSettled`
  instead. `requestRefresh` resolves `[]` when a version 5 grant bundle satisfies
  it.
- **`@spellguard/claude-code-plugin`, `@spellguard/codex-plugin`** — revoking a
  GitHub credential no longer takes the agent offline. The daemon removes the
  token, keeps the agent identity and stays connected; for a credential revoked
  on GitHub's side or whose refresh token expired, it requests a replacement on a
  backoff from 1 to 30 minutes, surviving restarts. SessionStart starts the
  daemon even when the config is marked revoked, and suggests
  `spellguard doctor --repair` before re-running setup.
- **`@spellguard/claude-code-plugin`, `@spellguard/codex-plugin`** — PreToolUse
  works out which GitHub repository each command writes to, with `cd` applied
  per shell segment (including subshells and `sh -c`), and every push or
  `gh pr create` in a chain needs a matching credential. When the target can't be
  determined, the hook blocks and suggests `git -C /path/to/worktree push …` or
  `gh pr create --repo OWNER/REPO`. Commands that used to pass can now be
  blocked. An expired credential no longer blocks a command, because the helper
  refreshes it on use.
- **`@spellguard/openclaw-plugin`** — inbound Slack HTTP-mode and Teams relay
  arrive on the single agent-control socket; the separate per-platform relay
  WebSockets are gone. A deployment that sets only `agentSecret` needs `agentUuid`
  in the plugin config for relay. **BREAKING:** the `spellguard_status` tool
  returns `credential.scope` (the scope union above) instead of
  `credential.repos`.
- **`@spellguard/management-api-types`** — `GithubCredentialStatusResponse.scope_summary`
  is the optional `GithubCredentialScope` union, and `ProxyConnectResponse` gains
  `agentId`.
- **`@spellguard/gateway`** — moves to `@agntcy/slim-bindings` `2.0.0-alpha.2`
  and `@hono/node-server` 2. The Dockerfile accepts a `SOURCE_DATE_EPOCH` build
  argument for reproducible images.
- **Demo agents and examples** — the demo agents are for local development only:
  their `deploy` scripts and per-environment `wrangler.jsonc` blocks are gone.
  They move to AI SDK 7 (agent-d also to `@langchain/core` 1.x), and `/chat`
  accepts an optional `correlationId` used as the trace id for every peer send in
  the exchange. The Python agents no longer return exception text in 500
  responses. The `toxicity-bert` example policy installs `torch` from PyPI, so it
  builds on arm64.
- The repository moves to vitest 4, and pytest now also collects `test_*.py`.

### Fixed

- **`@spellguard/verifier`** — injection policies decode Unicode tag-character
  smuggling and strip bidi controls before matching. `pii-detection` and
  `phi-guardian` no longer match reserved or no-reply emails, unlabelled
  ten-digit numbers, or card-shaped numbers that fail the Luhn check. On a tool
  leg, `action-allowlist` checks the call by its name, and `sequence-gate`,
  `data-flow-taint` and `flow-exfiltration` see the agent's earlier tool calls.
  Refusing an already quarantined agent no longer overwrites the original
  reason. Audit commitments for tool checks, `/admin/evaluate` runs and
  bilateral replies are SHA-256 digests of the content checked, and a reply no
  longer commits to its request. A bilateral exchange with no correlation id
  gets a fresh random id instead of one shared by every exchange between the
  same two agents. When the Verifier has lost an agent's encryption key (after a
  restart or key rotation), it fetches the key from the management server
  instead of delivering plaintext. Finding tool calls in a message and counting
  citations take linear time; crafted content used to make them quadratic.
- **`@spellguard/client`** — a registration within five minutes of the
  management token's expiry re-runs discovery first, so an agent that registers
  again after its first hour is no longer refused until it restarts. A tool check
  that gets a 401 for a stale channel token re-registers once and asks again, as
  sends already did. On Cloudflare Workers, usage and bypass reports go to the
  request's `waitUntil` instead of being cancelled when the response returns.
  Initialization runs once at a time, so a replaced attempt can't overwrite the
  active channel. Intent detection's patterns use bounded quantifiers, so long
  input can't cause slow regex backtracking. The Python receive endpoint no
  longer echoes exception text in a 500.
- **`@spellguard/mcp-guard`** — tools no platform parser recognized, and their
  results, used to be forwarded unchecked; every call and result is now checked.
  A 200 without a readable verdict, or a batch reply missing a message, counted
  as a pass and now blocks. `--fail-open` used to let refusals (4xx) through as
  well as outages; it now covers only network errors, timeouts and 5xx.
  Arguments or results over 512 KiB are blocked. The guard no longer uploads a
  preview of tool content with each decision. Long tool lists are read across
  all `tools/list` pages, and an expired token (after the machine slept, say) no
  longer leaves the guard unable to authenticate.
- **`@spellguard/claude-code-plugin`, `@spellguard/codex-plugin`** — security:
  revoked and superseded GitHub tokens no longer stay on disk (`config.json`, its
  `.bak` snapshot, the `git-tokens` file), and a config marked revoked makes the
  git helper serve nothing. When the last GitHub credential goes, the
  credential-helper wiring stays in place, so git fails closed instead of
  falling back to the machine's own credentials. Codex's shell policy also sets
  `GH_TOKEN` and `GITHUB_TOKEN` to empty, and Codex reset signals a daemon only
  after verifying the process's identity. A command the parser can't read, but
  whose text mentions a git mutation, now goes through the credential check.
- **`@spellguard/claude-code-plugin`, `@spellguard/codex-plugin`** — SessionStart
  no longer calls a configured machine "not configured" because of file
  permissions: it restores `0600` on a config you own (with a warning) and
  explains the fix otherwise. A network failure during the status check gets a
  clear transient-error message. Codex SessionStart prints plain status text
  instead of the JSON envelope some Codex versions rejected, and Codex
  `@spellguard-setup` attaches correctly to an existing agent. Both READMEs now
  document the session-scoped SSH-to-HTTPS remote rewrite
  (`SPELLGUARD_SSH_REWRITE=0` turns it off), which 0.1.0 already did although its
  notes said SSH remotes were refused.
- **`@spellguard/agent-control`** — frames are processed strictly in arrival
  order. Three consecutive 401s on the WebSocket upgrade end the session as
  `AUTH_FAILED` (a port or request id containing `401` no longer counts).
  Replayed frames missing a provider's secret no longer reach handlers; the
  existing credential stays until a full delivery arrives. Management base-URL
  normalization no longer uses a regex prone to catastrophic backtracking.
- **`@spellguard/openclaw-plugin`** — the tool guard evaluates every tool call,
  including calls with no arguments, so policies that decide on the tool name
  (allowlists, irreversible-action gates, rate and sequence limits) see them. The
  Teams normalizer strips formatting tags until none remain, so a nested tag no
  longer survives into the policy text.

### Removed

- **`@spellguard/client`** — `verifyVerifierRequest()` (also exported from
  `@spellguard/client/middleware`) and Python `verify_verifier_request()`. They
  only checked that a channel token was non-empty; signed deliveries now
  authenticate `/_spellguard/receive`.
- **`@spellguard/amp`** — **BREAKING:** `verifyArchiveIntegrity`, and its
  re-exports from `@spellguard/verifier` and the TypeScript client. It compared
  a commitment hash with the bare hash of the archived payload, so it could
  never match a commitment made by `generateCommitment` and reported every
  archive as tampered. To check archived messages against signed audit records,
  use `@spellguard/audit-verify`'s session replay.
- **`@spellguard/claude-code-plugin`** — the plaintext `gh-token` file. It fed a
  `GH_TOKEN` export that could leave `gh` stuck on the token a shell started
  with; leftover copies are deleted, and `gh` authenticates only through the
  per-agent `GH_CONFIG_DIR`.

### Migrating from 0.1.0

1. **Archive keys (Verifier).** Configure `MANAGEMENT_ARCHIVE_PUBLIC_KEY` (or
   the deprecated `MANAGEMENT_PUBLIC_KEY`), or set
   `SPELLGUARD_ALLOW_UNENCRYPTED_ARCHIVES=true` for local development; the
   Verifier no longer starts without one.
2. **Verifier registration and defaults.** With a management server configured,
   agents must register with a valid `X-Spellguard-Agent-Secret` or
   `X-Spellguard-Management-Token`; treat a 503 as retry-later. Re-registering a
   live agent id without a verified identity returns 409 until the earlier
   registration expires. Add `failBehavior: "allow"` or `"warn"` to any binding
   that relied on the old permissive default, and set `VERIFIER_DEV_MODE=true`
   locally (never on a deployed Verifier) to keep `/logs/*` and the reset
   routes. A management-compatible server must verify
   `X-Spellguard-Verifier-Signature`, and `signRequest(body)` becomes
   `signRequest(method, url, body)`.
3. **Policy scope shifts.** Catalog `tool-*` policies are now scoped `tools`,
   `messages`-scoped bindings apply on `/v1/mcp/evaluate` when no tool is
   named, and `schema` policies must use JSON Schema Draft 7. Review your
   bindings.
4. **Tool checks fail closed.** During a Verifier outage, wrapped tools now
   return a block instead of running; read `result.reason`. To keep the old
   behaviour, set `failOpen: true` / `fail_open=True`, or
   `SPELLGUARD_TOOL_POLICY_FAIL_OPEN=true` outside Workers.
5. **Attestation fails closed.** Managed mode needs a management server whose
   discovery returns `verifierImageHash` and `verifierPublicKey`; direct mode
   needs a real `expectedVerifierImageHash`. If you relied on the placeholder
   hash locally, set `SPELLGUARD_ALLOW_MOCK_ATTESTATION=true` with local URLs.
6. **Vercel AI SDK 7.** `maxTokens` becomes `maxOutputTokens`, tool `parameters`
   becomes `inputSchema`, and `maxSteps: n` becomes `stopWhen: stepCountIs(n)`.
   Upgrade `@openrouter/ai-sdk-provider` to 3.x; `@spellguard/langchain` users
   also need `zod` 4.
7. **mcp-guard.** List the variables the wrapped server needs with
   `--pass-env`, add `SPELLGUARD_ALLOW_FAIL_OPEN=true` next to `--fail-open`, and
   prefer `-- <command> [args...]` over `--wrap`.
8. **agent-control.** Switch on `scope_summary.mode` instead of reading
   `scope_summary.repos` (`isGithubCredentialScope` validates,
   `describeGithubCredentialScope` renders), treat a missing scope as no access,
   and move any shutdown from `onCredentialRevoked` to
   `onCredentialRevokeSettled`. Upgrade plugin copies together with the server.
9. **OpenClaw.** Read `credential.scope` instead of `credential.repos` from
   `spellguard_status`; a deployment that uses only `agentSecret` adds
   `agentUuid` to keep inbound relay.
10. **Removed exports.** Delete calls to `verifyVerifierRequest` /
   `verify_verifier_request` and `verifyArchiveIntegrity`.
11. **Coding-agent plugins.** A push or `gh pr create` whose target repository
   can't be worked out is now blocked; use `git -C /path push …` or
   `gh pr create --repo OWNER/REPO`.

## [0.1.0] - 2026-07-01

This release ships, for the first time, the **Claude Code** and **Codex**
coding-agent plugins, the shared **`@spellguard/agent-control`** credential-channel
client, the **AGNTCY SLIM gateway**, and the generated
**`@spellguard/management-api-types`** package. The demo agents can now run on the
**AGNTCY profile** (SLIM data plane + `dir` registry) via a one-command local-dev
stack, and all message legs gain gateway-opaque, app-layer encryption.

### Added

- **`@spellguard/claude-code-plugin`** — a Claude Code plugin (installable through
  the `/plugin` marketplace flow) that provisions and manages a scoped,
  attributable Spellguard GitHub credential. `SessionStart`/`PreToolUse`/`PostToolUse`
  hooks inject a git credential helper, spawn a background credential daemon, and
  record git activity (pushes, branch creates, PRs, commits); `/spellguard-setup`
  and `/spellguard-reset` skills handle browser-based provisioning and clean
  teardown. Revocation propagates within seconds and fails git operations closed
  with an actionable message. HTTPS remotes only (SSH refused). Optional portable
  SQLite code-attribution backend (`node:sqlite` / `better-sqlite3` with a
  self-install fallback); core tracking still works without the native module.
  Requires `SPELLGUARD_BASE_URL` (or `--base-url`) — the OSS build ships no default
  endpoint.
- **`@spellguard/codex-plugin`** — the OpenAI Codex counterpart (`codex plugin
  marketplace add` / `codex plugin add`), with `@spellguard-setup` /
  `@spellguard-reset` skills. Wires git/`gh` credential helpers through a
  Codex-scoped `~/.codex/config.toml` `[shell_environment_policy]` block (never the
  machine-global `~/.gitconfig`); credentials live session-local under
  `~/.config/spellguard/`. Runs a persistent agent-control daemon for push-based
  credential rotation/revocation, denies `git push` / `gh pr create` on a revoked
  credential, and shares the wire protocol, socket client, and daemon with the
  Claude Code plugin. Also requires `SPELLGUARD_BASE_URL` / `--base-url`.
- **`@spellguard/agent-control`** — a framework-neutral library holding the single
  TypeScript copy of the agent credential-channel client and wire protocol, shared
  by the Claude Code, Codex, and OpenClaw plugins. Includes `AgentControlClient`
  (PartySocket WebSocket transport with reconnect/resume, Hello/Ack handshake, and
  `credential_delivered` / `credential_rotated` / `credential_revoked` /
  `config_updated` frame handling), a typed version-pinned protocol
  (`AGENT_CONTROL_PROTOCOL_VERSION`) with a redacted-replay contract, a typed
  `openapi-fetch` management REST client (`agent-secret` and `bearer` auth,
  single-retry-on-5xx, agent-gone detection), and a versioned plugin-integration
  contract.
- **`@spellguard/management-api-types`** — a pure-types package exposing the
  management API as generated `openapi-typescript` definitions (`import type {
  paths, components, operations }`), the single source for building typed
  `openapi-fetch` clients. No runtime, no build step; safe in browser, Node, and
  Workers.
- **`@spellguard/gateway`** — an HTTP-to-SLIM translation service that lets
  HTTP/Workers agents participate in the AGNTCY SLIM transport. Wraps outbound HTTP
  as SLIM messages to the Verifier and POSTs SLIM-inbound messages to each agent's
  `/_spellguard/receive` callback, maintaining a `slimName -> callbackUrl` registry
  over SLIM control messages (documented WebSocket sidecar protocol in
  `PROTOCOL.md`). Isolates the native `@agntcy/slim-bindings` dependency on a Node
  host so edge agents stay on plain HTTPS. Wires up SLIM MLS per-session encryption
  on the gateway↔Verifier hops via shared-secret keying. Runs only under
  `SPELLGUARD_PROFILE=agntcy`; ships a Dockerfile for the compose profile or `pnpm
  dev` on the host. This is an early-stage component — per the package README its
  `@agntcy/slim-bindings` calls are still pending end-to-end validation against a
  live SLIM data plane.
- **AGNTCY-profile local-dev stack** — `docker-compose.agntcy.yml` brings up the
  SLIM data plane (`:46357`), a self-contained AGNTCY `dirctl daemon` with embedded
  SQLite/OCI store (`:8888`), and an optional profile-gated containerized Gateway
  (`:46358`). Adds `slim-config/server-config.yaml`, a `dev:agntcy` /
  `dev:agntcy:up` / `dev:agntcy:down` workflow, a protocol-flow diagram in the
  README, and pins `ghcr.io/agntcy/slim:2.0.0-alpha.1` +
  `ghcr.io/agntcy/dir-ctl:v1.4.0`. Integration tests now require the full agntcy
  stack running.

### Changed

- **`@spellguard/amp`** — adds a pluggable profile system (`loadProfile` /
  `ProfileBundle`) that swaps transport, discovery, and identity at deploy time via
  `SPELLGUARD_PROFILE` (default `original`). A new full `agntcy` profile provides
  SLIM data-plane transport over a gateway WebSocket, the AGNTCY `dir` registry for
  resolve/publish, and AGNTCY Identity Ed25519 JWT Verifiable Credentials; an
  unknown profile falls back to `original` with a warning, and unreachable AGNTCY
  infra fails loudly with structured errors. Adds `deriveAgentKeyPair(seed)`
  (deterministic X25519 via domain-separated HKDF) and `generateAgentKeyPair()` for
  gateway-opaque app-layer encryption. New `@spellguard/amp/profile` entrypoint,
  mirrored in the Python `spellguard_amp` package. The AGNTCY profile is renamed
  from `slim` to `agntcy`.
- **`@spellguard/client`** — adds gateway-opaque, app-layer encryption on every
  message leg: the client derives a per-agent X25519 keypair from its stable
  secret, registers the public key with the Verifier, and encrypts/decrypts inbound
  deliveries, replies, and sends so an intermediary gateway sees only ciphertext
  (agents without secret material stay on the legacy plaintext path). Resolves the
  active messaging profile at init, normalizes the management base URL (with or
  without a `/v1` suffix), and raises request timeouts to tolerate SLIM cold-session
  establishment and LLM-bearing routing (registration/policy checks 10s→60s;
  message-send legs gain an explicit 120s timeout).
- **`@spellguard/verifier`** — adds the full AGNTCY SLIM delivery path (worker-thread
  SLIM endpoint, gRPC `dir` resolution, HTTP-over-SLIM delivery to the gateway),
  with SLIM-only delivery when no management URL is set (the directory is the sole
  registry; resolution fails loudly rather than falling back to HTTP). Adds
  gateway-opaque message encryption to a recipient's registered X25519 key (X25519 +
  AES-256-GCM, HKDF info `spellguard-amp-v1`) with automatic plaintext fallback for
  legacy agents. Adds self-healing for the native SLIM RSS leak (proactive
  low-watermark self-recycle that exits only when no delivery is in flight), an
  off-loop SharedArrayBuffer liveness/health responder, a FIFO concurrency gate on
  inbound SLIM handling, supervised SLIM worker threads with backoff respawn, and an
  8s discovery-fetch deadline. Exposes the active profile/transport on system-info
  and heartbeat output.
- **`@spellguard/ctls`** — adds an optional `clientPublicKey` (X25519, hex) and
  `slimName` (AGNTCY SLIM name) to `RegisteredAgent` so the Verifier can encrypt
  delivered payloads to the agent and route over SLIM when discovered via the SLIM
  profile (both fall back to legacy/HTTP when absent). Raises the attestation-fetch
  per-attempt timeout 8s→60s and reduces retries 2→1 for cold SLIM gateway sessions.
- **LangChain and OpenAI adapters** — now capture and report per-call LLM token
  usage. `wrapOpenAI` reports usage from non-streaming chat completions (including
  cached-input and reasoning tokens; streaming skipped); the LangChain adapter
  (TypeScript and Python `SpellguardChatModel`) emits usage read defensively across
  provider-specific shapes. Emission is fire-and-forget and fail-open — it never
  throws into the underlying LLM call.
- **`@spellguard/openclaw-plugin`** — renamed from `@openclaw/spellguard` (npm scope
  migration; update imports). Raises the default `before_dispatch` Verifier-evaluate
  timeout 5s→10s and adds a configurable `verifierTimeout` (ms) option. Adds an
  Apache-2.0 LICENSE.
- **mcp-guard** — renames the `--management-url` flag to `--base-url` and the
  `SPELLGUARD_MANAGEMENT_URL` env var to `SPELLGUARD_BASE_URL`; the value must
  include the `/v1` path prefix.
- Upgraded `@agntcy/slim-bindings` and the SLIM data-plane image to `2.0.0-alpha.1`.

### Fixed

- **Routing cycles (`@spellguard/client`)** — a receiving agent no longer
  auto-routes back to its immediate inbound sender; the sender id is carried through
  the hop-context store and excluded from auto-route targets, keeping the
  communication graph a DAG.
- **Bilateral response-leg policy gap (`@spellguard/verifier`)** — recipient outbound
  policies are now evaluated on bilateral responses (redaction, quarantine,
  obligation dispatch) instead of the response leg being hardcoded to allow; no
  behavior change for agents without outbound bindings.
- **SLIM gateway resilience (`@spellguard/gateway`)** — a wedge detector recycles a
  wedged bindings process via soft consecutive/decaying-window counters, and an
  exactly-once publish-phase retry transparently replaces a dead cached session
  instead of surfacing one-shot send failures.

## [0.0.2] - 2026-05-20

### Added

- `CODE_OF_CONDUCT.md` adopting the [Contributor Covenant 2.1][cc21] by
  reference, with `conduct@spellguard.ai` as the reporting channel.
  Linked from `CONTRIBUTING.md`.

[cc21]: https://www.contributor-covenant.org/version/2/1/code_of_conduct/

## [0.0.1] - 2026-05-18

Initial OSS export of the Spellguard subset: client middleware, Verifier
proxy server, cTLS, AMP, LangChain / OpenAI / OpenClaw adapters, policy
SDK and catalog, demo agents, and the cross-language Python ports.
