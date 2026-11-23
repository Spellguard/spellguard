// SPDX-License-Identifier: Apache-2.0

import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchWithTimeout } from './fetch-with-timeout';
import { markIntegrationUnavailable } from './integration';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
/** The repo's pinned Supabase CLI, the one `scripts/dev-all.sh` runs. */
const SUPABASE_CLI = join(REPO_ROOT, 'node_modules', '.bin', 'supabase');
/**
 * The repo's local API (`supabase/config.toml` `[api] port`). `supabase status`
 * omits API_URL when the stack runs without PostgREST, as `dev:all` starts it.
 */
const DEFAULT_LOCAL_API_URL = 'http://127.0.0.1:54321';

export interface SupabaseAuthConfig {
  url: string;
  anonKey: string;
}

export interface TestCredentials {
  email: string;
  password: string;
  name?: string;
}

export interface SupabaseSession {
  accessToken: string;
  refreshToken: string;
  user: {
    id: string;
    email?: string;
  };
}

export function getSupabaseAuthConfig(): SupabaseAuthConfig | null {
  const url =
    process.env.SUPABASE_URL ||
    process.env.E2E_SUPABASE_URL ||
    process.env.STAGING_SUPABASE_URL ||
    '';
  const anonKey =
    process.env.SUPABASE_ANON_KEY ||
    process.env.E2E_SUPABASE_ANON_KEY ||
    process.env.STAGING_SUPABASE_ANON_KEY ||
    '';

  if (!url || !anonKey) {
    return null;
  }

  return { url, anonKey };
}

function authHeaders(anonKey: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    apikey: anonKey,
    Authorization: `Bearer ${anonKey}`,
  };
}

export async function isSupabaseAuthReachable(
  config: SupabaseAuthConfig,
): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      `${config.url}/auth/v1/.well-known/jwks.json`,
      5_000,
    );
    return res.ok;
  } catch {
    return false;
  }
}

function adminHeaders(serviceRoleKey: string): Record<string, string> {
  // Both spellings of a service-role key (legacy JWT, `sb_secret_…`) pass
  // the API gateway with the key as apikey AND bearer.
  return {
    'Content-Type': 'application/json',
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
  };
}

function parseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isLoopback(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '[::1]' ||
    host === '::1' ||
    /^127(?:\.\d{1,3}){3}$/.test(host)
  );
}

/** Whether two URLs address the same Supabase API; loopback spellings match. */
export function sameSupabaseApi(a: string, b: string): boolean {
  const left = parseUrl(a);
  const right = parseUrl(b);
  if (!left || !right) return false;
  if (left.protocol !== right.protocol || left.port !== right.port) {
    return false;
  }
  return (
    (isLoopback(left) && isLoopback(right)) ||
    left.hostname.toLowerCase() === right.hostname.toLowerCase()
  );
}

interface LocalStackStatus {
  apiUrl: string;
  serviceRoleKey: string;
}

let localStackStatus: Promise<LocalStackStatus | null> | undefined;

/**
 * The repo's running local stack, as `supabase status` reports it (the same
 * source `scripts/dev-all.sh` seeds from). Read-only: status never starts or
 * restarts anything. The CLI's output holds every local key, so a failure is
 * reported as "no key" and its error (which carries that output) never
 * escapes.
 */
function readLocalStackStatus(): Promise<LocalStackStatus | null> {
  return new Promise((resolve) => {
    execFile(
      SUPABASE_CLI,
      ['status', '--output', 'json'],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30_000, maxBuffer: 1 << 20 },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        try {
          const status = JSON.parse(stdout.slice(stdout.indexOf('{'))) as {
            API_URL?: unknown;
            SERVICE_ROLE_KEY?: unknown;
          };
          const apiUrl =
            typeof status.API_URL === 'string'
              ? status.API_URL
              : DEFAULT_LOCAL_API_URL;
          resolve(
            typeof status.SERVICE_ROLE_KEY === 'string' &&
              status.SERVICE_ROLE_KEY.length > 0
              ? { apiUrl, serviceRoleKey: status.SERVICE_ROLE_KEY }
              : null,
          );
        } catch {
          resolve(null);
        }
      },
    );
  });
}

/**
 * The service-role key for the Supabase API at `url`, or null when the run
 * holds none for it. A key is only ever sent to the API it belongs to:
 * SUPABASE_SERVICE_ROLE_KEY pairs with SUPABASE_URL (both come from the
 * management service's .env and .dev.vars that the integration and
 * cross-plugin configs load), and the repo's own local stack also answers
 * through `supabase status`. A hosted key is never inferred or hard-coded.
 */
async function serviceRoleKeyFor(url: string): Promise<string | null> {
  const envKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const envUrl = process.env.SUPABASE_URL;
  if (envKey && envUrl && sameSupabaseApi(envUrl, url)) return envKey;

  const parsed = parseUrl(url);
  if (!parsed || !isLoopback(parsed)) return null;
  localStackStatus ??= readLocalStackStatus();
  const status = await localStackStatus;
  return status && sameSupabaseApi(status.apiUrl, url)
    ? status.serviceRoleKey
    : null;
}

async function gotrueErrorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as {
      error_code?: unknown;
      code?: unknown;
    };
    const code = body.error_code ?? body.code;
    return typeof code === 'string' || typeof code === 'number'
      ? String(code)
      : null;
  } catch {
    return null;
  }
}

/**
 * Create `creds` already confirmed, through the GoTrue admin API. A public
 * /signup leaves a new user unconfirmed wherever email confirmation is on
 * (every hosted environment, and the local stack since supabase/config.toml
 * enabled it), and GoTrue refuses an unconfirmed user a password grant.
 */
async function createConfirmedUser(
  config: SupabaseAuthConfig,
  serviceRoleKey: string,
  creds: TestCredentials,
): Promise<void> {
  const response = await fetch(`${config.url}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders(serviceRoleKey),
    body: JSON.stringify({
      email: creds.email,
      password: creds.password,
      email_confirm: true,
      user_metadata: creds.name ? { name: creds.name } : undefined,
    }),
  });
  if (response.ok) return;

  const code = await gotrueErrorCode(response);
  // The email is taken, so the password probe failed on a wrong password or
  // an unconfirmed account. As before, the caller's sign-in reports which.
  if (code === 'email_exists' || code === 'user_already_exists') return;
  // Only the status and GoTrue's error code: never the key or a raw body.
  const hint =
    response.status === 401 || response.status === 403
      ? ` Check that SUPABASE_SERVICE_ROLE_KEY belongs to ${config.url}.`
      : '';
  throw new Error(
    `Supabase admin user creation failed: ${response.status} ${response.statusText}${code ? ` (${code})` : ''}.${hint}`,
  );
}

export async function ensureSupabaseUser(
  config: SupabaseAuthConfig,
  creds: TestCredentials,
): Promise<void> {
  // Probe signInWithPassword first. If the user already exists, sign-in
  // returns 200 + we exit cleanly. We avoid calling /signup for an
  // existing user because the local Supabase Auth stack cascades the
  // user's `public.profiles` row in that 422 "user_already_exists" path
  // — observed empirically: calling /signup with a duplicate email
  // returns HTTP 422 but the profile row vanishes. That broke seeded
  // tests that depend on operator/member profile + org membership
  // (analytics, management, detection-pipeline integration tests).
  const probeRes = await fetch(
    `${config.url}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: authHeaders(config.anonKey),
      body: JSON.stringify({ email: creds.email, password: creds.password }),
    },
  );
  if (probeRes.ok) {
    return; // User already exists with the expected password.
  }

  // A new user is created already confirmed, so the caller's password grant
  // works whether or not the stack requires email confirmation.
  const serviceRoleKey = await serviceRoleKeyFor(config.url);
  if (serviceRoleKey) {
    await createConfirmedUser(config, serviceRoleKey, creds);
    return;
  }

  // No service-role key for this API (a hosted stack the run holds no key
  // for): public sign-up, as before. Its user can sign in only where GoTrue
  // confirms sign-ups automatically.
  const response = await fetch(`${config.url}/auth/v1/signup`, {
    method: 'POST',
    headers: authHeaders(config.anonKey),
    body: JSON.stringify({
      email: creds.email,
      password: creds.password,
      data: creds.name ? { name: creds.name } : undefined,
    }),
  });

  if (response.ok || response.status === 400 || response.status === 422) {
    return;
  }

  const body = await response.text();
  throw new Error(
    `Supabase signup failed: ${response.status} ${response.statusText} ${body}`,
  );
}

export async function signInWithPassword(
  config: SupabaseAuthConfig,
  creds: TestCredentials,
): Promise<SupabaseSession> {
  const response = await fetch(
    `${config.url}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: authHeaders(config.anonKey),
      body: JSON.stringify({
        email: creds.email,
        password: creds.password,
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Supabase password login failed: ${response.status} ${response.statusText} ${body}`,
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    user: { id: string; email?: string };
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    user: data.user,
  };
}

export async function refreshSupabaseSession(
  config: SupabaseAuthConfig,
  refreshToken: string,
): Promise<SupabaseSession> {
  const response = await fetch(
    `${config.url}/auth/v1/token?grant_type=refresh_token`,
    {
      method: 'POST',
      headers: authHeaders(config.anonKey),
      body: JSON.stringify({ refresh_token: refreshToken }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Supabase refresh failed: ${response.status} ${response.statusText} ${body}`,
    );
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token: string;
    user: { id: string; email?: string };
  };
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    user: data.user,
  };
}

/**
 * Delete a Supabase auth user via the Admin API.
 * Best-effort: logs warnings but never throws, so cleanup doesn't fail tests.
 */
export async function deleteSupabaseUser(
  config: SupabaseAuthConfig,
  serviceRoleKey: string,
  userId: string,
): Promise<void> {
  try {
    const res = await fetch(`${config.url}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    });
    if (!res.ok) {
      console.warn(
        `[cleanup] Failed to delete Supabase user ${userId}: ${res.status} ${res.statusText}`,
      );
    }
  } catch (err) {
    console.warn(`[cleanup] Error deleting Supabase user ${userId}:`, err);
  }
}

export async function ensureSupabaseSession(creds: TestCredentials): Promise<{
  config: SupabaseAuthConfig;
  session: SupabaseSession;
} | null> {
  const config = getSupabaseAuthConfig();
  if (!config) {
    markIntegrationUnavailable(
      'Supabase auth env missing. Set SUPABASE_URL and SUPABASE_ANON_KEY.',
    );
    return null;
  }

  const reachable = await isSupabaseAuthReachable(config);
  if (!reachable) {
    markIntegrationUnavailable(
      `Supabase auth is not reachable at ${config.url}. Start Supabase or set env to a reachable instance.`,
    );
    return null;
  }

  await ensureSupabaseUser(config, creds);
  const session = await signInWithPassword(config, creds);
  return { config, session };
}
