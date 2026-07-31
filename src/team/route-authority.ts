import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  ContractViolation,
  canonicalBytesV1,
  parseCanonicalJsonV1,
} from '../contracts/state-schemas';
import {
  HostCapabilityProfileV1,
  HostRouteReceiptV1,
  validateHostCapabilityProfile,
  validateHostRouteReceipt,
} from '../native/capability-profile';
import { atomicWriteContractBytes, sha256 } from '../runtime/atomic';

export const WORKER_ROUTE_AUTHORITY_SCHEMA_V1 = 'oma.worker-route-authority/v1' as const;
const MAXIMUM_AUTHORITY_BYTES = 512 * 1024;

export interface WorkerRouteAuthorityV1 {
  schema: typeof WORKER_ROUTE_AUTHORITY_SCHEMA_V1;
  teamId: string;
  taskId: string;
  generation: number;
  contextDigest: string;
  profile: HostCapabilityProfileV1;
  receipt: HostRouteReceiptV1;
  authorityDigest: string;
}

export interface WorkerRouteAuthorityExpectedV1 {
  stateRoot: string;
  teamId: string;
  taskId: string;
  generation: number;
  contextDigest: string;
  provider: 'agy_headless' | 'tmux_agy';
  requestMode: 'headless' | 'interactive';
  resolvedExecutable: string;
  now: string;
}

/**
 * leader-only external state path；worker descriptor 不能指定任意 authority 檔。
 * team/task 只以 digest 進入路徑，避免 traversal 與跨 team 混用。
 */
export function workerRouteAuthorityPath(
  stateRoot: string,
  teamId: string,
  taskId: string,
  generation: number,
): string {
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw violation('Worker route generation is invalid');
  }
  return path.join(
    path.resolve(stateRoot),
    'team-route-authorities',
    sha256(teamId),
    `${sha256(taskId)}-g${generation}.json`,
  );
}

export function createWorkerRouteAuthority(input: {
  stateRoot: string;
  teamId: string;
  taskId: string;
  generation: number;
  contextDigest: string;
  profile: HostCapabilityProfileV1;
  receipt: HostRouteReceiptV1;
  now: string;
}): WorkerRouteAuthorityV1 {
  const profile = validateHostCapabilityProfile(input.profile);
  const receipt = validateHostRouteReceipt(input.receipt, profile, {
    now: input.now,
    generation: input.generation,
    contextDigest: input.contextDigest,
    identityDigest: profile.identityDigest,
    fallbackPreconditionsSatisfied: true,
  });
  const withoutDigest = {
    schema: WORKER_ROUTE_AUTHORITY_SCHEMA_V1,
    teamId: input.teamId,
    taskId: input.taskId,
    generation: input.generation,
    contextDigest: input.contextDigest,
    profile,
    receipt,
  };
  return { ...withoutDigest, authorityDigest: sha256(canonicalBytesV1(withoutDigest)) };
}

export function writeWorkerRouteAuthority(
  stateRoot: string,
  authority: Readonly<WorkerRouteAuthorityV1>,
): string {
  const target = workerRouteAuthorityPath(
    stateRoot,
    authority.teamId,
    authority.taskId,
    authority.generation,
  );
  atomicWriteContractBytes(target, canonicalBytesV1(authority), { mode: 0o600 });
  return target;
}

/**
 * Atomically claims and consumes one worker authority. Renaming the canonical
 * path before validation prevents two bootstraps from replaying the same
 * receipt concurrently; the claimed file is removed on every exit path.
 */
export function consumeWorkerRouteAuthority(
  expected: Readonly<WorkerRouteAuthorityExpectedV1>,
): WorkerRouteAuthorityV1 {
  const stateRoot = fs.realpathSync(path.resolve(expected.stateRoot));
  const target = workerRouteAuthorityPath(
    stateRoot,
    expected.teamId,
    expected.taskId,
    expected.generation,
  );
  const claim = `${target}.claim-${process.pid}-${crypto.randomBytes(16).toString('hex')}`;
  try {
    assertAuthorityFile(target);
    fs.renameSync(target, claim);
  } catch (error) {
    throw violation(`Worker route authority is unavailable or already consumed: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }
  try {
    assertAuthorityFile(claim);
    const realTarget = fs.realpathSync(claim);
    const relative = path.relative(stateRoot, realTarget);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      throw violation('Worker route authority escapes the external state root');
    }
    const parsed = parseCanonicalJsonV1(fs.readFileSync(realTarget));
    return validateWorkerRouteAuthority(parsed, expected);
  } finally {
    try { fs.rmSync(claim, { force: true }); } catch (_) { /* consumed authority stays unavailable */ }
  }
}

export function validateWorkerRouteAuthority(
  value: unknown,
  expected: Omit<WorkerRouteAuthorityExpectedV1, 'stateRoot'>,
): WorkerRouteAuthorityV1 {
  if (!isObject(value)) throw violation('Worker route authority must be an object');
  assertKeys(value, [
    'schema', 'teamId', 'taskId', 'generation', 'contextDigest', 'profile', 'receipt', 'authorityDigest',
  ]);
  const authority = value as unknown as WorkerRouteAuthorityV1;
  if (authority.schema !== WORKER_ROUTE_AUTHORITY_SCHEMA_V1
    || authority.teamId !== expected.teamId || authority.taskId !== expected.taskId
    || authority.generation !== expected.generation || authority.contextDigest !== expected.contextDigest
    || typeof authority.authorityDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(authority.authorityDigest)) {
    throw violation('Worker route authority identity binding is invalid');
  }
  const { authorityDigest, ...withoutDigest } = authority;
  if (authorityDigest !== sha256(canonicalBytesV1(withoutDigest))) {
    throw violation('Worker route authority digest is invalid');
  }
  const profile = validateHostCapabilityProfile(authority.profile);
  const receipt = validateHostRouteReceipt(authority.receipt, profile, {
    now: expected.now,
    generation: expected.generation,
    contextDigest: expected.contextDigest,
    identityDigest: profile.identityDigest,
    fallbackPreconditionsSatisfied: true,
    provider: expected.provider,
    requestMode: expected.requestMode,
  });
  if (receipt.resolvedExecutable !== expected.resolvedExecutable
    || profile.hostIdentity.realpath !== expected.resolvedExecutable) {
    throw violation('Worker route executable is not bound to the profile and receipt');
  }
  return { ...authority, profile, receipt };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw violation('Worker route authority keys are invalid');
  }
}

function assertAuthorityFile(target: string): void {
  const stat = fs.lstatSync(target);
  // Windows 不保留 POSIX owner/group/other mode 語意；只能在 POSIX 主機強制 0600。
  const unsafePosixMode = process.platform !== 'win32' && (stat.mode & 0o077) !== 0;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAXIMUM_AUTHORITY_BYTES
    || unsafePosixMode
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw violation('Worker route authority file ownership, type, or bounds are invalid');
  }
}

function violation(message: string): ContractViolation {
  return new ContractViolation('E_CAPABILITY_ROUTE', message);
}
