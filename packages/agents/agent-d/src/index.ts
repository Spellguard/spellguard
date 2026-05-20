// SPDX-License-Identifier: Apache-2.0

import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { ChatOpenAI } from '@langchain/openai';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createSpellguard } from '@spellguard/client';
import { createSpellguardChatModel } from '@spellguard/langchain';
import type { Hono as HonoType } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';

import patientData from '../data.json';

interface DiabetesPatient {
  id: string;
  name: string;
  dateOfBirth: string;
  diabetesType: 'Type 1' | 'Type 2';
  diagnosisDate: string;
  lastHbA1c: number;
  lastHbA1cDate: string;
  bmi: number;
  conditions: string[];
  medications: string[];
  notes: string;
}

function formatPatientContext(): string {
  return (patientData.patients as DiabetesPatient[])
    .map(
      (p) =>
        `- ${p.name} (${p.diabetesType}, diagnosed ${p.diagnosisDate}, HbA1c ${p.lastHbA1c}% as of ${p.lastHbA1cDate}, BMI ${p.bmi}): ${p.conditions.join(', ')}. Meds: ${p.medications.join(', ')}. Notes: ${p.notes}`,
    )
    .join('\n');
}

// Environment type for Cloudflare Workers
interface Env {
  MANAGEMENT_URL: string;
  SPELLGUARD_AGENT_SECRET: string;
  SELF_URL: string;
  AGENT_ID: string;
  CODE_HASH: string;
  OPENROUTER_API_KEY: string;
  VERIFIER_URL?: string;
  EXPECTED_VERIFIER_IMAGE_HASH?: string;
  PRIMARY_MODEL?: string;
  INTENT_MODEL?: string;
}

const SYSTEM_PROMPT = `You are Agent D, a research and clinical guidelines specialist powered by LangChain.

You have broad knowledge of medical research, clinical guidelines, and evidence-based practices.
You also have direct access to the following diabetes patient records:

${formatPatientContext()}

Your capabilities:
- Summarise clinical guidelines and research findings for specific patients or in general
- Explain medical concepts clearly
- Cross-reference information from other agents (Agent A for broader patient records, Agent B for lab data)
- Provide evidence-based, patient-specific recommendations based on the records above

When asked about a specific patient, look them up in your records and tailor your guidelines response to their situation (HbA1c, comorbidities, medications, diabetes type).

All your responses are logged through Spellguard Verifier for audit purposes.`;

const app = new Hono<{ Bindings: Env }>();

app.use('*', logger());
app.use('*', cors());

// biome-ignore lint/suspicious/noExplicitAny: BaseChatModel generic variance
const spellguard = createSpellguard<Env, BaseChatModel<any>>({
  agentCard: {
    name: 'agent-d',
    description: 'Research and clinical guidelines agent (LangChain)',
    url: '',
    version: '1.0.0',
    capabilities: { streaming: false, pushNotifications: false },
    skills: [
      {
        id: 'clinical-guidelines',
        name: 'Clinical Guidelines',
        description:
          'Provides evidence-based clinical guidelines and research summaries',
      },
      {
        id: 'coordinate',
        name: 'Coordinate',
        description: 'Coordinates with Agent A and Agent B to enrich responses',
      },
    ],
  },
  config: (env: Env) =>
    env.MANAGEMENT_URL && env.SPELLGUARD_AGENT_SECRET
      ? {
          type: 'managed',
          agentId: env.AGENT_ID,
          agentSecret: env.SPELLGUARD_AGENT_SECRET,
          managementUrl: env.MANAGEMENT_URL,
          selfUrl: env.SELF_URL,
          codeHash: env.CODE_HASH,
        }
      : {
          type: 'direct',
          agentId: env.AGENT_ID,
          verifierUrl: env.VERIFIER_URL || 'http://localhost:3000',
          selfUrl: env.SELF_URL,
          codeHash: env.CODE_HASH,
          expectedVerifierImageHash:
            env.EXPECTED_VERIFIER_IMAGE_HASH || 'sha384:dev-placeholder',
        },
  model: (env: Env) => {
    const chatModel = new ChatOpenAI({
      model: env.PRIMARY_MODEL || 'google/gemini-3.1-flash-lite-preview',
      apiKey: env.OPENROUTER_API_KEY,
      configuration: { baseURL: 'https://openrouter.ai/api/v1' },
    });
    return createSpellguardChatModel(chatModel);
  },
  intentDetectionModel: (env: Env) =>
    createOpenRouter({ apiKey: env.OPENROUTER_API_KEY })(
      env.INTENT_MODEL || 'google/gemini-3.1-flash-lite-preview',
    ),
  onMessage: async ({ message, senderId, model }) => {
    console.log(`[Agent D] Received from ${senderId}:`, message);

    const messageObj = message as { type?: string; prompt?: string };
    const prompt = messageObj.prompt || JSON.stringify(message);

    const result = await model.invoke([
      new SystemMessage(
        `${SYSTEM_PROMPT}\n\nThis request came from another agent (${senderId}) via Spellguard Verifier.`,
      ),
      new HumanMessage(prompt),
    ]);

    return { response: result.content };
  },
});

// Cast: @spellguard/client may resolve a different hono version than agent-d's.
// The types are structurally identical.
app.route(
  '/',
  spellguard.middleware() as unknown as HonoType<{ Bindings: Env }>,
);

app.get('/health', (c) =>
  c.json({ status: 'ok', agent: 'agent-d', framework: 'langchain' }),
);

/**
 * Main chat endpoint.
 * Uses createSpellguardChatModel so outgoing agent references are
 * automatically detected and routed through the Verifier.
 */
app.post('/chat', async (c) => {
  const body = await c.req.json();
  const { message } = body as { message: string };

  if (!message) {
    return c.json({ error: 'Message is required' }, 400);
  }

  const model = spellguard.getModel();

  console.log(`[Agent D] Processing: "${message.substring(0, 100)}..."`);

  try {
    const result = await model.invoke([
      new SystemMessage(SYSTEM_PROMPT),
      new HumanMessage(message),
    ]);

    return c.json({
      response: result.content,
      agent: 'agent-d',
      framework: 'langchain',
    });
  } catch (error) {
    console.error('[Agent D] Error:', error);
    return c.json(
      {
        error: 'Failed to process request',
        details: error instanceof Error ? error.message : String(error),
      },
      500,
    );
  }
});

export default app;
