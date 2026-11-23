# Spellguard CLI — full command reference index

Generated from: `spellguard schema`. Do not edit by hand.
Schema version: `4`

Every curated command lives in one of the reference families below. Find the
family whose commands match the task, then read that file for the per-command
flags, permissions, risk level, `--input` schema, and examples. `spellguard
schema` remains the exhaustive machine-readable catalog.

| Domain | Commands | Reference |
| --- | --- | --- |
| Access Rules And Requests | `access-requests`, `access-requests list`, `access-requests submit`, `access-requests decide`, `access-rules`, `access-rules list`, `access-rules simulate`, `access-rules create`, …(+3) | [access-governance.md](access-governance.md) |
| Activity | `activity`, `activity commits`, `activity commits list`, `activity events`, `activity events list`, `activity rollups`, `activity rollups packages`, `activity rollups packages get`, …(+11) | [activity.md](activity.md) |
| Agents | `agents`, `agents login`, `agents github-grants`, `agents github-grants list`, `agents github-grants show`, `agents github-grants status`, `agents github-grants replace`, `agents github-grants set`, …(+59) | [agents.md](agents.md) |
| Analytics | `analytics`, `analytics agents`, `analytics policies`, `analytics review-metrics`, `analytics summary`, `analytics timeseries`, `analytics tools` | [analytics.md](analytics.md) |
| API Keys | `api-keys`, `api-keys list`, `api-keys create`, `api-keys delete` | [api-keys.md](api-keys.md) |
| Raw API Escape Hatch (Uncurated) | `api` | [api.md](api.md) |
| Audit Logs | `audit`, `audit admin-content`, `audit agent-logs`, `audit agent-sessions`, `audit events`, `audit events get`, `audit events list`, `audit events review`, …(+7) | [audit.md](audit.md) |
| BYOK (Bring Your Own Key) | `byok`, `byok audit`, `byok config`, `byok migrate`, `byok offboard`, `byok resume`, `byok remove` | [byok.md](byok.md) |
| Connect | `connect` | [connect.md](connect.md) |
| Credentials And GitHub Scoping | `credentials`, `credentials list`, `credentials summary`, `credentials issue`, `credentials rotate`, `credentials acknowledge-exposure`, `credentials revoke`, `credentials manual`, …(+40) | [credentials.md](credentials.md) |
| Warm Connect Daemon | `daemon`, `daemon run`, `daemon status` | [daemon.md](daemon.md) |
| Dashboard | `dashboard`, `dashboard notifications`, `dashboard notifications list`, `dashboard setup-status`, `dashboard tiles` | [dashboard.md](dashboard.md) |
| Detection Pipeline | `detection-pipeline`, `detection-pipeline health` | [detection-pipeline.md](detection-pipeline.md) |
| Diagnostics, Version, Schema, And Update | `spellguard`, `doctor`, `schema`, `update`, `version` | [diagnostics.md](diagnostics.md) |
| GitHub Audit | `github-audit`, `github-audit bypasses`, `github-audit bypasses list`, `github-audit repo-activity`, `github-audit repo-activity-summary`, `github-audit streams`, `github-audit streams events`, `github-audit streams list`, …(+5) | [github-audit.md](github-audit.md) |
| A2A Grants | `grants`, `grants get`, `grants list`, `grants create`, `grants revoke` | [grants.md](grants.md) |
| Groups | `groups`, `groups bindings`, `groups bindings list`, `groups bindings create`, `groups bindings update`, `groups bindings delete`, `groups get`, `groups list`, …(+5) | [groups.md](groups.md) |
| A2A Task Handlers | `handlers`, `handlers list`, `handlers inspect`, `handlers restore` | [handlers.md](handlers.md) |
| Identity, Profiles, And Config | `whoami`, `login`, `logout`, `profile`, `profile create`, `profile list`, `config`, `config explain`, …(+5) | [identity.md](identity.md) |
| Invitations | `invitations`, `invitations list`, `invitations show`, `invitations create`, `invitations revoke`, `invitations accept`, `invitations decline` | [invitations.md](invitations.md) |
| A2A Issue Labels | `issue-labels`, `issue-labels list` | [issue-labels.md](issue-labels.md) |
| Management Rules | `management-rules`, `management-rules catalog`, `management-rules catalog get`, `management-rules catalog list`, `management-rules configure`, `management-rules update`, `management-rules health`, `management-rules list`, …(+11) | [management-rules.md](management-rules.md) |
| Members | `members`, `members list`, `members set-role`, `members remove` | [members.md](members.md) |
| Operations | `operations`, `operations list`, `operations wait` | [operations.md](operations.md) |
| Organizations | `orgs`, `orgs get`, `orgs list`, `orgs create`, `orgs update`, `orgs delete`, `orgs activate`, `orgs transfer` | [orgs.md](orgs.md) |
| People | `people`, `people list` | [people.md](people.md) |
| Policies | `policies`, `policies get`, `policies list`, `policies create`, `policies patch`, `policies publish`, `policies delete`, `policies apply-defaults`, …(+14) | [policies.md](policies.md) |
| Providers And Integrations | `openrouter`, `openrouter management-key`, `openrouter management-key connect`, `openrouter management-key disconnect`, `openrouter management-key status`, `openrouter management-key disconnect-impact`, `openrouter management-key orphans`, `openrouter management-key orphans list`, …(+75) | [providers-integrations.md](providers-integrations.md) |
| Provisioning | `provision`, `deprovision` | [provision.md](provision.md) |
| A2A Repo Configs | `repo-configs`, `repo-configs create`, `repo-configs delete`, `repo-configs list`, `repo-configs update` | [repo-configs.md](repo-configs.md) |
| A2A Review Delegation | `review-delegation`, `review-delegation get`, `review-delegation set`, `review-delegation clear`, `review-delegation teams`, `review-delegation activity` | [review-delegation.md](review-delegation.md) |
| Security Alerts | `security-alerts`, `security-alerts health`, `security-alerts list`, `security-alerts update` | [security-alerts.md](security-alerts.md) |
| Sentry | `sentry`, `sentry conversations`, `sentry conversations get`, `sentry conversations list`, `sentry rule-generations`, `sentry rule-generations latest`, `sentry summaries`, `sentry summaries latest`, …(+1) | [sentry.md](sentry.md) |
| Setup And Reset | `setup`, `setup claude-code`, `setup codex`, `reset` | [setup.md](setup.md) |
| AWS Shadow Agent Detection | `shadow`, `shadow config`, `shadow config get`, `shadow config status`, `shadow config request`, `shadow readiness`, `shadow readiness get`, `shadow readiness assess`, …(+10) | [shadow.md](shadow.md) |
| Spend Limits | `spend-limits`, `spend-limits list`, `spend-limits usage`, `spend-limits create`, `spend-limits update`, `spend-limits delete`, `spend-limits reenable` | [spend-limits.md](spend-limits.md) |
| Tailscale | `tailscale`, `tailscale connect`, `tailscale validate` | [tailscale.md](tailscale.md) |
| A2A Task Routing | `task-routing`, `task-routing get`, `task-routing list`, `task-routing create`, `task-routing update`, `task-routing delete`, `task-routing receipt` | [task-routing.md](task-routing.md) |
| A2A Tasks | `tasks`, `tasks get`, `tasks list`, `tasks activity`, `tasks send`, `tasks update`, `tasks complete`, `tasks message` | [tasks.md](tasks.md) |
| Test Runs (Adversarial Testing) | `test-runs`, `test-runs get`, `test-runs progress`, `test-runs create`, `test-runs cancel` | [test-runs.md](test-runs.md) |
| Test Targets (Adversarial Testing) | `test-targets`, `test-targets get`, `test-targets list`, `test-targets runs`, `test-targets create`, `test-targets delete` | [test-targets.md](test-targets.md) |
| Usage | `usage`, `usage agents`, `usage history`, `usage summary` | [usage.md](usage.md) |
| Verifiers | `verifiers`, `verifiers agents`, `verifiers attestation-log`, `verifiers get`, `verifiers list`, `verifiers transparency-log`, `verifiers create`, `verifiers delete`, …(+3) | [verifiers.md](verifiers.md) |
| Visibility | `visibility`, `visibility agent`, `visibility agent get`, `visibility agent allow-add`, `visibility agent block-add`, `visibility agent allow-remove`, `visibility agent block-remove`, `visibility group`, …(+5) | [visibility.md](visibility.md) |
