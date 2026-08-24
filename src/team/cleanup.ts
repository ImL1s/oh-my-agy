/**
 * 設計概念映射：OMC `omc team cleanup`、OMX `cleanup`（非 orphan-cleanup）、
 * OMG `omg job gc` + worktree 回收。OMA 以終局 task 為單位呼叫既有
 * `GitWorktreeManager.cleanupTerminal` / `removeIfSafe`，清理 mailbox-bodies，
 * 並把 aggregate 標為 retired。不擴充 `oma team api` op（歸 #6）。
 *
 * 刪除前先盤點、再 CAS 退役，最後才動 git／檔案，避免 `--expected-revision`
 * 衝突時已留下半刪除狀態。禁止破壞性 git restore／clean 參數。
 */
import * as fs from 'fs';
import * as path from 'path';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import { TeamStateStore } from './state';
import { TeamTaskStatus } from './types';
import { GitWorktreeManager, ManagedWorktreeV1 } from './worktree';

/** 與 HUD / cancel / wait 同一終局集合。 */
const TEAM_CLEANUP_TERMINAL_STATUSES: ReadonlySet<TeamTaskStatus> = new Set([
  'completed',
  'blocked_permission',
  'failed',
  'cancelled',
  'fenced_superseded',
]);

export function isTeamCleanupTerminalStatus(status: TeamTaskStatus): boolean {
  return TEAM_CLEANUP_TERMINAL_STATUSES.has(status);
}

export interface TeamCleanupResourceV1 {
  kind: 'worktree' | 'branch' | 'mailbox-body';
  taskId?: string;
  path?: string;
  branchName?: string;
}

export interface TeamCleanupPreservedV1 {
  kind: 'worktree' | 'branch';
  taskId: string;
  path?: string;
  branchName?: string;
  code: string;
  reason: string;
}

export interface TeamCleanupSkippedV1 {
  taskId: string;
  status: TeamTaskStatus;
  reason: 'non-terminal';
}

export interface TeamCleanupView {
  teamId: string;
  revision: number;
  dryRun: boolean;
  retired: boolean;
  planned: TeamCleanupResourceV1[];
  removed: TeamCleanupResourceV1[];
  preserved: TeamCleanupPreservedV1[];
  skipped: TeamCleanupSkippedV1[];
}

export interface TeamCleanupInput {
  store: TeamStateStore;
  worktrees: GitWorktreeManager;
  expectedRevision: number;
  dryRun: boolean;
  nowMs: number;
}

interface OwnedCleanupCandidate {
  descriptor: ManagedWorktreeV1;
  worktreeResource: TeamCleanupResourceV1;
  branchResource: TeamCleanupResourceV1;
  outcome: 'integrated' | 'cancelled';
  missing: boolean;
}

/**
 * 終局清理：只動終局 task 的 managed worktree / 分支 / mailbox body。
 * `--dry-run` 只預覽。未整合 commit 一律保留。禁止破壞性 git 還原或強制清潔。
 */
export async function cleanupTeam(
  input: Readonly<TeamCleanupInput>,
): Promise<Result<TeamCleanupView, RuntimeError>> {
  const snapshot = input.store.read();
  if (!snapshot.ok) return snapshot;
  if (snapshot.value.revision !== input.expectedRevision) {
    return err(runtimeError('E_REVISION_CONFLICT', 'Team state revision changed', {
      expectedRevision: input.expectedRevision,
      actualRevision: snapshot.value.revision,
    }));
  }

  const aggregate = snapshot.value.value;
  const ownerNonce = aggregate.ownerNonce;
  const teamId = aggregate.teamId;
  const allTerminal = Object.values(aggregate.tasks)
    .every((task) => isTeamCleanupTerminalStatus(task.status));
  const skipped: TeamCleanupSkippedV1[] = Object.values(aggregate.tasks)
    .filter((task) => !isTeamCleanupTerminalStatus(task.status))
    .map((task) => ({ taskId: task.id, status: task.status, reason: 'non-terminal' as const }));

  const planned: TeamCleanupResourceV1[] = [];
  const preserved: TeamCleanupPreservedV1[] = [];
  const candidates: OwnedCleanupCandidate[] = [];

  for (const descriptor of input.worktrees.listOwned(teamId)) {
    const task = aggregate.tasks[descriptor.workerId];
    if (task === undefined) continue;
    if (!isTeamCleanupTerminalStatus(task.status)) continue;
    if (descriptor.ownerNonce !== ownerNonce) {
      return err(runtimeError('E_LOCK_NOT_OWNER', 'Managed worktree cleanup owner does not match', {
        taskId: descriptor.workerId,
      }));
    }

    const outcome: 'integrated' | 'cancelled' = task.status === 'completed' ? 'integrated' : 'cancelled';
    const worktreeResource: TeamCleanupResourceV1 = {
      kind: 'worktree',
      taskId: descriptor.workerId,
      path: descriptor.path,
      branchName: descriptor.branchName,
    };
    const branchResource: TeamCleanupResourceV1 = {
      kind: 'branch',
      taskId: descriptor.workerId,
      branchName: descriptor.branchName,
    };

    if (!fs.existsSync(descriptor.path)) {
      planned.push(worktreeResource, branchResource);
      candidates.push({
        descriptor, worktreeResource, branchResource, outcome, missing: true,
      });
      continue;
    }

    const assessed = input.worktrees.assessOwnedRemoval(descriptor, {
      ownerNonce,
      integrated: outcome === 'integrated',
    });
    if (!assessed.ok) {
      if (assessed.error.code === 'E_LOCK_NOT_OWNER') return assessed;
      preserved.push(preservedFrom(descriptor, assessed.error.code, assessed.error.message));
      continue;
    }
    planned.push(worktreeResource, branchResource);
    candidates.push({
      descriptor, worktreeResource, branchResource, outcome, missing: false,
    });
  }

  const mailboxPlan = listMailboxBodies(input.store);
  if (!mailboxPlan.ok) return mailboxPlan;
  const mailboxResources: TeamCleanupResourceV1[] = [];
  if (allTerminal) {
    for (const bodyPath of mailboxPlan.value) {
      const resource: TeamCleanupResourceV1 = { kind: 'mailbox-body', path: bodyPath };
      planned.push(resource);
      mailboxResources.push(resource);
    }
  }

  if (input.dryRun) {
    return ok({
      teamId,
      revision: snapshot.value.revision,
      dryRun: true,
      retired: aggregate.retired === true,
      planned,
      removed: [],
      preserved,
      skipped,
    });
  }

  let revision = snapshot.value.revision;
  let retired = aggregate.retired === true;
  if (allTerminal) {
    const retiredSnapshot = await input.store.retireAfterCleanup({
      expectedRevision: input.expectedRevision,
      ownerNonce,
      dropMailboxIds: Object.keys(aggregate.mailbox),
      nowMs: input.nowMs,
    });
    if (!retiredSnapshot.ok) return retiredSnapshot;
    revision = retiredSnapshot.value.revision;
    retired = retiredSnapshot.value.value.retired === true;
  }

  const removed: TeamCleanupResourceV1[] = [];
  for (const candidate of candidates) {
    if (candidate.missing) {
      fs.rmSync(candidate.descriptor.markerPath, { force: true });
      fs.rmSync(`${candidate.descriptor.markerPath}.seal.json`, { force: true });
      removed.push(candidate.worktreeResource);
      const deleted = input.worktrees.deleteManagedBranch(candidate.descriptor.branchName);
      if (deleted.ok) removed.push(candidate.branchResource);
      else {
        preserved.push({
          kind: 'branch',
          taskId: candidate.descriptor.workerId,
          branchName: candidate.descriptor.branchName,
          code: deleted.error.code,
          reason: deleted.error.message,
        });
      }
      continue;
    }

    const cleaned = input.worktrees.cleanupTerminal(candidate.descriptor, {
      ownerNonce,
      outcome: candidate.outcome,
    });
    if (!cleaned.ok) {
      if (cleaned.error.code === 'E_LOCK_NOT_OWNER') return cleaned;
      preserved.push(preservedFrom(
        candidate.descriptor,
        cleaned.error.code,
        cleaned.error.message,
      ));
      continue;
    }
    removed.push(candidate.worktreeResource);
    const deleted = input.worktrees.deleteManagedBranch(candidate.descriptor.branchName);
    if (deleted.ok) removed.push(candidate.branchResource);
    else {
      preserved.push({
        kind: 'branch',
        taskId: candidate.descriptor.workerId,
        branchName: candidate.descriptor.branchName,
        code: deleted.error.code,
        reason: deleted.error.message,
      });
    }
  }

  for (const resource of mailboxResources) {
    if (resource.path === undefined) continue;
    fs.rmSync(resource.path, { force: true });
    removed.push(resource);
  }

  return ok({
    teamId,
    revision,
    dryRun: false,
    retired,
    planned,
    removed,
    preserved,
    skipped,
  });
}

function preservedFrom(
  descriptor: Readonly<ManagedWorktreeV1>,
  code: string,
  reason: string,
): TeamCleanupPreservedV1 {
  return {
    kind: 'worktree',
    taskId: descriptor.workerId,
    path: descriptor.path,
    branchName: descriptor.branchName,
    code,
    reason,
  };
}

function listMailboxBodies(store: TeamStateStore): Result<string[], RuntimeError> {
  const teamDir = path.resolve(store.teamDirectory());
  const bodiesRoot = path.resolve(teamDir, 'mailbox-bodies');
  if (!isContained(teamDir, bodiesRoot)) {
    return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'Mailbox bodies path escapes team directory'));
  }
  if (!fs.existsSync(bodiesRoot)) return ok([]);
  let rootStat: fs.Stats;
  try {
    rootStat = fs.lstatSync(bodiesRoot);
  } catch (error) {
    return err(runtimeError('E_CORRUPT_STATE', 'Unable to stat mailbox-bodies', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
  // 不跟隨 symlink，避免誤刪 team 目錄外的目標（node_modules 亦可能為 symlink）。
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return ok([]);
  let names: string[];
  try {
    names = fs.readdirSync(bodiesRoot);
  } catch (error) {
    return err(runtimeError('E_CORRUPT_STATE', 'Unable to list mailbox-bodies', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
  const files: string[] = [];
  for (const name of names) {
    const target = path.resolve(bodiesRoot, name);
    if (!isContained(bodiesRoot, target)) continue;
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink() || !stat.isFile()) continue;
    } catch (_) {
      continue;
    }
    files.push(target);
  }
  return ok(files);
}

function isContained(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${path.sep}`);
}
