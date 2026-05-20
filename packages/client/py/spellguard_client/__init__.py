# SPDX-License-Identifier: Apache-2.0

"""
spellguard_client - Python client for Spellguard

Provides secure agent-to-agent communication with Verifier-based attestation,
agent discovery, intent detection, and AI integration.
"""

from __future__ import annotations

# ===================================================================
# Re-exports from spellguard_ctls (Confidential TLS)
# ===================================================================

from spellguard_ctls.types import (
    AgentCard,
    AgentCardAuthentication,
    AgentCardCapabilities,
    AgentCardSkill,
    AttestationResult,
    Evidence,
    EvidenceClaims,
    VerifierAttestationDocument,
)
from spellguard_ctls.client.verifier_verify import (
    fetch_and_verify_verifier,
    verify_verifier_attestation,
)
from spellguard_ctls.crypto.signing import (
    generate_key_pair,
    sign,
    verify,
)

# ===================================================================
# Re-exports from spellguard_amp (Auditable Messaging Protocol)
# ===================================================================

from spellguard_amp.client import (
    encrypt_for_verifier,
    decrypt_from_verifier,
    hash_payload,
    verify_archive_integrity,
)
from spellguard_amp.types import (
    UnilateralSendResult,
    A2AResponse,
    AttestationLevel,
)

# ===================================================================
# Client-specific types
# ===================================================================

from spellguard_client.types import (
    SpellguardConfig,
    SpellguardDiscoveryConfig,
    ResolvedAgent,
    ClientChannel,
    UnilateralSendOptions,
    ManagedConfig,
    DirectConfig,
    SpellguardConfigMode,
    SpellguardOptions,
    MessageContext,
    PlatformAttestation,
    PlatformAttestationProvider,
)

# ===================================================================
# Configuration and channel management
# ===================================================================

from spellguard_client.attestation import (
    configure,
    discover_and_configure,
    get_or_create_channel,
    get_config,
    invalidate_channel,
    reset,
    check_tool_policy,
    ToolCheckResult,
)

# ===================================================================
# Discovery
# ===================================================================

from spellguard_client.discovery import (
    discover_agents,
    resolve_agent_card,
    clear_agent_cache,
    register_local_agent,
)

# ===================================================================
# Intent detection
# ===================================================================

from spellguard_client.intent import (
    AGENT_DETECTION_SYSTEM_PROMPT,
    detect_agent_references,
    might_contain_agent_reference,
    set_intent_detection_model,
    set_intent_detect_fn,
    get_intent_detection_model,
)

# ===================================================================
# Shared AI helpers
# ===================================================================

from spellguard_client.ai import (
    GenerateTextResult,
    build_agent_context_block,
    is_spellguard_agent,
    extract_text_from_response,
    is_policy_or_rate_limit_error,
    resolve_and_collect_agent_responses,
    generate_text,
    spellguard_tool,
    # Trace context (hops + correlation id) — top-level callers wrap
    # work in `set_current_hops(0)` + `set_current_correlation_id(...)`
    # so every nested send stamps the same correlation id and
    # multi-hop conversations land in audit_logs under one trace.
    get_current_hops,
    set_current_hops,
    get_current_correlation_id,
    set_current_correlation_id,
    new_correlation_id,
)

# ===================================================================
# Spellguard instance + middleware
# ===================================================================

from spellguard_client.spellguard import (
    SpellguardInstance,
    create_spellguard,
    verify_verifier_request,
)

# Lockfile / dependency reporting (advisory pipeline input)
from spellguard_client.dependencies import (
    SUPPORTED_LOCKFILES,
    LockfileFile,
    ParsedDependency,
    read_lockfile_from_dir,
    report_dependencies,
)

__all__ = [
    # ctls types
    "AgentCard",
    "AgentCardAuthentication",
    "AgentCardCapabilities",
    "AgentCardSkill",
    "AttestationResult",
    "Evidence",
    "EvidenceClaims",
    "VerifierAttestationDocument",
    # ctls client
    "fetch_and_verify_verifier",
    "verify_verifier_attestation",
    # ctls crypto
    "generate_key_pair",
    "sign",
    "verify",
    # amp client
    "encrypt_for_verifier",
    "decrypt_from_verifier",
    "hash_payload",
    "verify_archive_integrity",
    # amp types
    "UnilateralSendResult",
    "A2AResponse",
    "AttestationLevel",
    # client types
    "SpellguardConfig",
    "SpellguardDiscoveryConfig",
    "ResolvedAgent",
    "ClientChannel",
    "UnilateralSendOptions",
    "ManagedConfig",
    "DirectConfig",
    "SpellguardConfigMode",
    "SpellguardOptions",
    "MessageContext",
    "PlatformAttestation",
    "PlatformAttestationProvider",
    # attestation
    "configure",
    "discover_and_configure",
    "get_or_create_channel",
    "get_config",
    "invalidate_channel",
    "reset",
    "check_tool_policy",
    "ToolCheckResult",
    # discovery
    "discover_agents",
    "resolve_agent_card",
    "clear_agent_cache",
    "register_local_agent",
    # intent
    "AGENT_DETECTION_SYSTEM_PROMPT",
    "detect_agent_references",
    "might_contain_agent_reference",
    "set_intent_detection_model",
    "set_intent_detect_fn",
    "get_intent_detection_model",
    # ai
    "GenerateTextResult",
    "build_agent_context_block",
    "is_spellguard_agent",
    "extract_text_from_response",
    "is_policy_or_rate_limit_error",
    "resolve_and_collect_agent_responses",
    "generate_text",
    "spellguard_tool",
    "get_current_hops",
    "set_current_hops",
    "get_current_correlation_id",
    "set_current_correlation_id",
    "new_correlation_id",
    # spellguard instance
    "SpellguardInstance",
    "create_spellguard",
    "verify_verifier_request",
    # lockfile / dependency reporting
    "SUPPORTED_LOCKFILES",
    "LockfileFile",
    "ParsedDependency",
    "read_lockfile_from_dir",
    "report_dependencies",
]
