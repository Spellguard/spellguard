// SPDX-License-Identifier: Apache-2.0

/**
 * Agent C - External A2A Agent (No Spellguard)
 *
 * This is an external agent that only supports the A2A protocol.
 * It does NOT use Spellguard for attestation.
 * Used for testing one-sided Spellguard integration.
 *
 * Agent C provides:
 * - Weather data
 * - Stock prices
 * - Public system statistics
 */

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { OpenRouterProvider } from '@openrouter/ai-sdk-provider';
import { generateText, tool } from 'ai';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { z } from 'zod';

// Environment type for Cloudflare Workers
interface Env {
  SELF_URL: string;
  AGENT_ID: string;
  OPENROUTER_API_KEY: string;
  PRIMARY_MODEL?: string;
}

// A2A JSON-RPC types
interface A2ARequest {
  jsonrpc: '2.0';
  id: string;
  method: 'tasks/send' | 'tasks/get';
  params: {
    id: string;
    message: {
      role: 'user';
      parts: Array<{ type: 'text'; text: string }>;
    };
  };
}

interface A2AResponse {
  jsonrpc: '2.0';
  id: string;
  result?: {
    id: string;
    status: { state: 'completed' | 'pending' | 'failed' };
    artifacts?: Array<{ parts: Array<{ type: 'text'; text: string }> }>;
  };
  error?: { code: number; message: string };
}

// Mock data that Agent C provides
const EXTERNAL_DATA = {
  weatherData: {
    location: 'San Francisco, CA',
    temperature: 65,
    unit: 'fahrenheit',
    conditions: 'Partly cloudy',
    humidity: 72,
    windSpeed: 12,
    windDirection: 'NW',
    lastUpdated: new Date().toISOString(),
  },
  stockPrices: [
    { symbol: 'AAPL', price: 185.92, change: 2.34, volume: 52_000_000 },
    { symbol: 'GOOGL', price: 141.8, change: -0.52, volume: 18_000_000 },
    { symbol: 'MSFT', price: 388.47, change: 1.89, volume: 22_000_000 },
    { symbol: 'AMZN', price: 178.25, change: 3.12, volume: 35_000_000 },
    { symbol: 'NVDA', price: 495.22, change: 8.45, volume: 45_000_000 },
  ],
  publicStats: {
    totalQueries: 15234,
    avgResponseTime: 42,
    uptime: '99.97%',
    activeUsers: 1247,
    dataPointsServed: 8_500_000,
  },
};

/**
 * Create tools for external data access
 */
function createExternalDataTools() {
  return {
    getWeather: tool({
      description:
        'Get current weather information including temperature, conditions, humidity, and wind.',
      parameters: z.object({
        location: z
          .string()
          .optional()
          .describe(
            'Location to get weather for (currently only San Francisco supported)',
          ),
      }),
      execute: async ({ location }) => {
        const weather = EXTERNAL_DATA.weatherData;
        return {
          location: weather.location,
          temperature: weather.temperature,
          unit: weather.unit,
          conditions: weather.conditions,
          humidity: `${weather.humidity}%`,
          wind: `${weather.windSpeed} mph ${weather.windDirection}`,
          lastUpdated: weather.lastUpdated,
          note:
            location && location !== 'San Francisco'
              ? 'Note: Only San Francisco data is available. Showing San Francisco weather.'
              : undefined,
        };
      },
    }),

    getStockPrice: tool({
      description:
        'Get current stock price for a specific symbol. Available symbols: AAPL, GOOGL, MSFT, AMZN, NVDA.',
      parameters: z.object({
        symbol: z
          .string()
          .describe('Stock ticker symbol (e.g., AAPL, GOOGL, MSFT)'),
      }),
      execute: async ({ symbol }) => {
        const stock = EXTERNAL_DATA.stockPrices.find(
          (s) => s.symbol.toUpperCase() === symbol.toUpperCase(),
        );
        if (!stock) {
          return {
            found: false,
            error: `Stock symbol '${symbol}' not found. Available: AAPL, GOOGL, MSFT, AMZN, NVDA`,
          };
        }
        return {
          found: true,
          symbol: stock.symbol,
          price: `$${stock.price.toFixed(2)}`,
          change: `${stock.change >= 0 ? '+' : ''}${stock.change.toFixed(2)}`,
          changePercent: `${((stock.change / stock.price) * 100).toFixed(2)}%`,
          volume: stock.volume.toLocaleString(),
        };
      },
    }),

    listStocks: tool({
      description: 'List all available stock prices with their current values.',
      parameters: z.object({}),
      execute: async () => {
        return {
          stocks: EXTERNAL_DATA.stockPrices.map((s) => ({
            symbol: s.symbol,
            price: `$${s.price.toFixed(2)}`,
            change: `${s.change >= 0 ? '+' : ''}${s.change.toFixed(2)}`,
          })),
          count: EXTERNAL_DATA.stockPrices.length,
        };
      },
    }),

    getSystemStats: tool({
      description:
        'Get public system statistics including uptime, query counts, and performance metrics.',
      parameters: z.object({}),
      execute: async () => {
        const stats = EXTERNAL_DATA.publicStats;
        return {
          totalQueries: stats.totalQueries.toLocaleString(),
          avgResponseTime: `${stats.avgResponseTime}ms`,
          uptime: stats.uptime,
          activeUsers: stats.activeUsers.toLocaleString(),
          dataPointsServed: stats.dataPointsServed.toLocaleString(),
        };
      },
    }),

    listCapabilities: tool({
      description: 'List all data and capabilities that Agent C can provide.',
      parameters: z.object({}),
      execute: async () => {
        return {
          capabilities: [
            {
              name: 'Weather Data',
              description:
                'Current weather for San Francisco including temperature, conditions, humidity, and wind',
              tools: ['getWeather'],
            },
            {
              name: 'Stock Prices',
              description:
                'Real-time stock prices for AAPL, GOOGL, MSFT, AMZN, NVDA',
              tools: ['getStockPrice', 'listStocks'],
            },
            {
              name: 'System Statistics',
              description:
                'Public system metrics including uptime and performance',
              tools: ['getSystemStats'],
            },
          ],
        };
      },
    }),
  };
}

// System prompt for Agent C
const AGENT_C_SYSTEM_PROMPT = `You are Agent C, an external data provider agent.

You provide access to:
1. Weather data for San Francisco (temperature, conditions, humidity, wind)
2. Stock prices for major tech companies (AAPL, GOOGL, MSFT, AMZN, NVDA)
3. Public system statistics (uptime, query counts, response times)

Use your tools to retrieve the requested data and provide helpful, concise responses.
If asked what data you can provide, use the listCapabilities tool.

Important: You are a standard A2A agent and do NOT use Spellguard attestation.`;

const app = new Hono<{ Bindings: Env }>();

// Store OpenRouter instance for reuse
let openrouter: OpenRouterProvider | null = null;
let initialized = false;

// Middleware
app.use('*', logger());
app.use('*', cors());

// Initialize OpenRouter on first request
app.use('*', async (c, next) => {
  if (!initialized && c.env.OPENROUTER_API_KEY) {
    openrouter = createOpenRouter({
      apiKey: c.env.OPENROUTER_API_KEY,
    });
    initialized = true;
  }
  await next();
});

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    agent: 'agent-c',
    type: 'external-a2a-only',
    llmEnabled: initialized && openrouter !== null,
  });
});

/**
 * A2A Agent Card - Standard discovery endpoint
 * Note: No 'spellguard-verifier' authentication scheme - this is a plain A2A agent
 */
app.get('/.well-known/agent.json', (c) => {
  const selfUrl = c.env.SELF_URL || 'http://localhost:8789';

  return c.json({
    name: 'agent-c',
    description:
      'External A2A agent providing weather, stock, and public statistics data',
    url: selfUrl,
    version: '1.0.0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    skills: [
      {
        id: 'weather',
        name: 'Weather Data',
        description: 'Provides current weather information for San Francisco',
      },
      {
        id: 'stocks',
        name: 'Stock Prices',
        description: 'Provides current stock prices for major tech companies',
      },
      {
        id: 'stats',
        name: 'Public Statistics',
        description: 'Provides public system statistics and metrics',
      },
    ],
    // Note: No 'spellguard-verifier' in authentication schemes
    authentication: {
      schemes: ['none'],
    },
  });
});

/**
 * A2A JSON-RPC endpoint
 * Handles tasks/send and tasks/get methods
 */
app.post('/a2a', async (c) => {
  const request = (await c.req.json()) as A2ARequest;

  // Validate JSON-RPC format
  if (request.jsonrpc !== '2.0' || !request.id || !request.method) {
    return c.json(
      {
        jsonrpc: '2.0',
        id: request.id || null,
        error: { code: -32600, message: 'Invalid Request' },
      } as A2AResponse,
      400,
    );
  }

  // Extract message text
  const messageText =
    request.params?.message?.parts
      ?.filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('\n') || '';

  console.log(
    `[Agent C] Received A2A request: "${messageText.substring(0, 100)}..."`,
  );

  // Process the request
  let responseText: string;

  if (openrouter) {
    // Use LLM with tools
    try {
      const tools = createExternalDataTools();

      const result = await generateText({
        model: openrouter(
          c.env.PRIMARY_MODEL || 'google/gemini-3.1-flash-lite-preview',
        ),
        system: AGENT_C_SYSTEM_PROMPT,
        prompt: messageText,
        tools,
        maxSteps: 5,
      });

      responseText = result.text;
    } catch (error) {
      console.error('[Agent C] LLM error:', error);
      responseText = `Error processing request: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    // Fallback to simple response if no API key
    responseText = processFallbackRequest(messageText);
  }

  // Return A2A response
  const response: A2AResponse = {
    jsonrpc: '2.0',
    id: request.id,
    result: {
      id: request.params.id,
      status: { state: 'completed' },
      artifacts: [
        {
          parts: [{ type: 'text', text: responseText }],
        },
      ],
    },
  };

  return c.json(response);
});

/**
 * Fallback request processing when no LLM is available
 */
function processFallbackRequest(message: string): string {
  const lowerMessage = message.toLowerCase();

  if (
    lowerMessage.includes('weather') ||
    lowerMessage.includes('temperature')
  ) {
    const w = EXTERNAL_DATA.weatherData;
    return `Weather in ${w.location}: ${w.temperature}°F, ${w.conditions}. Humidity: ${w.humidity}%. Wind: ${w.windSpeed} mph ${w.windDirection}.`;
  }

  if (lowerMessage.includes('stock') || lowerMessage.includes('price')) {
    const stocks = EXTERNAL_DATA.stockPrices
      .map(
        (s) =>
          `${s.symbol}: $${s.price.toFixed(2)} (${s.change >= 0 ? '+' : ''}${s.change.toFixed(2)})`,
      )
      .join(', ');
    return `Stock prices: ${stocks}`;
  }

  if (lowerMessage.includes('stat') || lowerMessage.includes('uptime')) {
    const s = EXTERNAL_DATA.publicStats;
    return `System stats: ${s.totalQueries.toLocaleString()} queries, ${s.avgResponseTime}ms avg response, ${s.uptime} uptime.`;
  }

  if (
    lowerMessage.includes('capabilit') ||
    lowerMessage.includes('what can') ||
    lowerMessage.includes('provide')
  ) {
    return 'Agent C provides: weather data (San Francisco), stock prices (AAPL, GOOGL, MSFT, AMZN, NVDA), and system statistics.';
  }

  return 'Agent C can provide weather data, stock prices, or system statistics. Please ask about one of these topics.';
}

export default app;
