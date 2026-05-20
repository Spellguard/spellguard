// SPDX-License-Identifier: Apache-2.0

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import type { OpenRouterProvider } from '@openrouter/ai-sdk-provider';
import { createSpellguard } from '@spellguard/client';
import { generateText, spellguardTool, tool } from '@spellguard/client/ai';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { z } from 'zod';

// Import confidential data (bundled at build time)
import confidentialData from '../data.json';

// Type for the confidential data structure
type ConfidentialData = typeof confidentialData;

// Patient-specific type definitions
interface PatientVisit {
  date: string;
  reason: string;
  doctor: string;
}

interface PatientLabResults {
  cholesterol: number;
  bloodPressure: string;
  glucose: number;
  A1C?: number;
  troponin?: number;
  IgE?: number;
  hemoglobin?: number;
  ESR?: number;
  CRP?: number;
}

interface Patient {
  id: string;
  name: string;
  dateOfBirth: string;
  visits: PatientVisit[];
  labResults: PatientLabResults;
  insuranceProvider: string;
}

/**
 * Get list of patient names (without exposing full records)
 */
function listPatientNames(): string[] {
  const patients = (confidentialData as { patients?: Patient[] }).patients;
  if (!patients) return [];
  return patients.map((p) => p.name);
}

/**
 * Get patient by name (case-insensitive partial match)
 */
function findPatient(nameQuery: string): Patient | undefined {
  const patients = (confidentialData as { patients?: Patient[] }).patients;
  if (!patients) return undefined;
  const query = nameQuery.toLowerCase();
  return patients.find(
    (p) =>
      p.name.toLowerCase().includes(query) ||
      p.name.toLowerCase().startsWith(query.charAt(0)),
  );
}

/**
 * Get visit count for a patient
 */
function getPatientVisitCount(nameQuery: string): {
  found: boolean;
  patientName?: string;
  visitCount?: number;
  error?: string;
} {
  const patient = findPatient(nameQuery);
  if (!patient) {
    return { found: false, error: `Patient matching '${nameQuery}' not found` };
  }
  return {
    found: true,
    patientName: patient.name,
    visitCount: patient.visits.length,
  };
}

/**
 * Get patient visit details
 */
function getPatientVisitDetails(nameQuery: string): {
  found: boolean;
  patientName?: string;
  visitCount?: number;
  visitReasons?: string[];
  doctors?: string[];
  dateRange?: { earliest: string; latest: string };
  error?: string;
} {
  const patient = findPatient(nameQuery);
  if (!patient) {
    return { found: false, error: `Patient matching '${nameQuery}' not found` };
  }

  const visits = patient.visits;
  const dates = visits.map((v) => v.date).sort();

  return {
    found: true,
    patientName: patient.name,
    visitCount: visits.length,
    visitReasons: [...new Set(visits.map((v) => v.reason))],
    doctors: [...new Set(visits.map((v) => v.doctor))],
    dateRange:
      dates.length > 0
        ? { earliest: dates[0], latest: dates[dates.length - 1] }
        : undefined,
  };
}

/**
 * Get patient lab results (without raw values, just insights)
 */
function getPatientLabInsights(nameQuery: string): {
  found: boolean;
  patientName?: string;
  labMetrics?: string[];
  healthIndicators?: {
    cholesterolStatus: string;
    glucoseStatus: string;
  };
  error?: string;
} {
  const patient = findPatient(nameQuery);
  if (!patient) {
    return { found: false, error: `Patient matching '${nameQuery}' not found` };
  }

  const labs = patient.labResults;
  const cholesterol = labs.cholesterol;
  const glucose = labs.glucose;

  return {
    found: true,
    patientName: patient.name,
    labMetrics: Object.keys(labs),
    healthIndicators: {
      cholesterolStatus:
        cholesterol < 200
          ? 'Normal'
          : cholesterol < 240
            ? 'Borderline'
            : 'High',
      glucoseStatus:
        glucose < 100 ? 'Normal' : glucose < 126 ? 'Pre-diabetic' : 'Diabetic',
    },
  };
}

/**
 * Get list of available data keys (without exposing values)
 */
function listDataKeys(): string[] {
  return Object.keys(confidentialData);
}

/**
 * Analyze numeric data without exposing raw values
 */
function analyzeNumericData(key: string): {
  available: boolean;
  type?: string;
  stats?: {
    count: number;
    min: number;
    max: number;
    average: number;
    sum: number;
    median: number;
  };
  error?: string;
} {
  const data = confidentialData[key as keyof ConfidentialData];

  if (data === undefined) {
    return { available: false, error: `Key '${key}' not found` };
  }

  if (Array.isArray(data) && data.every((v) => typeof v === 'number')) {
    const numbers = data as number[];
    const sorted = [...numbers].sort((a, b) => a - b);
    const sum = numbers.reduce((a, b) => a + b, 0);
    return {
      available: true,
      type: 'numeric_array',
      stats: {
        count: numbers.length,
        min: Math.min(...numbers),
        max: Math.max(...numbers),
        average: sum / numbers.length,
        sum,
        median:
          numbers.length % 2 === 0
            ? (sorted[numbers.length / 2 - 1] + sorted[numbers.length / 2]) / 2
            : sorted[Math.floor(numbers.length / 2)],
      },
    };
  }

  if (typeof data === 'object' && !Array.isArray(data)) {
    const values = Object.values(data);
    if (values.every((v) => typeof v === 'number')) {
      const numbers = values as number[];
      const sorted = [...numbers].sort((a, b) => a - b);
      const sum = numbers.reduce((a, b) => a + b, 0);
      return {
        available: true,
        type: 'numeric_object',
        stats: {
          count: numbers.length,
          min: Math.min(...numbers),
          max: Math.max(...numbers),
          average: sum / numbers.length,
          sum,
          median:
            numbers.length % 2 === 0
              ? (sorted[numbers.length / 2 - 1] + sorted[numbers.length / 2]) /
                2
              : sorted[Math.floor(numbers.length / 2)],
        },
      };
    }
  }

  return {
    available: true,
    type: Array.isArray(data) ? 'array' : typeof data,
    error: 'Data is not numeric, cannot compute statistics',
  };
}

/**
 * Get metadata about a data key without exposing values
 */
function getDataMetadata(key: string): {
  exists: boolean;
  type?: string;
  itemCount?: number;
  keys?: string[];
} {
  const data = confidentialData[key as keyof ConfidentialData];

  if (data === undefined) {
    return { exists: false };
  }

  if (Array.isArray(data)) {
    return {
      exists: true,
      type: 'array',
      itemCount: data.length,
    };
  }

  if (typeof data === 'object') {
    return {
      exists: true,
      type: 'object',
      itemCount: Object.keys(data).length,
      keys: Object.keys(data),
    };
  }

  return {
    exists: true,
    type: typeof data,
  };
}

/**
 * Create tools for confidential data access
 */
/**
 * Normalize LLM tool arguments that may use `patient_name` instead of `patient`.
 * LLMs are non-deterministic about parameter naming; this accepts both.
 */
function normalizePatientArg(val: unknown): unknown {
  if (typeof val === 'object' && val !== null) {
    const obj = val as Record<string, unknown>;
    // LLMs are non-deterministic about parameter naming — accept all variants
    const alt = obj.patient_name ?? obj.patientName ?? obj.name;
    if (!obj.patient && alt) {
      return { ...obj, patient: alt };
    }
  }
  return val;
}

function createConfidentialDataTools() {
  return {
    listAvailableData: tool({
      description:
        'List all available confidential data keys. Does not expose any values.',
      parameters: z.object({}),
      execute: async () => {
        const keys = listDataKeys();
        return {
          availableKeys: keys,
          message: `Found ${keys.length} confidential data sets: ${keys.join(', ')}`,
        };
      },
    }),

    getDataInfo: tool({
      description:
        'Get metadata about a specific data key (type, count) without exposing values. You MUST provide the dataKey parameter.',
      parameters: z.object({
        dataKey: z
          .string()
          .default('')
          .describe('The data key to get information about'),
      }),
      execute: async ({ dataKey }) => {
        if (!dataKey) {
          return {
            available: false,
            error:
              'Missing dataKey parameter. Use listAvailableData first to see valid keys.',
          };
        }
        return getDataMetadata(dataKey);
      },
    }),

    analyzeData: tool({
      description:
        'Compute aggregate statistics (min, max, average, sum, median) for numeric data sets like employee_salaries or quarterly_revenue. REQUIRES a specific dataKey parameter. Only use this for numeric data analysis - NOT for patient medications or conditions (those are handled by Agent A).',
      parameters: z.object({
        dataKey: z
          .string()
          .default('')
          .describe(
            'REQUIRED: The data key to analyze (e.g., "employee_salaries", "quarterly_revenue"). Use listAvailableData first to see valid keys.',
          ),
      }),
      execute: async ({ dataKey }) => {
        if (!dataKey) {
          return {
            error:
              'Missing dataKey parameter. Use listAvailableData first to see valid keys.',
          };
        }
        return analyzeNumericData(dataKey);
      },
    }),

    compareDataSets: tool({
      description:
        'Compare statistics between two numeric data sets without exposing raw values. Both dataKey parameters are required.',
      parameters: z.object({
        firstDataKey: z
          .string()
          .default('')
          .describe('First data key to compare'),
        secondDataKey: z
          .string()
          .default('')
          .describe('Second data key to compare'),
      }),
      execute: async ({ firstDataKey, secondDataKey }) => {
        if (!firstDataKey || !secondDataKey) {
          return {
            success: false,
            error:
              'Both firstDataKey and secondDataKey are required. Use listAvailableData first to see valid keys.',
          };
        }
        const analysis1 = analyzeNumericData(firstDataKey);
        const analysis2 = analyzeNumericData(secondDataKey);

        if (!analysis1.stats || !analysis2.stats) {
          return {
            success: false,
            error: 'Both keys must contain numeric data for comparison',
            details: { firstDataKey: analysis1, secondDataKey: analysis2 },
          };
        }

        return {
          success: true,
          comparison: {
            [firstDataKey]: analysis1.stats,
            [secondDataKey]: analysis2.stats,
            insights: {
              averageDifference:
                analysis1.stats.average - analysis2.stats.average,
              sumRatio: analysis1.stats.sum / analysis2.stats.sum,
              countDifference: analysis1.stats.count - analysis2.stats.count,
            },
          },
        };
      },
    }),

    // Patient-specific tools — wrapped with spellguardTool for tool policy enforcement
    listPatients: spellguardTool({
      name: 'listPatients',
      description:
        'List all patient names in the system. Does not expose detailed records.',
      parameters: z.object({}),
      execute: async () => {
        const names = listPatientNames();
        return {
          patientNames: names,
          message: `Found ${names.length} patients: ${names.join(', ')}`,
        };
      },
    }),

    getPatientVisitCount: spellguardTool({
      name: 'getPatientVisitCount',
      description:
        'Get the number of doctor visits for a specific patient. Provide a patient name or first letter.',
      parameters: z.preprocess(
        normalizePatientArg,
        z.object({
          patient: z
            .string()
            .describe(
              'The patient name or first letter to search for (e.g., "Charlotte" or "C")',
            ),
        }),
      ),
      execute: async ({ patient }: { patient: string }) => {
        return getPatientVisitCount(patient);
      },
    }),

    getPatientVisitDetails: spellguardTool({
      name: 'getPatientVisitDetails',
      description:
        'Get detailed visit information for a patient including visit reasons, doctors seen, and date range.',
      parameters: z.preprocess(
        normalizePatientArg,
        z.object({
          patient: z
            .string()
            .describe('The patient name or first letter to search for'),
        }),
      ),
      execute: async ({ patient }: { patient: string }) => {
        return getPatientVisitDetails(patient);
      },
    }),

    getPatientLabInsights: spellguardTool({
      name: 'getPatientLabInsights',
      description:
        'Get lab result insights for a patient (health status indicators) without exposing raw values.',
      parameters: z.preprocess(
        normalizePatientArg,
        z.object({
          patient: z
            .string()
            .describe('The patient name or first letter to search for'),
        }),
      ),
      execute: async ({ patient }: { patient: string }) => {
        return getPatientLabInsights(patient);
      },
    }),

    getPatientInsurance: spellguardTool({
      name: 'getPatientInsurance',
      description: 'Get the insurance provider for a specific patient.',
      parameters: z.preprocess(
        normalizePatientArg,
        z.object({
          patient: z
            .string()
            .describe('The patient name or first letter to search for'),
        }),
      ),
      execute: async ({ patient }: { patient: string }) => {
        const found = findPatient(patient);
        if (!found) {
          return {
            found: false,
            error: `Patient matching '${patient}' not found`,
          };
        }
        return {
          found: true,
          patientName: found.name,
          insuranceProvider: found.insuranceProvider,
        };
      },
    }),
  };
}

// System prompt for Agent B explaining confidentiality rules
const AGENT_B_SYSTEM_PROMPT = `You are Agent B, a confidential data analysis specialist.

You have access to sensitive internal data and patient records through your tools. IMPORTANT RULES:
1. NEVER disclose raw values from the confidential data (especially lab results)
2. You CAN provide aggregate statistics (averages, sums, counts, min/max, medians)
3. You CAN describe trends and patterns in general terms
4. You CAN compare data sets using statistical measures
5. You CAN provide health status indicators (Normal/Borderline/High) for patient lab results
6. If asked for specific raw values, politely explain that you can only provide aggregated insights or status indicators

DATA BOUNDARIES - IMPORTANT:
- You do NOT have medication data. Medications are managed by Agent A.
- You do NOT have patient conditions. Conditions are managed by Agent A.
- If asked about medications or conditions, you MUST route the request to Agent A.
- When the user explicitly asks you to get data from another agent (e.g., "get this from Agent A"), you must route to that agent.

Available tools:
- listAvailableData: See what data sets are available
- getDataInfo: Get metadata (type, count) about a data set
- analyzeData: Compute statistics on numeric data (requires a dataKey parameter - do NOT call without it)
- compareDataSets: Compare two data sets statistically
- listPatients: See all patient names
- getPatientVisitCount: Get number of visits for a patient
- getPatientVisitDetails: Get visit reasons, doctors, and date ranges
- getPatientLabInsights: Get health indicators from lab results
- getPatientInsurance: Get insurance provider for a patient

IMPORTANT: Only call tools with proper parameters. If you don't know what parameter to provide, do NOT call the tool with empty values.

When responding to other agents, maintain the same confidentiality rules.
All your data access is logged through Spellguard for audit purposes.`;

// Environment type for Cloudflare Workers
interface Env {
  MANAGEMENT_URL: string;
  SPELLGUARD_AGENT_SECRET: string;
  SELF_URL: string;
  AGENT_ID: string;
  CODE_HASH: string;
  OPENROUTER_API_KEY: string;
  // Legacy: direct Verifier URL (used in dev when management isn't running)
  VERIFIER_URL?: string;
  EXPECTED_VERIFIER_IMAGE_HASH?: string;
  PRIMARY_MODEL?: string;
  INTENT_MODEL?: string;
}

const app = new Hono<{ Bindings: Env }>();

// Middleware
app.use('*', logger());
app.use('*', cors());

// Captured at init time so onMessage (which has no env) can use the configured model name.
let _primaryModel = 'google/gemini-3.1-flash-lite-preview';

const spellguard = createSpellguard<Env, OpenRouterProvider>({
  agentCard: {
    name: 'agent-b',
    description: 'Data analysis, patient records, and lab results agent',
    url: '',
    version: '1.0.0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    skills: [
      {
        id: 'analyze-data',
        name: 'Analyze Data',
        description: 'Analyzes structured data and returns insights',
      },
      {
        id: 'process-array',
        name: 'Process Array',
        description: 'Processes arrays of numbers and returns statistics',
      },
      {
        id: 'patient-records',
        name: 'Patient Records',
        description:
          'Access patient visit records, lab results, and insurance info',
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
  model: (env: Env) => createOpenRouter({ apiKey: env.OPENROUTER_API_KEY }),
  intentDetectionModel: (env: Env) =>
    createOpenRouter({ apiKey: env.OPENROUTER_API_KEY })(
      env.INTENT_MODEL || 'google/gemini-3.1-flash-lite-preview',
    ),
  onInitialized: (env: Env) => {
    _primaryModel = env.PRIMARY_MODEL || 'google/gemini-3.1-flash-lite-preview';
  },
  onMessage: async ({ message, senderId, model }) => {
    console.log(`[Agent B] Received from ${senderId}:`, message);

    const messageObj = message as { type?: string; prompt?: string };
    const prompt = messageObj.prompt || JSON.stringify(message);
    const tools = createConfidentialDataTools();

    const result = await generateText({
      model: model(_primaryModel),
      system: `${AGENT_B_SYSTEM_PROMPT}

This request came from another agent (${senderId}) via Spellguard Verifier.
Remember: provide only aggregate insights, never raw confidential values.`,
      prompt,
      tools,
      maxSteps: 5,
    });

    return { response: result.text };
  },
});

app.route('/', spellguard.middleware());

// Health check
app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    agent: 'agent-b',
  });
});

/**
 * Main chat endpoint.
 * Agent B specializes in data analysis.
 */
app.post('/chat', async (c) => {
  const body = await c.req.json();
  const { message } = body as { message: string };

  if (!message) {
    return c.json({ error: 'Message is required' }, 400);
  }

  const model = spellguard.getModel();

  console.log(`[Agent B] Processing: "${message.substring(0, 100)}..."`);

  const tools = createConfidentialDataTools();
  const maxAttempts = 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = await generateText({
        model: model(
          c.env.PRIMARY_MODEL || 'google/gemini-3.1-flash-lite-preview',
        ),
        system: AGENT_B_SYSTEM_PROMPT,
        prompt: message,
        tools,
        maxSteps: 10,
      });

      // If the LLM exhausted all steps on tool calls without a final
      // synthesis, make one more call without tools to force a summary.
      let text = result.text;
      if (!text || text.length < 20) {
        const stepTexts = result.steps
          ?.map((s: { text?: string }) => s.text)
          .filter(Boolean)
          .join('\n');
        const synthesis = await generateText({
          model: model(
            c.env.PRIMARY_MODEL || 'google/gemini-3.1-flash-lite-preview',
          ),
          system: AGENT_B_SYSTEM_PROMPT,
          prompt: `Based on the analysis you just performed, provide a concise summary answering the user's original question: "${message}"\n\nYour analysis notes:\n${stepTexts || '(no intermediate notes)'}`,
        });
        text = synthesis.text;
      }

      return c.json({
        response: text,
        agent: 'agent-b',
      });
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      // Retry on tool argument validation errors (LLM non-determinism)
      if (msg.includes('Invalid arguments for tool') && attempt < maxAttempts) {
        console.warn(
          `[Agent B] Tool argument error (attempt ${attempt}/${maxAttempts}), retrying: ${msg.substring(0, 120)}`,
        );
        continue;
      }
      break;
    }
  }

  console.error('[Agent B] Error:', lastError);
  return c.json(
    {
      error: 'Failed to process request',
      details:
        lastError instanceof Error ? lastError.message : String(lastError),
    },
    500,
  );
});

/**
 * Data analysis endpoint.
 * Accepts arrays of numbers and returns analysis.
 */
app.post('/analyze', async (c) => {
  const body = await c.req.json();
  const { data } = body as { data: number[] };

  if (!data || !Array.isArray(data)) {
    return c.json({ error: 'Data array is required' }, 400);
  }

  // Compute basic statistics
  const sum = data.reduce((a, b) => a + b, 0);
  const avg = sum / data.length;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const sorted = [...data].sort((a, b) => a - b);
  const median =
    data.length % 2 === 0
      ? (sorted[data.length / 2 - 1] + sorted[data.length / 2]) / 2
      : sorted[Math.floor(data.length / 2)];

  return c.json({
    analysis: {
      count: data.length,
      sum,
      average: avg,
      min,
      max,
      median,
      range: max - min,
    },
    agent: 'agent-b',
  });
});

export default app;
