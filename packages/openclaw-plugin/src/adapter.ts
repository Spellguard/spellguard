// SPDX-License-Identifier: Apache-2.0

import { type TObject, Type } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from 'openclaw/plugin-sdk';
import type { ToolDefinition, ToolResult } from './types';

export const RouteParameters = Type.Object({
  prompt: Type.String({
    description: 'The user prompt to route to referenced agents',
    maxLength: 10000,
  }),
});

export const StatusParameters = Type.Object({});

export const DiscoverParameters = Type.Object({
  agentId: Type.String({ description: 'Agent ID or URL to discover' }),
});

export function toAgentToolResult<T>(
  result: ToolResult<T>,
): AgentToolResult<ToolResult<T>> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    details: result,
  };
}

export function createAgentTool(
  tool: ToolDefinition,
  parameters: TObject,
): AgentTool {
  return {
    name: tool.name,
    label: tool.name.replace(/_/g, ' '),
    description: tool.description,
    parameters,
    async execute(_toolCallId: string, params: unknown) {
      const result = await tool.execute(params);
      return toAgentToolResult(result);
    },
  };
}
