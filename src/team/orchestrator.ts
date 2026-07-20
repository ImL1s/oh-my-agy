/**
 * 設計概念映射：TeamOrchestrator 對齊 OMC/OMX Team 編排垂直切片（start → claim → worktree → tmux → heartbeat）。
 * v1 僅啟動第一個無依賴 ready task；不實作 delivery / integration / publish / supervisor poll。
 */
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import { validateTeamManifest } from './manifest';
import { TeamStateStore } from './state';
import { TmuxController } from './tmux';
import {
  CanonicalTeamManifestV1,
  SupervisorHeartbeatV1,
  TeamAggregateV1,
  TeamTaskRuntimeV1,
} from './types';
import { GitWorktreeManager } from './worktree';

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
  tmux?: TmuxController;
  worktrees?: GitWorktreeManager;
  /** Default: process.execPath */
  workerExecutablePath?: string;
  /**
   * Bootstrap argv inserted between executable and marker/descriptor.
   * Default: compiled worker-hold.js next to this module.
   * Tests inject e.g. [holdJsPath].
   */
  workerBootstrapArgv?: readonly string[];
  /** Absolute path to worker-hold entry (js). Used if workerBootstrapArgv omitted. */
  workerHoldEntryPath?: string;
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
  private readonly tmux: TmuxController;
  private readonly worktrees: GitWorktreeManager;
  private readonly workerExecutablePath: string;
  private readonly workerBootstrapArgv: readonly string[];

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
    this.tmux = options.tmux ?? new TmuxController();
    this.worktrees = options.worktrees
      ?? new GitWorktreeManager(this.workspaceRoot, options.managedWorktreesRoot);
    this.workerExecutablePath = options.workerExecutablePath ?? process.execPath;
    if (options.workerBootstrapArgv !== undefined) {
      this.workerBootstrapArgv = options.workerBootstrapArgv;
    } else if (options.workerHoldEntryPath !== undefined) {
      this.workerBootstrapArgv = [options.workerHoldEntryPath];
    } else {
      // 生產預設：與本模組同目錄的編譯產物
      const entry = path.resolve(__dirname, 'worker-hold.js');
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

    // v1：只挑第一個 dependencies 為空的 ready task
    const ready = pickFirstReadyTask(validated.value);
    if (ready === null) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'No ready task with empty dependencies'));
    }

    const baseSha = gitHead(this.workspaceRoot);
    if (!baseSha.ok) return baseSha;

    const workerId = ready.id;
    const generation = 1;
    const branchName = `oma-team/${validated.value.teamId}/${workerId}-g${generation}`;
    const worktree = this.worktrees.create({
      teamId: validated.value.teamId,
      workerId,
      generation,
      branchName,
      baseSha: baseSha.value,
      ownerNonce,
    });
    if (!worktree.ok) return worktree;

    const claimToken = this.tokenFactory();
    const claimed = await store.claimTask(
      ready.id,
      workerId,
      created.value.revision,
      this.nowMs(),
      this.leaseMs,
      claimToken,
    );
    if (!claimed.ok) {
      this.worktrees.removeIfSafe(worktree.value, { ownerNonce, integrated: true });
      return claimed;
    }

    const sessionBase = this.sessionNamePrefix ?? `oma-${validated.value.teamId}`;
    const sessionName = sanitizeSession(`${sessionBase}-${workerId}-g${generation}`);
    const markerPath = path.join(worktree.value.path, '.oma-worker-ready');
    const descriptorPath = path.join(worktree.value.path, '.oma-worker-descriptor.json');
    // descriptor 只存 claimToken digest，不落明文
    const descriptor = {
      schemaVersion: 1 as const,
      teamId: validated.value.teamId,
      taskId: ready.id,
      workerId,
      generation,
      workerMode,
      claimTokenDigest: sha256(claimToken),
      worktreePath: worktree.value.path,
      stateRoot: this.stateRoot,
    };
    fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');

    const workerNonce = this.tokenFactory();
    // shellCommand = [executable, ...bootstrapArgv, descriptor] → hold 收到 marker 再 descriptor
    const pane = this.tmux.startWorker({
      sessionName,
      cwd: worktree.value.path,
      executablePath: this.workerExecutablePath,
      descriptorPath,
      bootstrapArgv: [...this.workerBootstrapArgv, markerPath],
      ownerNonce,
      workerNonce,
    });
    if (!pane.ok) {
      // descriptor 落在 worktree 內會讓 status 變 dirty；先移除再 best-effort cleanup
      try { fs.rmSync(descriptorPath, { force: true }); } catch (_) { /* best-effort */ }
      this.worktrees.removeIfSafe(worktree.value, { ownerNonce, integrated: true });
      return pane;
    }

    // startMarker 編碼 sessionName，供 status/stop 回復
    const heartbeat: SupervisorHeartbeatV1 = {
      schemaVersion: 1,
      workerId,
      ownerNonce,
      workerNonce,
      process: { pid: process.pid, startMarker: `tmux:${sessionName}` },
      paneId: pane.value.paneId,
      recordedAtMs: this.nowMs(),
    };
    const hb = await store.recordHeartbeat(claimed.value.revision, heartbeat);
    if (!hb.ok) {
      this.tmux.killOwnedSession(sessionName, ownerNonce);
      return hb;
    }

    return ok({
      teamId: validated.value.teamId,
      ownerNonce,
      aggregateRevision: hb.value.revision,
      workers: [{
        taskId: ready.id,
        generation,
        sessionName,
        paneId: pane.value.paneId,
        worktreePath: worktree.value.path,
        branchName,
        claimToken,
        markerPath,
      }],
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
}

function pickFirstReadyTask(manifest: CanonicalTeamManifestV1) {
  return manifest.tasks.find((task) => task.dependencies.length === 0) ?? null;
}

/** tmux validSessionName: /^[A-Za-z0-9_.-]+$/ */
function sanitizeSession(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 80);
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
