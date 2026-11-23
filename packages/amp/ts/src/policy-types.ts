// SPDX-License-Identifier: Apache-2.0

/**
 * The policy type registry shared by the management API, dashboard and
 * Verifier. Keep the order stable: it is also the order used by the typed
 * policy contract and generated clients.
 */

interface PolicyTypeRegistrySeed {
  readonly type: string;
  readonly label: string;
  readonly engineFamily: string;
  readonly authoringMode: string;
}

export const POLICY_TYPE_REGISTRY = Object.freeze([
  {
    type: 'builtin',
    label: 'Builtin',
    engineFamily: 'builtin',
    authoringMode: 'catalog',
  },
  {
    type: 'dsl',
    label: 'DSL (Rego)',
    engineFamily: 'dsl',
    authoringMode: 'dedicated',
  },
  {
    type: 'external',
    label: 'External',
    engineFamily: 'external',
    authoringMode: 'dedicated',
  },
  {
    type: 'regex',
    label: 'Regex',
    engineFamily: 'regex',
    authoringMode: 'dedicated',
  },
  {
    type: 'keyword',
    label: 'Keyword',
    engineFamily: 'builtin',
    authoringMode: 'dedicated',
  },
  {
    type: 'schema',
    label: 'Schema',
    engineFamily: 'schema',
    authoringMode: 'dedicated',
  },
  {
    type: 'contains',
    label: 'Contains',
    engineFamily: 'builtin',
    authoringMode: 'dedicated',
  },
  {
    type: 'time-window',
    label: 'Time Window',
    engineFamily: 'time-window',
    authoringMode: 'dedicated',
  },
  {
    type: 'code',
    label: 'Code Detection',
    engineFamily: 'builtin',
    authoringMode: 'dedicated',
  },
  {
    type: 'toxicity',
    label: 'Toxicity Filter',
    engineFamily: 'builtin',
    authoringMode: 'dedicated',
  },
  {
    type: 'injection',
    label: 'Injection',
    engineFamily: 'injection',
    authoringMode: 'dedicated',
  },
  {
    type: 'secrets',
    label: 'Secrets Detection',
    engineFamily: 'builtin',
    authoringMode: 'dedicated',
  },
  {
    type: 'url',
    label: 'URL Policy',
    engineFamily: 'url',
    authoringMode: 'dedicated',
  },
  {
    type: 'loop',
    label: 'Loop Detection',
    engineFamily: 'loop',
    authoringMode: 'dedicated',
  },
  {
    type: 'exfiltration',
    label: 'Exfiltration Detection',
    engineFamily: 'exfiltration',
    authoringMode: 'dedicated',
  },
  {
    type: 'nsfw-blocker',
    label: 'NSFW Blocker',
    engineFamily: 'builtin',
    authoringMode: 'dedicated',
  },
  {
    type: 'topic-boundary',
    label: 'Topic Boundary',
    engineFamily: 'builtin',
    authoringMode: 'dedicated',
  },
  {
    type: 'financial-disclaimer',
    label: 'Financial Disclaimer',
    engineFamily: 'builtin',
    authoringMode: 'dedicated',
  },
  {
    type: 'phi-guardian',
    label: 'PHI Guardian',
    engineFamily: 'builtin',
    authoringMode: 'dedicated',
  },
  {
    type: 'action-allowlist',
    label: 'Action Allowlist',
    engineFamily: 'builtin',
    authoringMode: 'dedicated',
  },
  {
    type: 'privilege-escalation',
    label: 'Privilege Escalation',
    engineFamily: 'builtin',
    authoringMode: 'dedicated',
  },
  {
    type: 'citation-enforcer',
    label: 'Citation Enforcer',
    engineFamily: 'builtin',
    authoringMode: 'dedicated',
  },
  {
    type: 'self-harm-prevention',
    label: 'Self-Harm Prevention',
    engineFamily: 'builtin',
    authoringMode: 'dedicated',
  },
  {
    type: 'path-traversal',
    label: 'Path Traversal',
    engineFamily: 'file',
    authoringMode: 'json',
  },
  {
    type: 'path-sandbox',
    label: 'Path Sandbox',
    engineFamily: 'file',
    authoringMode: 'json',
  },
  {
    type: 'command-allowlist',
    label: 'Command Allowlist',
    engineFamily: 'shell',
    authoringMode: 'json',
  },
  {
    type: 'argument-injection',
    label: 'Argument Injection',
    engineFamily: 'shell',
    authoringMode: 'json',
  },
  {
    type: 'sandbox-escape',
    label: 'Sandbox Escape',
    engineFamily: 'shell',
    authoringMode: 'json',
  },
  {
    type: 'ssrf',
    label: 'SSRF',
    engineFamily: 'network',
    authoringMode: 'json',
  },
  {
    type: 'scheme-allowlist',
    label: 'Scheme Allowlist',
    engineFamily: 'network',
    authoringMode: 'json',
  },
  {
    type: 'flow-exfiltration',
    label: 'Flow Exfiltration',
    engineFamily: 'network',
    authoringMode: 'json',
  },
  {
    type: 'network-injection-scan',
    label: 'Network Injection Scan',
    engineFamily: 'network',
    authoringMode: 'json',
  },
  {
    type: 'query-injection',
    label: 'Query Injection',
    engineFamily: 'database',
    authoringMode: 'json',
  },
  {
    type: 'ddl-block',
    label: 'DDL Block',
    engineFamily: 'database',
    authoringMode: 'json',
  },
  {
    type: 'write-block',
    label: 'Write Block',
    engineFamily: 'database',
    authoringMode: 'json',
  },
  {
    type: 'recipient-allowlist',
    label: 'Recipient Allowlist',
    engineFamily: 'comms',
    authoringMode: 'json',
  },
  {
    type: 'output-risk-scan',
    label: 'Output Risk Scan',
    engineFamily: 'comms',
    authoringMode: 'json',
  },
  {
    type: 'sequence-gate',
    label: 'Sequence Gate',
    engineFamily: 'comms',
    authoringMode: 'json',
  },
  {
    type: 'scope-isolation',
    label: 'Scope Isolation',
    engineFamily: 'memory',
    authoringMode: 'json',
  },
  {
    type: 'payload-size-limit',
    label: 'Payload Size Limit',
    engineFamily: 'memory',
    authoringMode: 'json',
  },
  {
    type: 'memory-injection-scan',
    label: 'Memory Injection Scan',
    engineFamily: 'memory',
    authoringMode: 'json',
  },
  {
    type: 'input-injection-scan',
    label: 'Input Injection Scan',
    engineFamily: 'file',
    authoringMode: 'json',
  },
  {
    type: 'invocation-rate-limit',
    label: 'Invocation Rate Limit',
    engineFamily: 'meta',
    authoringMode: 'json',
  },
  {
    type: 'irreversible-gate',
    label: 'Irreversible Gate',
    engineFamily: 'meta',
    authoringMode: 'json',
  },
  {
    type: 'output-size-limit',
    label: 'Output Size Limit',
    engineFamily: 'meta',
    authoringMode: 'json',
  },
  {
    type: 'data-flow-taint',
    label: 'Data Flow Taint',
    engineFamily: 'meta',
    authoringMode: 'json',
  },
  {
    type: 'identity-claim',
    label: 'Identity Claim',
    engineFamily: 'identity',
    authoringMode: 'dedicated',
  },
  // Session policies judge a tool call against the agent's session ledger
  // (internal design notes). Authored in the schema-driven
  // JSON editor: the creation schemas in management's policy-creation.ts
  // mirror the Verifier's config readers, refuse a fact pattern safeRegex
  // would refuse, and validate a config patch the same way, so the model,
  // facts and thresholds can be chosen when the policy is added or edited.
  {
    type: 'session-invariant',
    label: 'Session Invariant',
    engineFamily: 'session',
    authoringMode: 'json',
  },
  {
    type: 'semantic-consistency',
    label: 'Semantic Consistency',
    engineFamily: 'session',
    authoringMode: 'json',
  },
  // The agent's profile (internal design notes): judges every
  // output the agent makes (a tool call, an A2A message, a reply) against
  // what it received and what its owner says each output means.
  {
    type: 'agent-conduct',
    label: 'Agent Conduct',
    engineFamily: 'session',
    authoringMode: 'json',
  },
] as const satisfies readonly PolicyTypeRegistrySeed[]);

for (const entry of POLICY_TYPE_REGISTRY) {
  Object.freeze(entry);
}

export type PolicyEngineFamily =
  (typeof POLICY_TYPE_REGISTRY)[number]['engineFamily'];
export type PolicyAuthoringMode =
  (typeof POLICY_TYPE_REGISTRY)[number]['authoringMode'];
export type PolicyTypeRegistryEntry = (typeof POLICY_TYPE_REGISTRY)[number];
export type PolicyType = (typeof POLICY_TYPE_REGISTRY)[number]['type'];

const [firstPolicyType, ...remainingPolicyTypes] = POLICY_TYPE_REGISTRY;
export const POLICY_TYPES = Object.freeze([
  firstPolicyType.type,
  ...remainingPolicyTypes.map((entry) => entry.type),
] as const);

export const CREATABLE_POLICY_TYPES = Object.freeze(
  POLICY_TYPE_REGISTRY.filter((entry) => entry.authoringMode !== 'catalog').map(
    (entry) => entry.type,
  ),
);

const POLICY_TYPE_BY_NAME = new Map<string, PolicyTypeRegistryEntry>(
  POLICY_TYPE_REGISTRY.map((entry) => [entry.type, entry]),
);

export function getPolicyType(
  type: string,
): PolicyTypeRegistryEntry | undefined {
  return POLICY_TYPE_BY_NAME.get(type);
}

/** True when the type has a configured policy engine. */
export function isConfiguredPolicyType(type: string): type is PolicyType {
  const entry = getPolicyType(type);
  return (
    entry !== undefined &&
    entry.type !== 'builtin' &&
    entry.type !== 'dsl' &&
    entry.type !== 'external'
  );
}

// ── Decision models ────────────────────────────────────────────────

/**
 * Where a decision model runs. The Verifier picks the client for an entry
 * by this field.
 */
export type DecisionModelProvider = 'workers-ai';

interface DecisionModelSeed {
  /** The value a policy config names in `model`. */
  readonly id: string;
  readonly label: string;
  readonly provider: DecisionModelProvider;
  /** The provider's name for the model. */
  readonly modelRef: string;
  /**
   * The input tokens the model accepts in one call, state, questions and
   * images together. Over it the model refuses the call rather than cutting
   * the input. Measured live: clef answered "the maximum is 65529" on
   * 2026-10-29, clef-flash "the maximum is 24576" on 2026-10-22.
   */
  readonly contextTokens: number;
  /**
   * How many page images one call may carry in `images`. Both Clef models
   * refused a fifth image ("request exceeds the image count limit",
   * 2026-10-29). Zero sends none.
   */
  readonly maxImages: number;
  /**
   * The policy types that may name this model. `agent-conduct` takes Clef
   * only: in the 2026-10-30 measurement Clef Flash let attacks through and
   * flagged honest messages (internal design notes).
   */
  readonly policyTypes: readonly DecisionPolicyType[];
  readonly description: string;
}

/** The policy types that ask a decision model. */
export const DECISION_POLICY_TYPES = [
  'semantic-consistency',
  'agent-conduct',
] as const;
export type DecisionPolicyType = (typeof DECISION_POLICY_TYPES)[number];

/**
 * The decision models a `semantic-consistency` or `agent-conduct` policy can name in its
 * `model` key: the one list the Verifier's engine and model client, the
 * policy creation schema and the dashboard read
 * (internal design notes). The first entry is the
 * default.
 *
 * Every entry today is a Cloudflare Clef model on Workers AI. A model from
 * another provider is one more entry here with its own `provider` (for
 * example `provider: 'openrouter'`, with the provider's model name as
 * `modelRef`) plus one `DecisionModelClient` for that provider in the
 * Verifier, chosen by `provider`. The engine, the question bank and the
 * policy config do not change.
 */
export const DECISION_MODELS = Object.freeze([
  {
    id: 'clef',
    label: 'Clef',
    provider: 'workers-ai',
    modelRef: '@cf/cloudflare/clef',
    contextTokens: 65_529,
    maxImages: 4,
    policyTypes: ['semantic-consistency', 'agent-conduct'],
    description:
      'Cloudflare Clef on Workers AI. In the 2026-10-22 measurement it blocked all ten attack cases and kept the widest margin on the clean order.',
  },
  {
    id: 'clef-flash',
    label: 'Clef Flash',
    provider: 'workers-ai',
    modelRef: '@cf/cloudflare/clef-flash',
    contextTokens: 24_576,
    maxImages: 4,
    policyTypes: ['semantic-consistency'],
    description:
      'Cloudflare Clef Flash on Workers AI, the smaller Clef with a 24,576-token context. In the 2026-10-22 measurement it let one of ten attack cases through with a flag.',
  },
] as const satisfies readonly DecisionModelSeed[]);

for (const model of DECISION_MODELS) {
  Object.freeze(model);
}

export type DecisionModel = (typeof DECISION_MODELS)[number];
export type DecisionModelId = DecisionModel['id'];

const [firstDecisionModel, ...remainingDecisionModels] = DECISION_MODELS;
export const DECISION_MODEL_IDS = Object.freeze([
  firstDecisionModel.id,
  ...remainingDecisionModels.map((model) => model.id),
] as const);

/** The model a `semantic-consistency` config gets when it names none. */
export const DEFAULT_DECISION_MODEL_ID: DecisionModelId = firstDecisionModel.id;

export function getDecisionModel(id: string): DecisionModel | undefined {
  return DECISION_MODELS.find((model) => model.id === id);
}

/**
 * The ids of the models a policy type may name, in registry order. The
 * config reader and the creation schema of each type accept exactly these.
 */
export function decisionModelIdsFor(
  policyType: DecisionPolicyType,
): readonly DecisionModelId[] {
  return DECISION_MODELS.filter((model) =>
    (model.policyTypes as readonly string[]).includes(policyType),
  ).map((model) => model.id);
}

/** The models `agent-conduct` accepts: Clef only. */
export const AGENT_CONDUCT_MODEL_IDS = Object.freeze(
  decisionModelIdsFor('agent-conduct'),
);

// ── Document readers ───────────────────────────────────────────────

/**
 * Where a document reader (the OCR model that transcribes page images and
 * images inside PDFs) runs. The Verifier picks the client for an entry by
 * this field.
 */
export type DocumentReaderProvider = 'workers-ai';

interface DocumentReaderSeed {
  /** The value a `semantic-consistency` or `agent-conduct` config names in `reader`. */
  readonly id: string;
  /** Shown to people, and written into the reading markers Clef sees. */
  readonly label: string;
  readonly provider: DocumentReaderProvider;
  /** The provider's name for the model. */
  readonly modelRef: string;
  /**
   * Whether the reader reports a confidence per word. Vision models do not;
   * an engine such as Textract would.
   */
  readonly reportsConfidence: boolean;
  readonly description: string;
}

/**
 * The OCR models a `semantic-consistency` or `agent-conduct` policy can
 * name in its `reader` key (internal design notes).
 * The Verifier reads a received document once, with the reader of the
 * receiving agent's first binding of either type, and every policy on that
 * agent's ledger reads the result. The first entry is the default.
 *
 * As with DECISION_MODELS, a new engine is one more entry here with its own
 * `provider` (for example `aws-textract`, or `openrouter` with the provider's
 * model name as `modelRef`) plus one `OcrClient` for that provider in the
 * Verifier, chosen by `provider`. The reading, the ledger and the policy
 * config do not change.
 */
export const DOCUMENT_READERS = Object.freeze([
  {
    id: 'llama-4-scout',
    label: 'Llama 4 Scout',
    provider: 'workers-ai',
    modelRef: '@cf/meta/llama-4-scout-17b-16e-instruct',
    reportsConfidence: false,
    description:
      'Meta Llama 4 Scout on Workers AI. In the 2026-10-29 measurement it read every key value on scans, faxes and phone photos, and was the only model that read the small print on a phone photo correctly, at about $1 per 1,000 pages and 11 to 14 s per page.',
  },
  {
    id: 'mistral-small-3.1',
    label: 'Mistral Small 3.1',
    provider: 'workers-ai',
    modelRef: '@cf/mistralai/mistral-small-3.1-24b-instruct',
    reportsConfidence: false,
    description:
      'Mistral Small 3.1 on Workers AI. In the 2026-10-29 measurement it read the key values on scans as well as Scout, but on the phone photo it rewrote the injected price 3,200.00 as 3,570.00 in all three runs.',
  },
] as const satisfies readonly DocumentReaderSeed[]);

for (const reader of DOCUMENT_READERS) {
  Object.freeze(reader);
}

export type DocumentReader = (typeof DOCUMENT_READERS)[number];
export type DocumentReaderId = DocumentReader['id'];

const [firstDocumentReader, ...remainingDocumentReaders] = DOCUMENT_READERS;
export const DOCUMENT_READER_IDS = Object.freeze([
  firstDocumentReader.id,
  ...remainingDocumentReaders.map((reader) => reader.id),
] as const);

/** The reader a document gets when no binding names one. */
export const DEFAULT_DOCUMENT_READER_ID: DocumentReaderId =
  firstDocumentReader.id;

export function getDocumentReader(id: string): DocumentReader | undefined {
  return DOCUMENT_READERS.find((reader) => reader.id === id);
}
