/**
 * 設計概念映射：TeamOrchestrator 對齊 OMC/OMX Team 編排
 * （start → claim → worktree → tmux → heartbeat → supervise/reclaim → deliver → tick → wait → resume）。
 */
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { canonicalJson, sha256 } from '../runtime/atomic';
import {
  HUD_WATCH_INTERVAL_MS_DEFAULT,
  HUD_WATCH_INTERVAL_MS_MAX,
  HUD_WATCH_INTERVAL_MS_MIN,
  HUD_WATCH_MAX_ITERATIONS,
  boundedSleep,
} from '../hud/watch';
import { HostCapabilityProfileV1 } from '../native/capability-profile';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import { createDeliveryEvidence, DeliveryValidator } from './delivery';
import { IntegrationManager } from './integration';
import { probeRecordedWorkerProcess, probeTmuxSession } from './liveness';
import { ProcessLiveness } from '../runtime/lock';
import { readTeamManifest } from './manifest';
import { FastForwardPublisherV1 } from './publisher';
import { requireDeadProof } from './reclaim';
import { TeamStateStore } from './state';
import { assessWorker, SupervisorAssessment } from './supervisor';
import { teamWorkerLivenessBasenames } from './provider-readiness';
import {
  ArgvSpawnFn,
  observeTmuxWorkerIdentity,
  providerChildProcessMarker,
  providerLivenessFromResolution,
  resolveProviderChild,
  TmuxController,
} from './tmux';
import {
  CanonicalTeamManifestV1,
  CanonicalTeamTaskV1,
  ProcessMarkerV1,
  SupervisorHeartbeatV1,
  TeamAggregateV1,
  TeamTaskRuntimeV1,
  TeamTaskStatus,
  WorkerAuthorityBindingV1,
  WorkerPaneReceiptV1,
} from './types';
import { AuthorityLeaseStore, pathKeysFromWriteScope } from './authority-lease';
import { cleanupTeam, TeamCleanupView } from './cleanup';
import { GitWorktreeManager, ManagedWorktreeV1, resolveGitWorktreeIdentity } from './worktree';

export type { TeamCleanupView };
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
import {
  LEADER_CONTEXT_MAX_BYTES,
  TeamLeaderContextV1,
  leaderContextPath,
  writeBoundedLeaderContext,
} from './leader-context';
import {
  PersistentTeamSupervisor,
  WorkerRuntimeObservationV1,
  reconcileWorkerObservation,
} from './supervisor-control';

export interface ProviderProfileAuthorityV1 {
  profile: HostCapabilityProfileV1;
  resolvedExecutable: string;
  tmuxReadiness?: TmuxReadinessReceiptV1;
}

export interface TeamResumeObservationInputV1 {
  aggregate: TeamAggregateV1;
  binding: WorkerAuthorityBindingV1;
  heartbeat?: SupervisorHeartbeatV1;
}

export type TeamResumeObserverV1 = (
  input: Readonly<TeamResumeObservationInputV1>,
) => WorkerRuntimeObservationV1;

export interface TeamResumeWorkerRefV1 {
  taskId: string;
  generation: number;
}

export interface TeamResumeFencedRefV1 extends TeamResumeWorkerRefV1 {
  reason: 'block_identity_unproven' | 'fence_stale_observation';
}

export interface TeamResumeView {
  teamId: string;
  revision: number;
  supervisorGeneration: number;
  adopted: readonly TeamResumeWorkerRefV1[];
  fenced: readonly TeamResumeFencedRefV1[];
  reclaimable: readonly TeamResumeWorkerRefV1[];
  leaderContextPath: string;
  leaderContextBytes: number;
  leaderContextTruncated: boolean;
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
  /**
   * 測試注入：resume 對已綁定 worker 的 runtime observation。
   * production 以 process/pane probe 組 observation，不得盲目採納。
   */
  resumeObserver?: TeamResumeObserverV1;
  /** 測試注入：resume 生產觀測的 tmux/ps adapter（fake 行程表，不打真實 ps）。 */
  resumeIdentitySpawn?: {
    readonly tmuxSpawn?: ArgvSpawnFn;
    readonly psSpawn?: ArgvSpawnFn;
    readonly probePane?: (sessionName: string) => ProcessLiveness;
  };
  /** 測試注入：supervisor lease owner token；預設使用 team ownerNonce。 */
  supervisorOwnerToken?: string;
  /** 測試注入：supervisor process 身分；預設為本行程。 */
  supervisorProcess?: ProcessMarkerV1;
  /** leader-context.json 位元組上限；預設 LEADER_CONTEXT_MAX_BYTES。 */
  leaderContextMaxBytes?: number;
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
  retired: boolean;
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

/** 與 HUD `TERMINAL_TEAM_STATUSES` / cancel `TEAM_TERMINAL_STATUSES` 同一終局集合。 */
const TEAM_WAIT_TERMINAL_STATUSES: ReadonlySet<TeamTaskStatus> = new Set([
  'completed',
  'blocked_permission',
  'failed',
  'cancelled',
  'fenced_superseded',
]);

export type TeamWaitStoppedByV1 = 'converged' | 'timeout' | 'aborted';

export interface TeamWaitOptionsV1 {
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxIterations?: number;
  signal?: AbortSignal;
  nowMs?: () => number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

export interface TeamWaitView {
  teamId: string;
  revision: number;
  stopped_by: TeamWaitStoppedByV1;
  iterations: number;
  elapsed_ms: number;
  tasks: Readonly<Record<string, TeamTaskRuntimeV1>>;
}

export function isTeamWaitTerminalStatus(status: TeamTaskStatus): boolean {
  return TEAM_WAIT_TERMINAL_STATUSES.has(status);
}

function teamTasksHaveConverged(
  tasks: Readonly<Record<string, TeamTaskRuntimeV1>>,
): boolean {
  const values = Object.values(tasks);
  return values.every((task) => TEAM_WAIT_TERMINAL_STATUSES.has(task.status));
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
  private readonly resumeObserver: TeamResumeObserverV1 | undefined;
  private readonly resumeIdentitySpawn: TeamOrchestratorOptions['resumeIdentitySpawn'];
  private readonly supervisorOwnerToken: string | undefined;
  private readonly supervisorProcess: ProcessMarkerV1 | undefined;
  private readonly leaderContextMaxBytes: number;

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
    this.resumeObserver = options.resumeObserver;
    this.resumeIdentitySpawn = options.resumeIdentitySpawn;
    this.supervisorOwnerToken = options.supervisorOwnerToken;
    this.supervisorProcess = options.supervisorProcess;
    this.leaderContextMaxBytes = options.leaderContextMaxBytes ?? LEADER_CONTEXT_MAX_BYTES;
    if (options.workerBootstrapArgv !== undefined) {
      this.workerBootstrapArgv = options.workerBootstrapArgv;
    } else if (options.workerHoldEntryPath !== undefined) {
      this.workerBootstrapArgv = [options.workerHoldEntryPath];
    } else {
      // 生產預設：worker-bootstrap → oma team worker run（hold 僅測試注入）
      const entry = path.resolve(__dirname, 'worker-bootstrap.js');
      this.workerBootstrapArgv = [entry];
    }
  }

  async startFromManifest(
    manifestPath: string,
    workerMode: 'interactive' | 'headless',
  ): Promise<Result<StartTeamView, RuntimeError>> {
    const validated = readTeamManifest(manifestPath, this.workspaceRoot);
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
      retired: aggregate.retired === true,
      tasks: aggregate.tasks,
      heartbeats: aggregate.heartbeats,
      tmux: tmuxView,
    });
  }

  /**
   * 終局 worktree / 分支 / mailbox-bodies 回收。`stop` 仍只殺 tmux，不隱含 cleanup。
   * 設計概念映射：OMC `omc team cleanup`；OMX cleanup 生命週期 verb（非 team api op）。
   */
  async cleanup(
    teamId: string,
    expectedRevision: number,
    options: Readonly<{ dryRun?: boolean }> = {},
  ): Promise<Result<TeamCleanupView, RuntimeError>> {
    const store = new TeamStateStore(this.stateRoot, this.repoKey, this.workspaceKey, teamId);
    return cleanupTeam({
      store,
      worktrees: this.worktrees,
      expectedRevision,
      dryRun: options.dryRun === true,
      nowMs: this.nowMs(),
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
      // pane 存活時必須再證明 worker 子程序（#45 後是 node + oma team worker run，
      // 不是裸 agy）。失敗為 unknown（不得把 pane shell 當 alive）。
      // session 已死則改探 recorded process，才能組成 DeadProof。
      let processLiveness = hb === undefined ? 'unknown' : probeRecordedWorkerProcess(hb.process);
      const expectedBasenames = teamWorkerLivenessBasenames(
        this.workerExecutablePath,
        hb?.providerBasename,
      );
      if (sessionName !== undefined && hb !== undefined && paneLiveness === 'alive'
        && expectedBasenames.length > 0) {
        processLiveness = providerLivenessFromResolution(
          resolveProviderChild(sessionName, { expectedBasenames }),
        ).processLiveness;
      }
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
      ? probeRecordedWorkerProcess(hb.process)
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

  /**
   * 設計概念映射：OMC `omc team wait` / OMX `omx team await` / OMG `omg job wait`
   * （逾時不取消 worker）。有界輪詢沿用 HUD `watchHud`：interval 50–60000ms、
   * 迭代上限 10000、AbortSignal 清 timer。wait 唯讀，禁止 tick/stop。
   */
  async waitForConvergence(
    teamId: string,
    options: Readonly<TeamWaitOptionsV1> = {},
  ): Promise<Result<TeamWaitView, RuntimeError>> {
    const intervalMs = options.pollIntervalMs ?? HUD_WATCH_INTERVAL_MS_DEFAULT;
    const maximum = options.maxIterations ?? HUD_WATCH_MAX_ITERATIONS;
    if (!Number.isSafeInteger(intervalMs)
      || intervalMs < HUD_WATCH_INTERVAL_MS_MIN
      || intervalMs > HUD_WATCH_INTERVAL_MS_MAX) {
      return err(runtimeError(
        'E_VALIDATOR_REJECTED',
        `poll-interval-ms must be between ${HUD_WATCH_INTERVAL_MS_MIN} and ${HUD_WATCH_INTERVAL_MS_MAX}`,
      ));
    }
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > HUD_WATCH_MAX_ITERATIONS) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'wait iteration cap is invalid'));
    }
    if (options.timeoutMs !== undefined
      && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'timeout-ms must be a positive integer'));
    }
    const store = new TeamStateStore(this.stateRoot, this.repoKey, this.workspaceKey, teamId);
    const nowMs = options.nowMs ?? (() => Date.now());
    const sleep = options.sleep ?? boundedSleep;
    const startedAt = nowMs();
    const deadlineMs = options.timeoutMs === undefined ? undefined : startedAt + options.timeoutMs;
    let iterations = 0;
    let lastRevision = 0;
    let lastTasks: Readonly<Record<string, TeamTaskRuntimeV1>> = {};
    const view = (stoppedBy: TeamWaitStoppedByV1): TeamWaitView => ({
      teamId,
      revision: lastRevision,
      stopped_by: stoppedBy,
      iterations,
      elapsed_ms: Math.max(0, nowMs() - startedAt),
      tasks: lastTasks,
    });
    const refresh = (): Result<void, RuntimeError> => {
      const snapshot = store.read();
      if (!snapshot.ok) return err(snapshot.error);
      lastRevision = snapshot.value.revision;
      lastTasks = snapshot.value.value.tasks;
      return ok(undefined);
    };

    while (iterations < maximum) {
      if (options.signal?.aborted === true) {
        if (iterations === 0) {
          const loaded = refresh();
          if (!loaded.ok) return err(loaded.error);
        }
        return ok(view('aborted'));
      }
      const loaded = refresh();
      if (!loaded.ok) return err(loaded.error);
      iterations += 1;
      if (teamTasksHaveConverged(lastTasks)) return ok(view('converged'));
      if (deadlineMs !== undefined && nowMs() >= deadlineMs) return ok(view('timeout'));
      if (iterations >= maximum) return ok(view('timeout'));
      const remainingMs = deadlineMs === undefined ? intervalMs : deadlineMs - nowMs();
      if (remainingMs <= 0) return ok(view('timeout'));
      const waitMs = remainingMs < intervalMs ? remainingMs : intervalMs;
      try {
        await sleep(waitMs, options.signal);
      } catch (error) {
        if (options.signal !== undefined && options.signal.aborted) return ok(view('aborted'));
        return err(runtimeError('E_RETRYABLE_BLOCKER', 'Team wait poll failed', {
          cause: error instanceof Error ? error.message : String(error),
        }));
      }
    }
    return ok(view('timeout'));
  }

  /**
   * 設計概念映射：OMC `omc team resume` / OMX `omx team resume`（preflight-context.json）
   * / OMG `omg team resume`。取得 generation-fenced supervisor lease 後，對每個已綁定
   * worker 執行 `reconcileWorkerObservation`：健康者採納不重啟，身分無法證明則圍籬。
   * 重複 resume 為幂等（不產生 worker、不遞增 worker/supervisor generation）。
   * 禁止 git reset / git clean。
   */
  async resume(
    teamId: string,
    expectedRevision: number,
  ): Promise<Result<TeamResumeView, RuntimeError>> {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'expected-revision must be a non-negative integer'));
    }
    const store = new TeamStateStore(this.stateRoot, this.repoKey, this.workspaceKey, teamId);
    const snapshot = store.read();
    if (!snapshot.ok) return snapshot;
    if (snapshot.value.revision !== expectedRevision) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Team state revision changed', {
        expectedRevision,
        actualRevision: snapshot.value.revision,
      }));
    }
    if (snapshot.value.value.leaderWorkspaceKey !== this.workspaceKey) {
      return err(runtimeError(
        'E_TEAM_LEADER_REQUIRED',
        'Team resume requires the recorded leader workspace',
        { leaderWorkspaceKey: snapshot.value.value.leaderWorkspaceKey },
      ));
    }

    const nowMs = this.nowMs();
    const ownerToken = this.supervisorOwnerToken ?? snapshot.value.value.ownerNonce;
    const processMarker = this.supervisorProcess ?? {
      pid: process.pid,
      startMarker: `${process.pid}:${Math.floor(nowMs - process.uptime() * 1000)}`,
    };
    const supervisor = new PersistentTeamSupervisor({
      store,
      ownerToken,
      process: processMarker,
      leaseMs: this.leaseMs,
    });
    const ownerTokenDigest = sha256(ownerToken);
    const currentSupervisor = snapshot.value.value.supervisor;
    const heldByUs = currentSupervisor !== undefined
      && currentSupervisor.ownerTokenDigest === ownerTokenDigest
      && currentSupervisor.leasedUntilMs > nowMs;
    const leased = heldByUs
      ? snapshot
      : await supervisor.acquire(expectedRevision, nowMs);
    if (!leased.ok) return leased;

    let revision = leased.value.revision;
    let aggregate = leased.value.value;
    const adopted: TeamResumeWorkerRefV1[] = [];
    const fenced: TeamResumeFencedRefV1[] = [];
    const reclaimable: TeamResumeWorkerRefV1[] = [];
    const bindings = aggregate.workerBindings ?? {};
    for (const taskId of Object.keys(bindings).sort()) {
      const binding = bindings[taskId]!;
      const observation = this.observeBoundWorker(aggregate, binding);
      const reconciliation = reconcileWorkerObservation(aggregate, observation);
      if (reconciliation.action === 'adopt' || reconciliation.action === 'terminal_reconciled') {
        adopted.push({ taskId, generation: binding.generation });
        continue;
      }
      if (reconciliation.action === 'reclaim_generation_plus_one') {
        reclaimable.push({ taskId, generation: binding.generation });
        continue;
      }
      if (reconciliation.action !== 'block_identity_unproven'
        && reconciliation.action !== 'fence_stale_observation') {
        continue;
      }
      fenced.push({
        taskId,
        generation: binding.generation,
        reason: reconciliation.action,
      });
      const status = aggregate.tasks[taskId]?.status;
      if (status !== 'in_progress' && status !== 'awaiting_interaction') continue;
      const updated = await store.setTaskStatus(taskId, revision, 'orphan_identity_unproven');
      if (!updated.ok) return updated;
      revision = updated.value.revision;
      aggregate = updated.value.value;
    }

    const contextPath = leaderContextPath(store.teamDirectory());
    const stateRootResolved = path.resolve(this.stateRoot);
    const resolvedContext = path.resolve(contextPath);
    if (resolvedContext !== stateRootResolved
      && !resolvedContext.startsWith(`${stateRootResolved}${path.sep}`)) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'leader-context.json escapes the state root'));
    }
    const context: TeamLeaderContextV1 = {
      schemaVersion: 1,
      store_kind: 'team_leader_context',
      teamId,
      revision,
      supervisorGeneration: aggregate.supervisor?.generation ?? 0,
      recordedAtMs: nowMs,
      adopted,
      fenced,
      reclaimable,
    };
    const written = writeBoundedLeaderContext(contextPath, context, this.leaderContextMaxBytes);
    if (!written.ok) return written;

    return ok({
      teamId,
      revision,
      supervisorGeneration: aggregate.supervisor?.generation ?? 0,
      adopted,
      fenced,
      reclaimable,
      leaderContextPath: contextPath,
      leaderContextBytes: written.value.bytes,
      leaderContextTruncated: written.value.truncated,
    });
  }

  setMaxParallelWorkers(value: number): void {
    this.maxParallelWorkers = Math.max(1, value);
  }

  /**
   * 對已綁定 worker 組 runtime observation。測試可注入 resumeObserver。
   * 設計概念映射：OMC/OMX resume 採納前必須核對 process/pane 身分，PID reuse 不得視為健康。
   */
  private observeBoundWorker(
    aggregate: TeamAggregateV1,
    binding: WorkerAuthorityBindingV1,
  ): WorkerRuntimeObservationV1 {
    if (this.resumeObserver !== undefined) {
      return this.resumeObserver({
        aggregate,
        binding,
        ...(aggregate.heartbeats[binding.taskId] === undefined
          ? {}
          : { heartbeat: aggregate.heartbeats[binding.taskId] }),
      });
    }
    return observeBoundWorkerForResume(
      aggregate,
      binding,
      this.tmux,
      this.sessionNamePrefix,
      this.workerExecutablePath,
      this.resumeIdentitySpawn,
    );
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

    // 記錄實際 pane worker（execPath / oma CLI）與可選路由 agy 的聯集身分。
    // 設計概念映射：#45 後主體是 `oma team worker run`，不是裸 agy（Codex PR94 P1）。
    const expectedBasenames = teamWorkerLivenessBasenames(
      this.workerExecutablePath,
      routeReceipt.resolvedExecutable,
    );
    const resolvedChild = resolveProviderChild(sessionName, { expectedBasenames });
    const processIdentity = providerChildProcessMarker(resolvedChild)
      ?? paneProcessFallback(sessionName);
    const heartbeat: SupervisorHeartbeatV1 = {
      schemaVersion: 1,
      workerId,
      ownerNonce: input.ownerNonce,
      workerNonce,
      process: processIdentity,
      paneId: pane.value.paneId,
      sessionName,
      providerBasename: expectedBasenames[0],
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

/**
 * production resume observation：tmux 必須證明 worker **子程序**（#59），
 * 不得把 pane bootstrap comm 當 worker。觀測到的 process marker 必須寫回
 * observation，否則 identityMatches 對 binding 自身永遠成立（Codex PR95 P1）。
 */
export function observeBoundWorkerForResume(
  aggregate: TeamAggregateV1,
  binding: WorkerAuthorityBindingV1,
  tmux: TmuxController,
  sessionNamePrefix: string | undefined,
  workerExecutablePath: string,
  spawn?: Readonly<{
    tmuxSpawn?: ArgvSpawnFn;
    psSpawn?: ArgvSpawnFn;
    probePane?: (sessionName: string) => ProcessLiveness;
  }>,
): WorkerRuntimeObservationV1 {
  const heartbeat = aggregate.heartbeats[binding.taskId];
  let observedProcess: ProcessMarkerV1 | undefined = binding.process ?? heartbeat?.process;
  let processLiveness = observedProcess === undefined
    ? 'unknown' as const
    : probeRecordedWorkerProcess(observedProcess);

  const paneProbe = spawn?.probePane ?? probeTmuxSession;
  let paneLiveness = 'unknown' as ReturnType<typeof probeTmuxSession>;
  let observedPane = binding.pane;
  let providerIdentityMatched: boolean | undefined;
  if (binding.pane !== undefined) {
    paneLiveness = paneProbe(binding.pane.sessionName);
    if (paneLiveness === 'alive') {
      const inspected = tmux.inspectOwnedPane(binding.pane.sessionName);
      if (!inspected.ok) {
        paneLiveness = 'unknown';
      } else {
        const livePane: WorkerPaneReceiptV1 = {
          schemaVersion: 1,
          sessionName: inspected.value.sessionName,
          paneId: inspected.value.paneId,
          ownerNonce: inspected.value.ownerNonce,
          workerNonce: inspected.value.workerNonce,
        };
        if (canonicalJson(livePane) !== canonicalJson(binding.pane)) {
          observedPane = livePane;
        }
      }
      const expectedBasenames = teamWorkerLivenessBasenames(
        workerExecutablePath,
        heartbeat?.providerBasename,
      );
      if (expectedBasenames.length > 0) {
        const observed = observeTmuxWorkerIdentity(
          binding.pane.sessionName,
          expectedBasenames,
          spawn,
        );
        providerIdentityMatched = observed.providerIdentityMatched;
        processLiveness = observed.processLiveness;
        if (observed.process !== undefined) observedProcess = observed.process;
        else observedProcess = undefined;
      }
    }
  } else if (heartbeat !== undefined) {
    paneLiveness = paneProbe(
      inferSessionName(sessionNamePrefix, aggregate.teamId, binding.taskId, heartbeat),
    );
  }

  const observation: WorkerRuntimeObservationV1 = {
    taskId: binding.taskId,
    generation: binding.generation,
    providerReceiptHash: binding.providerReceiptHash,
    processLiveness,
    paneLiveness,
    ...(observedProcess === undefined ? {} : { process: observedProcess }),
    ...(observedPane === undefined ? {} : { pane: observedPane }),
    ...(providerIdentityMatched === undefined ? {} : { providerIdentityMatched }),
  };
  if (binding.provider === 'antigravity_native') {
    return { ...observation, nativeConversationHealthy: false };
  }
  return observation;
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
  if (heartbeat.sessionName !== undefined && /^[A-Za-z0-9_.-]+$/.test(heartbeat.sessionName)) {
    return heartbeat.sessionName;
  }
  if (heartbeat.process.startMarker.startsWith('tmux:')) {
    return heartbeat.process.startMarker.slice('tmux:'.length);
  }
  const base = prefix ?? `oma-${teamId}`;
  return sanitizeSession(`${base}-${workerId}-g1`);
}

function paneProcessFallback(sessionName: string): { pid: number; startMarker: string } {
  const panePid = readPanePid(sessionName);
  if (panePid === null) {
    return { pid: 0, startMarker: '' };
  }
  const start = spawnSync('ps', ['-o', 'lstart=', '-p', String(panePid)], {
    encoding: 'utf8',
    shell: false,
  });
  const startMarker = start.status === 0 ? start.stdout.trim() : '';
  return { pid: panePid, startMarker };
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
    { encoding: 'utf8', shell: false },
  );
  if (result.status !== 0) return null;
  const line = result.stdout.trim().split('\n')[0];
  const pid = Number(line);
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}
