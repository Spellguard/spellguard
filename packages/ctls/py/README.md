# spellguard-ctls

Confidential TLS (cTLS) for Python - Bidirectional attestation and secure channel establishment for Verifiers.

Python port of [`@spellguard/ctls`](../ctls/README.md).

## Overview

cTLS provides cryptographic primitives and protocols for establishing secure, attested channels between clients and Verifiers. It implements the RFC 9334 RATS (Remote ATtestation procedureS) pattern for bidirectional verification.

## Features

- **Verifier Attestation**: Generate and verify Verifier attestation documents
- **RFC 9334 RATS**: Evidence building, signing, and verification
- **Agent Registry**: Manage registered agents and channel tokens
- **Forward Secrecy**: Ephemeral session keys that never touch disk
- **Ed25519 Signing**: Cryptographic signing and verification via `cryptography`

## Installation

```bash
pip install spellguard-ctls
# or as an editable install from the monorepo
pip install -e packages/ctls/py
```

## Usage

### Client-Side: Verify Verifier Before Connecting

```python
from spellguard_ctls import (
    fetch_and_verify_verifier,
    build_evidence,
    sign_evidence,
)

# Step 1: Verify the Verifier is running expected code
result = await fetch_and_verify_verifier(verifier_url, expected_image_hash)
if not result.verified:
    raise RuntimeError("Verifier verification failed - connection refused")

# Step 2: Build and sign evidence for registration
evidence = build_evidence(
    agent_id="my-agent",
    code_hash="sha256:...",
    endpoint="https://my-agent.com/_spellguard/receive",
    agent_card_url="https://my-agent.com/.well-known/agent.json",
)

signed_evidence = await sign_evidence(evidence, private_key)
```

### Server-Side: Generate Attestation and Verify Evidence

```python
from spellguard_ctls import (
    generate_session_keys,
    generate_attestation_document,
    verify_evidence,
    register_agent,
)

# Initialize session keys (RAM-only, destroyed on shutdown)
await generate_session_keys()

# Generate attestation document for clients to verify
attestation = await generate_attestation_document(nonce)

# Verify client evidence and register
result = await verify_evidence(evidence)
if result.verified:
    register_agent(
        agent_id=result.agent_id,
        channel_token=result.channel_token,
    )
```

## API Reference

### Types

```python
@dataclass
class VerifierAttestationDocument:
    image_hash: str
    hardware_signature: str
    public_key: str
    timestamp: int
    nonce: str
    supported_algorithms: list[str] | None = None

@dataclass
class Evidence:
    agent_id: str
    claims: EvidenceClaims
    signature: str

@dataclass
class AttestationResult:
    agent_id: str
    verified: bool
    channel_token: str
    session_public_key: str
    expires_at: int
    error: str | None = None
```

### Client Functions

- `fetch_and_verify_verifier(url, expected_hash)` - Fetch and verify Verifier attestation
- `verify_verifier_attestation(attestation, expected_hash)` - Verify an attestation document
- `build_evidence(options)` - Build evidence claims
- `sign_evidence(evidence, private_key)` - Sign evidence with Ed25519

### Server Functions

- `generate_attestation_document(nonce)` - Generate Verifier attestation
- `verify_evidence(evidence)` - Verify client evidence
- `register_agent(agent)` - Register an agent
- `get_agent(agent_id)` - Get agent by ID
- `get_agent_by_token(token)` - Get agent by channel token
- `rotate_channel_token(agent_id)` - Rotate channel token

### Crypto Functions

- `generate_session_keys()` - Generate ephemeral session keys
- `destroy_session_keys()` - Securely destroy session keys
- `get_session_public_key()` - Get current session public key
- `sign(data, private_key)` - Sign data with Ed25519
- `verify(data, signature, public_key)` - Verify Ed25519 signature
- `generate_key_pair()` - Generate Ed25519 key pair

## Security Considerations

- Session keys are ephemeral and RAM-only for forward secrecy
- All keys are destroyed on process shutdown
- SSRF protection validates endpoints to prevent internal network access
- Channel tokens expire and should be rotated regularly
- Uses the `cryptography` library for all Ed25519 operations

## License

MIT
