# @spellguard/policy-catalog

Version-controlled policy definitions for Spellguard. Policies are authored as JSONC files, validated against a Zod schema, and synced to the database for Verifier runtime consumption.

## Quick Start

```bash
# Validate all catalog entries against the schema
pnpm --filter @spellguard/policy-catalog validate

# Diff catalog entries against the database
pnpm --filter @spellguard/policy-catalog diff

# Sync catalog entries to the database
pnpm --filter @spellguard/policy-catalog sync
```

## Catalog Structure

```
catalog/
├── system/                    # System-level policies (shipped with Spellguard)
│   ├── injection.jsonc        # Injection detection config
│   ├── exfiltration.jsonc     # Data exfiltration detection
│   ├── toxicity.jsonc         # Toxicity/hate speech detection
│   ├── secrets.jsonc          # Secret/credential detection
│   ├── url.jsonc              # URL policy (requireHttps, blocked domains)
│   ├── privilege-escalation.jsonc
│   ├── phi-guardian.jsonc     # Protected health information
│   ├── citation-enforcer.jsonc
│   ├── financial-disclaimer.jsonc
│   ├── action-allowlist.jsonc
│   ├── keyword.jsonc          # Keyword-based detection
│   ├── regex.jsonc            # Custom regex pattern detection
│   ├── schema.jsonc           # JSON Schema validation (partial mode)
│   ├── contains.jsonc         # Phrase/substring detection
│   └── pii-detection.jsonc    # PII detection (SSN, email, phone, CC)
└── recommended/               # Recommended policies (optional)
compliance/
└── frameworks.jsonc           # OWASP, MITRE ATLAS, NIST AI RMF definitions
```

## Entry Schema

Each JSONC file contains a `policies` array. Each policy has:

- `slug` — unique identifier
- `name` / `description` — human-readable metadata
- `type` — engine type (e.g., `injection`, `builtin`, `regex`, `schema`)
- `level` — `system` or `recommended`
- `isCritical` — whether violations are critical
- `failBehavior` — `block` or `flag`
- `config` — engine-specific configuration (patterns, phrases, thresholds, etc.)
- `defaultBinding` — direction, effect, and priority for test and default deployments
- `provenance` — source and date tracking

## How It Works

1. **Filesystem** — Policies are authored as JSONC in `catalog/`
2. **Validation** — `pnpm validate` checks all entries against the Zod schema
3. **Diff** — `pnpm diff` compares catalog entries against the database
4. **Sync** — `pnpm sync` upserts entries to the database
5. **Runtime** — Verifier polls the management server for resolved policies (5m TTL, 30s background refresh)

A catalog binding builder is also available for offline testing — it loads catalog entries directly and merges same-type policies into aggregate bindings.
