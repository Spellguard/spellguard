# @spellguard/amp

Auditable Messaging Protocol (AMP) - Commitment generation, message routing, and pluggable logging backends for transparent, auditable agent-to-agent communication.

## Overview

AMP provides the infrastructure for tamper-evident audit trails and secure message archiving. It supports pluggable backends for commitment logging (transparency logs) and message archiving (permanent storage).

## Features

- **Commitment Generation**: Cryptographic commitments for message integrity
- **Pluggable Backends**: Choose your commitment and archive backends
- **Channel Management**: Agent-to-agent communication channels
- **Client Encryption**: Encrypt/decrypt messages for Verifier
- **Archive Verification**: Verify archive integrity against commitments

## Installation

```bash
npm install @spellguard/amp
# or
pnpm add @spellguard/amp
```

## Usage

### Server-Side: Generate and Log Commitments

```typescript
import {
  generateCommitment,
  initLoggingBackends,
  logAndArchive,
} from '@spellguard/amp';

// Initialize backends (configured via environment variables)
await initLoggingBackends();

// Generate commitment for a message
const commitment = generateCommitment(message);

// Log commitment and archive message
const result = await logAndArchive(message, commitment);
console.log('Commitment ID:', result.commitmentId);
console.log('Archive ID:', result.archiveId);
if (result.warnings.length > 0) {
  console.warn('Warnings:', result.warnings);
}
```

### Client-Side: Encrypt Messages

```typescript
import { encryptForVerifier, verifyArchiveIntegrity } from '@spellguard/amp';

// Encrypt payload for Verifier
const encrypted = encryptForVerifier(JSON.stringify(payload), sessionPublicKey);

// Verify archive matches commitment
const isValid = await verifyArchiveIntegrity(commitment, archive);
```

## Configuration

Configure backends via environment variables:

```bash
# Commitment Backend (tamper-evident audit trail)
COMMITMENT_BACKEND=memory|rekor

# Archive Backend (encrypted message storage)
ARCHIVE_BACKEND=memory|s3

# Rekor (free, public transparency log)
REKOR_URL=https://rekor.sigstore.dev

# S3 (AWS or S3-compatible like MinIO, R2)
S3_BUCKET=my-bucket
S3_REGION=us-east-1
S3_ACCESS_KEY_ID=...
S3_SECRET_ACCESS_KEY=...
S3_ENDPOINT=https://s3.amazonaws.com  # Optional for S3-compatible
```

## Available Backends

### Commitment Backends

| Backend | Description | Cost |
|---------|-------------|------|
| `memory` | In-memory (testing only) | Free |
| `rekor` | Sigstore transparency log | Free |

### Archive Backends

| Backend | Description | Cost |
|---------|-------------|------|
| `memory` | In-memory (testing only) | Free |
| `s3` | AWS S3 with Object Lock (WORM) | S3 pricing |

## API Reference

### Types

```typescript
interface SecureMessage {
  id: string;
  sender: string;
  recipient: string;
  encryptedPayload: string;
  timestamp: number;
}

interface MessageCommitment {
  messageId: string;
  sender: string;
  recipient: string;
  hash: string;
  timestamp: number;
}

interface LoggingResult {
  commitmentId?: string;
  archiveId?: string;
  warnings: string[];
}

interface CommitmentBackend {
  readonly name: string;
  init(): Promise<void>;
  logCommitment(commitment: MessageCommitment): Promise<string | null>;
  verifyCommitment(hash: string): Promise<boolean>;
  isConnected(): boolean;
}

interface ArchiveBackend {
  readonly name: string;
  init(): Promise<void>;
  archive(message: SecureMessage, commitment: MessageCommitment): Promise<string | null>;
  retrieve(archiveId: string): Promise<SecureMessage | null>;
  isConnected(): boolean;
}
```

### Commitment Functions

- `generateCommitment(message)` - Generate commitment for a message
- `verifyCommitment(commitment, message)` - Verify commitment matches message

### Logging Functions

- `initLoggingBackends()` - Initialize configured backends
- `logCommitment(commitment)` - Log commitment to backend
- `archiveMessage(message, commitment)` - Archive message to backend
- `logAndArchive(message, commitment)` - Log and archive in one operation
- `verifyCommitmentExists(hash)` - Check if commitment exists in backend

### Channel Functions

- `getOrCreateChannel(agent1, agent2)` - Get or create a channel
- `updateChannelActivity(channelId)` - Update last activity timestamp
- `getChannelStats()` - Get channel statistics

### Client Functions

- `encryptForVerifier(payload, sessionPublicKey)` - Encrypt for Verifier
- `decryptFromVerifier(encrypted, sessionPublicKey)` - Decrypt from Verifier
- `hashPayload(payload)` - Hash payload for commitment
- `verifyArchiveIntegrity(commitment, archive)` - Verify archive integrity

## Implementing Custom Backends

```typescript
import type { CommitmentBackend } from '@spellguard/amp';

const myBackend: CommitmentBackend = {
  name: 'my-backend',

  async init() {
    // Connect to your service
  },

  async logCommitment(commitment) {
    // Log and return ID
    return 'my-commitment-id';
  },

  async verifyCommitment(hash) {
    // Check if commitment exists
    return true;
  },

  isConnected() {
    return true;
  },
};
```

## Security Considerations

- Commitments are SHA-256 hashes of encrypted payloads (Verifier never sees plaintext)
- Archives contain encrypted payloads, not plaintext messages
- S3 Object Lock provides WORM compliance for regulatory requirements
- Rekor provides cryptographic proof of log inclusion
- Memory backends should only be used for testing

## License

MIT
