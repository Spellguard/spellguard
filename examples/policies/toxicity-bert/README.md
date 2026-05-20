# Toxicity BERT Policy Service

Dockerized external policy service for semantic toxicity detection.

The service implements the Spellguard external-policy contract:

- `POST /evaluate`
- request body: `{ content, policyId, policySlug, config }`
- response body: `[{ type, confidence, message? }]`

Default model:

- `unitary/toxic-bert`

This is intended for:

- local development
- adversarial benchmarking
- a deployable container later for Cloud Run / Modal / internal API proxying

## Local Docker

Start the service:

```bash
pnpm run dev:toxicity-model
```

In local dev, `pnpm run dev:all` and `pnpm run dev:services` start this sidecar automatically, and the Verifier / adversarial runner auto-discover it at `http://127.0.0.1:3110/evaluate`.

Only set an explicit endpoint if you want to override that default:

```bash
export SPELLGUARD_TOXICITY_SEMANTIC_ENDPOINT=http://127.0.0.1:3110/evaluate
export SPELLGUARD_TOXICITY_SEMANTIC_TIMEOUT=3000
```

Stop it:

```bash
pnpm run dev:toxicity-model:stop
```

## Environment

- `MODEL_ID`
  - default: `unitary/toxic-bert`
- `TOXICITY_THRESHOLD`
  - default: `0.6`
- `TOXICITY_SECONDARY_THRESHOLD`
  - default: `0.05`
- `MAX_CONTENT_CHARS`
  - default: `4000`
- `PORT`
  - default: `3100`

## Notes

- The service treats high-confidence `toxic` scores as actionable only when the
  model also emits an abuse-oriented secondary label such as `insult`,
  `threat`, or `identity_hate`.
- The first startup downloads the model and is slower.
- The compose service persists the Hugging Face cache in a Docker volume so
  subsequent starts are much faster.
