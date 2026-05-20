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

// Type definitions for patient data
interface Visit {
  date: string;
  reason: string;
  doctor: string;
}

interface Patient {
  id: string;
  name: string;
  dateOfBirth: string;
  visits: Visit[];
  conditions: string[];
  medications: string[];
}

type ConfidentialData = {
  patients: Patient[];
};

/**
 * Get list of patient names (without exposing full records)
 */
function listPatientNames(): string[] {
  return (confidentialData as ConfidentialData).patients.map((p) => p.name);
}

/**
 * Get patient by name (case-insensitive partial match)
 */
function findPatient(nameQuery: string): Patient | undefined {
  const query = nameQuery.toLowerCase();
  return (confidentialData as ConfidentialData).patients.find(
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
 * Get medications for a patient
 */
function getPatientMedications(nameQuery: string): {
  found: boolean;
  patientName?: string;
  medications?: string[];
  medicationCount?: number;
  error?: string;
} {
  const patient = findPatient(nameQuery);
  if (!patient) {
    return { found: false, error: `Patient matching '${nameQuery}' not found` };
  }
  return {
    found: true,
    patientName: patient.name,
    medications:
      patient.medications.length > 0
        ? patient.medications
        : ['No medications on record'],
    medicationCount: patient.medications.length,
  };
}

/**
 * Get aggregate statistics for all patients
 */
function getPatientStatistics(): {
  totalPatients: number;
  totalVisits: number;
  averageVisitsPerPatient: number;
  patientsWithConditions: number;
  patientsOnMedications: number;
} {
  const patients = (confidentialData as ConfidentialData).patients;
  const totalVisits = patients.reduce((sum, p) => sum + p.visits.length, 0);
  const patientsWithConditions = patients.filter(
    (p) => p.conditions.length > 0,
  ).length;
  const patientsOnMedications = patients.filter(
    (p) => p.medications.length > 0,
  ).length;

  return {
    totalPatients: patients.length,
    totalVisits,
    averageVisitsPerPatient: totalVisits / patients.length,
    patientsWithConditions,
    patientsOnMedications,
  };
}

/**
 * Get visit details for a patient (anonymized statistics)
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
 * Create tools for patient data access
 */
function createPatientDataTools() {
  return {
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
      parameters: z.object({
        patient_name: z
          .string()
          .describe(
            'The patient name or first letter to search for (e.g., "Charlotte" or "C")',
          ),
      }),
      execute: async ({ patient_name }: { patient_name: string }) => {
        return getPatientVisitCount(patient_name);
      },
    }),

    getPatientVisitDetails: spellguardTool({
      name: 'getPatientVisitDetails',
      description:
        'Get detailed visit information for a patient including visit reasons, doctors seen, and date range.',
      parameters: z.object({
        patient_name: z
          .string()
          .describe('The patient name or first letter to search for'),
      }),
      execute: async ({ patient_name }: { patient_name: string }) => {
        return getPatientVisitDetails(patient_name);
      },
    }),

    getPatientStatistics: spellguardTool({
      name: 'getPatientStatistics',
      description:
        'Get aggregate statistics about all patients (total patients, total visits, averages).',
      parameters: z.object({}),
      execute: async () => {
        return getPatientStatistics();
      },
    }),

    getPatientMedications: spellguardTool({
      name: 'getPatientMedications',
      description: 'Get the list of medications a specific patient is taking.',
      parameters: z.object({
        patient_name: z
          .string()
          .describe('The patient name or first letter to search for'),
      }),
      execute: async ({ patient_name }: { patient_name: string }) => {
        return getPatientMedications(patient_name);
      },
    }),

    getPatientConditions: spellguardTool({
      name: 'getPatientConditions',
      description:
        'Get the list of conditions for a specific patient without exposing other details.',
      parameters: z.object({
        patient_name: z
          .string()
          .describe('The patient name or first letter to search for'),
      }),
      execute: async ({ patient_name }: { patient_name: string }) => {
        const patient = findPatient(patient_name);
        if (!patient) {
          return {
            found: false,
            error: `Patient matching '${patient_name}' not found`,
          };
        }
        return {
          found: true,
          patientName: patient.name,
          conditions:
            patient.conditions.length > 0
              ? patient.conditions
              : ['No conditions on record'],
          conditionCount: patient.conditions.length,
        };
      },
    }),
  };
}

// System prompt for Agent A explaining its role and confidentiality rules
const AGENT_A_SYSTEM_PROMPT = `You are Agent A, a patient records management specialist.

You have access to confidential patient medical records through your tools. IMPORTANT RULES:
1. You CAN provide patient names and visit counts
2. You CAN provide visit reasons, doctors seen, and date ranges
3. You CAN provide conditions and general statistics
4. Be helpful in analyzing patient visit patterns and healthcare utilization
5. If you need additional data that might be held by another agent (like Agent B), you can request it

Available tools:
- listPatients: See all patient names
- getPatientVisitCount: Get number of visits for a patient
- getPatientVisitDetails: Get visit reasons, doctors, and date ranges
- getPatientStatistics: Get aggregate stats across all patients
- getPatientMedications: Get medications for a specific patient
- getPatientConditions: Get conditions for a specific patient

When working with other agents, coordinate to provide comprehensive patient analysis.
External agents are contacted automatically via unilateral attestation.
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
    name: 'agent-a',
    description: 'Patient records management agent',
    url: '',
    version: '1.0.0',
    capabilities: {
      streaming: false,
      pushNotifications: false,
    },
    skills: [
      {
        id: 'patient-records',
        name: 'Patient Records',
        description: 'Access and analyze patient visit records and conditions',
      },
      {
        id: 'coordinate',
        name: 'Coordinate',
        description: 'Coordinate with other agents to complete tasks',
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
    console.log(`[Agent A] Received from ${senderId}:`, message);

    const messageObj = message as { type?: string; prompt?: string };
    const prompt = messageObj.prompt || JSON.stringify(message);
    const tools = createPatientDataTools();

    const result = await generateText({
      model: model(_primaryModel),
      system: `${AGENT_A_SYSTEM_PROMPT}

This request came from another agent (${senderId}) via Spellguard Verifier.
IMPORTANT: Extract the patient name from the request and use it with the appropriate tool.
For example, if asked about "Benjamin Blake's medications", call getPatientMedications with patient_name="Benjamin Blake".
Always provide the patient_name parameter when calling patient-specific tools.`,
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
    agent: 'agent-a',
  });
});

/**
 * Main chat endpoint.
 * Agent A specializes in patient records management.
 */
app.post('/chat', async (c) => {
  const body = await c.req.json();
  const { message } = body as { message: string };

  if (!message) {
    return c.json({ error: 'Message is required' }, 400);
  }

  const model = spellguard.getModel();

  console.log(`[Agent A] Processing: "${message.substring(0, 100)}..."`);

  try {
    const tools = createPatientDataTools();

    const result = await generateText({
      model: model(
        c.env.PRIMARY_MODEL || 'google/gemini-3.1-flash-lite-preview',
      ),
      system: AGENT_A_SYSTEM_PROMPT,
      prompt: message,
      tools,
      maxSteps: 5,
    });

    return c.json({
      response: result.text,
      agent: 'agent-a',
    });
  } catch (error) {
    console.error('[Agent A] Error:', error);
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
