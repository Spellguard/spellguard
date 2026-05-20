// SPDX-License-Identifier: Apache-2.0

import { markIntegrationUnavailable } from './integration';

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
    const res = await fetch(`${config.url}/auth/v1/.well-known/jwks.json`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function ensureSupabaseUser(
  config: SupabaseAuthConfig,
  creds: TestCredentials,
): Promise<void> {
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
