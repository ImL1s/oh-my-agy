import * as crypto from 'crypto';
import {
  ManagedLaunchTransaction as RuntimeManagedLaunchTransaction,
  SessionLocator,
} from '../continuation/state';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { currentProcessIdentity } from '../runtime/process';
import {
  StateRootOptions,
  WorkspaceIdentityV1,
  resolveStateRoot,
  resolveWorkspaceIdentity,
} from '../runtime/state-root';
import { ProcessIdentity, Result, err, ok } from '../runtime/types';
import {
  ManagedLaunchTransaction,
  PrepareManagedLaunchInput,
  PrepareManagedResumeInput,
  PreparedManagedInvocation,
} from './managed-invocation';

export interface RuntimeManagedTransactionOptions {
  readonly cwd?: string;
  readonly stateRoot?: StateRootOptions;
  readonly launchTtlMs?: number;
  readonly sessionIdFactory?: () => string;
  readonly launchNonceFactory?: () => string;
  readonly ownerNonceFactory?: () => string;
  readonly operationIdFactory?: () => string;
}

interface ActiveCapability {
  readonly prepared: PreparedManagedInvocation;
  readonly capability: RuntimeManagedLaunchTransaction;
}

export class RuntimeManagedTransactionAdapter implements ManagedLaunchTransaction {
  readonly stateRoot: string;
  readonly workspace: WorkspaceIdentityV1;
  private readonly locator: SessionLocator;
  private readonly launchTtlMs: number;
  private readonly sessionIdFactory: () => string;
  private readonly launchNonceFactory: () => string;
  private readonly ownerNonceFactory: () => string;
  private readonly operationIdFactory: () => string;
  private readonly active = new Map<string, ActiveCapability>();

  static create(
    options: Readonly<RuntimeManagedTransactionOptions> = {},
  ): Result<RuntimeManagedTransactionAdapter, RuntimeError> {
    const stateRoot = resolveStateRoot(options.stateRoot);
    if (!stateRoot.ok) return stateRoot;
    const workspace = resolveWorkspaceIdentity(options.cwd ?? process.cwd());
    if (!workspace.ok) return workspace;
    return ok(new RuntimeManagedTransactionAdapter(stateRoot.value.path, workspace.value, options));
  }

  private constructor(
    stateRoot: string,
    workspace: WorkspaceIdentityV1,
    options: Readonly<RuntimeManagedTransactionOptions>,
  ) {
    this.stateRoot = stateRoot;
    this.workspace = workspace;
    this.launchTtlMs = options.launchTtlMs ?? 30_000;
    this.sessionIdFactory = options.sessionIdFactory ?? (() => crypto.randomUUID());
    this.launchNonceFactory = options.launchNonceFactory
      ?? (() => crypto.randomBytes(32).toString('hex'));
    this.ownerNonceFactory = options.ownerNonceFactory
      ?? (() => crypto.randomBytes(16).toString('hex'));
    this.operationIdFactory = options.operationIdFactory ?? (() => crypto.randomUUID());
    this.locator = new SessionLocator(this.stateRoot, this.workspace.workspaceKey, {
      nonceFactory: this.launchNonceFactory,
      resumeOwnerFactory: () => currentProcessIdentity(this.ownerNonceFactory()),
    });
  }

  async prepareLaunch(
    _input: Readonly<PrepareManagedLaunchInput>,
  ): Promise<Result<PreparedManagedInvocation, RuntimeError>> {
    const ownerNonce = this.ownerNonceFactory();
    const created = await this.locator.createManagedLaunch({
      sessionId: this.sessionIdFactory(),
      repoKey: this.workspace.repoKey,
      workspaceKey: this.workspace.workspaceKey,
      workspacePath: this.workspace.workspacePath,
      launchNonce: this.launchNonceFactory(),
      owner: currentProcessIdentity(ownerNonce),
      ttlMs: this.launchTtlMs,
    });
    if (!created.ok) return created;
    return this.activate(created.value.session, created.value.transaction);
  }

  async prepareResume(
    input: Readonly<PrepareManagedResumeInput>,
  ): Promise<Result<PreparedManagedInvocation, RuntimeError>> {
    const resumed = await this.locator.prepareResume(input.conversationId, input.expectedRevision);
    if (!resumed.ok) return resumed;
    if (resumed.value.sessionId !== input.sessionId) {
      return err(runtimeError('E_WORKSPACE_MISMATCH', 'Conversation is not bound to the requested session', {
        requestedSessionId: input.sessionId,
      }));
    }
    return this.activate(resumed.value, this.locator.managedLaunch(resumed.value));
  }

  recordChildSpawned(
    prepared: Readonly<PreparedManagedInvocation>,
    identity: Readonly<ProcessIdentity>,
  ): Result<void, RuntimeError> {
    const active = this.active.get(prepared.operationIdentity.operationId);
    if (active === undefined || !samePreparedIdentity(active.prepared, prepared)) {
      return err(runtimeError('E_STALE_ACTIVE_POINTER', 'Managed launch capability is absent or stale'));
    }
    const recorded = active.capability.recordChildSpawned(identity);
    return recorded.ok ? ok(undefined) : recorded;
  }

  async recordOutcome(
    prepared: Readonly<PreparedManagedInvocation>,
  ): Promise<Result<void, RuntimeError>> {
    const active = this.active.get(prepared.operationIdentity.operationId);
    if (active === undefined || !samePreparedIdentity(active.prepared, prepared)) {
      return err(runtimeError('E_STALE_ACTIVE_POINTER', 'Managed launch outcome has no live capability'));
    }
    this.active.delete(prepared.operationIdentity.operationId);
    return ok(undefined);
  }

  private activate(
    session: Readonly<{
      state: 'launch_pending' | 'resume_pending' | 'bound' | 'idle';
      sessionId: string;
      conversationId: string | null;
      launchNonce: string;
      invocationGeneration: number;
      owner: ProcessIdentity;
    }>,
    capability: RuntimeManagedLaunchTransaction,
  ): Result<PreparedManagedInvocation, RuntimeError> {
    if (!['launch_pending', 'resume_pending'].includes(session.state)) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Managed launch is not pending'));
    }
    const ownerNonce = session.owner.ownerNonce;
    if (ownerNonce === undefined || ownerNonce === '') {
      return err(runtimeError('E_PROCESS_IDENTITY_UNPROVEN', 'Wrapper owner nonce is missing'));
    }
    const operationId = this.operationIdFactory();
    const prepared: PreparedManagedInvocation = {
      kind: session.state === 'launch_pending' ? 'launch' : 'resume',
      launchTransactionId: operationId,
      sessionId: session.sessionId,
      conversationId: session.conversationId,
      launchNonce: session.launchNonce,
      invocationGeneration: session.invocationGeneration,
      cwd: this.workspace.workspacePath,
      operationIdentity: { operationId, ownerNonce },
    };
    this.active.set(operationId, { prepared, capability });
    return ok(prepared);
  }
}

function samePreparedIdentity(
  left: Readonly<PreparedManagedInvocation>,
  right: Readonly<PreparedManagedInvocation>,
): boolean {
  return left.launchTransactionId === right.launchTransactionId
    && left.sessionId === right.sessionId
    && left.conversationId === right.conversationId
    && left.launchNonce === right.launchNonce
    && left.invocationGeneration === right.invocationGeneration
    && left.cwd === right.cwd
    && left.operationIdentity.operationId === right.operationIdentity.operationId
    && left.operationIdentity.ownerNonce === right.operationIdentity.ownerNonce;
}
