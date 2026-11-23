# Changelog

## Unreleased

- **The management token is renewed before a registration presents an
  expired one.** Discovery gives the agent a management token that expires an
  hour later, and every registration with the Verifier presents it. The
  Verifier refuses an expired one with 401 `Invalid management token`, even
  alongside a valid agent secret. The SDK never renewed it, so an agent that had
  to register again after its first hour (the Verifier had forgotten its
  channel token, or another instance of the agent had replaced it, #1603) was
  refused until it restarted, and the tool check's re-register below failed
  the same way. A registration within five minutes of the token's expiry now
  re-runs discovery first, with the agent secret it was discovered with, and
  registers with the new token. A token passed to `configure()` directly has
  no discovery to renew it and is presented as before.

- **`createSpellguard({ attestationState })`.** An instance can run in an
  attestation state its caller passes instead of one of its own. Code that
  acts as the same agent outside the instance's requests, such as a scheduled
  job sending as it, then runs in that state with `runWithAttestationState`
  and shares the instance's Verifier channel. The Verifier keeps one channel
  token per agent, so two states for one agent each register and replace the
  other's token.

- **A tool check re-registers once when its channel token is stale
  (#1603).** The Verifier answers `/v1/tools/check` with 401 when it no longer
  knows the channel's token: it restarted or rotated its keys, the token
  expired, or another instance of the agent registered since (it keeps one
  token per agent). A send already re-registered and retried once on that
  answer; a tool check failed closed with `verifier_refused` until something
  else re-registered, so an agent with two instances, like a demo fleet agent
  that the fleet also sends as, had every tool call refused. `checkToolPolicy`
  now re-registers once and asks again; a second 401 still fails closed.

- **A first-contact refusal is no longer reported as a bypass (#1858).** A
  plaintext delivery that passed the signature check came from the agent's
  own Verifier, which had no key for the agent yet. `/_spellguard/receive`
  still refuses it with `reason: "plaintext_refused"`, and the Verifier still
  delivers once more, encrypted (#1528). It no longer posts a
  `plaintext_refused` report to management, which showed every org admin a
  "Possible Spellguard bypass" notice for the Verifier's own first delivery.
  `DeliveryBypassReason` drops `plaintext_refused`. Management ignores the
  report from older SDKs.

- **Usage reports reach management from Cloudflare Workers (#1506).** The
  self-reported usage `generateText` and the adapters send after each LLM call
  was fire-and-forget, so workerd cancelled it when the response returned and
  no report from an agent on Workers ever arrived. The middleware now hands
  each pending report to the request's `waitUntil`. Code that calls the model
  outside a request, such as a cron handler, wraps that work in the new
  `runWithWaitUntil((promise) => ctx.waitUntil(promise), fn)`. Nothing changes
  under Node.

- **Decrypt failures name their reason (#1528).** `/_spellguard/receive`
  answers a delivery it cannot decrypt with `reason: "decrypt_failed"` next to
  the existing error. The Verifier reads it, with `plaintext_refused`, as a sign
  that its key for the agent is out of date, and delivers once more to the key
  the agent registered while refusing. An older Verifier ignores the field.

- **Bypass alerts (#1407).** `/_spellguard/receive` reports each delivery it
  refuses, and each one it accepts unverified in report-only mode, to
  management's `POST /v1/agents/:id/delivery-bypass` with the agent secret.
  Management alerts the organization's owners and admins on the dashboard. The
  report is fire-and-forget, sent at most once per outcome and reason every
  five minutes, and skipped when the agent has no secret or no management URL
  (`managementUrl`, `SPELLGUARD_MANAGEMENT_URL` or `SPELLGUARD_BASE_URL`). A
  Verifier outage is not reported. Needs a management server with the route;
  an older one answers 404, which the SDK ignores.
