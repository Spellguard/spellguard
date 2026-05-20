# spellguard-amp

Auditable Messaging Protocol (AMP) for Python - Commitment generation, message routing, and pluggable logging backends for transparent, auditable agent-to-agent communication.

Python port of [`@spellguard/amp`](../amp/README.md).

## Overview

AMP provides the infrastructure for tamper-evident audit trails and secure message archiving. It supports pluggable backends for commitment logging (transparency logs) and message archiving (permanent storage).

## Features

- **Commitment Generation**: Cryptographic commitments for message integrity
- **Pluggable Backends**: Choose your commitment and archive backends
- **Channel Management**: Agent-to-agent communication channels
- **Client Encryption**: Encrypt/decrypt messages for Verifier (ECDH + AES-256-GCM)
- **Archive Verification**: Verify archive integrity against commitments

## Installation

```bash
pip install spellguard-amp
# or as an editable install from the monorepo
pip install -e packages/amp/py
```

## Usage

### Server-Side: Generate and Log Commitments

```python
from spellguard_amp import (
    generate_commitment,
    init_logging_backends,
    log_and_archive,
)

# Initialize backends (configured via environment variables)
await init_logging_backends()

# Generate commitment for a message
commitment = generate_commitment(message)

# Log commitment and archive message
result = await log_and_archive(message, commitment)
print("Commitment ID:", result.commitment_id)
print("Archive ID:", result.archive_id)
```

### Client-Side: Encrypt Messages

```python
from spellguard_amp import encrypt_for_verifier, verify_archive_integrity

# Encrypt payload for Verifier
encrypted = encrypt_for_verifier(json.dumps(payload), session_public_key)

# Verify archive matches commitment
is_valid = await verify_archive_integrity(commitment, archive)
```

## Encryption

Messages are encrypted using:

- **X25519 ECDH** for key agreement (ephemeral key per message)
- **HKDF-SHA256** for key derivation (info: `spellguard-amp-v1`)
- **AES-256-GCM** for authenticated encryption

Wire format: `0x01 || public_key(32) || nonce(12) || ciphertext+tag`

## API Reference

### Types

```python
@dataclass
class SecureMessage:
    id: str
    sender: str
    recipient: str
    encrypted_payload: str
    timestamp: int

@dataclass
class MessageCommitment:
    message_id: str
    sender: str
    recipient: str
    hash: str
    timestamp: int
```

### Commitment Functions

- `generate_commitment(message)` - Generate commitment for a message
- `verify_commitment(commitment, message)` - Verify commitment matches message

### Channel Functions

- `get_or_create_channel(agent1, agent2)` - Get or create a channel
- `update_channel_activity(channel_id)` - Update last activity timestamp
- `get_channel_stats()` - Get channel statistics

### Client Functions

- `encrypt_for_verifier(payload, session_public_key)` - Encrypt for Verifier
- `decrypt_from_verifier(encrypted, session_public_key)` - Decrypt from Verifier
- `hash_payload(payload)` - Hash payload for commitment
- `verify_archive_integrity(commitment, archive)` - Verify archive integrity

## Security Considerations

- Commitments are SHA-256 hashes of encrypted payloads (Verifier never sees plaintext)
- Archives contain encrypted payloads, not plaintext messages
- Each encryption generates a fresh X25519 key pair for forward secrecy
- Memory backends should only be used for testing

## License

MIT
