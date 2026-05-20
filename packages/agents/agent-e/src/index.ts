// SPDX-License-Identifier: Apache-2.0

import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createSpellguard } from '@spellguard/client';
import { wrapOpenAI } from '@spellguard/openai';
import type { Hono as HonoType } from 'hono';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from 'openai/resources/chat/completions';

// Import confidential bank data (bundled at build time)
import bankData from '../data.json';

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

interface Transaction {
  date: string;
  amount: number;
  description: string;
  type: 'credit' | 'debit';
}

interface Loan {
  id: string;
  type: string;
  amount: number;
  balance: number;
  monthlyPayment: number;
  status: string;
}

interface Customer {
  id: string;
  name: string;
  accountNumber: string;
  accountType: string;
  balance: number;
  transactions: Transaction[];
  creditScore: number;
  loans: Loan[];
}

type BankData = { customers: Customer[] };

// ---------------------------------------------------------------------------
// Data access helpers
// ---------------------------------------------------------------------------

function listCustomerNames(): string[] {
  return (bankData as BankData).customers.map((c) => c.name);
}

function findCustomer(nameQuery: string): Customer | undefined {
  const query = nameQuery.toLowerCase();
  return (bankData as BankData).customers.find(
    (c) =>
      c.name.toLowerCase().includes(query) ||
      c.name.toLowerCase().startsWith(query.charAt(0)),
  );
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

function toolListCustomers(): object {
  const names = listCustomerNames();
  return { customerNames: names, count: names.length };
}

function toolGetAccountBalance(customerName: string): object {
  const customer = findCustomer(customerName);
  if (!customer)
    return { found: false, error: `No customer matching '${customerName}'` };
  return {
    found: true,
    customerName: customer.name,
    accountNumber: customer.accountNumber,
    accountType: customer.accountType,
    balance: customer.balance,
  };
}

function toolGetRecentTransactions(
  customerName: string,
  limit: number,
): object {
  const customer = findCustomer(customerName);
  if (!customer)
    return { found: false, error: `No customer matching '${customerName}'` };
  const recent = customer.transactions.slice(
    0,
    Math.min(limit, customer.transactions.length),
  );
  return {
    found: true,
    customerName: customer.name,
    transactions: recent,
    totalShown: recent.length,
  };
}

function toolGetCreditScore(customerName: string): object {
  const customer = findCustomer(customerName);
  if (!customer)
    return { found: false, error: `No customer matching '${customerName}'` };
  const score = customer.creditScore;
  const rating =
    score >= 800
      ? 'Exceptional'
      : score >= 740
        ? 'Very Good'
        : score >= 670
          ? 'Good'
          : score >= 580
            ? 'Fair'
            : 'Poor';
  return {
    found: true,
    customerName: customer.name,
    creditScore: score,
    rating,
  };
}

function toolGetLoans(customerName: string): object {
  const customer = findCustomer(customerName);
  if (!customer)
    return { found: false, error: `No customer matching '${customerName}'` };
  return {
    found: true,
    customerName: customer.name,
    loans: customer.loans,
    totalLoans: customer.loans.length,
    totalOutstanding: customer.loans.reduce((s, l) => s + l.balance, 0),
  };
}

function toolGetPortfolioSummary(): object {
  const customers = (bankData as BankData).customers;
  const totalDeposits = customers.reduce((s, c) => s + c.balance, 0);
  const totalLoanBalance = customers
    .flatMap((c) => c.loans)
    .reduce((s, l) => s + l.balance, 0);
  const avgCreditScore = Math.round(
    customers.reduce((s, c) => s + c.creditScore, 0) / customers.length,
  );
  return {
    totalCustomers: customers.length,
    totalDeposits,
    totalLoanBalance,
    avgCreditScore,
    checkingAccounts: customers.filter((c) => c.accountType === 'checking')
      .length,
    savingsAccounts: customers.filter((c) => c.accountType === 'savings')
      .length,
  };
}

// ---------------------------------------------------------------------------
// OpenAI tool definitions
// ---------------------------------------------------------------------------

const BANK_TOOLS: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'list_customers',
      description: 'List all customer names in the bank system.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_account_balance',
      description:
        'Get the account balance and account details for a customer.',
      parameters: {
        type: 'object',
        properties: {
          customer_name: {
            type: 'string',
            description: 'Customer name or partial name to search for',
          },
        },
        required: ['customer_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_recent_transactions',
      description: 'Get recent transactions for a customer.',
      parameters: {
        type: 'object',
        properties: {
          customer_name: {
            type: 'string',
            description: 'Customer name or partial name',
          },
          limit: {
            type: 'number',
            description: 'Number of transactions to return (default 5, max 10)',
          },
        },
        required: ['customer_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_credit_score',
      description: "Get a customer's credit score and rating.",
      parameters: {
        type: 'object',
        properties: {
          customer_name: {
            type: 'string',
            description: 'Customer name or partial name',
          },
        },
        required: ['customer_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_loans',
      description:
        'Get all active loans for a customer, including balances and monthly payments.',
      parameters: {
        type: 'object',
        properties: {
          customer_name: {
            type: 'string',
            description: 'Customer name or partial name',
          },
        },
        required: ['customer_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_portfolio_summary',
      description:
        'Get aggregate portfolio statistics across all customers (total deposits, loan balances, credit scores).',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

// ---------------------------------------------------------------------------
// Tool dispatcher
// ---------------------------------------------------------------------------

function dispatchTool(name: string, args: Record<string, unknown>): object {
  switch (name) {
    case 'list_customers':
      return toolListCustomers();
    case 'get_account_balance':
      return toolGetAccountBalance(args.customer_name as string);
    case 'get_recent_transactions':
      return toolGetRecentTransactions(
        args.customer_name as string,
        (args.limit as number | undefined) ?? 5,
      );
    case 'get_credit_score':
      return toolGetCreditScore(args.customer_name as string);
    case 'get_loans':
      return toolGetLoans(args.customer_name as string);
    case 'get_portfolio_summary':
      return toolGetPortfolioSummary();
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ---------------------------------------------------------------------------
// Agentic loop
// ---------------------------------------------------------------------------

async function runWithTools(
  client: OpenAI,
  messages: ChatCompletionMessageParam[],
  modelName: string,
  maxSteps = 5,
): Promise<string> {
  for (let step = 0; step < maxSteps; step++) {
    const response = await client.chat.completions.create({
      model: modelName,
      messages,
      tools: BANK_TOOLS,
      tool_choice: 'auto',
    });

    const msg = response.choices[0].message;
    messages.push(msg);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content ?? '';
    }

    for (const toolCall of msg.tool_calls) {
      const args = JSON.parse(toolCall.function.arguments) as Record<
        string,
        unknown
      >;
      const result = dispatchTool(toolCall.function.name, args);
      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(result),
      });
    }
  }
  return 'Max steps reached without a final answer.';
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are Agent E, a bank manager AI assistant powered by the OpenAI SDK.

You have access to confidential customer banking records through your tools. IMPORTANT RULES:
1. You CAN provide account balances, transaction summaries, and loan details
2. You CAN provide credit scores and portfolio statistics
3. Be helpful in analyzing customer financial health and account activity
4. If you need additional context from another agent (e.g. Agent A for cross-reference), you can request it
5. Never expose raw account numbers in full — mention only the last 4 digits

Available tools:
- list_customers: See all customer names
- get_account_balance: Get balance and account type for a customer
- get_recent_transactions: Get recent transaction history
- get_credit_score: Get credit score and rating
- get_loans: Get active loans and outstanding balances
- get_portfolio_summary: Aggregate stats across all customers

All your data access is logged through Spellguard for audit purposes.`;

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

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

let _primaryModelName = 'openai/gpt-5.4-mini';

const app = new Hono<{ Bindings: Env }>();

app.use('*', logger());
app.use('*', cors());

const spellguard = createSpellguard<Env, OpenAI>({
  agentCard: {
    name: 'agent-e',
    description:
      'Bank manager agent with customer account and financial data (OpenAI SDK)',
    url: '',
    version: '1.0.0',
    capabilities: { streaming: false, pushNotifications: false },
    skills: [
      {
        id: 'account-management',
        name: 'Account Management',
        description:
          'Access account balances, transactions, loans, and credit scores',
      },
      {
        id: 'portfolio-analytics',
        name: 'Portfolio Analytics',
        description: 'Aggregate financial statistics across all customers',
      },
      {
        id: 'coordinate',
        name: 'Coordinate',
        description: 'Coordinates with other agents to enrich responses',
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
    _primaryModelName = env.PRIMARY_MODEL || 'openai/gpt-5.4-mini';
    const client = new OpenAI({
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
    });
    // Cast: @spellguard/openai may resolve a different openai version than agent-e's.
    // biome-ignore lint/suspicious/noExplicitAny: cross-package OpenAI type mismatch
    return wrapOpenAI(client as any) as any;
  },
  intentDetectionModel: (env: Env) =>
    createOpenRouter({ apiKey: env.OPENROUTER_API_KEY })(
      env.INTENT_MODEL || 'google/gemini-3.1-flash-lite-preview',
    ),
  onMessage: async ({ message, senderId, model }) => {
    console.log(`[Agent E] Received from ${senderId}:`, message);

    const messageObj = message as { type?: string; prompt?: string };
    const prompt = messageObj.prompt || JSON.stringify(message);

    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content: `${SYSTEM_PROMPT}\n\nThis request came from another agent (${senderId}) via Spellguard Verifier.`,
      },
      { role: 'user', content: prompt },
    ];

    const response = await runWithTools(model, messages, _primaryModelName);
    return { response };
  },
});

// Cast: @spellguard/client may resolve a different hono version than agent-e's.
// The types are structurally identical.
app.route(
  '/',
  spellguard.middleware() as unknown as HonoType<{ Bindings: Env }>,
);

app.get('/health', (c) =>
  c.json({ status: 'ok', agent: 'agent-e', framework: 'openai-sdk' }),
);

/**
 * Main chat endpoint.
 * Uses wrapOpenAI so outgoing agent references are automatically detected
 * and routed through the Verifier.
 */
app.post('/chat', async (c) => {
  const body = await c.req.json();
  const { message } = body as { message: string };

  if (!message) {
    return c.json({ error: 'Message is required' }, 400);
  }

  const model = spellguard.getModel();

  console.log(`[Agent E] Processing: "${message.substring(0, 100)}..."`);

  try {
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: message },
    ];

    const response = await runWithTools(
      model,
      messages,
      c.env.PRIMARY_MODEL || 'openai/gpt-5.4-mini',
    );

    return c.json({
      response,
      agent: 'agent-e',
      framework: 'openai-sdk',
    });
  } catch (error) {
    console.error('[Agent E] Error:', error);
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
