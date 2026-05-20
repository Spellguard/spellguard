// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve a platform identity token for internal-mode verifiers.
 *
 * Internal-mode verifiers prove their identity via cloud platform tokens
 * instead of hardware Verifier attestation. This factory acquires the appropriate
 * token based on VERIFIER_IDENTITY_PROVIDER.
 *
 * Supported providers:
 *   - aws:  Presigned STS GetCallerIdentity URL (verified by management's aws verifier)
 *   - gcp:  GCP metadata server identity token (verified by management's gcp verifier)
 *   - azure: Azure IMDS managed identity token (verified by management's azure verifier)
 *   - oidc: Pre-provisioned or fetched OIDC token (verified by management's oidc verifier)
 */

export interface PlatformIdentityToken {
  /** The identity provider used */
  provider: 'aws' | 'gcp' | 'azure' | 'oidc';
  /** The token value (format depends on provider) */
  token: string;
}

/**
 * Resolve a platform identity token for the current environment.
 *
 * @returns Platform identity token, or null if no provider is configured
 */
export async function resolveIdentityToken(): Promise<PlatformIdentityToken | null> {
  const provider = process.env.VERIFIER_IDENTITY_PROVIDER?.toLowerCase();

  if (!provider) {
    console.warn(
      '[Verifier] VERIFIER_IDENTITY_PROVIDER not set — internal-mode verifier will register without platform attestation',
    );
    return null;
  }

  switch (provider) {
    case 'aws':
      return { provider: 'aws', token: await resolveAwsToken() };
    case 'gcp':
      return { provider: 'gcp', token: await resolveGcpToken() };
    case 'azure':
      return { provider: 'azure', token: await resolveAzureToken() };
    case 'oidc':
      return { provider: 'oidc', token: await resolveOidcToken() };
    default:
      throw new Error(
        `Unknown VERIFIER_IDENTITY_PROVIDER: ${provider}. Supported: aws, gcp, azure, oidc`,
      );
  }
}

// ── AWS ────────────────────────────────────────────────────────────
// Generate a presigned STS GetCallerIdentity URL.
// The management aws identity verifier expects this exact format:
// it POSTs to the presigned URL and extracts ARN/Account/UserId from
// the STS response.

interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

async function resolveAwsToken(): Promise<string> {
  const creds = await getAwsCredentials();
  return presignStsGetCallerIdentity(creds);
}

async function getAwsCredentials(): Promise<AwsCredentials> {
  // 1. ECS task role credentials
  const ecsUri = process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI;
  if (ecsUri) {
    const res = await fetch(`http://169.254.170.2${ecsUri}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        AccessKeyId: string;
        SecretAccessKey: string;
        Token: string;
      };
      return {
        accessKeyId: data.AccessKeyId,
        secretAccessKey: data.SecretAccessKey,
        sessionToken: data.Token,
      };
    }
  }

  // 2. EC2 instance profile (IMDSv2)
  const imdsToken = await getImdsToken();

  // Discover the role name attached to this instance
  const roleRes = await fetch(
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    {
      headers: { 'X-aws-ec2-metadata-token': imdsToken },
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!roleRes.ok) {
    throw new Error(`Failed to discover EC2 IAM role: ${roleRes.status}`);
  }
  const roleName = (await roleRes.text()).trim();

  const credsRes = await fetch(
    `http://169.254.169.254/latest/meta-data/iam/security-credentials/${roleName}`,
    {
      headers: { 'X-aws-ec2-metadata-token': imdsToken },
      signal: AbortSignal.timeout(5000),
    },
  );
  if (!credsRes.ok) {
    throw new Error(`Failed to fetch EC2 credentials: ${credsRes.status}`);
  }
  const data = (await credsRes.json()) as {
    AccessKeyId: string;
    SecretAccessKey: string;
    Token: string;
  };
  return {
    accessKeyId: data.AccessKeyId,
    secretAccessKey: data.SecretAccessKey,
    sessionToken: data.Token,
  };
}

async function getImdsToken(): Promise<string> {
  const res = await fetch('http://169.254.169.254/latest/api/token', {
    method: 'PUT',
    headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' },
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new Error(`IMDS token request failed: ${res.status}`);
  return await res.text();
}

/**
 * Build a presigned STS GetCallerIdentity URL using AWS SigV4.
 * The management aws verifier will POST to this URL to verify identity.
 */
async function presignStsGetCallerIdentity(
  creds: AwsCredentials,
): Promise<string> {
  const region =
    process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1';
  const host =
    region === 'us-east-1'
      ? 'sts.amazonaws.com'
      : `sts.${region}.amazonaws.com`;

  const now = new Date();
  const amzDate = `${now.toISOString().replace(/[-:]/g, '').split('.')[0]}Z`;
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${region}/sts/aws4_request`;

  // Query params (sorted alphabetically for canonical request)
  const queryParams: [string, string][] = [
    ['Action', 'GetCallerIdentity'],
    ['Version', '2011-06-15'],
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${creds.accessKeyId}/${credentialScope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', '60'],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  if (creds.sessionToken) {
    queryParams.push(['X-Amz-Security-Token', creds.sessionToken]);
  }
  queryParams.sort((a, b) => a[0].localeCompare(b[0]));

  const canonicalQueryString = queryParams
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

  // Canonical request (POST with empty body)
  const emptyBodyHash = await sha256Hex('');
  const canonicalRequest = [
    'POST',
    '/',
    canonicalQueryString,
    `host:${host}\n`,
    'host',
    emptyBodyHash,
  ].join('\n');

  // String to sign
  const canonicalRequestHash = await sha256Hex(canonicalRequest);
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    canonicalRequestHash,
  ].join('\n');

  // Derive signing key: kDate → kRegion → kService → kSigning
  const kDate = await hmacSha256(
    new TextEncoder().encode(`AWS4${creds.secretAccessKey}`),
    dateStamp,
  );
  const kRegion = await hmacSha256(kDate, region);
  const kService = await hmacSha256(kRegion, 'sts');
  const kSigning = await hmacSha256(kService, 'aws4_request');

  const signature = bufToHex(
    new Uint8Array(await hmacSha256(kSigning, stringToSign)),
  );

  return `https://${host}/?${canonicalQueryString}&X-Amz-Signature=${signature}`;
}

// ── SigV4 crypto helpers (Web Crypto API) ─────────────────────────

async function sha256Hex(data: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(data),
  );
  return bufToHex(new Uint8Array(hash));
}

async function hmacSha256(
  key: ArrayBuffer | Uint8Array,
  data: string,
): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

function bufToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// ── GCP ────────────────────────────────────────────────────────────
// Fetch a service account identity token from the GCP metadata server.

async function resolveGcpToken(): Promise<string> {
  const audience =
    process.env.VERIFIER_IDENTITY_AUDIENCE || 'spellguard-management';
  const serviceAccount = process.env.VERIFIER_GCP_SERVICE_ACCOUNT || 'default';
  const url = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/${serviceAccount}/identity?audience=${encodeURIComponent(audience)}`;

  const res = await fetch(url, {
    headers: { 'Metadata-Flavor': 'Google' },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`GCP metadata identity token failed: ${res.status}`);
  }

  return await res.text();
}

// ── Azure ──────────────────────────────────────────────────────────
// Fetch a managed identity token from the Azure IMDS.

async function resolveAzureToken(): Promise<string> {
  const resource =
    process.env.VERIFIER_IDENTITY_AUDIENCE || 'https://management.azure.com/';
  const url = `http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=${encodeURIComponent(resource)}`;

  const res = await fetch(url, {
    headers: { Metadata: 'true' },
    signal: AbortSignal.timeout(5000),
  });

  if (!res.ok) {
    throw new Error(`Azure IMDS identity token failed: ${res.status}`);
  }

  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

// ── OIDC ───────────────────────────────────────────────────────────
// Use a pre-provisioned token or fetch from a custom endpoint.
// This covers serverless runtimes (Access Service Token injected as secret),
// Kubernetes (projected service account token), and other OIDC providers.

async function resolveOidcToken(): Promise<string> {
  // 1. Pre-provisioned token (e.g., secret-managed static token, K8s projected token file)
  const staticToken = process.env.VERIFIER_IDENTITY_TOKEN;
  if (staticToken) {
    return staticToken;
  }

  // 2. Fetch from a custom endpoint
  const tokenUrl = process.env.VERIFIER_IDENTITY_TOKEN_URL;
  if (tokenUrl) {
    const res = await fetch(tokenUrl, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(
        `OIDC token fetch from ${tokenUrl} failed: ${res.status}`,
      );
    }
    return await res.text();
  }

  // 3. Kubernetes projected service account token
  const k8sTokenPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';
  try {
    const { readFileSync } = await import('node:fs');
    const token = readFileSync(k8sTokenPath, 'utf-8').trim();
    if (token) return token;
  } catch {
    // Not running in K8s — fall through
  }

  throw new Error(
    'OIDC provider requires VERIFIER_IDENTITY_TOKEN, VERIFIER_IDENTITY_TOKEN_URL, ' +
      'or a Kubernetes service account token at /var/run/secrets/kubernetes.io/serviceaccount/token',
  );
}
