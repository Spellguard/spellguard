# Security policy

Spellguard's purpose is to provide auditable, attested agent-to-agent
communication. We take security issues seriously and appreciate
responsible disclosure.

## Reporting a vulnerability

**Please do not file public GitHub issues for security vulnerabilities.**

Report security issues privately through GitHub's private vulnerability
reporting:

➡️ [Report a vulnerability](https://github.com/Spellguard/spellguard/security/advisories/new)

Please include:

- A description of the issue and its impact.
- Steps to reproduce (or a proof-of-concept).
- The affected version(s) or commit SHA(s).
- Your contact information for follow-up.

We will acknowledge receipt within **3 business days** and aim to provide
an initial assessment within **7 business days**.

## Disclosure process

1. You report the issue privately (see above).
2. We confirm the vulnerability and determine the affected versions.
3. We develop a fix in a private branch.
4. We coordinate a disclosure timeline with you. Default target is
   **90 days** from initial report, or earlier if a fix is ready and we
   agree on a release window.
5. We publish a patched release, then publish a security advisory
   crediting the reporter (unless they request anonymity).

If we don't reach you within 14 days of trying, we reserve the right to
publish the advisory without coordination.

## Scope

In scope:

- Cryptographic flaws in `@spellguard/ctls`, `@spellguard/amp`, or their
  Python ports.
- Authentication or authorization bypass in `@spellguard/verifier` or
  `@spellguard/client`.
- Policy-evasion vulnerabilities in shipped policy engines.
- Supply-chain compromise of any package in this repo.

Out of scope:

- Vulnerabilities in third-party dependencies — please report those
  upstream first.
- Closed-source components (`spellguard-management`, dashboard, etc.) —
  those are tracked separately.
- Issues that require physical access to a user's machine or compromised
  developer credentials.

## Safe harbor

We support security research conducted in good faith. We will not pursue
legal action against researchers who:

- Make a good-faith effort to avoid privacy violations, service
  degradation, or data destruction.
- Only interact with accounts they own or have explicit permission to test.
- Give us reasonable time to remediate before public disclosure.

Thank you for helping keep Spellguard and its users safe.
