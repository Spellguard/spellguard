// SPDX-License-Identifier: Apache-2.0

import type { PlatformParser } from '../types';
import { GenericParser } from './generic';
import { SlackParser } from './slack';

const parsers: PlatformParser[] = [
  new SlackParser(),
  // Future: new DiscordParser(), new TeamsParser()
];

/**
 * Auto-detect which platform an MCP server represents based on its tools.
 * Returns the first matching parser, or the generic fallback.
 */
export function detectPlatform(tools: unknown[]): PlatformParser {
  for (const parser of parsers) {
    if (parser.detect(tools)) return parser;
  }
  return new GenericParser();
}
