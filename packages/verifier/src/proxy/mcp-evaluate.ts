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
import { readCorrelationId } from '../session/keys';
import { mapResponseLevel, resolveResponseLevel } from './effect-handlers';
import {
  evaluatePolicies,
  evaluateToolCallPolicies,
  filterByScope,
} from './policy-evaluator';
import type { PolicyCheckResult } from './policy-evaluator';
import type {
  ContentPart,
  NormalizedIdentityClaims,
  ResolvedPolicyBinding,
} from './policy-evaluator-types';

// ── Request / Response Types ──────────────────────────────────────────

interface McpEvaluateRequestSingle {
  agentId: string;
  platform?: string;
  direction: 'inbound' | 'outbound';
  tool?: string;
  context?: Record<string, unknown>;
  content: ContentPart[];
  /**
   * Optional conversation id, validated like the tool check's and passed to
   * the engines. This leg has no session ledger (design §4.3).
   */
  correlationId?: unknown;
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
  /** As on a single request; applies to every message in the batch. */
  correlationId?: unknown;
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
    bindings: directionBindings,
    identity: agentPolicies.identityContext,
  };
}

/**
 * Infer which policy leg an MCP evaluation represents from its structured
 * context. Channel traffic is a message unless the caller explicitly names a
 * tool. Treating every MCP evaluation as a tool call made tool-only shell
 * policies scan ordinary Slack Markdown.
 */
function evaluationScope(
  context?: Record<string, unknown>,
  tool?: string,
): 'messages' | 'tools' {
  return tool || typeof context?.tool === 'string' ? 'tools' : 'messages';
}

/**
 * A tool evaluation's arguments. The tool guards send one content part holding
 * the arguments as a JSON object; anything else carries no structured
 * arguments, and a parameter constraint then has nothing to check.
 */
function toolArguments(
  content: ContentPart[],
): Record<string, unknown> | undefined {
  if (content.length !== 1) return undefined;
  try {
    const parsed: unknown = JSON.parse(content[0].value);
    return parsed !== null &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function evaluationToolName(
  context?: Record<string, unknown>,
  tool?: string,
): string | undefined {
  if (tool) return tool;
  return typeof context?.tool === 'string' ? context.tool : undefined;
}

/**
 * Evaluate a single content payload against resolved bindings.
 */
async function evaluateSingle(
  agentId: string,
  direction: 'inbound' | 'outbound',
  content: ContentPart[],
  bindings: ResolvedPolicyBinding[],
  scope: 'messages' | 'tools',
  toolName?: string,
  identity?: NormalizedIdentityClaims[],
  correlationId?: string,
): Promise<McpEvaluateResult> {
  const flatContent = flattenContent(content);
  const scopedBindings = filterByScope(bindings, scope);

  if (scopedBindings.length === 0) {
    return { result: 'allow', detections: [], redactions: [] };
  }

  const options = { agentId, direction, toolName, identity, correlationId };
  const checks =
    scope === 'tools'
      ? await evaluateToolCallPolicies(scopedBindings, flatContent, {
          ...options,
          // Outbound content is the call's arguments. Inbound content is the
          // tool's result, which is not a set of parameters.
          toolParams:
            direction === 'outbound' ? toolArguments(content) : undefined,
        })
      : await evaluatePolicies(scopedBindings, flatContent, options);

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

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
    ? value
    : undefined;
}

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
  tool?: string,
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
      // Optional extras an MCP Guard sends, so the record lands on its own
      // connection with the channel's name (#1501). Management checks the
      // connection belongs to the token's agent.
      channelName: optionalString(context?.channelName),
      connectionId: optionalString(context?.connectionId),
      tool: tool ?? context?.tool,
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
export async function handleMcpEvaluate(c: Context): Promise<Response> {
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

  const correlation = readCorrelationId(body.correlationId);
  if (!correlation.ok) {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: correlation.error } },
      400,
    );
  }
  const correlationId = correlation.value;

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
        evaluationScope(msg.context),
        evaluationToolName(msg.context),
        identity,
        correlationId,
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
    evaluationScope(body.context, body.tool),
    evaluationToolName(body.context, body.tool),
    identity,
    correlationId,
  );

  reportTraffic(
    bearerToken,
    body.agentId,
    body.direction,
    evalResult,
    body.platform,
    body.context,
    flattenContent(body.content),
    typeof body.tool === 'string' ? body.tool : undefined,
  );

  return c.json(evalResult);
}

// ── Approved tools (POST /v1/mcp/tools) ──────────────────────────────

const MAX_TOOL_NAMES = 500;
const MAX_TOOL_NAME_LENGTH = 200;

/**
 * Which of these tool names the agent's approved-tools policies let it call.
 *
 * An approved-tools policy is an `action-allowlist` binding on the outbound
 * tool leg. A name is withheld only when those bindings, run through the same
 * engine and response-level mapping a call goes through, would block a call
 * by that name. Parameter rules are left out: they depend on a call's
 * arguments, and every call is still checked on `/v1/mcp/evaluate` when it is
 * made. So this never shows a tool a call couldn't use, and never hides one a
 * flag-only (monitoring) allowlist would let through.
 */
export async function allowedToolNames(
  agentId: string,
  names: string[],
  bindings: ResolvedPolicyBinding[],
  identity?: NormalizedIdentityClaims[],
): Promise<string[]> {
  const allowlists = filterByScope(bindings, 'tools')
    .filter((b) => b.policyType === 'action-allowlist')
    .map((b) => ({
      ...b,
      config: { ...(b.config ?? {}), actionConstraints: {} },
    }));
  if (allowlists.length === 0) return names;

  const allowed: string[] = [];
  for (const name of names) {
    const checks = await evaluatePolicies(allowlists, '', {
      agentId,
      direction: 'outbound',
      toolName: name,
      toolParams: {},
      identity,
    });
    const verdict = mapResponseLevel(
      resolveResponseLevel(checks.map((check) => check.responseLevel)),
    );
    if (verdict !== 'block') allowed.push(name);
  }
  return allowed;
}

/**
 * POST /v1/mcp/tools
 *
 * Body `{ agentId, tools: string[] }`, answer `{ allowed: string[] }`: the
 * names an MCP Guard may show its client. Same auth as `/v1/mcp/evaluate`.
 */
export async function handleMcpTools(c: Context): Promise<Response> {
  const authResult = await validateAuth(c);
  if (!authResult.valid) {
    return c.json(
      { error: { code: 'INVALID_TOKEN', message: authResult.error } },
      authResult.status as 401,
    );
  }

  let body: { agentId?: unknown; tools?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'Invalid JSON body' } },
      400,
    );
  }

  if (typeof body.agentId !== 'string' || !body.agentId) {
    return c.json(
      { error: { code: 'BAD_REQUEST', message: 'Missing or invalid agentId' } },
      400,
    );
  }
  if (authResult.claims && authResult.claims.agentId !== body.agentId) {
    return c.json(
      { error: { code: 'FORBIDDEN', message: 'agentId does not match token' } },
      403,
    );
  }
  const tools = body.tools;
  if (
    !Array.isArray(tools) ||
    tools.length > MAX_TOOL_NAMES ||
    !tools.every(
      (name) =>
        typeof name === 'string' &&
        name.length > 0 &&
        name.length <= MAX_TOOL_NAME_LENGTH,
    )
  ) {
    return c.json(
      {
        error: {
          code: 'BAD_REQUEST',
          message: `tools must be an array of at most ${MAX_TOOL_NAMES} non-empty names`,
        },
      },
      400,
    );
  }

  const { bindings, identity, error } = await resolveBindings(
    body.agentId,
    'outbound',
  );
  if (error) {
    return c.json(
      { error: { code: 'BINDINGS_UNAVAILABLE', message: error } },
      503,
    );
  }

  const names = [...new Set(tools as string[])];
  const allowed = await allowedToolNames(
    body.agentId,
    names,
    bindings,
    identity,
  );
  return c.json({ allowed });
}
