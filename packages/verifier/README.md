# @spellguard/verifier

Verifier proxy server — routes messages between agents, enforces policies, and logs audit trails.

## Overview

The Verifier  proxy is the central hub of Spellguard. All agent-to-agent messages flow through it. It handles:

- **Bilateral routing** — Spellguard-to-Spellguard agent communication with bidirectional attestation
- **Unilateral routing** — Communication with external A2A agents (discovery + one-sided attestation)
- **Policy enforcement** — Evaluates org/group/agent policies on every message
- **Audit logging** — Commits message hashes and archives encrypted payloads

## Policy Enforcement

Policies are enforced using a three-tier hierarchy: **org > group > agent**. Org-level bindings cascade to all agents, group-level bindings cascade to group members, and agent-level bindings apply to individual agents. Higher-level bindings cannot be overridden by lower levels (restrict-only model). Agents with no policy bindings allow all traffic (fail-open default).

### How It Works

1. **Configuration**: Bind policies at three levels — org, group, or agent. Each binding specifies a `policyId`, `direction` (inbound/outbound/both), `effect` (block/flag), and optional `config`
2. **Resolution**: Verifier fetches effective policies from management via `GET /v1/internal/agents/:agentId/policies` (cached with 5-minute TTL, background poller every 30s)
3. **Engine dispatch**: Each binding is routed to the engine registered for its `policyType`
4. **Enforcement**: Sender's outbound policies before forwarding, recipient's inbound policies before forwarding, sender's inbound policies on the response. If any policy denies, the message is blocked
5. **Decision logic**: Detections + `block` effect = deny; detections + `flag` effect = permit/flag; no detections = permit
6. **Audit trail**: Both agents receive audit log entries with `policyChecks` results

### Pluggable Engine Registry

Policy evaluation is powered by a **pluggable engine registry**. Each policy binding has a `policyType` that routes to the appropriate engine. New engines can be added by implementing the `PolicyEngine` interface:

```typescript
import { registerEngine } from '@spellguard/verifier';
import type { PolicyEngine, PolicyEvalContext, PolicyDetection } from '@spellguard/verifier';

const myEngine: PolicyEngine = {
  name: 'rego',
  evaluate(ctx: PolicyEvalContext): PolicyDetection[] {
    return [];
  },
};

registerEngine('rego', myEngine);
```

When a binding's `policyType` has no registered engine, the **Enforcement Fallback** (`failBehavior`) controls the outcome:
- `'allow'` (default): silent permit
- `'block'`: deny with a synthetic `engine-missing` detection
- `'warn'`: console warning + silent permit

### Builtin Policies

The built-in engine handles `policyType: 'builtin'` plus 12 specialized policy types:

| Type / Slug | Description |
|-------------|-------------|
| `builtin` / `pii-detection` | Detects SSN, email, phone, and credit card patterns |
| `builtin` / `prompt-injection` | Deprecated — use `policyType: 'injection'` instead |
| `builtin` / `max-length` | Blocks/flags messages exceeding `config.maxLength` |
| `builtin` / `blocked-patterns` | Blocks/flags messages matching `config.patterns` (regex) |
| `builtin` / `rate-limit-standard` | Stub: rate limiting tracked separately |
| `builtin` / `internal-only` | Stub: requires sender/recipient org context |
| `keyword` | Exact keyword matching with optional word-boundary and case-sensitivity |
| `contains` | Substring phrase matching with optional matchAll mode |
| `code` | Detects fenced code blocks and language-specific patterns |
| `toxicity` | Detects threats, harassment, hate speech, and profanity via keyword patterns, with optional semantic endpoint fallback |
| `nsfw-blocker` | Blocks explicit sexual content, violence, and nudity (with medical exceptions) |
| `topic-boundary` | Keeps agents focused on allowed topics/domains (strict/moderate/loose modes) |
| `financial-disclaimer` | Enforces disclaimers on financial advice |
| `phi-guardian` | HIPAA PHI detection (MRN, ICD-10, CPT codes, medical keywords) |
| `action-allowlist` | Restricts agent tool calls to allowed actions with parameter constraints |
| `privilege-escalation` | Prevents privilege escalation, impersonation, and jailbreak attempts |
| `citation-enforcer` | Requires source citations for factual claims |
| `self-harm-prevention` | Detects crisis content with tiered detection and crisis resources |

All core policies run inside the Verifier with no external services required. For semantic toxicity augmentation, set `SPELLGUARD_TOXICITY_SEMANTIC_ENDPOINT` to an HTTP endpoint that accepts `{ content, policyId, policySlug, config }` and returns a JSON array of detections. The toxicity engine only calls the endpoint when heuristic matching misses. Optional: `SPELLGUARD_TOXICITY_SEMANTIC_TIMEOUT` (ms, default `3000`). In local non-production runs, the Verifier auto-discovers the bundled Docker sidecar at `http://127.0.0.1:3110/evaluate` when it is running, so `pnpm run dev:all` and `pnpm run dev:services` work without manual exports. The Phala deploy flow provisions the same sidecar internally and points the Verifier at `http://toxicity-bert:3100/evaluate` by default unless you override the endpoint.

### Regex Engine

Evaluates user-defined regular expressions (`policyType: 'regex'`):

```json
{
  "patterns": [
    { "pattern": "\\bpassword\\s*=", "label": "password-leak" },
    { "pattern": "sk_live_[a-zA-Z0-9]+", "flags": "i", "label": "stripe-key" }
  ]
}
```

### External HTTPS Engine

Delegates evaluation to an HTTP(S) endpoint (`policyType: 'external'`). The binding's `externalEndpoint` receives a POST with `{ content, policyId, policySlug, config }` and returns a JSON array of `PolicyDetection` objects.

Configuration: `externalEndpoint` (URL), `externalTimeout` (ms, default 5000), `failBehavior` (`'allow'`/`'block'`/`'warn'`).

### Custom External Policies

See [`packages/policy-sdk/README.md`](../policy-sdk/README.md) and [`examples/policies/competitor-mention/`](../../examples/policies/competitor-mention/) for building custom policies with `@spellguard/policy-sdk`.

### Loop Prevention (Hop Limit)

The Verifier enforces a maximum hop count on bilateral messages to prevent infinite routing loops (e.g. A→B→A→B→…). Each message carries a `_spellguardHops` counter set by the client library. The Verifier checks the counter after outbound policy evaluation: if it meets or exceeds `MAX_MESSAGE_HOPS` (default 3), the message is rejected with `responseLevel: 'block'`. Otherwise, the counter is incremented and injected into the forwarded payload. The hop count is transparent to agent developers — the client middleware handles all propagation.

### Security Hardening

- JSON block parsing limited to depth 64 and size 64KB to prevent DoS
- User-provided patterns validated by `safeRegex()` (rejects >256 chars and catastrophic backtracking)
- Compiled patterns are cached
- Injection engine short-circuits on high-confidence (>=0.95) matches

## Environment Variables

| Variable | Description |
|----------|-------------|
| `COMMITMENT_BACKEND` | `rekor` or `memory` (default: `memory`) |
| `ARCHIVE_BACKEND` | `s3` or `memory` (default: `memory`) |
| `VERIFIER_MOCK_MODE` | `true` for local dev without real attestation |
| `MANAGEMENT_PUBLIC_KEY` | Ed25519 public key for verifying admin evaluate requests |
| `MANAGEMENT_PUBLIC_KEY_PREVIOUS` | Previous signing key for rotation overlap (optional) |
| `MANAGEMENT_KEY_PREVIOUS_EXPIRES` | ISO 8601 expiry for previous key (default: 24h) |
| `VERIFIER_NONCE_DB_PATH` | SQLite nonce store path (default: `./data/nonces.db`) |
| `VERIFIER_TRUST_PROXY` | Trust `x-forwarded-for` for admin-evaluate IP handling |
| `VERIFIER_ADMIN_RATE_LIMIT` | Per-source admin-evaluate limit/min (default: `30`) |
| `VERIFIER_ADMIN_AUTH_FAIL_LIMIT` | Per-source failed-auth limit/min (default: `5`) |
| `VERIFIER_ADMIN_GLOBAL_RATE_LIMIT` | Global admin-evaluate circuit-breaker/min (default: `100`) |
| `MAX_MESSAGE_HOPS` | Maximum bilateral routing hops before rejection (default: `3`) |
| `VERIFIER_PLATFORM` | `phala` for Phala Cloud (auto-URL via dstack), `nitro` for AWS Nitro Enclaves |
| `VERIFIER_EXTERNAL_URL` | Explicit external URL override (required for Nitro, optional for Phala) |
| `DYNAMODB_NONCE_TABLE` | DynamoDB table name for shared nonce store (required for Nitro) |
| `PHALA_GATEWAY_DOMAIN` | Override Phala gateway domain |

**Rekor Backend** (`COMMITMENT_BACKEND=rekor`): `REKOR_URL` (default: `https://rekor.sigstore.dev`)

**S3 Backend** (`ARCHIVE_BACKEND=s3`): `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_ENDPOINT` (optional)

## Attestation

Attestation generation is handled by `@spellguard/ctls` (`generateAttestationDocument`), which supports all platforms. The Verifier server imports it as a single source of truth. See the [`@spellguard/ctls` README](../ctls/README.md) for platform details.

## Deployment

### Docker

```bash
docker build -t spellguard-verifier -f packages/verifier/Dockerfile .
```

### Phala Cloud CVM

```bash
cp packages/verifier/.env.staging.example packages/verifier/.env.staging
# Edit with your values
pnpm run deploy:verifier:staging
```

The deploy script automatically injects `VERIFIER_IMAGE_HASH`, mounts the dstack socket for TDX attestation, waits for the CVM to reach "running" status, and runs post-deploy health checks.
It also deploys the semantic toxicity BERT sidecar as an internal-only companion container and wires `SPELLGUARD_TOXICITY_SEMANTIC_ENDPOINT` to that service by default.

With `VERIFIER_PLATFORM=phala`, the Verifier auto-detects its external URL at boot via `DstackClient.info()`.

### AWS Nitro Enclaves

```bash
cp packages/verifier/.env.nitro.example packages/verifier/.env.staging
# Edit with your values (VERIFIER_EXTERNAL_URL, DYNAMODB_NONCE_TABLE, etc.)
./scripts/deploy-nitro.sh --env staging
```

The Nitro deploy builds a Docker image, pushes to ECR, deploys a CDK stack (ALB with TLS, Auto Scaling Group, DynamoDB), and registers the PCR0 measurement. The enclave runs inside an initramfs with vsock bridges for inbound/outbound traffic. See the [root README](../../README.md) for full details.

## License

MIT
