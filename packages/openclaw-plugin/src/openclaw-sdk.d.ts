// SPDX-License-Identifier: Apache-2.0

declare module 'openclaw/plugin-sdk' {
  import type { TSchema, Static } from '@sinclair/typebox';

  export interface TextContent {
    type: 'text';
    text: string;
  }

  export interface ImageContent {
    type: 'image';
    url: string;
    mediaType?: string;
  }

  export interface AgentToolResult<T = unknown> {
    content: (TextContent | ImageContent)[];
    details: T;
  }

  export type AgentToolUpdateCallback<T> = (
    update: Partial<AgentToolResult<T>>,
  ) => void;

  export interface AgentTool<
    TParameters extends TSchema = TSchema,
    TDetails = unknown,
  > {
    name: string;
    label: string;
    description: string;
    parameters: TParameters;
    execute: (
      toolCallId: string,
      params: Static<TParameters>,
      signal?: AbortSignal,
      onUpdate?: AgentToolUpdateCallback<TDetails>,
    ) => Promise<AgentToolResult<TDetails>>;
  }

  export interface OpenClawPluginToolContext {
    config: unknown;
    sessionKey: string;
  }

  export type OpenClawPluginToolFactory = (
    ctx: OpenClawPluginToolContext,
  ) => AnyAgentTool | AnyAgentTool[] | null | undefined;

  export interface OpenClawPluginToolOptions {
    name?: string;
    names?: string[];
    optional?: boolean;
  }

  export interface PluginLogger {
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
  }

  /** Minimal subset of the OpenClaw Slack account config. */
  export interface SlackAccountConfig {
    mode?: 'socket' | 'http';
    signingSecret?: string;
    botToken?: string;
    enabled?: boolean;
  }

  /** Minimal subset of the OpenClaw Slack channel config. */
  export interface SlackConfig extends SlackAccountConfig {
    accounts?: Record<string, SlackAccountConfig>;
  }

  /** Minimal subset of the OpenClaw Teams channel config. */
  export interface MSTeamsConfig {
    appId?: string;
    appPassword?: string;
    tenantId?: string;
    webhook?: { port?: number; path?: string };
    enabled?: boolean;
  }

  /** Minimal subset of the full OpenClaw config exposed to plugins. */
  export interface OpenClawConfig {
    gateway?: { port?: number };
    channels?: { slack?: SlackConfig; msteams?: MSTeamsConfig };
    [key: string]: unknown;
  }

  export interface OpenClawPluginApi {
    config: OpenClawConfig;
    pluginConfig: Record<string, unknown> | undefined;
    logger: PluginLogger;
    registerTool: (
      tool: AnyAgentTool | OpenClawPluginToolFactory,
      opts?: OpenClawPluginToolOptions,
    ) => void;
    registerService: (service: OpenClawPluginService) => void;
    on: (
      event: string,
      // biome-ignore lint/complexity/noBannedTypes: handler signatures vary per event
      handler: Function,
      opts?: { priority?: number },
    ) => void;
  }
}
