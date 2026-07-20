import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJson, canonicalJson, FaultInjector, NO_FAULTS, sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { acquireOwnerLock, ProcessLiveness, releaseOwnerLock } from '../runtime/lock';
import { readProcessIdentity } from '../runtime/process';
import { ProcessIdentity, Result, err, ok } from '../runtime/types';
import {
  SessionAggregateStore,
  SessionAggregateV1,
  createInitialSessionAggregate,
  sessionAggregatePath,
} from './session-aggregate';

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
  bindingRoute: 'exact_env' | null;
}

export interface BoundSessionV1 extends PendingSessionV1 {
  state: 'bound';
  conversationId: string;
  bindingRoute: 'exact_env';
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
  schemaVersion: 1;
  conversationId: string;
  sessionId: string;
  repoKey: string | null;
  workspaceKey: string;
  workspacePath: string;
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
      || value.binding.bindingRoute !== 'exact_env'
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
    const sessionsRoot = path.join(this.stateRoot, 'workspaces', this.workspaceKey, 'sessions');
    if (!fs.existsSync(sessionsRoot)) return ok(null);
    try {
      for (const entry of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const aggregatePath = path.join(sessionsRoot, entry.name, 'aggregate.json');
        if (!fs.existsSync(aggregatePath)) continue;
        const aggregate = new SessionAggregateStore(aggregatePath).read();
        if (!aggregate.ok) return aggregate;
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
    } catch (error) {
      return err(runtimeError('E_CORRUPT_STATE', 'Workspace pending sessions could not be enumerated', {
        cause: error instanceof Error ? error.message : String(error),
      }));
    }
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
      schemaVersion: 1,
      conversationId,
      sessionId: aggregate.sessionId,
      repoKey: aggregate.repoKey,
      workspaceKey: aggregate.workspaceKey,
      workspacePath: aggregate.binding.workspacePath,
    };
    const target = this.conversationPath(conversationId);
    const existing = readJsonFile<ConversationIndexV1>(target);
    if (existing.ok) {
      return canonicalJson(existing.value) === canonicalJson(index)
        ? existing
        : err(runtimeError('E_BINDING_CONFLICT', 'Conversation index conflicts with the bound aggregate'));
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
      value.schemaVersion !== 1
      || value.conversationId !== conversationId
      || typeof value.sessionId !== 'string'
      || value.workspaceKey !== this.workspaceKey
    ) {
      return err(runtimeError('E_WORKSPACE_MISMATCH', 'Conversation index is not authoritative here'));
    }
    return ok(value);
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
      'workspaces', this.workspaceKey, 'launches', sha256(pending.sessionId),
      `${pending.invocationGeneration}.json`,
    );
    if (!fs.existsSync(target)) atomicWriteJson(target, audit, {
      transactionId: `launch-${pending.invocationGeneration}`,
    });
  }

  private workspaceLaunchLockPath(): string {
    return path.join(this.stateRoot, 'workspaces', this.workspaceKey, 'launch.lock');
  }

  private conversationPath(conversationId: string): string {
    return path.join(
      this.stateRoot, 'workspaces', this.workspaceKey,
      'conversations', `${sha256(conversationId)}.json`,
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
    path.resolve(stateRoot), 'workspaces', workspaceKey,
    'invocations', sha256(sessionId), String(invocationGeneration), 'child-spawned.json',
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
    bindingRoute: 'exact_env',
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
