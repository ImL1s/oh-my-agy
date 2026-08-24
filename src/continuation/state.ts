import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJson, canonicalJson, FaultInjector, NO_FAULTS, sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { acquireOwnerLock, ProcessLiveness, releaseOwnerLock } from '../runtime/lock';
import { readProcessIdentity } from '../runtime/process';
import {
  ensureContainedPath,
  externalStatePathKey,
  platformWorkspaceSessionsRoot,
} from '../runtime/state-root';
import { ProcessIdentity, Result, err, ok } from '../runtime/types';
import {
  SessionAggregateStore,
  SessionAggregateV1,
  createInitialSessionAggregate,
  sessionAggregateHash,
  sessionAggregatePath,
} from './session-aggregate';
import {
  AntigravityNativeReceiptV1,
  ParsedImportedCarrierV1,
  validateAntigravityNativeReceipt,
} from '../contracts/carrier';

export type LaunchAuthorityEvidenceV1 =
  | { kind: 'antigravity_native_receipt'; receipt: AntigravityNativeReceiptV1 }
  | { kind: 'imported_carrier'; carrier: ParsedImportedCarrierV1 };

export interface NativeConversationExpectationV1 {
  runId: string;
  taskId: string;
  generation: number;
  parentConversationId?: string;
  provider?: AntigravityNativeReceiptV1['provider'];
}

/**
 * Reconcile zero/one/many native bindings. Imported Codex/OMX carriers are
 * comparison evidence only and can never satisfy this authority cardinality.
 */
export function reconcileNativeConversationReceipt(
  evidence: readonly LaunchAuthorityEvidenceV1[],
  expected: Readonly<NativeConversationExpectationV1>,
): Result<AntigravityNativeReceiptV1, RuntimeError> {
  const native: AntigravityNativeReceiptV1[] = [];
  try {
    for (const item of evidence) {
      if (item.kind === 'imported_carrier') {
        if (item.carrier.native_authority !== false || item.carrier.imported_only !== true) {
          return err(runtimeError('E_BINDING_CONFLICT', 'Imported carrier authority marker is invalid'));
        }
        continue;
      }
      validateAntigravityNativeReceipt(item.receipt);
      if (item.receipt.run_id === expected.runId
        && item.receipt.task_id === expected.taskId
        && (expected.parentConversationId === undefined
          || item.receipt.parent_conversation_id === expected.parentConversationId)
        && (expected.provider === undefined || item.receipt.provider === expected.provider)) {
        native.push(item.receipt);
      }
    }
  } catch (error) {
    return err(runtimeError('E_BINDING_CONFLICT', 'Native conversation receipt is invalid', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
  if (native.length === 0) {
    return err(runtimeError('E_CONVERSATION_UNBOUND', 'No exact native conversation receipt exists'));
  }
  const exactGeneration = native.filter((receipt) => receipt.generation === expected.generation);
  if (exactGeneration.length === 0) {
    return err(runtimeError(
      'E_INVOCATION_GENERATION_MISMATCH',
      'Native conversation receipt generation is stale or future',
    ));
  }
  const unique = new Map(exactGeneration.map((receipt) => [receipt.receipt_hash, receipt]));
  if (unique.size !== 1) {
    return err(runtimeError('E_BINDING_CONFLICT', 'Multiple native conversation receipts match'));
  }
  return ok(structuredClone([...unique.values()][0]));
}

export interface ManagedBindingEnv {
  OMA_SESSION_ID: string;
  OMA_LAUNCH_NONCE: string;
  OMA_INVOCATION_GENERATION: string;
}

export interface CreatePendingSessionInput {
  sessionId: string;
  repoKey: string | null;
  workspaceKey: string;
  workspacePath: string;
  launchNonce: string;
  owner: ProcessIdentity;
  ttlMs: number;
}

export interface PendingSessionV1 {
  schemaVersion: 1;
  revision: number;
  sessionId: string;
  repoKey: string | null;
  workspaceKey: string;
  workspacePath: string;
  launchNonce: string;
  launchNonceDigest: string;
  invocationGeneration: number;
  owner: ProcessIdentity;
  expiresAtMs: number;
  state: 'launch_pending' | 'resume_pending' | 'bound' | 'idle';
  conversationId: string | null;
  bindingRoute: 'exact_env' | 'first_preinvocation' | null;
}

export interface BoundSessionV1 extends PendingSessionV1 {
  state: 'bound';
  conversationId: string;
  bindingRoute: 'exact_env' | 'first_preinvocation';
}

export interface PreInvocationEventV1 {
  conversationId: string;
  workspaceKeys: readonly string[];
}

export interface StopLocatorEventV1 {
  conversationId: string;
  invocationGeneration: number;
  workspaceKeys: readonly string[];
}

export interface AllowDiagnostic {
  kind: 'AllowDiagnostic';
  decision: 'allow';
  error: RuntimeError;
}

export interface BoundExactEnv {
  kind: 'BoundExactEnv';
  bindingRoute: 'exact_env';
  session: BoundSessionV1;
}

export interface ExactBoundSession {
  kind: 'ExactBoundSession';
  session: BoundSessionV1;
}

export type PreInvocationBindingResult = BoundExactEnv | AllowDiagnostic;
export type StopLocatorResult = ExactBoundSession | AllowDiagnostic;

export interface SessionLocatorOptions {
  now?: () => number;
  nonceFactory?: () => string;
  resumeTtlMs?: number;
  resumeOwnerFactory?: () => ProcessIdentity;
  processLiveness?: (identity: Readonly<ProcessIdentity>) => ProcessLiveness;
  faultInjector?: FaultInjector;
  childSpawnWaitMs?: number;
  childSpawnPollMs?: number;
}

interface ConversationIndexV1 {
  store_kind: 'conversation_index';
  schema_version: 1;
  schemaVersion: 1;
  conversationId: string;
  sessionId: string;
  repoKey: string | null;
  workspaceKey: string;
  workspacePath: string;
  aggregateId: string;
  aggregateRevision: number;
  aggregateSha256: string;
  invocationGeneration: number;
}

interface LaunchAuditV1 {
  schemaVersion: 1;
  kind: 'launch_prepared' | 'resume_prepared';
  sessionId: string;
  repoKey: string | null;
  workspaceKey: string;
  workspacePath: string;
  invocationGeneration: number;
  launchNonceDigest: string;
  aggregateRevision: number;
  owner: ProcessIdentity;
  preparedAtMs: number;
}

export interface ChildSpawnAuditV1 {
  schemaVersion: 1;
  type: 'child_spawned';
  sessionId: string;
  workspaceKey: string;
  invocationGeneration: number;
  launchNonceDigest: string;
  child: ProcessIdentity;
  recordedAtMs: number;
}

export interface ManagedLaunchResultV1 {
  session: PendingSessionV1;
  transaction: ManagedLaunchTransaction;
}

interface ManagedLaunchTransactionOptions {
  stateRoot: string;
  session: PendingSessionV1;
  now: () => number;
  faultInjector: FaultInjector;
}

/**
 * 單一 workspace（或整個 state root）底下的 session aggregate 路徑庫存。
 * 設計概念映射：OMC `session-search` / OMX `session-search` / OMG `session allocate`
 * 的唯讀枚舉面；OMA 不另建第二份 inventory，只列出 SessionLocator 已在走的
 * `{stateRoot}/workspaces/<key>/sessions/<id>/aggregate.json`。
 */
export interface WorkspaceSessionInventoryEntryV1 {
  readonly workspacePathKey: string;
  readonly sessionPathKey: string;
  readonly aggregatePath: string;
}

/**
 * 唯讀枚舉 platform workspace sessions。不做 CAS、不寫檔。
 * `workspaceKey` 缺省時掃描整個 state root 的 workspaces/；未知 key 回空清單。
 */
export function listWorkspaceSessionInventory(
  stateRoot: string,
  workspaceKey?: string,
): Result<readonly WorkspaceSessionInventoryEntryV1[], RuntimeError> {
  const root = path.resolve(stateRoot);
  if (!fs.existsSync(root)) return ok([]);
  if (workspaceKey !== undefined) {
    let sessionsRoot: string;
    try {
      sessionsRoot = platformWorkspaceSessionsRoot(root, workspaceKey);
    } catch (error) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'Workspace sessions root is unsafe', {
        workspaceKey,
        cause: error instanceof Error ? error.message : String(error),
      }));
    }
    return listSessionEntries(sessionsRoot, externalStatePathKey(workspaceKey));
  }
  const workspaces = ensureContainedPath(root, 'workspaces');
  if (!workspaces.ok) return workspaces;
  const dirs = listChildDirectories(workspaces.value);
  if (!dirs.ok) return dirs;
  const entries: WorkspaceSessionInventoryEntryV1[] = [];
  for (const workspacePathKey of dirs.value) {
    const sessionsRelative = path.join('workspaces', workspacePathKey, 'sessions');
    const sessionsRoot = ensureContainedPath(root, sessionsRelative);
    if (!sessionsRoot.ok) continue;
    const listed = listSessionEntries(sessionsRoot.value, workspacePathKey);
    if (!listed.ok) return listed;
    entries.push(...listed.value);
  }
  return ok(entries);
}

function listSessionEntries(
  sessionsRoot: string,
  workspacePathKey: string,
): Result<readonly WorkspaceSessionInventoryEntryV1[], RuntimeError> {
  const dirs = listChildDirectories(sessionsRoot);
  if (!dirs.ok) return dirs;
  const entries: WorkspaceSessionInventoryEntryV1[] = [];
  for (const sessionPathKey of dirs.value) {
    const aggregatePath = path.join(sessionsRoot, sessionPathKey, 'aggregate.json');
    if (!fs.existsSync(aggregatePath)) continue;
    entries.push({ workspacePathKey, sessionPathKey, aggregatePath });
  }
  return ok(entries);
}

function listChildDirectories(parent: string): Result<readonly string[], RuntimeError> {
  if (!fs.existsSync(parent)) return ok([]);
  try {
    const stat = fs.lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return err(runtimeError('E_CORRUPT_STATE', 'Session inventory parent is not a real directory', {
        parent,
      }));
    }
    const names: string[] = [];
    for (const entry of fs.readdirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      if (entry.name.includes('/') || entry.name.includes('\\') || entry.name.includes('\0')) continue;
      names.push(entry.name);
    }
    names.sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
    return ok(names);
  } catch (error) {
    return err(runtimeError('E_CORRUPT_STATE', 'Session inventory could not be enumerated', {
      parent,
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

/**
 * Single-use launch capability. recordChildSpawned is deliberately synchronous:
 * ProcessRunner.onSpawn must not return until this durable audit exists. The
 * PreInvocation path performs a bounded wait, covering the child-runs-first race.
 */
export class ManagedLaunchTransaction {
  readonly env: ManagedBindingEnv;
  private readonly stateRoot: string;
  private readonly session: PendingSessionV1;
  private readonly now: () => number;
  private readonly faultInjector: FaultInjector;

  constructor(options: Readonly<ManagedLaunchTransactionOptions>) {
    this.stateRoot = path.resolve(options.stateRoot);
    this.session = structuredClone(options.session);
    this.now = options.now;
    this.faultInjector = options.faultInjector;
    this.env = {
      OMA_SESSION_ID: this.session.sessionId,
      OMA_LAUNCH_NONCE: this.session.launchNonce,
      OMA_INVOCATION_GENERATION: String(this.session.invocationGeneration),
    };
  }

  recordChildSpawned(
    identity: Readonly<ProcessIdentity>,
  ): Result<ChildSpawnAuditV1, RuntimeError> {
    const aggregate = new SessionAggregateStore(sessionAggregatePath(
      this.stateRoot,
      this.session.workspaceKey,
      this.session.sessionId,
    )).read();
    if (!aggregate.ok) return aggregate;
    const binding = aggregate.value.binding;
    if (
      binding.activeInvocationGeneration !== this.session.invocationGeneration
      || binding.launchNonceDigest !== this.session.launchNonceDigest
      || !['launch_pending', 'resume_pending'].includes(binding.state)
    ) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Launch capability is no longer current'));
    }
    if (binding.owner === null
      || identity.parentPid !== binding.owner.pid
      || (binding.owner.ownerNonce !== undefined && identity.ownerNonce !== binding.owner.ownerNonce)) {
      return err(runtimeError('E_PROCESS_IDENTITY_UNPROVEN', 'Spawned child is not owned by the pending wrapper', {
        childPid: identity.pid,
        parentPid: identity.parentPid,
        wrapperPid: binding.owner?.pid,
      }));
    }
    const audit: ChildSpawnAuditV1 = {
      schemaVersion: 1,
      type: 'child_spawned',
      sessionId: this.session.sessionId,
      workspaceKey: this.session.workspaceKey,
      invocationGeneration: this.session.invocationGeneration,
      launchNonceDigest: this.session.launchNonceDigest,
      child: { ...identity },
      recordedAtMs: this.now(),
    };
    const target = childSpawnAuditPath(
      this.stateRoot,
      this.session.workspaceKey,
      this.session.sessionId,
      this.session.invocationGeneration,
    );
    const existing = readJsonFile<ChildSpawnAuditV1>(target);
    if (existing.ok) {
      return canonicalJson(existing.value) === canonicalJson(audit)
        ? existing
        : err(runtimeError('E_BINDING_CONFLICT', 'A different child already owns this invocation'));
    }
    try {
      atomicWriteJson(target, audit, {
        transactionId: `child-${this.session.invocationGeneration}`,
        faultInjector: this.faultInjector,
      });
      return ok(audit);
    } catch (error) {
      return err(runtimeError('E_CORRUPT_STATE', 'Child-spawn audit could not be committed', {
        cause: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

export class SessionLocator {
  private readonly stateRoot: string;
  private readonly now: () => number;
  private readonly nonceFactory: () => string;
  private readonly resumeTtlMs: number;
  private readonly resumeOwnerFactory: () => ProcessIdentity;
  private readonly processLiveness: (identity: Readonly<ProcessIdentity>) => ProcessLiveness;
  private readonly faultInjector: FaultInjector;
  private readonly childSpawnWaitMs: number;
  private readonly childSpawnPollMs: number;
  readonly workspaceKey: string;

  constructor(
    stateRoot: string,
    workspaceKey: string,
    options: SessionLocatorOptions = {},
  ) {
    // 一律 realpath，避免 macOS /var vs /private/var 造成 state 讀寫分裂。
    const resolved = path.resolve(stateRoot);
    this.stateRoot = fs.existsSync(resolved) ? fs.realpathSync(resolved) : resolved;
    this.workspaceKey = workspaceKey;
    this.now = options.now ?? (() => Date.now());
    this.nonceFactory = options.nonceFactory ?? (() => crypto.randomBytes(16).toString('hex'));
    this.resumeTtlMs = options.resumeTtlMs ?? 30_000;
    this.resumeOwnerFactory = options.resumeOwnerFactory ?? (() => ({
      pid: process.pid,
      startMarker: readProcessIdentity(process.pid)?.startMarker ?? `${process.pid}`,
    }));
    this.processLiveness = options.processLiveness ?? defaultIdentityLiveness;
    this.faultInjector = options.faultInjector ?? NO_FAULTS;
    this.childSpawnWaitMs = options.childSpawnWaitMs ?? 1_000;
    this.childSpawnPollMs = options.childSpawnPollMs ?? 10;
  }

  async createManagedLaunch(
    input: Readonly<CreatePendingSessionInput>,
  ): Promise<Result<ManagedLaunchResultV1, RuntimeError>> {
    const pending = await this.createPending(input);
    return pending.ok
      ? ok({ session: pending.value, transaction: this.managedLaunch(pending.value) })
      : pending;
  }

  managedLaunch(session: Readonly<PendingSessionV1>): ManagedLaunchTransaction {
    return new ManagedLaunchTransaction({
      stateRoot: this.stateRoot,
      session: structuredClone(session),
      now: this.now,
      faultInjector: this.faultInjector,
    });
  }

  async createPending(
    input: Readonly<CreatePendingSessionInput>,
  ): Promise<Result<PendingSessionV1, RuntimeError>> {
    if (
      input.workspaceKey !== this.workspaceKey
      || input.sessionId.trim() === ''
      || input.launchNonce === ''
      || input.ttlMs <= 0
    ) {
      return err(runtimeError('E_WORKSPACE_MISMATCH', 'Pending session does not match this locator'));
    }
    const workspaceLock = await acquireOwnerLock(this.workspaceLaunchLockPath());
    if (!workspaceLock.ok) return workspaceLock;
    try {
      const livePending = this.findLivePending();
      if (!livePending.ok) return livePending;
      if (livePending.value !== null) {
        return err(runtimeError('E_PENDING_LAUNCH_EXISTS', 'Workspace already has a live pending launch', {
          sessionId: livePending.value.sessionId,
          invocationGeneration: livePending.value.binding.activeInvocationGeneration,
        }));
      }
      const expiresAtMs = this.now() + input.ttlMs;
      const aggregate = createInitialSessionAggregate({
        sessionId: input.sessionId,
        repoKey: input.repoKey,
        workspaceKey: input.workspaceKey,
        workspacePath: input.workspacePath,
        launchNonceDigest: sha256(input.launchNonce),
        owner: input.owner,
        expiresAtMs,
      });
      const store = this.aggregateStore(input.sessionId);
      const initialized = await store.initialize(aggregate);
      if (!initialized.ok) return initialized;
      const pending = aggregateToPending(initialized.value, input.launchNonce);
      this.writeLaunchAudit(pending, 'launch_prepared');
      return ok(pending);
    } finally {
      releaseOwnerLock(workspaceLock.value);
    }
  }

  /**
   * 為既有 Autopilot session 首次 drive 裝填 launch_pending + 明文 nonce。
   * 若 conversation 已綁定則應改走 prepareResume。
   */
  async armExistingSessionForDrive(input: {
    sessionId: string;
    conversationId: string;
    expectedRevision: number;
    workspacePath: string;
    ttlMs?: number;
  }): Promise<Result<PendingSessionV1, RuntimeError>> {
    const index = this.readConversationIndex(input.conversationId);
    if (index.ok) {
      return err(runtimeError(
        'E_BINDING_CONFLICT',
        'Conversation already indexed; use prepareResume instead of armExistingSessionForDrive',
      ));
    }
    const launchNonce = this.nonceFactory();
    const owner = this.resumeOwnerFactory();
    const store = this.aggregateStore(input.sessionId);
    const updated = await store.compareAndSwap(input.expectedRevision, (snapshot) => {
      if (snapshot.autopilot.terminal !== null
        || ['cancelled', 'failed', 'tripped'].includes(snapshot.autopilot.phase)) {
        throw new Error('Terminal Autopilot sessions cannot be driven');
      }
      if (snapshot.binding.state === 'bound' && snapshot.binding.conversationId === input.conversationId) {
        throw new Error('Session already bound; use prepareResume');
      }
      return {
        ...snapshot,
        revision: input.expectedRevision + 1,
        binding: {
          ...snapshot.binding,
          conversationId: input.conversationId,
          launchNonceDigest: sha256(launchNonce),
          state: 'launch_pending' as const,
          bindingRoute: null,
          owner,
          expiresAtMs: this.now() + (input.ttlMs ?? this.resumeTtlMs),
          workspacePath: input.workspacePath || snapshot.binding.workspacePath,
          activeInvocationGeneration: Math.max(1, snapshot.binding.activeInvocationGeneration || 1),
        },
      };
    });
    if (!updated.ok) {
      const current = store.read();
      if (current.ok && ['cancelled', 'failed', 'tripped'].includes(current.value.autopilot.phase)) {
        return err(runtimeError('E_TERMINAL_STATE', 'Terminal sessions cannot be driven'));
      }
      return updated;
    }
    const pending = aggregateToPending(updated.value, launchNonce);
    this.writeLaunchAudit(pending, 'launch_prepared');
    return ok(pending);
  }

  async prepareResume(
    conversationId: string,
    expectedRevision: number,
  ): Promise<Result<PendingSessionV1, RuntimeError>> {
    const index = this.readConversationIndex(conversationId);
    if (!index.ok) {
      return err(runtimeError('E_CONVERSATION_UNBOUND', 'Conversation has no exact managed binding', {
        conversationId,
      }));
    }
    const launchNonce = this.nonceFactory();
    const owner = this.resumeOwnerFactory();
    const store = this.aggregateStore(index.value.sessionId);
    const updated = await store.compareAndSwap(expectedRevision, (snapshot) => {
      if (
        snapshot.binding.conversationId !== conversationId
        || snapshot.binding.state !== 'bound'
        || snapshot.autopilot.terminal !== null
        || ['cancelled', 'failed', 'tripped'].includes(snapshot.autopilot.phase)
      ) {
        throw new Error('Conversation is not precisely resumable');
      }
      return {
        ...snapshot,
        revision: snapshot.revision + 1,
        binding: {
          ...snapshot.binding,
          activeInvocationGeneration: snapshot.binding.activeInvocationGeneration + 1,
          launchNonceDigest: sha256(launchNonce),
          state: 'resume_pending',
          bindingRoute: null,
          owner,
          expiresAtMs: this.now() + this.resumeTtlMs,
        },
      };
    });
    if (!updated.ok) {
      const current = store.read();
      if (current.ok && ['cancelled', 'failed', 'tripped'].includes(current.value.autopilot.phase)) {
        return err(runtimeError('E_TERMINAL_STATE', 'Terminal sessions cannot be resumed'));
      }
      return updated;
    }
    const pending = aggregateToPending(updated.value, launchNonce);
    this.writeLaunchAudit(pending, 'resume_prepared');
    return ok(pending);
  }

  async bindPreInvocation(
    event: Readonly<PreInvocationEventV1>,
    env: Readonly<ManagedBindingEnv> | undefined,
  ): Promise<PreInvocationBindingResult> {
    if (!isCompleteBindingEnv(env)) {
      return allow(runtimeError('E_BINDING_ENV_MISSING', 'Managed binding environment is missing or partial'));
    }
    const generation = Number(env.OMA_INVOCATION_GENERATION);
    if (!Number.isSafeInteger(generation) || generation < 1) {
      return allow(runtimeError('E_INVOCATION_GENERATION_MISMATCH', 'Invocation generation is invalid'));
    }
    const selected = exactWorkspace(event.workspaceKeys, this.workspaceKey);
    if (!selected.ok) return allow(selected.error);
    const store = this.aggregateStore(env.OMA_SESSION_ID);
    const pendingSnapshot = store.read();
    if (!pendingSnapshot.ok) return allow(pendingSnapshot.error);
    const pending = pendingSnapshot.value;
    if (
      pending.workspaceKey !== this.workspaceKey
      || pending.binding.launchNonceDigest !== sha256(env.OMA_LAUNCH_NONCE)
      || pending.binding.activeInvocationGeneration !== generation
    ) {
      return allow(runtimeError('E_BINDING_CONFLICT', 'Managed binding identity does not match live state'));
    }
    if (pending.binding.state === 'bound') {
      if (pending.binding.conversationId !== event.conversationId
        || pending.binding.bindingRoute !== 'exact_env') {
        return allow(runtimeError('E_BINDING_CONFLICT', 'Session is already bound to another conversation'));
      }
      const indexed = this.ensureConversationIndex(event.conversationId, pending);
      if (!indexed.ok) return allow(indexed.error);
      return {
        kind: 'BoundExactEnv',
        bindingRoute: 'exact_env',
        session: asBoundSession(pending, env.OMA_LAUNCH_NONCE),
      };
    }
    const owner = pending.binding.owner;
    if (
      !['launch_pending', 'resume_pending'].includes(pending.binding.state)
      || pending.binding.expiresAtMs === null
      || pending.binding.expiresAtMs < this.now()
      || owner === null
      || this.processLiveness(owner) !== 'alive'
    ) {
      return allow(runtimeError('E_BINDING_PENDING_EXPIRED', 'Pending launch expired or its owner is not live'));
    }

    const childAudit = await this.waitForChildSpawn(
      env.OMA_SESSION_ID,
      generation,
      pending.binding.launchNonceDigest,
    );
    if (!childAudit.ok) return allow(childAudit.error);
    const preexistingIndex = this.readConversationIndex(event.conversationId);
    if (preexistingIndex.ok && preexistingIndex.value.sessionId !== pending.sessionId) {
      return allow(runtimeError('E_BINDING_CONFLICT', 'Conversation index belongs to another session'));
    }

    const updated = await store.compareAndSwap(pending.revision, (snapshot) => ({
      ...snapshot,
      revision: snapshot.revision + 1,
      binding: {
        ...snapshot.binding,
        state: 'bound',
        conversationId: event.conversationId,
        bindingRoute: 'exact_env',
        expiresAtMs: null,
      },
    }));
    if (!updated.ok) {
      const replay = store.read();
      if (
        replay.ok
        && replay.value.binding.state === 'bound'
        && replay.value.binding.conversationId === event.conversationId
        && replay.value.binding.activeInvocationGeneration === generation
      ) {
        const indexed = this.ensureConversationIndex(event.conversationId, replay.value);
        return indexed.ok
          ? {
            kind: 'BoundExactEnv', bindingRoute: 'exact_env',
            session: asBoundSession(replay.value, env.OMA_LAUNCH_NONCE),
          }
          : allow(indexed.error);
      }
      return allow(updated.error);
    }
    const indexed = this.ensureConversationIndex(event.conversationId, updated.value);
    if (!indexed.ok) return allow(indexed.error);
    return {
      kind: 'BoundExactEnv',
      bindingRoute: 'exact_env',
      session: asBoundSession(updated.value, env.OMA_LAUNCH_NONCE),
    };
  }

  readBoundAggregate(sessionId: string): Result<SessionAggregateV1, RuntimeError> {
    return this.aggregateStore(sessionId).read();
  }

  refreshConversationProjection(
    conversationId: string,
    aggregate: Readonly<SessionAggregateV1>,
  ): Result<void, RuntimeError> {
    const refreshed = this.ensureConversationIndex(conversationId, aggregate);
    return refreshed.ok ? ok(undefined) : refreshed;
  }

  resolveStop(event: Readonly<StopLocatorEventV1>): StopLocatorResult {
    const selected = exactWorkspace(event.workspaceKeys, this.workspaceKey);
    if (!selected.ok) return allow(selected.error);
    const index = this.readConversationIndex(event.conversationId);
    if (!index.ok) {
      return allow(runtimeError('E_CONVERSATION_UNBOUND', 'Stop conversation is not managed here'));
    }
    const session = this.aggregateStore(index.value.sessionId).read();
    if (!session.ok) return allow(session.error);
    const value = session.value;
    if (
      value.binding.state !== 'bound'
      || !['exact_env', 'first_preinvocation'].includes(value.binding.bindingRoute ?? '')
      || value.binding.conversationId !== event.conversationId
      || value.workspaceKey !== this.workspaceKey
    ) {
      return allow(runtimeError('E_BINDING_CONFLICT', 'Stop event is not bound to this exact session'));
    }
    if (value.binding.activeInvocationGeneration !== event.invocationGeneration) {
      return allow(runtimeError(
        'E_INVOCATION_GENERATION_MISMATCH',
        'Stop event generation does not match the active invocation',
      ));
    }
    return { kind: 'ExactBoundSession', session: asBoundSession(value, '') };
  }

  private aggregateStore(sessionId: string): SessionAggregateStore {
    return new SessionAggregateStore(
      sessionAggregatePath(this.stateRoot, this.workspaceKey, sessionId),
      { faultInjector: this.faultInjector },
    );
  }

  private findLivePending(): Result<SessionAggregateV1 | null, RuntimeError> {
    const inventory = listWorkspaceSessionInventory(this.stateRoot, this.workspaceKey);
    if (!inventory.ok) return inventory;
    for (const entry of inventory.value) {
      const aggregate = new SessionAggregateStore(entry.aggregatePath).read();
      if (!aggregate.ok) {
        if (aggregate.error.code === 'E_NOT_FOUND') continue;
        return aggregate;
      }
      const binding = aggregate.value.binding;
      if (
        ['launch_pending', 'resume_pending'].includes(binding.state)
        && binding.expiresAtMs !== null
        && binding.expiresAtMs >= this.now()
        && binding.owner !== null
        && this.processLiveness(binding.owner) === 'alive'
      ) return ok(aggregate.value);
    }
    return ok(null);
  }

  private async waitForChildSpawn(
    sessionId: string,
    generation: number,
    launchNonceDigest: string,
  ): Promise<Result<ChildSpawnAuditV1, RuntimeError>> {
    const target = childSpawnAuditPath(
      this.stateRoot, this.workspaceKey, sessionId, generation,
    );
    const deadline = Date.now() + this.childSpawnWaitMs;
    do {
      const record = readJsonFile<ChildSpawnAuditV1>(target);
      if (record.ok) {
        const audit = record.value;
        if (
          audit.schemaVersion === 1
          && audit.type === 'child_spawned'
          && audit.sessionId === sessionId
          && audit.workspaceKey === this.workspaceKey
          && audit.invocationGeneration === generation
          && audit.launchNonceDigest === launchNonceDigest
        ) return ok(audit);
        return err(runtimeError('E_BINDING_CONFLICT', 'Child-spawn audit identity is invalid'));
      }
      if (Date.now() >= deadline) break;
      await sleep(this.childSpawnPollMs);
    } while (true);
    return err(runtimeError('E_RETRYABLE_BLOCKER', 'Durable child-spawn handshake was not observed in time', {
      sessionId, generation,
    }));
  }

  private ensureConversationIndex(
    conversationId: string,
    aggregate: Readonly<SessionAggregateV1>,
  ): Result<ConversationIndexV1, RuntimeError> {
    const index: ConversationIndexV1 = {
      store_kind: 'conversation_index',
      schema_version: 1,
      schemaVersion: 1,
      conversationId,
      sessionId: aggregate.sessionId,
      repoKey: aggregate.repoKey,
      workspaceKey: aggregate.workspaceKey,
      workspacePath: aggregate.binding.workspacePath,
      aggregateId: aggregate.aggregate_id,
      aggregateRevision: aggregate.revision,
      aggregateSha256: sessionAggregateHash(aggregate),
      invocationGeneration: aggregate.binding.activeInvocationGeneration,
    };
    const target = this.conversationPath(conversationId);
    const existing = readJsonFile<ConversationIndexV1>(target);
    if (existing.ok) {
      const identityMatches = existing.value.conversationId === index.conversationId
        && existing.value.sessionId === index.sessionId
        && existing.value.workspaceKey === index.workspaceKey
        && existing.value.aggregateId === index.aggregateId;
      if (!identityMatches) {
        return err(runtimeError('E_BINDING_CONFLICT', 'Conversation index conflicts with the bound aggregate'));
      }
      // Revision/hash are a projection and are refreshed only from authority.
      if (canonicalJson(existing.value) !== canonicalJson(index)) {
        atomicWriteJson(target, index, { transactionId: `refresh-${aggregate.revision}` });
      }
      return ok(index);
    }
    try {
      atomicWriteJson(target, index, { transactionId: sha256(conversationId) });
      return ok(index);
    } catch (error) {
      return err(runtimeError('E_CORRUPT_STATE', 'Conversation index could not be written', {
        cause: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  private readConversationIndex(
    conversationId: string,
  ): Result<ConversationIndexV1, RuntimeError> {
    const result = readJsonFile<ConversationIndexV1>(this.conversationPath(conversationId));
    if (!result.ok) return result;
    const value = result.value;
    if (
      value.store_kind !== 'conversation_index'
      || value.schema_version !== 1
      || value.schemaVersion !== 1
      || value.conversationId !== conversationId
      || typeof value.sessionId !== 'string'
      || value.workspaceKey !== this.workspaceKey
      || !/^[0-9a-f]{64}$/.test(value.aggregateId)
      || !/^[0-9a-f]{64}$/.test(value.aggregateSha256)
      || !Number.isSafeInteger(value.aggregateRevision)
      || !Number.isSafeInteger(value.invocationGeneration)
    ) {
      return err(runtimeError('E_WORKSPACE_MISMATCH', 'Conversation index is not authoritative here'));
    }
    return ok(value);
  }

  private resolveConversationAggregate(
    conversationId: string,
  ): Result<SessionAggregateV1, RuntimeError> {
    const index = this.readConversationIndex(conversationId);
    if (!index.ok) return index;
    const aggregate = this.aggregateStore(index.value.sessionId).read();
    if (!aggregate.ok) return aggregate;
    if (aggregate.value.aggregate_id !== index.value.aggregateId
      || aggregate.value.binding.conversationId !== conversationId
      || aggregate.value.workspaceKey !== this.workspaceKey) {
      return err(runtimeError('E_BINDING_CONFLICT', 'Conversation index does not resolve its aggregate'));
    }
    return aggregate;
  }

  private writeLaunchAudit(
    pending: Readonly<PendingSessionV1>,
    kind: LaunchAuditV1['kind'],
  ): void {
    const audit: LaunchAuditV1 = {
      schemaVersion: 1,
      kind,
      sessionId: pending.sessionId,
      repoKey: pending.repoKey,
      workspaceKey: pending.workspaceKey,
      workspacePath: pending.workspacePath,
      invocationGeneration: pending.invocationGeneration,
      launchNonceDigest: pending.launchNonceDigest,
      aggregateRevision: pending.revision,
      owner: { ...pending.owner },
      preparedAtMs: this.now(),
    };
    const target = path.join(
      this.stateRoot,
      'workspaces', externalStatePathKey(this.workspaceKey),
      'launches', externalStatePathKey(pending.sessionId),
      `${pending.invocationGeneration}.json`,
    );
    if (!fs.existsSync(target)) atomicWriteJson(target, audit, {
      transactionId: `launch-${pending.invocationGeneration}`,
    });
  }

  private workspaceLaunchLockPath(): string {
    return path.join(
      this.stateRoot, 'workspaces', externalStatePathKey(this.workspaceKey), 'launch.lock',
    );
  }

  private conversationPath(conversationId: string): string {
    return path.join(
      this.stateRoot, 'workspaces', externalStatePathKey(this.workspaceKey),
      'conversations', `${externalStatePathKey(conversationId)}.json`,
    );
  }
}

export function childSpawnAuditPath(
  stateRoot: string,
  workspaceKey: string,
  sessionId: string,
  invocationGeneration: number,
): string {
  return path.join(
    path.resolve(stateRoot), 'workspaces', externalStatePathKey(workspaceKey),
    'invocations', externalStatePathKey(sessionId), String(invocationGeneration), 'child-spawned.json',
  );
}

function aggregateToPending(
  aggregate: Readonly<SessionAggregateV1>,
  launchNonce: string,
): PendingSessionV1 {
  const owner = aggregate.binding.owner;
  if (owner === null || aggregate.binding.expiresAtMs === null) {
    throw new Error('Pending aggregate is missing launch ownership');
  }
  return {
    schemaVersion: 1,
    revision: aggregate.revision,
    sessionId: aggregate.sessionId,
    repoKey: aggregate.repoKey,
    workspaceKey: aggregate.workspaceKey,
    workspacePath: aggregate.binding.workspacePath,
    launchNonce,
    launchNonceDigest: aggregate.binding.launchNonceDigest,
    invocationGeneration: aggregate.binding.activeInvocationGeneration,
    owner: { ...owner },
    expiresAtMs: aggregate.binding.expiresAtMs,
    state: aggregate.binding.state,
    conversationId: aggregate.binding.conversationId,
    bindingRoute: aggregate.binding.bindingRoute,
  };
}

function asBoundSession(
  aggregate: Readonly<SessionAggregateV1>,
  launchNonce: string,
): BoundSessionV1 {
  const owner = aggregate.binding.owner ?? { pid: 0, startMarker: 'unknown' };
  return {
    schemaVersion: 1,
    revision: aggregate.revision,
    sessionId: aggregate.sessionId,
    repoKey: aggregate.repoKey,
    workspaceKey: aggregate.workspaceKey,
    workspacePath: aggregate.binding.workspacePath,
    launchNonce,
    launchNonceDigest: aggregate.binding.launchNonceDigest,
    invocationGeneration: aggregate.binding.activeInvocationGeneration,
    owner: { ...owner },
    expiresAtMs: aggregate.binding.expiresAtMs ?? Number.MAX_SAFE_INTEGER,
    state: 'bound',
    conversationId: aggregate.binding.conversationId as string,
    bindingRoute: aggregate.binding.bindingRoute === 'first_preinvocation'
      ? 'first_preinvocation' : 'exact_env',
  };
}

function isCompleteBindingEnv(
  env: Readonly<ManagedBindingEnv> | undefined,
): env is Readonly<ManagedBindingEnv> {
  return env !== undefined
    && typeof env.OMA_SESSION_ID === 'string'
    && env.OMA_SESSION_ID !== ''
    && typeof env.OMA_LAUNCH_NONCE === 'string'
    && env.OMA_LAUNCH_NONCE !== ''
    && typeof env.OMA_INVOCATION_GENERATION === 'string'
    && env.OMA_INVOCATION_GENERATION !== '';
}

function exactWorkspace(
  workspaceKeys: readonly string[],
  expected: string,
): Result<string, RuntimeError> {
  const matches = workspaceKeys.filter((key) => key === expected);
  if (matches.length !== 1) {
    return err(runtimeError('E_WORKSPACE_AMBIGUOUS', 'Event must resolve exactly one matching workspace', {
      expected, matches: matches.length,
    }));
  }
  return ok(matches[0]);
}

function allow(error: RuntimeError): AllowDiagnostic {
  return { kind: 'AllowDiagnostic', decision: 'allow', error };
}

function readJsonFile<T>(target: string): Result<T, RuntimeError> {
  if (!fs.existsSync(target)) {
    return err(runtimeError('E_NOT_FOUND', 'State record does not exist', { target }));
  }
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) {
      return err(runtimeError('E_CORRUPT_STATE', 'State record is not a bounded regular file', { target }));
    }
    return ok(JSON.parse(fs.readFileSync(target, 'utf8')) as T);
  } catch (error) {
    return err(runtimeError('E_CORRUPT_STATE', 'State record JSON is corrupt', {
      target, cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

function defaultIdentityLiveness(identity: Readonly<ProcessIdentity>): ProcessLiveness {
  try {
    process.kill(identity.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'dead' : 'unknown';
  }
  const current = readProcessIdentity(identity.pid, identity.ownerNonce);
  return current !== null && current.startMarker === identity.startMarker ? 'alive' : 'dead';
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
