// SPDX-License-Identifier: Apache-2.0

/**
 * Evaluate-only content endpoint: `POST /v1/content/evaluate`.
 *
 * For callers that already sit on the traffic path and only need a verdict.
 * The first is the OpenShell supervisor middleware (#1438): OpenShell forwards
 * the request itself, so the Verifier must not (unlike the LLM gateway, which
 * relays to the provider). The caller sends the extracted text of one request
 * or response and gets back allow, flag, or block.
 *
 * Identity is the LLM gateway's binding: `X-Spellguard-Agent-Id` plus
 * `X-Spellguard-Agent-Secret`, checked against the control plane with
 * `verifyAgentIdentity` before any policy loads. A long-lived middleware holds
 * an agent secret, not a management-issued JWT, so `/v1/mcp/evaluate` does not
 * fit. Unlike the gateway there is no observe rollout mode: a managed Verifier
 * always enforces, and an unmanaged one (no `MANAGEMENT_URL`) evaluates local
 * policies without identity, matching every other leg.
 *
 * Only the `'llm'` scope is accepted today, and only bindings scoped exactly
 * `'llm'` apply (`filterByScope`'s `explicitOnly`). Unscoped and `'all'`
 * bindings do not, unlike on the LLM gateway (internal design notes
 * §5.5). The default catalog is built for chat traffic, and its unscoped
 * policies block almost all of a coding agent's model traffic: every JSON
 * tool call, URLs read out of code, git author emails (#1438, #1480, #1489).
 * An admin opts this leg in by binding policies with scope LLM only. Every
 * verdict says how many policies it applied (`appliedPolicies`), so a caller
 * can tell "allowed" from "nothing to check against". Block bindings fail
 * closed, as on the gateway.
 */

import type { Context } from 'hono';

import { getAgentPolicies } from '../management/policy-cache';
import { reportBilateralEvent } from '../management/reporter';
import { CORRELATION_ID_ERROR, isValidCorrelationId } from '../session/keys';
import { createConcurrencyGate } from '../slim/concurrency-gate';
import {
  handleQuarantine,
  mapResponseLevel,
  resolveResponseLevel,
  shouldQuarantineFromChecks,
} from './effect-handlers';
import type { ResponseLevel } from './effect-handlers';
import { checkAgentSecret, makeCommitment } from './llm-gateway';
import { evaluatePolicies, filterByScope } from './policy-evaluator';
import type { PolicyCheckResult } from './policy-evaluator';
import type {
  ContentPart,
  PolicyType,
  ResolvedPolicyBinding,
} from './policy-evaluator-types';
import { STATEFUL_POLICY_TYPES, buildQuarantineReason } from './policy-helpers';

/** The audit `event_type` for every evaluation through this route. */
export const CONTENT_EVALUATE_EVENT_TYPE = 'content-evaluate';

/**
 * Upper bound on the flattened content. OpenShell caps one payload at 4 MiB;
 * decompression and JSON escaping can grow the extracted text past that.
 */
export const MAX_CONTENT_CHARS = 16 * 1024 * 1024;

const SCOPES = ['llm'] as const;
type Scope = (typeof SCOPES)[number];

export interface ContentEvaluateRequest {
  direction: 'inbound' | 'outbound';
  scope: Scope;
  destination: { host: string; method?: string; path?: string };
  /**
   * A part typed `system` is the vendor instruction channel
   * (SYSTEM_PART_TYPE), `model` text the model wrote (MODEL_PART_TYPE).
   */
  content: ContentPart[];
  /** Caller context recorded on the audit event. Strings only. */
  context?: Record<string, string>;
  /**
   * False when the caller will evaluate a superset of this content again, as
   * the OpenShell response leg does with a growing streamed completion. A
   * non-final evaluation writes an audit event only when it blocks; the final
   * one always does. Defaults to true.
   */
  final?: boolean;
  /**
   * On a block, also report which parts block on their own (`blockedParts`),
   * so the caller can withhold just those and forward the rest.
   */
  attribute?: boolean;
}

export interface ContentEvaluateResponse {
  result: 'allow' | 'flag' | 'block';
  responseLevel: ResponseLevel;
  /** Stable code for a block, safe to show the agent. */
  reasonCode?: string;
  /** The policy that decided a block. */
  policy?: string;
  detections: Array<{ engine: string; policy: string; confidence: number }>;
  retryAfter?: number;
  /**
   * With `attribute`, on a block: indices into `content` of the parts that
   * block on their own. Empty when only the combination blocks, or when the
   * block is not about the content (quarantine, rate limit).
   */
  blockedParts?: number[];
  /**
   * The version of the agent's policy configuration this verdict used. A
   * caller that remembers verdicts drops them when it changes.
   */
  policyVersion?: string;
  /**
   * How many of the agent's policies this evaluation applied: its bindings
   * scoped `'llm'` for this direction. Zero means the content was checked
   * against nothing, so an `allow` is not a judgement.
   */
  appliedPolicies: number;
}

function badRequest(c: Context, message: string): Response {
  return c.json({ error: { code: 'BAD_REQUEST', message } }, 400);
}

/** Returns an error message, or null when the body is valid. */
export function validateRequest(body: unknown): string | null {
  if (typeof body !== 'object' || body === null)
    return 'Body must be a JSON object';
  const b = body as Record<string, unknown>;
  if (b.direction !== 'inbound' && b.direction !== 'outbound') {
    return 'direction must be "inbound" or "outbound"';
  }
  if (!SCOPES.includes(b.scope as Scope)) {
    return `scope must be one of: ${SCOPES.join(', ')}`;
  }
  const d = b.destination as Record<string, unknown> | undefined;
  if (typeof d !== 'object' || d === null || typeof d.host !== 'string') {
    return 'destination.host is required';
  }
  if (
    !Array.isArray(b.content) ||
    !b.content.every(
      (p) =>
        typeof p === 'object' &&
        p !== null &&
        typeof (p as ContentPart).type === 'string' &&
        typeof (p as ContentPart).value === 'string',
    )
  ) {
    return 'content must be an array of {type, value} strings';
  }
  if (
    b.context !== undefined &&
    (typeof b.context !== 'object' ||
      b.context === null ||
      !Object.values(b.context).every((v) => typeof v === 'string'))
  ) {
    return 'context must be an object of strings';
  }
  const context = b.context as Record<string, string> | undefined;
  if (
    context?.correlationId !== undefined &&
    !isValidCorrelationId(context.correlationId)
  ) {
    return `context.${CORRELATION_ID_ERROR}`;
  }
  return optionalBooleans(b, ['final', 'attribute']);
}

/**
 * The audit row's correlation id: the caller's `context.correlationId` when
 * it sent one, else its `requestId` (what this route has always used).
 */
function auditCorrelationId(req: ContentEvaluateRequest): string | undefined {
  return req.context?.correlationId ?? req.context?.requestId;
}

function optionalBooleans(
  b: Record<string, unknown>,
  names: string[],
): string | null {
  const bad = names.find(
    (n) => b[n] !== undefined && typeof b[n] !== 'boolean',
  );
  return bad ? `${bad} must be a boolean` : null;
}

const REASON_CODES: Partial<Record<ResponseLevel, string>> = {
  block: 'spellguard_policy_block',
  quarantine: 'spellguard_agent_quarantined',
  rate_limit: 'spellguard_rate_limited',
};

/**
 * Build the verdict. Detections carry the engine and policy only: an engine's
 * free-text detail can quote the matched content, and this response is
 * handed to a caller that may log it.
 */
export function buildVerdict(
  checks: PolicyCheckResult[],
  appliedPolicies: number,
): ContentEvaluateResponse {
  const responseLevel = resolveResponseLevel(
    checks.map((c) => c.responseLevel),
  );
  const result = mapResponseLevel(responseLevel);
  const deciding = checks.find((c) => c.decision === 'deny');
  const retryAfter = checks.find((c) => c.retryAfter !== undefined)?.retryAfter;
  return {
    result,
    responseLevel,
    appliedPolicies,
    ...(result === 'block'
      ? {
          reasonCode: REASON_CODES[responseLevel] ?? 'spellguard_policy_block',
          policy: deciding?.policyName,
        }
      : {}),
    detections: checks.flatMap((c) =>
      c.detections.map((d) => ({
        engine: c.policyType ?? 'unknown',
        policy: c.policyName,
        confidence: d.confidence,
      })),
    ),
    ...(retryAfter !== undefined ? { retryAfter } : {}),
  };
}

/**
 * The content part type a caller uses for the agent vendor's own instruction
 * channel: Anthropic `system` and system-role messages, OpenAI `instructions`
 * and developer messages.
 */
export const SYSTEM_PART_TYPE = 'system';

/**
 * The content part type for text the model wrote, sent back to it as
 * conversation history: earlier assistant messages and tool calls. Like the
 * system channel it skips injection detectors (the model's own words are not
 * an attempt to override it, and code in them trips shell-snippet patterns);
 * content checks still run, because a process that rewrites history can put
 * anything in an assistant turn.
 */
export const MODEL_PART_TYPE = 'model';

/** Part types evaluated without the bindings `exemptOnSystemChannel` names. */
const EXEMPT_PART_TYPES = new Set([SYSTEM_PART_TYPE, MODEL_PART_TYPE]);

/**
 * The injection detectors, named one by one so a new policy type is never
 * exempted by its name alone: the prompt-injection scans, plus the shell and
 * SQL injection checks, which code in instructions and model output trips.
 */
const INJECTION_POLICY_TYPES: ReadonlySet<PolicyType> = new Set<PolicyType>([
  'injection',
  'input-injection-scan',
  'network-injection-scan',
  'memory-injection-scan',
  'argument-injection',
  'query-injection',
]);

/**
 * Bindings that do not run on the system channel.
 *
 * Injection detectors look for text that tries to replace the model's
 * instructions. On the instruction channel itself that is what every message
 * does: Codex's own developer block says "Any previous instructions ... are no
 * longer active", and other coding agents' system prompts trip shell-snippet
 * patterns. Whoever controls that channel already controls the agent, so the
 * detectors there only produce false positives that block every model call.
 * Content checks (secrets, PII, keywords, exfiltration) still apply: a secret
 * in a system prompt still leaves the machine.
 *
 * Rate-limit bindings are left out so that one request counts once, in the
 * pass over the non-system content.
 */
export function exemptOnSystemChannel(binding: ResolvedPolicyBinding): boolean {
  return (
    INJECTION_POLICY_TYPES.has(binding.policyType) ||
    binding.effect === 'rate_limit'
  );
}

/** One result per policy: a deny wins, and detections from both passes are kept. */
function mergeChecks(checks: PolicyCheckResult[]): PolicyCheckResult[] {
  const byPolicy = new Map<string, PolicyCheckResult>();
  for (const check of checks) {
    const prior = byPolicy.get(check.policyId);
    if (!prior) {
      byPolicy.set(check.policyId, check);
      continue;
    }
    const winner = prior.decision === 'deny' ? prior : check;
    byPolicy.set(check.policyId, {
      ...winner,
      detections: [...prior.detections, ...check.detections],
      durationMs: prior.durationMs + check.durationMs,
    });
  }
  return [...byPolicy.values()];
}

/**
 * Evaluate the system-channel and model-authored parts and the rest
 * separately, so the former skip the bindings `exemptOnSystemChannel` names.
 */
export async function evaluateParts(
  bindings: ResolvedPolicyBinding[],
  parts: ContentPart[],
  options: Parameters<typeof evaluatePolicies>[2],
): Promise<PolicyCheckResult[]> {
  const join = (selected: ContentPart[]) =>
    selected.map((p) => p.value).join('\n');
  const system = join(parts.filter((p) => EXEMPT_PART_TYPES.has(p.type)));
  const rest = join(parts.filter((p) => !EXEMPT_PART_TYPES.has(p.type)));
  const checks: PolicyCheckResult[] = [];
  if (rest || !system) {
    checks.push(...(await evaluatePolicies(bindings, rest, options)));
  }
  if (system) {
    checks.push(
      ...(await evaluatePolicies(
        bindings.filter((b) => !exemptOnSystemChannel(b)),
        system,
        options,
      )),
    );
  }
  return mergeChecks(checks);
}

type EvaluateOptions = Parameters<typeof evaluatePolicies>[2];

/**
 * At most this many per-part re-runs at once. A model-backed policy makes a
 * network call per run, and a resent history can be hundreds of parts.
 */
export const ATTRIBUTION_CONCURRENCY = 8;

/**
 * The bindings worth re-running one part at a time to find what caused a
 * block: the ones that denied, minus stateful ones.
 */
function attributionBindings(
  bindings: ResolvedPolicyBinding[],
  checks: PolicyCheckResult[],
): ResolvedPolicyBinding[] {
  const denied = new Set(
    checks.filter((c) => c.decision === 'deny').map((c) => c.policyId),
  );
  return bindings.filter(
    (b) =>
      denied.has(b.policyId) &&
      b.effect !== 'rate_limit' &&
      !STATEFUL_POLICY_TYPES.has(b.policyType),
  );
}

/**
 * The indices of the parts that block on their own, found by re-running the
 * denying policies on each part, `ATTRIBUTION_CONCURRENCY` at a time. Runs
 * only after a block, so a clean call costs nothing extra.
 */
export async function attributeBlock(
  bindings: ResolvedPolicyBinding[],
  parts: ContentPart[],
  checks: PolicyCheckResult[],
  options: EvaluateOptions,
): Promise<number[]> {
  const rerun = attributionBindings(bindings, checks);
  if (rerun.length === 0) return [];
  if (parts.length === 1) return [0];
  const gate = createConcurrencyGate(ATTRIBUTION_CONCURRENCY);
  const blocked = await Promise.all(
    parts.map((part) =>
      gate.run(async () => {
        const partChecks = await evaluateParts(rerun, [part], options);
        const level = resolveResponseLevel(
          partChecks.map((c) => c.responseLevel),
        );
        return mapResponseLevel(level) === 'block';
      }),
    ),
  );
  return blocked.flatMap((b, i) => (b ? [i] : []));
}

/**
 * Bind the agent id to its secret, as the LLM gateway does. Returns a
 * rejection Response, or null to proceed. There is no observe rollout mode:
 * a managed Verifier always enforces, and only an unmanaged one skips.
 */
async function authenticate(
  c: Context,
  agentId: string,
): Promise<Response | null> {
  const rejection = await checkAgentSecret(
    c,
    agentId,
    process.env.MANAGEMENT_URL ? 'enforce' : 'off',
    'content-evaluate',
  );
  if (!rejection) return null;
  return c.json(
    { error: { code: 'UNAUTHORIZED', message: rejection.reason } },
    rejection.status,
  );
}

/** Evaluate the content against the agent's `'llm'`-scoped bindings. */
async function evaluateRequest(
  agentId: string,
  cfg: Awaited<ReturnType<typeof getAgentPolicies>>,
  req: ContentEvaluateRequest,
): Promise<{ checks: PolicyCheckResult[]; verdict: ContentEvaluateResponse }> {
  if (!cfg) return { checks: [], verdict: buildVerdict([], 0) };
  const bindings = filterByScope(
    req.direction === 'outbound' ? cfg.outbound : cfg.inbound,
    'llm',
    { explicitOnly: true },
  );
  const options: EvaluateOptions = {
    agentId,
    direction: req.direction,
    agentStatus: cfg.agentStatus,
    identity: cfg.identityContext,
    correlationId: req.context?.correlationId,
  };
  const checks = await evaluateParts(bindings, req.content, options);
  const verdict = buildVerdict(checks, bindings.length);
  if (cfg.version) verdict.policyVersion = cfg.version;
  if (req.attribute && verdict.result === 'block') {
    verdict.blockedParts = await attributeBlock(
      bindings,
      req.content,
      checks,
      options,
    );
  }
  return { checks, verdict };
}

export async function handleContentEvaluate(c: Context): Promise<Response> {
  const agentId = c.req.header('X-Spellguard-Agent-Id');
  if (!agentId) {
    return c.json(
      {
        error: {
          code: 'UNAUTHORIZED',
          message: 'Missing X-Spellguard-Agent-Id',
        },
      },
      401,
    );
  }
  const rejected = await authenticate(c, agentId);
  if (rejected) return rejected;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return badRequest(c, 'Invalid JSON body');
  }
  const problem = validateRequest(body);
  if (problem) return badRequest(c, problem);
  const req = body as ContentEvaluateRequest;

  const content = req.content.map((p) => p.value).join('\n');
  if (content.length > MAX_CONTENT_CHARS) {
    return c.json(
      {
        error: {
          code: 'PAYLOAD_TOO_LARGE',
          message: `content exceeds ${MAX_CONTENT_CHARS} characters`,
        },
      },
      413,
    );
  }

  // Fail closed when management is configured but unreachable: an
  // evaluate-only caller has no other way to learn the agent's policies.
  const cfg = await getAgentPolicies(agentId);
  if (!cfg && process.env.MANAGEMENT_URL) {
    return c.json(
      {
        error: {
          code: 'BINDINGS_UNAVAILABLE',
          message: 'Policy data unavailable for agent',
        },
      },
      503,
    );
  }

  const { checks, verdict } = await evaluateRequest(agentId, cfg, req);
  if (req.final === false && verdict.result !== 'block') {
    return c.json(verdict);
  }

  reportBilateralEvent(
    makeCommitment(agentId, content, auditCorrelationId(req)),
    verdict.responseLevel,
    checks,
    req.direction,
    agentId,
    CONTENT_EVALUATE_EVENT_TYPE,
    {
      scope: req.scope,
      destination: {
        host: req.destination.host,
        method: req.destination.method,
        path: req.destination.path,
      },
      contentParts: req.content.length,
      contentChars: content.length,
      appliedPolicies: verdict.appliedPolicies,
      ...(verdict.blockedParts
        ? { blockedParts: verdict.blockedParts.length }
        : {}),
      ...(req.context ? { caller: req.context } : {}),
    },
  );
  if (shouldQuarantineFromChecks(checks)) {
    await handleQuarantine(
      agentId,
      buildQuarantineReason(checks) ||
        'Content evaluation triggered quarantine',
    );
  }

  return c.json(verdict);
}
