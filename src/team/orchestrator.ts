/**
 * 設計概念映射：TeamOrchestrator 對齊 OMC/OMX Team 編排（start → claim → worktree → tmux → heartbeat → supervise/reclaim → deliver → tick）。
 */
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { sha256 } from '../runtime/atomic';
import { HostCapabilityProfileV1 } from '../native/capability-profile';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import { createDeliveryEvidence, DeliveryValidator } from './delivery';
import { IntegrationManager } from './integration';
import { probeProcessPid, probeTmuxSession } from './liveness';
import { validateTeamManifest } from './manifest';
import { FastForwardPublisherV1 } from './publisher';
import { requireDeadProof } from './reclaim';
import { TeamStateStore } from './state';
import { assessWorker, SupervisorAssessment } from './supervisor';
import { TmuxController } from './tmux';
import {
  CanonicalTeamManifestV1,
  CanonicalTeamTaskV1,
  SupervisorHeartbeatV1,
  TeamAggregateV1,
  TeamTaskRuntimeV1,
} from './types';
import { AuthorityLeaseStore, pathKeysFromWriteScope } from './authority-lease';
import { GitWorktreeManager, ManagedWorktreeV1, resolveGitWorktreeIdentity } from './worktree';
import {
  TmuxReadinessReceiptV1,
  preflightTeamWorkerProviderRoute,
  routeTeamWorkerProvider,
} from './provider';
import {
  createWorkerRouteAuthority,
  workerRouteAuthorityPath,
  writeWorkerRouteAuthority,
} from './route-authority';

export interface ProviderProfileAuthorityV1 {
  profile: HostCapabilityProfileV1;
  resolvedExecutable: string;
  tmuxReadiness?: TmuxReadinessReceiptV1;
}

export interface TeamOrchestratorOptions {
  stateRoot: string;
  workspaceRoot: string;
  repoKey: string | null;
  workspaceKey: string;
  managedWorktreesRoot: string;
  /** Prefixed unique base for tmux session names; default `oma-${teamId}` */
  sessionNamePrefix?: string;
  tokenFactory?: () => string;
  nowMs?: () => number;
  leaseMs?: number;
  maxParallelWorkers?: number;
  tmux?: TmuxController;
  worktrees?: GitWorktreeManager;
  /** Default: process.execPath */
  workerExecutablePath?: string;
  /**
   * Bootstrap argv inserted between executable and marker/descriptor.
   * Default: compiled worker-bootstrap.js next to this module.
   * Tests inject e.g. [holdJsPath].
   */
  workerBootstrapArgv?: readonly string[];
  /** Absolute path to worker-hold/bootstrap entry (js). Used if workerBootstrapArgv omitted. */
  workerHoldEntryPath?: string;
  /** Evidence-bearing profile factory. The central Team router owns provider selection. */
  providerProfileFactory?: (input: Readonly<{
    launchMode: 'interactive' | 'headless';
    generation: number;
    contextDigest: string;
    selectedAt: string;
  }>) => Result<ProviderProfileAuthorityV1, RuntimeError>
    | Promise<Result<ProviderProfileAuthorityV1, RuntimeError>>;
}

export interface StartedWorkerView {
  taskId: string;
  generation: number;
  sessionName: string;
  paneId: string;
  worktreePath: string;
  branchName: string;
  /** 明文 claimToken 僅在此回傳一次；descriptor 只存 digest */
  claimToken: string;
  markerPath: string;
  providerProfileDigest: string;
  routeReceiptDigest: string;
}

export interface StartTeamView {
  teamId: string;
  ownerNonce: string;
  aggregateRevision: number;
  workers: StartedWorkerView[];
}

export interface TeamStatusView {
  teamId: string;
  revision: number;
  ownerNonce: string;
  tasks: Readonly<Record<string, TeamTaskRuntimeV1>>;
  heartbeats: TeamAggregateV1['heartbeats'];
  tmux: Readonly<Record<string, { alive: boolean; paneId?: string }>>;
}

export interface StopTeamView {
  teamId: string;
  killedSessions: string[];
}

export interface SuperviseReport {
  teamId: string;
  revision: number;
  assessments: Readonly<Record<string, SupervisorAssessment>>;
}

export interface ReclaimView {
  teamId: string;
  taskId: string;
  revision: number;
  status: string;
}

export interface DeliverView {
  teamId: string;
  taskId: string;
  revision: number;
  status: string;
  headSha: string;
  integrationTip?: string;
}

export interface TickView {
  teamId: string;
  aggregateRevision: number;
  started: StartedWorkerView[];
}

export class TeamOrchestrator {
  private readonly stateRoot: string;
  private readonly workspaceRoot: string;
  private readonly repoKey: string | null;
  private readonly workspaceKey: string;
  private readonly managedWorktreesRoot: string;
  private readonly sessionNamePrefix: string | undefined;
  private readonly tokenFactory: () => string;
  private readonly nowMs: () => number;
  private readonly leaseMs: number;
  private maxParallelWorkers: number;
  private readonly tmux: TmuxController;
  private readonly worktrees: GitWorktreeManager;
  private readonly workerExecutablePath: string;
  private readonly workerBootstrapArgv: readonly string[];
  private readonly providerProfileFactory: TeamOrchestratorOptions['providerProfileFactory'];

  constructor(options: Readonly<TeamOrchestratorOptions>) {
    this.stateRoot = options.stateRoot;
    this.workspaceRoot = fs.realpathSync(options.workspaceRoot);
    this.repoKey = options.repoKey;
    this.workspaceKey = options.workspaceKey;
    this.managedWorktreesRoot = options.managedWorktreesRoot;
    this.sessionNamePrefix = options.sessionNamePrefix;
    this.tokenFactory = options.tokenFactory
      ?? (() => crypto.randomBytes(16).toString('hex'));
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.leaseMs = options.leaseMs ?? 300_000;
    this.maxParallelWorkers = Math.max(1, options.maxParallelWorkers ?? 1);
    this.tmux = options.tmux ?? new TmuxController();
    this.worktrees = options.worktrees
      ?? new GitWorktreeManager(this.workspaceRoot, options.managedWorktreesRoot);
    this.workerExecutablePath = options.workerExecutablePath ?? process.execPath;
    this.providerProfileFactory = options.providerProfileFactory;
    if (options.workerBootstrapArgv !== undefined) {
      this.workerBootstrapArgv = options.workerBootstrapArgv;
    } else if (options.workerHoldEntryPath !== undefined) {
      this.workerBootstrapArgv = [options.workerHoldEntryPath];
    } else {
      // 生產預設：agy worker-bootstrap（hold 僅測試注入）
      const entry = path.resolve(__dirname, 'worker-bootstrap.js');
      this.workerBootstrapArgv = [entry];
    }
  }

  async startFromManifest(
    manifestPath: string,
    workerMode: 'interactive' | 'headless',
  ): Promise<Result<StartTeamView, RuntimeError>> {
    if (!fs.existsSync(manifestPath)) {
      return err(runtimeError('E_MANIFEST_INVALID', `manifest not found: ${manifestPath}`));
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      return err(runtimeError(
        'E_MANIFEST_INVALID',
        `cannot parse manifest: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
    const validated = validateTeamManifest(raw, this.workspaceRoot);
    if (!validated.ok) return validated;

    const ownerNonce = this.tokenFactory();
    const store = new TeamStateStore(
      this.stateRoot,
      this.repoKey,
      this.workspaceKey,
      validated.value.teamId,
    );
    const created = await store.create(
      validated.value,
      ownerNonce,
      this.repoKey,
      this.workspaceKey,
    );
    if (!created.ok) return created;

    const ready = listReadyTaskSpecs(validated.value, created.value.value);
    if (ready.length === 0) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'No ready claimable tasks'));
    }

    const workers: StartedWorkerView[] = [];
    let revision = created.value.revision;
    for (const task of ready.slice(0, this.maxParallelWorkers)) {
      const started = await this.startOneTask({
        store,
        teamId: validated.value.teamId,
        task,
        ownerNonce,
        workerMode,
        expectedRevision: revision,
        // The first worker owns the create+launch transaction and may remove
        // the just-created aggregate on failure. Once any worker is live, a
        // later launch must instead roll back only that task; deleting the
        // aggregate would orphan the already-running worker.
        launchTransaction: workers.length === 0,
      });
      if (!started.ok) {
        if (workers.length === 0) {
          const current = store.read();
          if (!current.ok) return current;
          const rolledBack = await store.rollbackLaunch(current.value.revision, ownerNonce);
          return rolledBack.ok ? started : rolledBack;
        }
        // startOneTask only returns the original launch error after its
        // per-task state/lease/worktree cleanup has completed. Refresh the
        // aggregate revision so a partial-success response never advertises a
        // stale revision from before that rollback.
        const current = store.read();
        if (!current.ok) return current;
        revision = current.value.revision;
        break;
      }
      workers.push(started.value.worker);
      revision = started.value.revision;
    }

    return ok({
      teamId: validated.value.teamId,
      ownerNonce,
      aggregateRevision: revision,
      workers,
    });
  }

  async status(teamId: string): Promise<Result<TeamStatusView, RuntimeError>> {
    const store = new TeamStateStore(
      this.stateRoot,
      this.repoKey,
      this.workspaceKey,
      teamId,
    );
    const snapshot = store.read();
    if (!snapshot.ok) return snapshot;
    const aggregate = snapshot.value.value;
    const tmuxView: Record<string, { alive: boolean; paneId?: string }> = {};
    for (const [workerId, hb] of Object.entries(aggregate.heartbeats)) {
      const sessionName = inferSessionName(this.sessionNamePrefix, aggregate.teamId, workerId, hb);
      const alive = this.tmux.hasSession(sessionName);
      let paneId = hb.paneId;
      if (alive) {
        const inspected = this.tmux.inspectOwnedPane(sessionName);
        if (inspected.ok) paneId = inspected.value.paneId;
      }
      tmuxView[sessionName] = { alive, paneId };
    }
    return ok({
      teamId: aggregate.teamId,
      revision: snapshot.value.revision,
      ownerNonce: aggregate.ownerNonce,
      tasks: aggregate.tasks,
      heartbeats: aggregate.heartbeats,
      tmux: tmuxView,
    });
  }

  async stop(teamId: string): Promise<Result<StopTeamView, RuntimeError>> {
    const store = new TeamStateStore(
      this.stateRoot,
      this.repoKey,
      this.workspaceKey,
      teamId,
    );
    const snapshot = store.read();
    if (!snapshot.ok) return snapshot;
    const aggregate = snapshot.value.value;
    const killed: string[] = [];
    for (const [workerId, hb] of Object.entries(aggregate.heartbeats)) {
      const sessionName = inferSessionName(this.sessionNamePrefix, aggregate.teamId, workerId, hb);
      if (!this.tmux.hasSession(sessionName)) continue;
      const result = this.tmux.killOwnedSession(sessionName, aggregate.ownerNonce);
      if (!result.ok) return result;
      killed.push(sessionName);
    }
    return ok({ teamId, killedSessions: killed });
  }

  async superviseOnce(teamId: string): Promise<Result<SuperviseReport, RuntimeError>> {
    const store = new TeamStateStore(this.stateRoot, this.repoKey, this.workspaceKey, teamId);
    const snapshot = store.read();
    if (!snapshot.ok) return snapshot;
    const aggregate = snapshot.value.value;
    const assessments: Record<string, SupervisorAssessment> = {};
    let revision = snapshot.value.revision;
    for (const task of Object.values(aggregate.tasks)) {
      if (task.status !== 'in_progress' && task.status !== 'awaiting_interaction') continue;
      const hb = aggregate.heartbeats[task.id];
      const sessionName = hb === undefined
        ? undefined
        : inferSessionName(this.sessionNamePrefix, aggregate.teamId, task.id, hb);
      const paneLiveness = sessionName === undefined ? 'unknown' : probeTmuxSession(sessionName);
      const processLiveness = hb === undefined ? 'unknown' : probeProcessPid(hb.process.pid);
      const assessment = assessWorker(task, hb, this.nowMs(), paneLiveness, processLiveness);
      assessments[task.id] = assessment;
      if (assessment.status === 'awaiting_interaction') {
        const updated = await store.setTaskStatus(task.id, revision, 'awaiting_interaction');
        if (!updated.ok) return updated;
        revision = updated.value.revision;
      } else if (assessment.status === 'reclaimable') {
        // 只有 DeadProof 可清 claim；Unknown 必須保留 worker identity/capability。
        const released = await store.releaseClaimAfterDeadProof(task.id, revision);
        if (!released.ok) return released;
        revision = released.value.revision;
        await this.releaseLeasesForTask(teamId, task.id);
      } else if (assessment.status === 'orphan_identity_unproven') {
        // Unknown 是隔離狀態，不可視為死亡證明或重新排入 ready queue。
        const updated = await store.setTaskStatus(task.id, revision, 'orphan_identity_unproven');
        if (!updated.ok) return updated;
        revision = updated.value.revision;
      }
    }
    return ok({ teamId, revision, assessments });
  }

  async reclaimTask(
    teamId: string,
    taskId: string,
    expectedRevision: number,
    paneLiveness?: 'alive' | 'dead' | 'unknown',
    processLiveness?: 'alive' | 'dead' | 'unknown',
  ): Promise<Result<ReclaimView, RuntimeError>> {
    const store = new TeamStateStore(this.stateRoot, this.repoKey, this.workspaceKey, teamId);
    const snapshot = store.read();
    if (!snapshot.ok) return snapshot;
    const hb = snapshot.value.value.heartbeats[taskId];
    const sessionName = hb === undefined
      ? undefined
      : inferSessionName(this.sessionNamePrefix, teamId, taskId, hb);
    // 預設 orchestrator 重探；CLI 旗標僅當 probe 失敗時的 fallback
    const pane = sessionName !== undefined
      ? probeTmuxSession(sessionName)
      : (paneLiveness ?? 'unknown');
    const proc = hb !== undefined
      ? probeProcessPid(hb.process.pid)
      : (processLiveness ?? 'unknown');
    // 若重探結果與呼叫端矛盾且呼叫端宣稱 dead，仍以重探為準
    const proof = requireDeadProof(pane, proc);
    if (!proof.ok) return proof;
    if (sessionName !== undefined && this.tmux.hasSession(sessionName)) {
      const killed = this.tmux.killOwnedSession(sessionName, snapshot.value.value.ownerNonce);
      if (!killed.ok) return killed;
    }
    const released = await store.releaseClaimAfterDeadProof(taskId, expectedRevision);
    if (!released.ok) return released;
    await this.releaseLeasesForTask(teamId, taskId);
    return ok({
      teamId,
      taskId,
      revision: released.value.revision,
      status: released.value.value.tasks[taskId]!.status,
    });
  }

  async deliverTask(input: {
    teamId: string;
    taskId: string;
    expectedRevision: number;
    claimToken: string;
    generation: number;
    worktreePath: string;
  }): Promise<Result<DeliverView, RuntimeError>> {
    const store = new TeamStateStore(this.stateRoot, this.repoKey, this.workspaceKey, input.teamId);
    const snapshot = store.read();
    if (!snapshot.ok) return snapshot;
    const aggregate = snapshot.value.value;
    if (snapshot.value.revision !== input.expectedRevision) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Team state revision changed', {
        expectedRevision: input.expectedRevision,
        actualRevision: snapshot.value.revision,
      }));
    }
    const task = aggregate.tasks[input.taskId];
    const spec = aggregate.manifest.tasks.find((entry) => entry.id === input.taskId);
    if (task === undefined || spec === undefined) {
      return err(runtimeError('E_NOT_FOUND', 'Team task does not exist', { taskId: input.taskId }));
    }
    if (task.claim?.token !== input.claimToken || task.claim.generation !== input.generation) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Task claim token or generation is stale'));
    }
    // 交付前先停 worker：hold/bootstrap 可能在 clean 之後又寫回 .oma-worker-ready（race）
    const heartbeat = aggregate.heartbeats[input.taskId];
    if (heartbeat !== undefined) {
      const sessionName = inferSessionName(this.sessionNamePrefix, input.teamId, input.taskId, heartbeat);
      if (this.tmux.hasSession(sessionName)) {
        const killed = this.tmux.killOwnedSession(sessionName, aggregate.ownerNonce);
        if (!killed.ok) return killed;
      }
    }
    // 交付前移除 orchestrator 執行期檔，確保 porcelain clean（delivery 契約要求）
    const cleaned = ensureWorkerWorktreeCleanForDelivery(input.worktreePath);
    if (!cleaned.ok) return cleaned;

    const markerPath = `${input.worktreePath}.owner.json`;
    let deliveryBase = '';
    if (fs.existsSync(markerPath)) {
      try {
        const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { baseSha?: string };
        if (typeof marker.baseSha === 'string') deliveryBase = marker.baseSha;
      } catch (_) { /* fall through */ }
    }
    if (deliveryBase === '') {
      return err(runtimeError('E_CORRUPT_STATE', 'Managed worktree owner marker baseSha is missing'));
    }
    const head = gitHead(input.worktreePath);
    if (!head.ok) return head;
    const commits = gitRevList(input.worktreePath, deliveryBase, head.value);
    if (!commits.ok) return commits;
    if (commits.value.length === 0) {
      return err(runtimeError('E_DELIVERY_UNINTEGRATED', 'No commits to deliver'));
    }
    let workerWorkspaceKey: string;
    try {
      workerWorkspaceKey = resolveGitWorktreeIdentity(input.worktreePath).workspaceKey;
    } catch (error) {
      return err(runtimeError('E_LEADER_WORKTREE_CHANGED', 'Worker worktree identity failed', {
        cause: error instanceof Error ? error.message : String(error),
      }));
    }

    const evidence = createDeliveryEvidence({
      taskId: input.taskId,
      taskRevision: task.revision,
      manifestRevision: aggregate.manifest.revision,
      claimToken: input.claimToken,
      generation: input.generation,
      baseSha: deliveryBase,
      orderedCommits: commits.value,
      headSha: head.value,
      commandEvidenceIds: Object.keys(task.commandEvidence),
      workerWorkspaceKey,
      workerWorktreeRealpath: input.worktreePath,
    });
    if (!evidence.ok) return evidence;

    const completedDeps = new Set(
      Object.values(aggregate.tasks)
        .filter((entry) => entry.status === 'completed')
        .map((entry) => entry.id),
    );
    const validated = new DeliveryValidator().validate(evidence.value, {
      task: spec,
      currentTaskRevision: task.revision,
      manifestRevision: aggregate.manifest.revision,
      claimToken: input.claimToken,
      generation: input.generation,
      completedDependencies: completedDeps,
      commandEvidenceIds: new Set(Object.keys(task.commandEvidence)),
    });
    if (!validated.ok) return validated;

    const accepted = await store.acceptDelivery(input.expectedRevision, evidence.value);
    if (!accepted.ok) return accepted;

    const prepared = new IntegrationManager(this.managedWorktreesRoot).prepare({
      leaderRepo: this.workspaceRoot,
      stateRevision: accepted.value.revision,
      ownerNonce: aggregate.ownerNonce,
      delivery: validated.value,
    });
    if (!prepared.ok) return prepared;

    const published = await new FastForwardPublisherV1().publishCheckedOutRef(prepared.value);
    if (!published.ok) return published;

    const integrated = await store.markIntegrated(
      input.taskId,
      accepted.value.revision,
      validated.value.deliveryDigest,
    );
    if (!integrated.ok) return integrated;
    await this.releaseLeasesForTask(input.teamId, input.taskId);

    return ok({
      teamId: input.teamId,
      taskId: input.taskId,
      revision: integrated.value.revision,
      status: integrated.value.value.tasks[input.taskId]!.status,
      headSha: head.value,
      integrationTip: published.value.integrationTip,
    });
  }

  async tick(teamId: string, workerMode: 'interactive' | 'headless' = 'headless'): Promise<Result<TickView, RuntimeError>> {
    const store = new TeamStateStore(this.stateRoot, this.repoKey, this.workspaceKey, teamId);
    const snapshot = store.read();
    if (!snapshot.ok) return snapshot;
    const aggregate = snapshot.value.value;
    const inFlight = Object.values(aggregate.tasks).filter((task) => task.status === 'in_progress').length;
    const slots = Math.max(0, this.maxParallelWorkers - inFlight);
    if (slots === 0) {
      return ok({ teamId, aggregateRevision: snapshot.value.revision, started: [] });
    }
    const ready = listReadyTaskSpecs(aggregate.manifest, aggregate);
    const started: StartedWorkerView[] = [];
    let revision = snapshot.value.revision;
    for (const task of ready.slice(0, slots)) {
      const one = await this.startOneTask({
        store,
        teamId,
        task,
        ownerNonce: aggregate.ownerNonce,
        workerMode,
        expectedRevision: revision,
        launchTransaction: false,
      });
      if (!one.ok) {
        if (started.length === 0) return one;
        break;
      }
      started.push(one.value.worker);
      revision = one.value.revision;
    }
    return ok({ teamId, aggregateRevision: revision, started });
  }

  setMaxParallelWorkers(value: number): void {
    this.maxParallelWorkers = Math.max(1, value);
  }

  private async releaseLeasesForTask(
    teamId: string,
    taskId: string,
  ): Promise<Result<void, RuntimeError>> {
    const leases = new AuthorityLeaseStore(this.stateRoot, teamId);
    const ensured = await leases.ensure();
    if (!ensured.ok) return ensured;
    const released = await leases.releaseAllForTask(taskId, ensured.value.revision);
    return released.ok ? ok(undefined) : released;
  }

  private async startOneTask(input: {
    store: TeamStateStore;
    teamId: string;
    task: CanonicalTeamTaskV1;
    ownerNonce: string;
    workerMode: 'interactive' | 'headless';
    expectedRevision: number;
    launchTransaction: boolean;
  }): Promise<Result<{ worker: StartedWorkerView; revision: number }, RuntimeError>> {
    const baseSha = gitHead(this.workspaceRoot);
    if (!baseSha.ok) return baseSha;
    const workerId = input.task.id;
    const claimToken = this.tokenFactory();
    const claimDigest = sha256(claimToken);

    // AuthorityLease：overlapping write_scope 必須先取得 exclusive lease
    const pathKeys = pathKeysFromWriteScope(input.task.write_scope as any);
    if (pathKeys.length > 0) {
      const leases = new AuthorityLeaseStore(this.stateRoot, input.teamId);
      const ensured = await leases.ensure();
      if (!ensured.ok) return ensured;
      let leaseRev = ensured.value.revision;
      for (const pathKey of pathKeys) {
        const acquired = await leases.acquire(
          pathKey,
          input.task.id,
          claimDigest,
          this.nowMs(),
          this.leaseMs,
          leaseRev,
        );
        if (!acquired.ok) {
          if (input.launchTransaction) {
            const rolledBack = await this.rollbackLaunchLeases(input.teamId, input.task.id);
            if (!rolledBack.ok) return rolledBack;
          } else {
            const released = await this.releaseLeasesForTask(input.teamId, input.task.id);
            if (!released.ok) return released;
          }
          return acquired;
        }
        leaseRev = acquired.value.revision;
      }
    }

    // claim 先 CAS，generation 以結果為準
    const claimed = await input.store.claimTask(
      input.task.id,
      workerId,
      input.expectedRevision,
      this.nowMs(),
      this.leaseMs,
      claimToken,
    );
    if (!claimed.ok) {
      if (input.launchTransaction) {
        const rolledBack = await this.rollbackLaunchLeases(input.teamId, input.task.id);
        if (!rolledBack.ok) return rolledBack;
      } else {
        const released = await this.releaseLeasesForTask(input.teamId, input.task.id);
        if (!released.ok) return released;
      }
      return claimed;
    }
    const generation = claimed.value.value.tasks[input.task.id]!.claim!.generation;

    const contextDigest = sha256([
      this.repoKey ?? '', this.workspaceKey, input.teamId, input.task.id,
    ].join('\0'));
    const authorityRequestedAt = new Date(this.nowMs()).toISOString();
    const authority = this.providerProfileFactory === undefined
      ? undefined
      : await this.providerProfileFactory({
        launchMode: input.workerMode,
        generation,
        contextDigest,
        selectedAt: authorityRequestedAt,
      });
    const preflightSelectedAt = new Date(this.nowMs()).toISOString();
    const preflight = authority === undefined
      ? err(runtimeError('E_CAPABILITY_UNPROVEN', 'Team worker launch requires an evidence-bearing host profile'))
      : !authority.ok
        ? authority
        : preflightTeamWorkerProviderRoute({
          profile: authority.value.profile,
          now: preflightSelectedAt,
          launchMode: input.workerMode,
          generation,
          contextDigest,
          resolvedExecutable: authority.value.resolvedExecutable,
          ...(authority.value.tmuxReadiness === undefined
            ? {} : { tmuxReadiness: authority.value.tmuxReadiness }),
        });
    if (!preflight.ok) {
      const rolledBack = input.launchTransaction
        ? await this.rollbackLaunchLeases(input.teamId, input.task.id)
        : await this.rollbackFailedTaskLaunch({
          store: input.store,
          teamId: input.teamId,
          taskId: input.task.id,
          ownerNonce: input.ownerNonce,
          claimToken,
          generation,
          expectedRevision: claimed.value.revision,
        });
      if (!rolledBack.ok) return rolledBack;
      return preflight;
    }
    const branchName = `oma-team/${input.teamId}/${workerId}-g${generation}-${this.tokenFactory().slice(0, 8)}`;
    const worktree = this.worktrees.create({
      teamId: input.teamId,
      workerId,
      generation,
      branchName,
      baseSha: baseSha.value,
      ownerNonce: input.ownerNonce,
    });
    if (!worktree.ok) {
      if (input.launchTransaction) {
        const rolledBack = await this.rollbackLaunchLeases(input.teamId, input.task.id);
        if (!rolledBack.ok) return rolledBack;
      } else {
        const rolledBack = await this.rollbackFailedTaskLaunch({
          store: input.store,
          teamId: input.teamId,
          taskId: input.task.id,
          ownerNonce: input.ownerNonce,
          claimToken,
          generation,
          expectedRevision: claimed.value.revision,
        });
        if (!rolledBack.ok) return rolledBack;
      }
      return worktree;
    }

    const rollbackPreparedWorktree = async (): Promise<Result<void, RuntimeError>> => {
      const worktreeRollback = this.worktrees.rollbackLaunch(worktree.value, input.ownerNonce);
      if (input.launchTransaction) {
        const rolledBack = await this.rollbackLaunchLeases(input.teamId, input.task.id);
        if (!rolledBack.ok) return rolledBack;
        return worktreeRollback;
      }
      return this.rollbackFailedTaskLaunch({
        store: input.store,
        teamId: input.teamId,
        taskId: input.task.id,
        ownerNonce: input.ownerNonce,
        claimToken,
        generation,
        expectedRevision: claimed.value.revision,
        worktree: worktree.value,
        worktreeAlreadyRolledBack: worktreeRollback.ok,
      });
    };

    // Preflight remains before worktree creation. Re-read authority after that
    // potentially slow step so every launch and receipt uses current evidence.
    const routeAuthorityRequestedAt = new Date(this.nowMs()).toISOString();
    const routeAuthority = this.providerProfileFactory === undefined
      ? undefined
      : await this.providerProfileFactory({
        launchMode: input.workerMode,
        generation,
        contextDigest,
        selectedAt: routeAuthorityRequestedAt,
      });
    if (routeAuthority === undefined || !routeAuthority.ok) {
      const rolledBack = await rollbackPreparedWorktree();
      if (!rolledBack.ok) return rolledBack;
      return routeAuthority === undefined
        ? err(runtimeError('E_CAPABILITY_UNPROVEN', 'Team provider profile authority is unavailable'))
        : routeAuthority;
    }
    const routeSelectedAt = new Date(this.nowMs()).toISOString();
    const selected = routeTeamWorkerProvider({
      profile: routeAuthority.value.profile,
      now: routeSelectedAt,
      launchMode: input.workerMode,
      generation,
      contextDigest,
      resolvedExecutable: routeAuthority.value.resolvedExecutable,
      ...(routeAuthority.value.tmuxReadiness === undefined
        ? {} : { tmuxReadiness: routeAuthority.value.tmuxReadiness }),
    });
    if (!selected.ok) {
      const rolledBack = await rollbackPreparedWorktree();
      if (!rolledBack.ok) return rolledBack;
      return selected;
    }
    const routeReceipt = selected.value;
    let routeAuthorityPath = workerRouteAuthorityPath(
      this.stateRoot,
      input.teamId,
      input.task.id,
      generation,
    );
    let routeAuthorityDigest: string;
    try {
      const persistedRouteAuthority = createWorkerRouteAuthority({
        stateRoot: this.stateRoot,
        teamId: input.teamId,
        taskId: input.task.id,
        generation,
        contextDigest,
        profile: routeAuthority.value.profile,
        receipt: routeReceipt,
        now: routeSelectedAt,
      });
      routeAuthorityPath = writeWorkerRouteAuthority(this.stateRoot, persistedRouteAuthority);
      routeAuthorityDigest = persistedRouteAuthority.authorityDigest;
    } catch (error) {
      try { fs.rmSync(routeAuthorityPath, { force: true }); } catch (_) { /* best-effort */ }
      const rolledBack = await rollbackPreparedWorktree();
      if (!rolledBack.ok) return rolledBack;
      return err(runtimeError('E_CAPABILITY_UNPROVEN', 'Worker route authority could not be persisted', {
        cause: error instanceof Error ? error.message : String(error),
      }));
    }

    const sessionBase = this.sessionNamePrefix ?? `oma-${input.teamId}`;
    const sessionName = sanitizeSession(`${sessionBase}-${workerId}-g${generation}`);
    const markerPath = path.join(worktree.value.path, '.oma-worker-ready');
    const descriptorPath = path.join(worktree.value.path, '.oma-worker-descriptor.json');
    const sessionId = this.tokenFactory();
    const launchNonce = this.tokenFactory();
    const descriptor = {
      schemaVersion: 1 as const,
      teamId: input.teamId,
      taskId: input.task.id,
      workerId,
      generation,
      workerMode: input.workerMode,
      claimTokenDigest: sha256(claimToken),
      worktreePath: worktree.value.path,
      stateRoot: this.stateRoot,
      sessionId,
      launchNonce,
      invocationGeneration: 1,
      taskPrompt: `Execute team task ${input.task.id}`,
      agyCommand: routeReceipt.resolvedExecutable,
      provider: routeReceipt.provider,
      providerProfileDigest: routeReceipt.profileDigest,
      routeReceiptDigest: routeReceipt.receiptDigest,
      routeContextDigest: contextDigest,
      routeAuthorityDigest,
      capabilityMode: input.task.write_scope === 'none' ? 'read-only' : 'read-write',
      boundedDuration: '5m0s',
    };
    fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    const omaDir = path.join(worktree.value.path, '.oma');
    fs.mkdirSync(omaDir, { recursive: true, mode: 0o700 });
    const capPath = path.join(omaDir, 'worker-capability.json');
    fs.writeFileSync(capPath, `${JSON.stringify({ claimToken })}\n`, { encoding: 'utf8', mode: 0o600 });

    const workerNonce = this.tokenFactory();
    const pane = this.tmux.startWorker({
      sessionName,
      cwd: worktree.value.path,
      executablePath: this.workerExecutablePath,
      descriptorPath,
      bootstrapArgv: [...this.workerBootstrapArgv, markerPath],
      ownerNonce: input.ownerNonce,
      workerNonce,
    });
    if (!pane.ok) {
      try { fs.rmSync(routeAuthorityPath, { force: true }); } catch (_) { /* best-effort */ }
      try { fs.rmSync(descriptorPath, { force: true }); } catch (_) { /* best-effort */ }
      try { fs.rmSync(capPath, { force: true }); } catch (_) { /* best-effort */ }
      const worktreeRollback = this.worktrees.rollbackLaunch(worktree.value, input.ownerNonce);
      if (input.launchTransaction) {
        const rolledBack = await this.rollbackLaunchLeases(input.teamId, input.task.id);
        if (!rolledBack.ok) return rolledBack;
        if (!worktreeRollback.ok) return worktreeRollback;
      } else {
        const rolledBack = await this.rollbackFailedTaskLaunch({
          store: input.store,
          teamId: input.teamId,
          taskId: input.task.id,
          ownerNonce: input.ownerNonce,
          claimToken,
          generation,
          expectedRevision: claimed.value.revision,
          worktree: worktree.value,
          worktreeAlreadyRolledBack: worktreeRollback.ok,
        });
        if (!rolledBack.ok) return rolledBack;
      }
      return pane;
    }

    const panePid = readPanePid(sessionName);
    const heartbeat: SupervisorHeartbeatV1 = {
      schemaVersion: 1,
      workerId,
      ownerNonce: input.ownerNonce,
      workerNonce,
      process: {
        pid: panePid ?? process.pid,
        startMarker: `tmux:${sessionName}`,
      },
      paneId: pane.value.paneId,
      recordedAtMs: this.nowMs(),
    };
    const hb = await input.store.recordHeartbeat(claimed.value.revision, heartbeat);
    if (!hb.ok) {
      const tmuxRollback = this.tmux.killOwnedSession(sessionName, input.ownerNonce);
      try { fs.rmSync(routeAuthorityPath, { force: true }); } catch (_) { /* best-effort */ }
      try { fs.rmSync(descriptorPath, { force: true }); } catch (_) { /* best-effort */ }
      try { fs.rmSync(capPath, { force: true }); } catch (_) { /* best-effort */ }
      const worktreeRollback = this.worktrees.rollbackLaunch(worktree.value, input.ownerNonce);
      if (input.launchTransaction) {
        const rolledBack = await this.rollbackLaunchLeases(input.teamId, input.task.id);
        if (!rolledBack.ok) return rolledBack;
        if (!worktreeRollback.ok) return worktreeRollback;
        if (!tmuxRollback.ok) return tmuxRollback;
      } else {
        const rolledBack = await this.rollbackFailedTaskLaunch({
          store: input.store,
          teamId: input.teamId,
          taskId: input.task.id,
          ownerNonce: input.ownerNonce,
          claimToken,
          generation,
          expectedRevision: claimed.value.revision,
          worktree: worktree.value,
          worktreeAlreadyRolledBack: worktreeRollback.ok,
          initialCleanupError: tmuxRollback.ok ? undefined : tmuxRollback.error,
        });
        if (!rolledBack.ok) return rolledBack;
      }
      return hb;
    }

    return ok({
      revision: hb.value.revision,
      worker: {
        taskId: input.task.id,
        generation,
        sessionName,
        paneId: pane.value.paneId,
        worktreePath: worktree.value.path,
        branchName,
        claimToken,
        markerPath,
        providerProfileDigest: routeReceipt.profileDigest,
        routeReceiptDigest: routeReceipt.receiptDigest,
      },
    });
  }

  private async rollbackLaunchLeases(
    teamId: string,
    taskId: string,
  ): Promise<Result<void, RuntimeError>> {
    const leases = new AuthorityLeaseStore(this.stateRoot, teamId);
    const snapshot = await leases.ensure();
    if (!snapshot.ok) return snapshot;
    const released = await leases.releaseAllForTask(taskId, snapshot.value.revision);
    if (!released.ok) return released;
    return leases.rollbackEmpty(released.value.revision);
  }

  private async rollbackFailedTaskLaunch(input: {
    store: TeamStateStore;
    teamId: string;
    taskId: string;
    ownerNonce: string;
    claimToken: string;
    generation: number;
    expectedRevision: number;
    worktree?: ManagedWorktreeV1;
    worktreeAlreadyRolledBack?: boolean;
    initialCleanupError?: RuntimeError;
  }): Promise<Result<void, RuntimeError>> {
    let cleanupError = input.initialCleanupError;
    if (input.worktree !== undefined && input.worktreeAlreadyRolledBack !== true) {
      const removed = this.worktrees.rollbackLaunch(input.worktree, input.ownerNonce);
      if (!removed.ok) cleanupError = removed.error;
    }
    const state = await input.store.rollbackTaskLaunch({
      expectedRevision: input.expectedRevision,
      taskId: input.taskId,
      claimToken: input.claimToken,
      generation: input.generation,
      ownerNonce: input.ownerNonce,
    });
    if (!state.ok && cleanupError === undefined) cleanupError = state.error;
    const leases = await this.releaseLeasesForTask(input.teamId, input.taskId);
    if (!leases.ok && cleanupError === undefined) cleanupError = leases.error;
    return cleanupError === undefined ? ok(undefined) : err(cleanupError);
  }
}

/** deps 皆 completed 且 task claimable 的規格列 */
export function listReadyTaskSpecs(
  manifest: CanonicalTeamManifestV1,
  aggregate: TeamAggregateV1,
): CanonicalTeamTaskV1[] {
  return manifest.tasks.filter((task) => {
    const runtime = aggregate.tasks[task.id];
    if (runtime === undefined) return false;
    if (runtime.claim !== undefined
      || !['pending', 'awaiting_interaction', 'orphan_identity_unproven'].includes(runtime.status)) {
      return false;
    }
    return task.dependencies.every((dep) => aggregate.tasks[dep]?.status === 'completed');
  });
}

/**
 * 清除 worker 執行期檔並確認 porcelain 為空。
 * 設計概念映射：delivery clean proof 契約；先停 worker 仍可能殘留檔，故重試 clean。
 */
function ensureWorkerWorktreeCleanForDelivery(worktreePath: string): Result<void, RuntimeError> {
  const runtimeRelatives = ['.oma-worker-ready', '.oma-worker-descriptor.json'];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    for (const relative of runtimeRelatives) {
      try { fs.rmSync(path.join(worktreePath, relative), { force: true }); } catch (_) { /* best-effort */ }
    }
    try { fs.rmSync(path.join(worktreePath, '.oma'), { recursive: true, force: true }); } catch (_) { /* best-effort */ }
    const status = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: worktreePath,
      encoding: 'utf8',
    });
    if (status.status === 0 && (status.stdout ?? '') === '') {
      return ok(undefined);
    }
    // 極短等待：防止殘留 writer 在 kill 後仍 flush 一次
    sleepMs(50);
  }
  const finalStatus = spawnSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
    cwd: worktreePath,
    encoding: 'utf8',
  });
  return err(runtimeError('E_DELIVERY_UNINTEGRATED', 'Worker worktree could not be made clean for delivery', {
    porcelain: finalStatus.stdout ?? '',
  }));
}

function sleepMs(ms: number): void {
  try {
    const ia = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(ia, 0, 0, ms);
  } catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) { /* spin fallback */ }
  }
}

/** tmux validSessionName: /^[A-Za-z0-9_.-]+$/ */
function sanitizeSession(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]+/g, '-').slice(0, 80);
}

function inferSessionName(
  prefix: string | undefined,
  teamId: string,
  workerId: string,
  heartbeat: SupervisorHeartbeatV1,
): string {
  if (heartbeat.process.startMarker.startsWith('tmux:')) {
    return heartbeat.process.startMarker.slice('tmux:'.length);
  }
  const base = prefix ?? `oma-${teamId}`;
  return sanitizeSession(`${base}-${workerId}-g1`);
}

function gitHead(cwd: string): Result<string, RuntimeError> {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    return err(runtimeError('E_RETRYABLE_BLOCKER', 'Unable to resolve leader HEAD', {
      stderr: result.stderr,
    }));
  }
  return ok(result.stdout.trim());
}

function gitRevList(
  cwd: string,
  baseSha: string,
  headSha: string,
): Result<string[], RuntimeError> {
  const result = spawnSync(
    'git',
    ['rev-list', '--reverse', '--first-parent', `${baseSha}..${headSha}`],
    { cwd, encoding: 'utf8' },
  );
  if (result.status !== 0) {
    return err(runtimeError('E_RETRYABLE_BLOCKER', 'Unable to list delivery commits', {
      stderr: result.stderr,
    }));
  }
  const commits = result.stdout.trim() === '' ? [] : result.stdout.trim().split('\n');
  return ok(commits);
}

/** 讀取 tmux session 第一個 pane 的 shell pid（worker 側 process 身分） */
function readPanePid(sessionName: string): number | null {
  const result = spawnSync(
    'tmux',
    ['list-panes', '-t', sessionName, '-F', '#{pane_pid}'],
    { encoding: 'utf8' },
  );
  if (result.status !== 0) return null;
  const line = result.stdout.trim().split('\n')[0];
  const pid = Number(line);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}
