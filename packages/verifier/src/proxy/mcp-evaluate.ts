// SPDX-License-Identifier: Apache-2.0

/**
 * MCP Evaluate Endpoint Handler
 *
 * Evaluates MCP proxy traffic against agent policies using the existing
 * evaluatePolicies pipeline. Supports single and batch evaluation modes.
 *
 * Route: POST /v1/mcp/evaluate
 * Auth: Management JWT via Authorization: Bearer <token>
 */

import type { Context } from 'hono';

import { verifyAndExtractAgentPublicKey } from '../auth/management-jwt';
import { getAgentPolicies } from '../management/policy-cache';
import { resolveResponseLevel } from './effect-handlers';
import type { ResponseLevel } from './effect-handlers';
import { evaluatePolicies, filterByScope } from './policy-evaluator';
import type { PolicyCheckResult } from './policy-evaluator';
import type {
  NormalizedIdentityClaims,
  ResolvedPolicyBinding,
} from './policy-evaluator-types';

// ── Request / Response Types ──────────────────────────────────────────

interface ContentPart {
  type: string;
  value: string;
}

interface McpEvaluateRequestSingle {
  agentId: string;
  platform?: string;
  direction: 'inbound' | 'outbound';
  tool?: string;
  context?: Record<string, unknown>;
  content: ContentPart[];
}

interface McpBatchMessage {
  messageId: string;
  content: ContentPart[];
  context?: Record<string, unknown>;
}

interface McpEvaluateRequestBatch {
  agentId: string;
  platform?: string;
  direction: 'inbound' | 'outbound';
  batch: true;
  messages: McpBatchMessage[];
}

type McpEvaluateRequest = McpEvaluateRequestSingle | McpEvaluateRequestBatch;

interface Detection {
  engine: string;
  policy: string;
  confidence: number;
  detail?: string;
}

interface Redaction {
  start: number;
  end: number;
  replacement: string;
}

interface McpEvaluateResult {
  result: 'allow' | 'block' | 'flag';
  detections: Detection[];
  redactions: Redaction[];
}

interface McpEvaluateResultWithId extends McpEvaluateResult {
  messageId: string;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Flatten typed content array to a single string for policy evaluation.
 */
function flattenContent(content: ContentPart[]): string {
  return content.map((c) => c.value).join('\n');
}

/**
 * Map the 6-level ResponseLevel to the 3-level MCP result.
 * block/quarantine/rate_limit -> 'block'
 * flag/redact -> 'flag'
 * allow -> 'allow'
 */
function mapResponseLevel(level: ResponseLevel): 'allow' | 'block' | 'flag' {
  switch (level) {
    case 'block':
    case 'quarantine':
    case 'rate_limit':
      return 'block';
    case 'flag':
    case 'redact':
      return 'flag';
    case 'allow':
      return 'allow';
    default:
      return 'allow';
  }
}

/**
 * Map PolicyDetection[] from multiple PolicyCheckResults to the simpler
 * MCP Detection[] format.
 */
function mapDetections(checks: PolicyCheckResult[]): Detection[] {
  const detections: Detection[] = [];
  for (const check of checks) {
    if (check.detections.length === 0) continue;
    for (const d of check.detections) {
      detections.push({
        engine: check.policyType ?? 'unknown',
        policy: check.policyName,
        confidence: d.confidence,
        detail: d.message,
      });
    }
  }
  return detections;
}

/**
 * Map RedactionMetadata from PolicyCheckResults to the simpler
 * MCP Redaction[] format.
 */
function mapRedactions(checks: PolicyCheckResult[]): Redaction[] {
  const redactions: Redaction[] = [];
  for (const check of checks) {
    if (!check.redactionMetadata) continue;
    for (const span of check.redactionMetadata.spans) {
      redactions.push({
        start: span.start,
        end: span.end,
        replacement: '[content removed by Spellguard]',
      });
    }
  }
  return redactions;
}

/**
 * Resolve policy bindings for an agent from the management server.
 * All bindings are fetched server-side — callers cannot supply their own
 * to prevent SSRF via externalEndpoint.
 */
async function resolveBindings(
  agentId: string,
  direction: 'inbound' | 'outbound',
): Promise<{
  bindings: ResolvedPolicyBinding[];
  identity?: NormalizedIdentityClaims[];
  error?: string;
}> {
  const agentPolicies = await getAgentPolicies(agentId);
  if (!agentPolicies) {
    return {
      bindings: [],
      error: 'Policy data unavailable for agent',
    };
  }

  const directionBindings =
    direction === 'inbound' ? agentPolicies.inbound : agentPolicies.outbound;
  return {
    bindings: filterByScope(directionBindings, 'tools'),
    identity: agentPolicies.identityContext,
  };
}

/**
 * Evaluate a single content payload against resolved bindings.
 */
async function evaluateSingle(
  agentId: string,
  direction: 'inbound' | 'outbound',
  content: ContentPart[],
  bindings: ResolvedPolicyBinding[],
  identity?: NormalizedIdentityClaims[],
): Promise<McpEvaluateResult> {
  const flatContent = flattenContent(content);

  if (bindings.length === 0) {
    return { result: 'allow', detections: [], redactions: [] };
  }

  const checks = await evaluatePolicies(bindings, flatContent, {
    agentId,
    direction,
    identity,
  });

  const responseLevel = resolveResponseLevel(
    checks.map((c) => c.responseLevel),
  );

  return {
    result: mapResponseLevel(responseLevel),
    detections: mapDetections(checks),
    redactions: mapRedactions(checks),
  };
}

// ── Auth ──────────────────────────────────────────────────────────────

/**
 * Validate the management token from the Authorization header.
 * Uses the existing management JWT verification mechanism.
 */
interface AuthSuccess {
  valid: true;
  claims: { agentId: string } | null;
}
interface AuthFailure {
  valid: false;
  status: number;
  error: string;
}

async function validateAuth(c: Context): Promise<AuthSuccess | AuthFailure> {
  const authHeader = c.req.header('Authorization');
  if (!authHeader) {
    return { valid: false, status: 401, error: 'Missing Authorization header' };
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return {
      valid: false,
      status: 401,
      error: 'Invalid Authorization header format',
    };
  }

  const token = parts[1];
  try {
    const claims = await verifyAndExtractAgentPublicKey(token);
    // null means MANAGEMENT_PUBLIC_KEY not configured -- allow in dev/mock mode
    if (claims === null) {
      return { valid: true, claims: null };
    }
    return { valid: true, claims: { agentId: claims.agentId } };
  } catch {
    return { valid: false, status: 401, error: 'Invalid or expired token' };
  }
}

// ── Request Validation ────────────────────────────────────────────────

function isBatchRequest(body: unknown): body is McpEvaluateRequestBatch {
  return (
    typeof body === 'object' &&
    body !== null &&
    (body as McpEvaluateRequestBatch).batch === true
  );
}

function validateDirection(
  direction: unknown,
): direction is 'inbound' | 'outbound' {
  return direction === 'inbound' || direction === 'outbound';
}

function validateContentArray(content: unknown): content is ContentPart[] {
  if (!Array.isArray(content)) return false;
  return content.every(
    (c) =>
      typeof c === 'object' &&
      c !== null &&
      typeof c.type === 'string' &&
      typeof c.value === 'string',
  );
}

// ── Traffic Reporting ────────────────────────────────────────────────

/**
 * Fire-and-forget traffic report to the management server.
 * The Verifier is the authoritative evaluator, so reporting from here
 * ensures traffic data matches the actual verdict.
 */
function reportTraffic(
  token: string,
  agentId: string,
  direction: string,
  result: McpEvaluateResult,
  platform?: string,
  context?: Record<string, unknown>,
  contentPreview?: string,
): void {
  const managementUrl = process.env.MANAGEMENT_URL?.replace(/\/v1\/?$/, '');
  if (!managementUrl) return;

  fetch(`${managementUrl}/v1/connections/report-traffic`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      direction,
      result: result.result,
      detections: result.detections,
      platform,
      channel: context?.channel,
      tool: context?.tool,
      contentPreview:
        typeof contentPreview === 'string'
          ? contentPreview.slice(0, 200)
          : undefined,
      timestamp: new Date().toISOString(),
    }),
  }).catch(() => {
    // Non-fatal — don't block evaluation
  });
}

// ── Handler ───────────────────────────────────────────────────────────

/**
 * POST /v1/mcp/evaluate
 *
 * Evaluates MCP proxy traffic against the agent's policies.
 * Supports single and batch evaluation modes.
 */
export async function handleMcpEvaluate(c: Context) {
  // 1. Auth
  const authResult = await validateAuth(c);
  if (!authResult.valid) {
    return c.json(
      { error: { code: 'INVALID_TOKEN', message: authResult.error } },
      authResult.status as 401,
    );
  }

  // 2. Parse body
  let body: McpEvaluateRequest;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
      400,
    );
  }

  // 3. Common field validation
  if (!body.agentId || typeof body.agentId !== 'string') {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'Missing or invalid agentId' } },
      400,
    );
  }

  // 4. Verify agentId matches JWT claims (prevents IDOR)
  if (authResult.claims && authResult.claims.agentId !== body.agentId) {
    return c.json(
      { error: { code: 'FORBIDDEN', message: 'agentId does not match token' } },
      403,
    );
  }

  if (!validateDirection(body.direction)) {
    return c.json(
      {
        error: {
          code: 'BAD_REQUEST',
          message:
            'Missing or invalid direction (must be "inbound" or "outbound")',
        },
      },
      400,
    );
  }

  // Extract bearer token for traffic reporting
  const bearerToken = c.req.header('Authorization')?.split(' ')[1] ?? '';

  // 5. Resolve bindings once (shared across batch messages)
  const {
    bindings,
    identity,
    error: bindingsError,
  } = await resolveBindings(body.agentId, body.direction);

  if (bindingsError) {
    // Fail-closed: cannot evaluate without policy data
    return c.json(
      { error: { code: 'BINDINGS_UNAVAILABLE', message: bindingsError } },
      503,
    );
  }

  // 6. Dispatch based on batch vs single mode
  if (isBatchRequest(body)) {
    // Batch mode
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return c.json(
        {
          error: {
            code: 'BAD_REQUEST',
            message: 'Batch request requires a non-empty messages array',
          },
        },
        400,
      );
    }

    const MAX_BATCH_SIZE = 100;
    if (body.messages.length > MAX_BATCH_SIZE) {
      return c.json(
        {
          error: {
            code: 'BAD_REQUEST',
            message: `Batch size exceeds maximum of ${MAX_BATCH_SIZE}`,
          },
        },
        400,
      );
    }

    const results: McpEvaluateResultWithId[] = [];

    for (const msg of body.messages) {
      if (!msg.messageId || typeof msg.messageId !== 'string') {
        return c.json(
          {
            error: {
              code: 'BAD_REQUEST',
              message: 'Each batch message must have a messageId',
            },
          },
          400,
        );
      }

      if (!validateContentArray(msg.content)) {
        return c.json(
          {
            error: {
              code: 'BAD_REQUEST',
              message: `Invalid content array for message ${msg.messageId}`,
            },
          },
          400,
        );
      }

      const evalResult = await evaluateSingle(
        body.agentId,
        body.direction,
        msg.content,
        bindings,
        identity,
      );

      reportTraffic(
        bearerToken,
        body.agentId,
        body.direction,
        evalResult,
        body.platform,
        msg.context,
        flattenContent(msg.content),
      );

      results.push({
        messageId: msg.messageId,
        ...evalResult,
      });
    }

    return c.json({ results });
  }

  // Single mode
  if (!validateContentArray(body.content)) {
    return c.json(
      {
        error: {
          code: 'BAD_REQUEST',
          message: 'Missing or invalid content array',
        },
      },
      400,
    );
  }

  const evalResult = await evaluateSingle(
    body.agentId,
    body.direction,
    body.content,
    bindings,
    identity,
  );

  reportTraffic(
    bearerToken,
    body.agentId,
    body.direction,
    evalResult,
    body.platform,
    body.context,
    flattenContent(body.content),
  );

  return c.json(evalResult);
}
