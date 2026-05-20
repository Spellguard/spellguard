// SPDX-License-Identifier: Apache-2.0

import type { TObject } from '@sinclair/typebox';
import {
  buildAgentContextBlock,
  getConfig,
  resolveAgentCard,
  resolveAndCollectAgentResponses,
} from '@spellguard/client';
import { z } from 'zod';

import {
  DiscoverParameters,
  RouteParameters,
  StatusParameters,
} from './adapter';
import type { SpellguardConfig } from './config';
import type {
  DiscoverData,
  RouteData,
  SpellguardErrorCode,
  StatusData,
  ToolDefinition,
  ToolError,
  ToolResult,
} from './types';

const SpellguardRouteInput = z.object({
  prompt: z
    .string()
    .max(10000)
    .describe('The user prompt to route to referenced agents'),
});

const SpellguardDiscoverInput = z.object({
  agentId: z.string().describe('Agent ID or URL to discover'),
});

function mapError(error: unknown): ToolError {
  const message = error instanceof Error ? error.message : String(error);
  let code: SpellguardErrorCode = 'INTERNAL_ERROR';

  if (
    message.includes('not configured') ||
    message.includes('Verifier attestation failed')
  ) {
    code = 'ATTESTATION_FAILED';
  } else if (
    message.includes('not responding') ||
    message.includes('ECONNREFUSED') ||
    message.includes('fetch failed') ||
    message.includes('network') ||
    message.includes('timeout')
  ) {
    code = 'VERIFIER_UNAVAILABLE';
  } else if (
    message.includes('not found') ||
    message.includes('Could not discover') ||
    message.includes('not registered')
  ) {
    code = 'RECIPIENT_NOT_FOUND';
  } else if (message.includes('rejected')) {
    code = 'MESSAGE_REJECTED';
  } else if (
    message.includes('expired') ||
    message.includes('Channel token stale')
  ) {
    code = 'CHANNEL_EXPIRED';
  }

  return {
    success: false,
    error: { code, message },
  };
}

function logEvent(
  event: string,
  agentId: string,
  extra?: Record<string, unknown>,
) {
  console.log(
    JSON.stringify({
      service: 'openclaw-spellguard-plugin',
      event,
      agentId,
      timestamp: new Date().toISOString(),
      ...extra,
    }),
  );
}

async function checkVerifierHealth(
  verifierUrl: string,
): Promise<StatusData['verifier']['status']> {
  try {
    const resp = await fetch(`${verifierUrl}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    return resp.ok ? 'healthy' : 'unhealthy';
  } catch {
    return 'unreachable';
  }
}

export interface ToolBundle {
  definition: ToolDefinition;
  parameters: TObject;
}

export function createTools(config: SpellguardConfig): ToolBundle[] {
  return [
    {
      parameters: RouteParameters,
      definition: {
        name: 'spellguard_route',
        description:
          'Send a prompt to one or more named Spellguard agents (e.g. agent-a, agent-b) and return their responses. Call this tool whenever the user asks you to query, message, ask, or route a question to another agent. The `prompt` parameter should reference the target agent(s) by name; agent discovery and Verifier-attested delivery are handled for you.',
        async execute(input: unknown): Promise<ToolResult<RouteData>> {
          const startTime = Date.now();
          let parsed: z.infer<typeof SpellguardRouteInput>;
          try {
            parsed = SpellguardRouteInput.parse(input);
          } catch (err) {
            return {
              success: false,
              error: {
                code: 'INVALID_INPUT',
                message: err instanceof Error ? err.message : String(err),
              },
            };
          }

          try {
            const agentResponses = await resolveAndCollectAgentResponses(
              parsed.prompt,
            );
            const contextBlock =
              agentResponses.length > 0
                ? buildAgentContextBlock(agentResponses)
                : null;

            const durationMs = Date.now() - startTime;
            logEvent('route', config.agentId, {
              agentCount: agentResponses.length,
              agents: agentResponses.map((r) => r.agent),
              durationMs,
            });

            return {
              success: true,
              data: { agentResponses, contextBlock },
            };
          } catch (err) {
            const durationMs = Date.now() - startTime;
            const result = mapError(err);
            logEvent('error', config.agentId, {
              errorCode: result.error.code,
              durationMs,
            });
            return result;
          }
        },
      },
    },
    {
      parameters: StatusParameters,
      definition: {
        name: 'spellguard_status',
        description:
          "Returns Spellguard configuration status, Verifier health, and the plugin's identity.",
        async execute(): Promise<ToolResult<StatusData>> {
          try {
            const clientConfig = getConfig();
            const configured = clientConfig !== undefined;
            const verifierUrl =
              clientConfig?.verifierUrl ?? config.verifierUrl ?? '';
            const verifierStatus = verifierUrl
              ? await checkVerifierHealth(verifierUrl)
              : 'unreachable';

            logEvent('status', config.agentId);

            return {
              success: true,
              data: {
                configured,
                verifier: { status: verifierStatus, url: verifierUrl },
                self: {
                  agentId: config.agentId,
                  webhookUrl: config.selfUrl,
                },
              },
            };
          } catch (err) {
            return mapError(err);
          }
        },
      },
    },
    {
      parameters: DiscoverParameters,
      definition: {
        name: 'spellguard_discover',
        description:
          "Retrieves another agent's capabilities via the A2A protocol.",
        async execute(input: unknown): Promise<ToolResult<DiscoverData>> {
          let parsed: z.infer<typeof SpellguardDiscoverInput>;
          try {
            parsed = SpellguardDiscoverInput.parse(input);
          } catch (err) {
            return {
              success: false,
              error: {
                code: 'INVALID_INPUT',
                message: err instanceof Error ? err.message : String(err),
              },
            };
          }

          try {
            const card = await resolveAgentCard(parsed.agentId);
            if (!card) {
              return {
                success: false,
                error: {
                  code: 'RECIPIENT_NOT_FOUND',
                  message: `Could not discover agent: ${parsed.agentId}`,
                },
              };
            }

            logEvent('discover', config.agentId, {
              targetAgent: parsed.agentId,
            });

            return {
              success: true,
              data: { agentCard: card },
            };
          } catch (err) {
            return mapError(err);
          }
        },
      },
    },
  ];
}
