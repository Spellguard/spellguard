# Contributing to Spellguard

Thanks for your interest in contributing! This document covers how to set up
a dev environment, what changes we accept, and how PRs flow back into the
project.

## Licensing

Spellguard is released under the [Apache License 2.0](LICENSE). By
submitting a contribution, you agree that your contribution is licensed
under the same terms.

New source files should include an SPDX header:

```ts
// SPDX-License-Identifier: Apache-2.0
```

```py
# SPDX-License-Identifier: Apache-2.0
```

## Reporting bugs and proposing features

- **Bugs** — open an issue using the *Bug report* template. Include a
  minimal reproduction, expected vs. actual behavior, and your environment.
- **Features** — open an issue using the *Feature request* template before
  starting work on a large change, so we can align on the design.
- **Security issues** — do **not** file a public issue. See
  [SECURITY.md](SECURITY.md) for the private disclosure channel.

## Development setup

Prerequisites:

- Node.js 24+
- pnpm 9+
- Python 3.13 (for the Python packages and their tests)

```bash
# Install Node deps
pnpm install

# Build workspace TS libs. Required before typecheck/test because
# workspace packages resolve each other through `exports` fields that
# point at ./dist/.
pnpm run build:libs

# Python deps
pnpm run setup:python
```

## Running checks

```bash
pnpm run typecheck         # TypeScript type-check across the workspace
pnpm run lint:check        # Lint without auto-fix (matches CI)
pnpm run test              # Vitest unit/component tests
pnpm run test:python       # Pytest unit tests for Python packages
```

Integration tests require the Verifier and demo agents to be running:

```bash
# In one terminal:
pnpm run dev

# In another:
pnpm run test:integration
pnpm run test:python:integration
```

CI runs the non-integration suites on every PR; the integration suites
are expected to pass locally before you mark a PR ready for review.

## Pull request workflow

1. Fork the repo and create a feature branch from `main`.
2. Keep PRs focused — one logical change per PR. Split unrelated changes
   into separate PRs so they can be reviewed independently.
3. Add or update tests for any new behavior. Don't disable existing tests
   to "make CI pass"; if a test is wrong, fix it deliberately.
4. Run `pnpm run lint:check && pnpm run typecheck && pnpm run test` before
   pushing.
5. Open the PR against `main`. Fill in the PR template — Summary,
   Motivation, Changes, Test plan.
6. Address review feedback by pushing new commits to the branch; we squash
   on merge, so commit history within the branch doesn't need to be linear.

## How merged PRs are released

This repository is the public surface of a larger internal monorepo.
Merged PRs are mirrored back into the internal repo by maintainers, and
new releases here are published as squash commits against `main`. This
means:

- **Maintained on `main` only.** We don't accept PRs against release
  branches. Bug-fix releases are cut from `main` after the fix lands.
- **Don't expect direct write access to non-`main` branches.** All
  long-lived branches in this repo are managed by automation.
- **Releases happen on a regular cadence**, not on every merge.

## Style and conventions

- TypeScript: `moduleResolution: "bundler"`. Don't use `.js` extensions in
  TypeScript imports (`pnpm run lint:check` enforces this).
- Python: type-annotated, formatted with the project's defaults; aim for
  parity with the TypeScript counterpart where one exists.
- Don't add comments that explain *what* well-named code already says.
  Comment *why* a non-obvious choice was made (constraint, workaround,
  bug reference).
- Keep PRs out of `packages/management/`, `packages/dashboard/`, and other
  paths that aren't in this repo — those are closed-source components.

## Getting help

- Check the [README](README.md) for the project overview.
- Browse existing [issues](https://github.com/Spellguard/spellguard/issues)
  and PRs; your question may already be answered.
- Open a new issue if you're stuck — we'd rather hear an unclear question
  than have you spin your wheels.
