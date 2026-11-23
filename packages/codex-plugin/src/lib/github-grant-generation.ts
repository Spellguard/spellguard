// SPDX-License-Identifier: Apache-2.0

import { randomUUID } from 'node:crypto';
import {
  accessSync,
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  readlinkSync,
  statSync,
} from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type {
  GithubGrantCredentialDescriptor,
  GithubGrantsBundleFrame,
} from '@spellguard/agent-control';
import { parseServerFrame } from '@spellguard/agent-control';
import { readConfig, readPrivateConfigFile, writeConfig } from './config-store';
import { canonicalizeGitRemote } from './git-remote-canonicalizer';

/** The single machine-wide git author identity a grant set is issued under. */
interface GitAuthorIdentity {
  name: string;
  email: string;
}

interface GenerationState {
  protocolVersion: 5;
  /** Agent identity whose revision sequence this generation belongs to. */
  agentId: string;
  deliveryId: string;
  grantSetRevision: string;
  grants: Array<Omit<GithubGrantCredentialDescriptor, 'scoped_token'>>;
  /**
   * The author identity this generation was issued under. Non-secret, and part
   * of the generation itself so the activated set is self-describing. Absent on
   * a zero-grant set (nothing issued it) and on generations written by builds
   * that predate the identity fix.
   *
   * Diagnostic only today: no code path reads this back out of state.json —
   * the identity a session actually git-commits under comes from config.json's
   * `gitAuthorName`/`gitAuthorEmail`, written by `establishGitAuthorIdentity`
   * below. Kept anyway (not removed) so an operator inspecting a generation
   * directory on disk can see which identity it was issued under without
   * cross-referencing server-side audit logs — cheap and harmless to persist.
   */
  gitAuthor?: GitAuthorIdentity;
}

function generationAgentId(state: GenerationState): string | null {
  if (UUID_PATTERN.test(state.agentId)) return state.agentId;
  const legacyAgentId = state.grants[0]?.agent_id;
  return typeof legacyAgentId === 'string' && UUID_PATTERN.test(legacyAgentId)
    ? legacyAgentId
    : null;
}

function bundleAgentId(
  configDir: string,
  frame: GithubGrantsBundleFrame,
): string {
  const memberAgentId = frame.credentials[0]?.agent_id;
  const localAgentId = readConfig(join(configDir, 'config.json')).config
    ?.agentId;
  if (memberAgentId && localAgentId && memberAgentId !== localAgentId) {
    throw new Error('GitHub grant bundle belongs to a different agent');
  }
  const agentId = memberAgentId ?? localAgentId;
  if (!agentId || !UUID_PATTERN.test(agentId)) {
    throw new Error('GitHub grant bundle has no authenticated agent identity');
  }
  if (frame.credentials.some((credential) => credential.agent_id !== agentId)) {
    throw new Error('GitHub grant bundle contains mixed agent identities');
  }
  return agentId;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeSupersededGenerations(
  root: string,
  generations: string,
  activeRevision: string,
  removeEveryInactiveGeneration = false,
): Promise<void> {
  const rootStat = await lstat(generations);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error('unsafe GitHub generations directory');
  }
  const currentTarget = readlinkSync(join(root, 'current'));
  const currentMatch = CURRENT_TARGET_PATTERN.exec(currentTarget);
  if (!currentMatch || currentMatch[1] !== activeRevision) {
    throw new Error('GitHub generation changed before cleanup');
  }
  for (const entry of await readdir(generations, { withFileTypes: true })) {
    const generationMatch = CURRENT_TARGET_PATTERN.exec(
      `generations/${entry.name}`,
    );
    const stagingMatch = STAGING_NAME_PATTERN.exec(entry.name);
    const revision = generationMatch?.[1] ?? stagingMatch?.[1];
    if (
      !revision ||
      (!removeEveryInactiveGeneration &&
        BigInt(revision) > BigInt(activeRevision))
    )
      continue;
    if (generationMatch && entry.name === basename(currentTarget)) continue;
    const candidate = join(generations, entry.name);
    if (dirname(candidate) !== generations) {
      throw new Error('unsafe GitHub generation cleanup target');
    }
    const stat = await lstat(candidate);
    if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
    await rm(candidate, { recursive: true });
  }
  await syncDirectory(generations);
}

async function currentState(root: string): Promise<GenerationState | null> {
  try {
    const raw = readPrivateConfigFile(join(root, 'current', 'state.json'));
    return JSON.parse(raw) as GenerationState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function matchesActiveGeneration(
  root: string,
  current: GenerationState,
  frame: GithubGrantsBundleFrame,
): Promise<boolean> {
  const grants = frame.credentials.map(
    ({ scoped_token: _secret, ...grant }) => grant,
  );
  if (JSON.stringify(current.grants) !== JSON.stringify(grants)) return false;
  for (const grant of frame.credentials) {
    const token = readPrivateConfigFile(
      join(root, 'current', 'tokens', grant.grant_id),
    );
    if (token !== `${grant.scoped_token}\n`) return false;
  }
  return true;
}

/**
 * The author identity carried by a grant set. Decision D7: the git author
 * identity is single and machine-wide, not per-org, so — exactly as the V4
 * handler does with the first freshly-installed credential — the FIRST grant in
 * the authoritative full set supplies it. A zero-grant set has no issuer and so
 * carries no identity.
 */
function grantSetGitAuthor(
  frame: GithubGrantsBundleFrame,
): GitAuthorIdentity | null {
  const providerData = frame.credentials[0]?.provider_data;
  if (!providerData) return null;
  const { git_author_name: name, git_author_email: email } = providerData;
  if (!name || !email) return null;
  return { name, email };
}

/**
 * Project the grant set's author identity into the config store — the fields
 * `env-file-writer.ts` exports as `GIT_CONFIG_VALUE_*` (`user.name`/
 * `user.email`) and the session-start hook heals into Codex's
 * `[shell_environment_policy]`. Without this a V5-only agent authenticates to
 * GitHub correctly but has NO Spellguard git identity, so its commits fall back
 * to the machine default or git refuses to commit at all.
 *
 * Callers MUST run this BEFORE the current-pointer flip: the pointer flip is
 * what makes the tokens live, so establishing the identity first means a reader
 * that can see live tokens can never find the identity missing. The reverse
 * order would leave exactly that window open.
 *
 * A config that is absent, malformed, or unreadable is skipped rather than
 * fatal — identical to `handleCredentialUpdate`'s `if (!cur.config) return`.
 * Denying GitHub access over an unreadable local config would trade a real
 * credential outage for an attribution gap.
 */
function establishGitAuthorIdentity(
  configDir: string,
  author: GitAuthorIdentity | null,
): void {
  if (!author) return;
  const configPath = join(configDir, 'config.json');
  const current = readConfig(configPath);
  if (!current.config) return;
  if (
    current.config.gitAuthorName === author.name &&
    current.config.gitAuthorEmail === author.email
  ) {
    return;
  }
  writeConfig(
    {
      ...current.config,
      gitAuthorName: author.name,
      gitAuthorEmail: author.email,
    },
    configPath,
  );
}

/**
 * Stage a complete token/config/helper generation, fsync it, then switch one
 * symlink. Readers therefore see the old or new full set across a crash, never
 * a mixture. No token is present in state.json or the manifest.
 */
export async function applyGithubGrantBundle(
  configDir: string,
  frame: GithubGrantsBundleFrame,
  testHooks: { beforeActivate?: () => void | Promise<void> } = {},
): Promise<void> {
  const parsed = parseServerFrame(JSON.stringify(frame));
  if (!parsed || parsed.type !== 'github_grants_bundle') {
    throw new Error('invalid GitHub grant bundle');
  }

  const root = join(configDir, 'github-grants');
  const generations = join(root, 'generations');
  await mkdir(generations, { recursive: true, mode: 0o700 });
  const gitAuthor = grantSetGitAuthor(frame);
  const agentId = bundleAgentId(configDir, frame);
  const current = await currentState(root);
  const incoming = BigInt(frame.grant_set_revision);
  let replacingAgent = false;
  if (current) {
    const activeAgentId = generationAgentId(current);
    if (!activeAgentId && current.grantSetRevision !== '0') {
      throw new Error('active GitHub grant generation has no agent identity');
    }
    const sameAgent = activeAgentId === agentId;
    replacingAgent = activeAgentId !== null && !sameAgent;
    const active = BigInt(current.grantSetRevision);
    if (sameAgent && incoming < active)
      throw new Error('stale GitHub grant set revision');
    if (sameAgent && incoming === active) {
      if (
        current.deliveryId === frame.delivery_id ||
        (await matchesActiveGeneration(root, current, frame))
      ) {
        // Idempotent re-delivery of the ALREADY-ACTIVE set: the tokens are
        // live, so re-asserting the identity here repairs a machine whose
        // generation was applied by a build that never wrote one (the resume
        // replay is that machine's only chance to be healed).
        establishGitAuthorIdentity(configDir, gitAuthor);
        await removeSupersededGenerations(
          root,
          generations,
          current.grantSetRevision,
        );
        return;
      }
      throw new Error('conflicting GitHub grant set revision');
    }
  }

  const generationName = `${frame.grant_set_revision}-${frame.delivery_id}`;
  const staging = join(
    generations,
    `.${generationName}.${randomUUID()}.staging`,
  );
  const destination = join(generations, generationName);
  // Recover an exact delivery that crashed after generation rename but before
  // the sole current-pointer commit boundary.
  await rm(destination, { recursive: true, force: true });
  await mkdir(join(staging, 'tokens'), { recursive: true, mode: 0o700 });

  const state: GenerationState = {
    protocolVersion: 5,
    agentId,
    deliveryId: frame.delivery_id,
    grantSetRevision: frame.grant_set_revision,
    grants: frame.credentials.map(
      ({ scoped_token: _secret, ...grant }) => grant,
    ),
    ...(gitAuthor ? { gitAuthor } : {}),
  };
  await writeFile(join(staging, 'state.json'), JSON.stringify(state, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });

  const manifest: string[] = [];
  for (const grant of frame.credentials) {
    const tokenName = grant.grant_id;
    const tokenPath = join(staging, 'tokens', tokenName);
    await writeFile(tokenPath, `${grant.scoped_token}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    const repositories =
      grant.scope.mode === 'selected'
        ? grant.scope.repository_names.join(',')
        : '';
    manifest.push(
      [
        grant.github_org_login.toLowerCase(),
        grant.grant_id,
        `tokens/${tokenName}`,
        grant.scope.mode,
        repositories,
      ].join('\t'),
    );
  }
  await writeFile(join(staging, 'manifest.tsv'), `${manifest.join('\n')}\n`, {
    mode: 0o600,
    flag: 'wx',
  });
  await syncDirectory(join(staging, 'tokens'));
  await syncDirectory(staging);
  await rename(staging, destination);
  await syncDirectory(generations);

  // Identity BEFORE the commit boundary below. A failure here throws with the
  // staged generation still unpointed, so the old full set (and its identity)
  // stays active — never new tokens under a missing or stale author.
  establishGitAuthorIdentity(configDir, gitAuthor);

  await testHooks.beforeActivate?.();

  const nextLink = join(root, `.current.${randomUUID()}`);
  await symlink(join('generations', basename(destination)), nextLink);
  await rename(nextLink, join(root, 'current'));
  await syncDirectory(root);

  // Cleanup is after activation, so a failure cannot roll the helper back to
  // the old set. It remains loud: an exact redelivery retries this deletion
  // through the idempotent branch above.
  await removeSupersededGenerations(
    root,
    generations,
    frame.grant_set_revision,
    replacingAgent,
  );
}

export async function readActiveGithubGrantState(
  configDir: string,
): Promise<GenerationState | null> {
  return currentState(join(configDir, 'github-grants'));
}

/**
 * The V5 answer for ONE GitHub remote.
 *
 * Five states, not a boolean, because the four ways there is no usable
 * credential are not the same fact and must not produce the same message
 * (#781, #793):
 *  - `available`  — a covering grant that has not expired.
 *  - `expired`    — a covering grant whose token has expired. Its scoped token
 *                   id is exactly the input the pull-on-use refresh supersedes,
 *                   so callers pass it through: git runs, the credential helper
 *                   refreshes, and an unrefreshable token fails closed at git
 *                   or at GitHub. Blocking here made the recovery path
 *                   unreachable from a coding-agent session.
 *  - `absent`     — no V5 authority on disk at all; the caller's legacy V4
 *                   fallback is permitted.
 *  - `unavailable`— a V5 authority exists but is malformed, wrong-agent, or
 *                   carries no grant covering this remote. Authoritative:
 *                   fail closed, no fallback.
 *  - `unattributed`— no GitHub remote was supplied to resolve against. Nothing
 *                   was asked about a credential; saying one is unavailable
 *                   sends operators hunting a problem that does not exist.
 */
export type ActiveGithubGrantResolution =
  | { state: 'absent' | 'unavailable' | 'unattributed' }
  | {
      state: 'available' | 'expired';
      scopedTokenId: string;
      /** Absent only on a legacy V4 credential that carries no expiry. */
      expiresAt?: string;
    };

/** The five answers a GitHub credential lookup can give. */
export type GithubCredentialState = ActiveGithubGrantResolution['state'];

export interface ActiveGithubGrantExpiryEntry {
  scopedTokenId: string;
  expiresAt: string;
}

export type ActiveGithubGrantExpiryResolution =
  | { state: 'absent' | 'unavailable' }
  | { state: 'available'; entries: ActiveGithubGrantExpiryEntry[] };

export type ActiveGithubGrantPrimaryTokenResolution =
  | { state: 'absent' | 'unavailable' }
  | { state: 'available'; token: string | null };

interface NormalizedGrant {
  grantId: string;
  agentId: string;
  owner: string;
  mode: string;
  repositories: string[];
  scopedTokenId: string;
  expiresAt: string;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CURRENT_TARGET_PATTERN =
  /^generations\/(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const STAGING_NAME_PATTERN =
  /^\.(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.staging$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function protectedArtifactSize(path: string): number | null {
  const flags =
    fsConstants.O_RDONLY |
    (process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW);
  try {
    const fd = openSync(path, flags);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) return null;
      if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0)
        return null;
      return stat.size;
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

function tokenArtifactIsUsable(path: string): boolean {
  const size = protectedArtifactSize(path);
  return size !== null && size > 1;
}

type FrozenGeneration =
  | { state: 'absent' | 'unavailable' }
  | {
      state: 'selected';
      path: string;
      revision: string;
      deliveryId: string;
    };

function freezeGeneration(
  root: string,
  afterReadlink?: () => void,
): FrozenGeneration {
  const current = join(root, 'current');
  try {
    if (!lstatSync(current).isSymbolicLink()) return { state: 'unavailable' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'absent' }
      : { state: 'unavailable' };
  }
  try {
    const target = readlinkSync(current);
    const match = CURRENT_TARGET_PATTERN.exec(target);
    if (!match) return { state: 'unavailable' };
    const generations = join(root, 'generations');
    const generation = join(root, target);
    const generationsStat = lstatSync(generations);
    const generationStat = lstatSync(generation);
    if (
      generationsStat.isSymbolicLink() ||
      !generationsStat.isDirectory() ||
      generationStat.isSymbolicLink() ||
      !generationStat.isDirectory()
    ) {
      return { state: 'unavailable' };
    }
    afterReadlink?.();
    return {
      state: 'selected',
      path: generation,
      revision: match[1],
      deliveryId: match[2],
    };
  } catch {
    // `current` exists and is authoritative. A dangling target or any failure
    // to freeze its generation must not reopen legacy V4 fallback.
    return { state: 'unavailable' };
  }
}

function selectFrozenGeneration(
  configDir: string,
  afterReadlink?: () => void,
): FrozenGeneration {
  const framework = freezeGeneration(
    join(configDir, 'github-grants'),
    afterReadlink,
  );
  if (framework.state !== 'absent') return framework;
  return freezeGeneration(
    join(dirname(configDir), 'github-grants'),
    afterReadlink,
  );
}

function parseGenerationHeader(
  state: unknown,
  manifest: string,
  frozen: Extract<FrozenGeneration, { state: 'selected' }>,
): { grants: unknown[]; lines: string[] } | null {
  if (!isRecord(state) || state.protocolVersion !== 5) return null;
  if (state.deliveryId !== frozen.deliveryId) return null;
  if (state.grantSetRevision !== frozen.revision) return null;
  if (!Array.isArray(state.grants) || !manifest.endsWith('\n')) return null;
  const body = manifest.slice(0, -1);
  const lines = body === '' ? [] : body.split('\n');
  if (lines.length !== state.grants.length) return null;
  return { grants: state.grants, lines };
}

function managedGrant(raw: Record<string, unknown>): NormalizedGrant {
  return {
    grantId: raw.grantId as string,
    agentId: raw.agentId as string,
    owner: raw.owner as string,
    mode: raw.mode as string,
    repositories: raw.repositoryNames as string[],
    scopedTokenId: raw.scopedTokenId as string,
    expiresAt: raw.expiresAt as string,
  };
}

function frameworkGrant(raw: Record<string, unknown>): NormalizedGrant | null {
  if (raw.provider !== 'github' || raw.status !== 'valid') return null;
  const scope = isRecord(raw.scope) ? raw.scope : {};
  return {
    grantId: raw.grant_id as string,
    agentId: raw.agent_id as string,
    owner: raw.github_org_login as string,
    mode: scope.mode as string,
    repositories: scope.repository_names as string[],
    scopedTokenId: raw.scoped_token_id as string,
    expiresAt: raw.expires_at as string,
  };
}

function validNormalizedGrant(
  grant: NormalizedGrant,
  allowExpired = false,
): boolean {
  if (!UUID_PATTERN.test(grant.grantId) || !UUID_PATTERN.test(grant.agentId)) {
    return false;
  }
  if (!grant.owner || grant.owner.trim() !== grant.owner) return false;
  if (
    !grant.scopedTokenId.trim() ||
    !Number.isFinite(Date.parse(grant.expiresAt))
  ) {
    return false;
  }
  // GitHub login display casing is not canonical. The generation manifest and
  // repository scope use lowercase routing keys, so normalize only the
  // descriptor owner before performing those exact comparisons. Repository
  // paths themselves remain required to be lowercase below.
  grant.owner = grant.owner.toLowerCase();
  if (!allowExpired && Date.parse(grant.expiresAt) <= Date.now()) return false;
  if (grant.mode === 'all') {
    if (
      grant.repositories !== undefined &&
      (!Array.isArray(grant.repositories) || grant.repositories.length > 0)
    ) {
      return false;
    }
    grant.repositories = [];
    return true;
  }
  if (grant.mode !== 'selected' || !Array.isArray(grant.repositories)) {
    return false;
  }
  if (grant.repositories.length === 0) return false;
  const repositories = new Set<string>();
  for (const repo of grant.repositories) {
    if (typeof repo !== 'string' || repo !== repo.toLowerCase()) return false;
    const [owner, name, ...extra] = repo.split('/');
    if (owner !== grant.owner || !name || extra.length > 0) return false;
    if (repositories.has(repo)) return false;
    repositories.add(repo);
  }
  if (repositories.size !== grant.repositories.length) {
    return false;
  }
  return true;
}

function normalizeGrant(
  raw: unknown,
  revision: string,
  allowExpired = false,
): NormalizedGrant | null {
  if (!isRecord(raw)) return null;
  const managed = typeof raw.grantId === 'string';
  if (!managed && raw.grant_set_revision !== revision) return null;
  const grant = managed ? managedGrant(raw) : frameworkGrant(raw);
  if (!grant || !validNormalizedGrant(grant, allowExpired)) return null;
  return grant;
}

function expiryEntriesFromGeneration(
  frozen: Extract<FrozenGeneration, { state: 'selected' }>,
  state: unknown,
  manifest: string,
  agentId: string,
): ActiveGithubGrantExpiryResolution {
  const header = parseGenerationHeader(state, manifest, frozen);
  if (!header) return { state: 'unavailable' };
  const seenGrants = new Set<string>();
  const seenOwners = new Set<string>();
  const seenTokens = new Set<string>();
  const entries: ActiveGithubGrantExpiryEntry[] = [];
  for (let index = 0; index < header.lines.length; index++) {
    const fields = header.lines[index].split('\t');
    const grant = normalizeGrant(header.grants[index], frozen.revision, true);
    if (
      !grant ||
      grant.agentId !== agentId ||
      seenOwners.has(grant.owner) ||
      seenTokens.has(grant.scopedTokenId)
    ) {
      return { state: 'unavailable' };
    }
    if (!matchManifestGrant(frozen.path, fields, grant, seenGrants)) {
      return { state: 'unavailable' };
    }
    seenOwners.add(grant.owner);
    seenTokens.add(grant.scopedTokenId);
    entries.push({
      scopedTokenId: grant.scopedTokenId,
      expiresAt: grant.expiresAt,
    });
  }
  return { state: 'available', entries };
}

function primaryTokenFromGeneration(
  frozen: Extract<FrozenGeneration, { state: 'selected' }>,
  state: unknown,
  manifest: string,
  agentId: string,
): ActiveGithubGrantPrimaryTokenResolution {
  const header = parseGenerationHeader(state, manifest, frozen);
  if (!header || !isRecord(state)) return { state: 'unavailable' };
  const persistedAgentId = state.agentId;
  if (
    persistedAgentId !== undefined &&
    (typeof persistedAgentId !== 'string' || persistedAgentId !== agentId)
  ) {
    return { state: 'unavailable' };
  }
  if (header.lines.length === 0) {
    return persistedAgentId === agentId
      ? { state: 'available', token: null }
      : { state: 'unavailable' };
  }

  const seenGrants = new Set<string>();
  const seenOwners = new Set<string>();
  const seenTokens = new Set<string>();
  let primaryGrantId: string | undefined;
  for (let index = 0; index < header.lines.length; index++) {
    const fields = header.lines[index].split('\t');
    const grant = normalizeGrant(header.grants[index], frozen.revision);
    if (
      !grant ||
      grant.agentId !== agentId ||
      seenOwners.has(grant.owner) ||
      seenTokens.has(grant.scopedTokenId) ||
      !matchManifestGrant(frozen.path, fields, grant, seenGrants)
    ) {
      return { state: 'unavailable' };
    }
    seenOwners.add(grant.owner);
    seenTokens.add(grant.scopedTokenId);
    primaryGrantId ??= grant.grantId;
  }
  if (!primaryGrantId) return { state: 'unavailable' };
  try {
    const raw = readPrivateConfigFile(
      join(frozen.path, 'tokens', primaryGrantId),
    );
    if (!raw.endsWith('\n')) return { state: 'unavailable' };
    const token = raw.slice(0, -1);
    if (!token || /[\r\n]/.test(token)) return { state: 'unavailable' };
    return { state: 'available', token };
  } catch {
    return { state: 'unavailable' };
  }
}

function matchManifestGrant(
  generationPath: string,
  fields: string[],
  grant: NormalizedGrant,
  seen: Set<string>,
): NormalizedGrant | null {
  if (fields.length !== 5) return null;
  const [owner, grantId, tokenRelative, mode, repositories] = fields;
  if (seen.has(grantId) || grantId !== grant.grantId) return null;
  if (owner !== grant.owner || mode !== grant.mode) return null;
  if (repositories !== grant.repositories.join(',')) return null;
  if (tokenRelative !== `tokens/${grantId}`) return null;
  if (!tokenArtifactIsUsable(join(generationPath, tokenRelative))) return null;
  seen.add(grantId);
  return grant;
}

function resolveFromGeneration(
  frozen: Extract<FrozenGeneration, { state: 'selected' }>,
  state: unknown,
  manifest: string,
  remote: { owner: string; repo: string },
  agentId: string,
): ActiveGithubGrantResolution {
  const header = parseGenerationHeader(state, manifest, frozen);
  if (!header) return { state: 'unavailable' };
  const seen = new Set<string>();
  const seenOwners = new Set<string>();
  const fullRepo = `${remote.owner}/${remote.repo}`;
  let selected: NormalizedGrant | undefined;
  for (let index = 0; index < header.lines.length; index++) {
    const fields = header.lines[index].split('\t');
    // STRUCTURE only (allowExpired). Expiry is decided once, below, for the
    // grant that actually covers this remote. Checking it here made one org's
    // expired grant reject the whole generation, so a still-valid grant for a
    // different org was unusable too (#781) — the per-owner defect the Go
    // helper already fixed (`validGrant` in internal/gitcredential/helper.go).
    const grant = normalizeGrant(header.grants[index], frozen.revision, true);
    if (!grant || grant.agentId !== agentId || seenOwners.has(grant.owner)) {
      return { state: 'unavailable' };
    }
    const matched = matchManifestGrant(frozen.path, fields, grant, seen);
    if (!matched) return { state: 'unavailable' };
    seenOwners.add(grant.owner);
    const covers =
      matched.owner === remote.owner &&
      (matched.mode === 'all' || matched.repositories.includes(fullRepo));
    if (covers && !selected) selected = matched;
  }
  if (!selected) return { state: 'unavailable' };
  return {
    state:
      Date.parse(selected.expiresAt) <= Date.now() ? 'expired' : 'available',
    scopedTokenId: selected.scopedTokenId,
    expiresAt: selected.expiresAt,
  };
}

/**
 * Resolve the non-secret token id selected by the helper-consumed V5 current
 * generation for one GitHub remote. The token file is opened only for private
 * regular-file metadata; its secret bytes never enter this process or the hook
 * payload. `absent` alone permits the caller's legacy V4 fallback. Any present
 * but malformed/incomplete generation is authoritative and fails closed. An
 * expired covering grant resolves to `expired`, not to nothing: see the state
 * documentation on `ActiveGithubGrantResolution`.
 */
export function resolveActiveGithubGrantCredential(
  configDir: string,
  remoteUrl: string | undefined,
  agentId: string,
  options: { afterCurrentReadlink?: () => void } = {},
): ActiveGithubGrantResolution {
  const selected = selectFrozenGeneration(
    configDir,
    options.afterCurrentReadlink,
  );
  if (selected.state !== 'selected') return selected;
  // No GitHub remote to resolve against is an ATTRIBUTION failure, not a
  // credential failure: nothing was asked about a credential yet.
  const remote = remoteUrl ? canonicalizeGitRemote(remoteUrl) : null;
  if (!remote) return { state: 'unattributed' };
  try {
    const state = JSON.parse(
      readPrivateConfigFile(join(selected.path, 'state.json')),
    );
    const manifest = readPrivateConfigFile(join(selected.path, 'manifest.tsv'));
    return resolveFromGeneration(selected, state, manifest, remote, agentId);
  } catch {
    return { state: 'unavailable' };
  }
}

/**
 * Read the non-secret expiry descriptors from the helper-consumed V5 current
 * generation. Expired members remain valid inputs here because they are the
 * entries most urgently needing refresh. Any present but malformed,
 * incomplete, revoked, or wrong-agent generation is authoritative unavailable;
 * only a truly absent V5 root permits the daemon's legacy V4 census.
 */
export function readActiveGithubGrantExpiryEntries(
  configDir: string,
  agentId: string,
  options: { afterCurrentReadlink?: () => void } = {},
): ActiveGithubGrantExpiryResolution {
  const selected = selectFrozenGeneration(
    configDir,
    options.afterCurrentReadlink,
  );
  if (selected.state !== 'selected') return selected;
  try {
    const state = JSON.parse(
      readPrivateConfigFile(join(selected.path, 'state.json')),
    );
    const manifest = readPrivateConfigFile(join(selected.path, 'manifest.tsv'));
    return expiryEntriesFromGeneration(selected, state, manifest, agentId);
  } catch {
    return { state: 'unavailable' };
  }
}

/**
 * Read the primary token from the helper-consumed V5 authority so custom
 * framework projections can be reconstructed after a daemon restart. A
 * present but malformed or wrong-agent generation is authoritative and fails
 * closed; only an absent V5 authority permits legacy V4 fallback.
 */
export function readActiveGithubGrantPrimaryToken(
  configDir: string,
  agentId: string,
  options: { afterCurrentReadlink?: () => void } = {},
): ActiveGithubGrantPrimaryTokenResolution {
  const selected = selectFrozenGeneration(
    configDir,
    options.afterCurrentReadlink,
  );
  if (selected.state !== 'selected') return selected;
  try {
    const state = JSON.parse(
      readPrivateConfigFile(join(selected.path, 'state.json')),
    );
    const manifest = readPrivateConfigFile(join(selected.path, 'manifest.tsv'));
    return primaryTokenFromGeneration(selected, state, manifest, agentId);
  } catch {
    return { state: 'unavailable' };
  }
}

interface LegacyCompanion {
  path: string;
  size: number;
}

function newestCompanion(configDir: string): LegacyCompanion | null {
  const candidates = [
    join(configDir, 'git-tokens'),
    join(dirname(configDir), 'git-tokens'),
  ];
  const readable = candidates.flatMap((path) => {
    try {
      accessSync(path, fsConstants.R_OK);
      const stat = statSync(path);
      return [{ path, size: stat.size, mtime: stat.mtimeMs }];
    } catch {
      return [];
    }
  });
  readable.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path));
  const selected = readable[0];
  return selected ? { path: selected.path, size: selected.size } : null;
}

function companionContainsCredential(
  companion: LegacyCompanion,
  key: string,
  expectedToken: string,
): boolean {
  const keyBytes = Buffer.from(key, 'utf8');
  const tokenBytes = Buffer.from(expectedToken, 'utf8');
  const chunk = Buffer.allocUnsafe(4096);
  let fd: number | undefined;
  let keyOffset = 0;
  let keyMatches = true;
  let afterTab = false;
  let tokenOffset = 0;
  let tokenMatches = true;
  const matches = () =>
    keyMatches &&
    afterTab &&
    tokenMatches &&
    tokenOffset === tokenBytes.length &&
    tokenOffset > 0;
  try {
    fd = openSync(companion.path, fsConstants.O_RDONLY);
    for (let count = readSync(fd, chunk, 0, chunk.length, null); count > 0; ) {
      for (let index = 0; index < count; index++) {
        const byte = chunk[index];
        if (byte === 0x0a) {
          if (matches()) return true;
          keyOffset = 0;
          keyMatches = true;
          afterTab = false;
          tokenOffset = 0;
          tokenMatches = true;
        } else if (!afterTab && byte === 0x09) {
          afterTab = true;
          keyMatches = keyMatches && keyOffset === keyBytes.length;
        } else if (!afterTab) {
          keyMatches =
            keyMatches &&
            keyOffset < keyBytes.length &&
            byte === keyBytes[keyOffset];
          keyOffset++;
        } else {
          tokenMatches =
            tokenMatches &&
            tokenOffset < tokenBytes.length &&
            byte === tokenBytes[tokenOffset];
          tokenOffset++;
        }
      }
      chunk.fill(0, 0, count);
      count = readSync(fd, chunk, 0, chunk.length, null);
    }
    return matches();
  } catch {
    return false;
  } finally {
    keyBytes.fill(0);
    tokenBytes.fill(0);
    chunk.fill(0);
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * Resolve legacy V4 status identity against the helper's authoritative TSV.
 * Companion token bytes are compared only to bind the helper artifact to the
 * config identity, then zeroed immediately; this resolver never returns or logs
 * them. A helper-first rotation therefore blocks until config commits too.
 */
export function resolveLegacyGithubCredential(
  config: import('./config-store').SpellguardConfig,
  configDir: string,
  remoteUrl: string | undefined,
): ActiveGithubGrantResolution {
  if (config.revoked) return { state: 'unavailable' };
  if (!remoteUrl) return { state: 'unattributed' };
  const remote = canonicalizeGitRemote(remoteUrl);
  if (!remote) return { state: 'unattributed' };
  const companion = newestCompanion(configDir);
  if (config.githubCredentials !== undefined) {
    const entry = config.githubCredentials[remote.owner];
    if (
      !companion ||
      !entry?.scopedToken ||
      !companionContainsCredential(companion, remote.owner, entry.scopedToken)
    )
      return { state: 'unavailable' };
    if (!entry || entry.revoked || !entry.scopedTokenId)
      return { state: 'unavailable' };
    if (
      !Number.isFinite(Date.parse(entry.expiresAt)) ||
      Date.parse(entry.expiresAt) <= Date.now()
    ) {
      return { state: 'unavailable' };
    }
    return {
      state: 'available',
      scopedTokenId: entry.scopedTokenId,
      expiresAt: entry.expiresAt,
    };
  }
  if (
    (companion !== null &&
      !companionContainsCredential(companion, '*', config.scopedToken ?? '')) ||
    !config.scopedTokenId ||
    !config.scopedToken
  )
    return { state: 'unavailable' };
  if (
    config.expiresAt !== undefined &&
    (!Number.isFinite(Date.parse(config.expiresAt)) ||
      Date.parse(config.expiresAt) <= Date.now())
  ) {
    return { state: 'unavailable' };
  }
  return {
    state: 'available',
    scopedTokenId: config.scopedTokenId,
    expiresAt: config.expiresAt,
  };
}
