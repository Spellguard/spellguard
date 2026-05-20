# @spellguard/ctls

Confidential TLS (cTLS) - Bidirectional attestation and secure channel establishment for Verifiers.

## Overview

cTLS provides cryptographic primitives and protocols for establishing secure, attested channels between clients and Verifiers. It implements the RFC 9334 RATS (Remote ATtestation procedureS) pattern for bidirectional verification.

## Features

- **Verifier Attestation**: Generate and verify Verifier attestation documents across multiple platforms (AWS Nitro Enclaves, Phala Cloud TDX, mock)
- **RFC 9334 RATS**: Evidence building, signing, and verification
- **Agent Registry**: Manage registered agents and channel tokens
- **Forward Secrecy**: Ephemeral session keys that never touch disk
- **Ed25519 Signing**: Cryptographic signing and verification

## Installation

```bash
npm install @spellguard/ctls
# or
pnpm add @spellguard/ctls
```

## Usage

### Client-Side: Verify Verifier Before Connecting

```typescript
import { fetchAndVerifyVerifier, buildEvidence, signEvidence } from '@spellguard/ctls';

// Step 1: Verify the Verifier is running expected code
const result = await fetchAndVerifyVerifier(verifierUrl, expectedImageHash);
if (!result.verified) {
  throw new Error('Verifier verification failed - connection refused');
}

// Step 2: Build and sign evidence for registration
const evidence = buildEvidence({
  agentId: 'my-agent',
  codeHash: 'sha256:...',
  endpoint: 'https://my-agent.com/_spellguard/receive',
  agentCardUrl: 'https://my-agent.com/.well-known/agent.json',
});

const signedEvidence = await signEvidence(evidence, privateKey);
```

### Server-Side: Generate Attestation and Verify Evidence

```typescript
import {
  generateSessionKeys,
  generateAttestationDocument,
  verifyEvidence,
  registerAgent,
} from '@spellguard/ctls';

// Initialize session keys (RAM-only, destroyed on shutdown)
await generateSessionKeys();

// Generate attestation document for clients to verify
const attestation = await generateAttestationDocument(nonce);

// Verify client evidence and register
const result = await verifyEvidence(evidence);
if (result.verified) {
  registerAgent({
    agentId: result.agentId,
    channelToken: result.channelToken,
    // ...
  });
}
```

## API Reference

### Types

```typescript
interface VerifierAttestationDocument {
  imageHash: string;           // PCR0 (Nitro), Docker hash (Phala), or env var
  hardwareSignature: string;   // COSE_Sign1 (Nitro), TDX quote (Phala), or self-signed (mock)
  publicKey: string;           // Verifier's ephemeral Ed25519 session key
  timestamp: number;
  nonce: string;
  supportedAlgorithms?: string[];
  eventLog?: string;           // TDX event log (Phala only)
  composeHash?: string;        // Docker compose hash (Phala only)
}

interface Evidence {
  agentId: string;
  claims: {
    codeHash: string;
    endpoint: string;
    agentCardUrl: string;
    capabilities: string[];
    preferredAlgorithm?: string;
  };
  signature: string;
}

interface AttestationResult {
  agentId: string;
  verified: boolean;
  channelToken: string;
  sessionPublicKey: string;
  expiresAt: number;
  error?: string;
}
```

### Client Functions

- `fetchAndVerifyVerifier(url, expectedHash, options?)` - Fetch and verify Verifier attestation
- `verifyVerifierAttestation(attestation, expectedHash)` - Verify an attestation document
- `buildEvidence(options)` - Build evidence claims
- `signEvidence(evidence, privateKey)` - Sign evidence with Ed25519

### Server Functions

- `generateAttestationDocument(nonce)` - Generate Verifier attestation (platform-aware: Nitro NSM, Phala TDX, or mock)
- `generateNitroAttestation(userData)` - Direct NSM attestation for AWS Nitro Enclaves
- `verifyEvidence(evidence, options?)` - Verify client evidence
- `registerAgent(agent)` - Register an agent
- `getAgent(agentId)` - Get agent by ID
- `getAgentByToken(token)` - Get agent by channel token
- `rotateChannelToken(agentId)` - Rotate channel token

### Crypto Functions

- `generateSessionKeys()` - Generate ephemeral session keys
- `destroySessionKeys()` - Securely destroy session keys
- `getSessionPublicKey()` - Get current session public key
- `sign(data, privateKey)` - Sign data with Ed25519
- `verify(data, signature, publicKey)` - Verify Ed25519 signature
- `generateKeyPair()` - Generate Ed25519 key pair

## Platform Support

`generateAttestationDocument()` detects the platform via `VERIFIER_PLATFORM` and produces the appropriate attestation:

| Platform | `VERIFIER_PLATFORM` | Image Hash Source | Signature Type |
|----------|---------------|-------------------|----------------|
| AWS Nitro | `nitro` | PCR0 from NSM device | COSE_Sign1 (Nitro hypervisor) |
| Phala Cloud | `phala` | `VERIFIER_IMAGE_HASH` env var | TDX quote (Intel SGX/TDX) |
| Mock | any + `VERIFIER_MOCK_MODE=true` | `VERIFIER_IMAGE_HASH` or placeholder | Ed25519 self-signed |

On Nitro, the Go helper binary (`/opt/spellguard/nsm-attestation`) communicates with `/dev/nsm` to get the hardware attestation document and PCR measurements. No `VERIFIER_IMAGE_HASH` env var is needed.

## Security Considerations

- Session keys are ephemeral and RAM-only for forward secrecy
- All keys are destroyed on process shutdown
- SSRF protection validates endpoints to prevent internal network access
- Channel tokens expire and should be rotated regularly
- Mock mode should only be used in development

## License

MIT
