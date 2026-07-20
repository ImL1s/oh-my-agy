import { spawnSync } from 'child_process';
import * as fs from 'fs';
import { canonicalJson, sha256 } from '../runtime/atomic';
import { runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import { scopeContainsPath } from './manifest';
import { CanonicalTeamTaskV1, DeliveryEvidenceV1 } from './types';

export interface CreateDeliveryEvidenceInput {
  taskId: string;
  taskRevision: number;
  manifestRevision: number;
  claimToken: string;
  generation: number;
  baseSha: string;
  orderedCommits: readonly string[];
  headSha: string;
  commandEvidenceIds: readonly string[];
  workerWorkspaceKey: string;
  workerWorktreeRealpath: string;
}

export interface DeliveryDiffEntryV1 {
  status: string;
  sourcePath: string;
  destinationPath?: string;
}

export interface ValidatedDeliveryV1 {
  schemaVersion: 1;
  evidence: DeliveryEvidenceV1;
  diff: readonly DeliveryDiffEntryV1[];
  deliveryDigest: string;
}

export interface DeliveryValidationContext {
  task: CanonicalTeamTaskV1;
  currentTaskRevision: number;
  manifestRevision: number;
  claimToken: string;
  generation: number;
  completedDependencies: ReadonlySet<string>;
  commandEvidenceIds: ReadonlySet<string>;
}

export function createDeliveryEvidence(
  input: Readonly<CreateDeliveryEvidenceInput>,
): Result<DeliveryEvidenceV1> {
  let worktree: string;
  try { worktree = fs.realpathSync(input.workerWorktreeRealpath); } catch (_) {
    return err(runtimeError('E_LEADER_WORKTREE_CHANGED', 'Worker worktree cannot be resolved'));
  }
  const status = git(worktree, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!status.ok) return status;
  const diff = inspectDeliveryDiff(worktree, input.baseSha, input.headSha);
  if (!diff.ok) return diff;
  return ok({
    schemaVersion: 1,
    taskId: input.taskId,
    taskRevision: input.taskRevision,
    manifestRevision: input.manifestRevision,
    claimToken: input.claimToken,
    generation: input.generation,
    baseSha: input.baseSha,
    orderedCommits: [...input.orderedCommits],
    headSha: input.headSha,
    cleanStatusDigest: sha256(status.value.stdout),
    commandEvidenceIds: [...input.commandEvidenceIds],
    workerWorkspaceKey: input.workerWorkspaceKey,
    workerWorktreeRealpath: worktree,
    scopeDiffDigest: sha256(canonicalJson(diff.value)),
  });
}

export class DeliveryValidator {
  validate(
    evidence: Readonly<DeliveryEvidenceV1>,
    context: Readonly<DeliveryValidationContext>,
  ): Result<ValidatedDeliveryV1> {
    if (
      evidence.schemaVersion !== 1
      || evidence.taskId !== context.task.id
      || evidence.taskRevision !== context.currentTaskRevision
      || evidence.manifestRevision !== context.manifestRevision
      || evidence.claimToken !== context.claimToken
      || evidence.generation !== context.generation
      || evidence.orderedCommits.length === 0
      || evidence.orderedCommits[evidence.orderedCommits.length - 1] !== evidence.headSha
    ) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Delivery identity, revision, token, or generation is stale'));
    }
    for (const dependency of context.task.dependencies) {
      if (!context.completedDependencies.has(dependency)) {
        return err(runtimeError('E_TASK_DEPENDENCY_BLOCKED', 'Delivery dependency is not completed', { dependency }));
      }
    }
    for (const evidenceId of evidence.commandEvidenceIds) {
      if (!context.commandEvidenceIds.has(evidenceId)) {
        return err(runtimeError('E_REVISION_CONFLICT', 'Delivery references unknown command evidence', { evidenceId }));
      }
    }
    if (context.task.verification.commands.length > evidence.commandEvidenceIds.length) {
      return err(runtimeError('E_DELIVERY_UNINTEGRATED', 'Delivery is missing required verification command evidence'));
    }
    let worktree: string;
    try { worktree = fs.realpathSync(evidence.workerWorktreeRealpath); } catch (_) {
      return err(runtimeError('E_LEADER_WORKTREE_CHANGED', 'Worker worktree cannot be resolved'));
    }
    if (worktree !== evidence.workerWorktreeRealpath) {
      return err(runtimeError('E_LEADER_WORKTREE_CHANGED', 'Worker worktree identity is not canonical'));
    }
    const head = git(worktree, ['rev-parse', 'HEAD']);
    if (!head.ok) return head;
    if (head.value.stdout.trim() !== evidence.headSha) {
      return err(runtimeError('E_LEADER_HEAD_CHANGED', 'Worker HEAD does not match delivery head'));
    }
    const linear = validateLinearHistory(worktree, evidence.baseSha, evidence.orderedCommits, evidence.headSha);
    if (!linear.ok) return linear;
    const status = git(worktree, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (!status.ok) return status;
    if (status.value.stdout !== '' || sha256(status.value.stdout) !== evidence.cleanStatusDigest) {
      return err(runtimeError('E_DELIVERY_UNINTEGRATED', 'Worker worktree clean proof does not match'));
    }
    const diff = inspectDeliveryDiff(worktree, evidence.baseSha, evidence.headSha);
    if (!diff.ok) return diff;
    if (sha256(canonicalJson(diff.value)) !== evidence.scopeDiffDigest) {
      return err(runtimeError('E_DELIVERY_SCOPE_VIOLATION', 'Delivery scope diff digest does not match Git tree diff'));
    }
    for (const entry of diff.value) {
      if (
        !scopeContainsPath(context.task.write_scope, entry.sourcePath)
        || (entry.destinationPath !== undefined && !scopeContainsPath(context.task.write_scope, entry.destinationPath))
      ) {
        return err(runtimeError('E_DELIVERY_SCOPE_VIOLATION', 'Delivery modifies a path outside canonical task scope', {
          sourcePath: entry.sourcePath,
          destinationPath: entry.destinationPath,
        }));
      }
    }
    const value: ValidatedDeliveryV1 = {
      schemaVersion: 1,
      evidence: { ...evidence, orderedCommits: [...evidence.orderedCommits], commandEvidenceIds: [...evidence.commandEvidenceIds] },
      diff: diff.value,
      deliveryDigest: sha256(canonicalJson(evidence)),
    };
    return ok(value);
  }
}

export function inspectDeliveryDiff(
  worktree: string,
  baseSha: string,
  headSha: string,
): Result<DeliveryDiffEntryV1[]> {
  const result = git(worktree, ['diff-tree', '--no-commit-id', '-r', '--name-status', '-M', '-C', '-z', baseSha, headSha]);
  if (!result.ok) return result;
  const tokens = result.value.stdout.split('\0');
  if (tokens[tokens.length - 1] === '') tokens.pop();
  const entries: DeliveryDiffEntryV1[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = tokens[index++];
    const sourcePath = tokens[index++];
    if (status === undefined || sourcePath === undefined || status === '') {
      return err(runtimeError('E_CORRUPT_STATE', 'Git tree diff output is malformed'));
    }
    if (status.startsWith('R') || status.startsWith('C')) {
      const destinationPath = tokens[index++];
      if (destinationPath === undefined) return err(runtimeError('E_CORRUPT_STATE', 'Git rename/copy diff is incomplete'));
      entries.push({ status, sourcePath, destinationPath });
    } else {
      entries.push({ status, sourcePath });
    }
  }
  return ok(entries);
}

function validateLinearHistory(
  worktree: string,
  baseSha: string,
  orderedCommits: readonly string[],
  headSha: string,
): Result<void> {
  const listed = git(worktree, ['rev-list', '--reverse', '--first-parent', `${baseSha}..${headSha}`]);
  if (!listed.ok) return listed;
  const actual = listed.value.stdout.trim() === '' ? [] : listed.value.stdout.trim().split('\n');
  if (canonicalJson(actual) !== canonicalJson(orderedCommits)) {
    return err(runtimeError('E_DELIVERY_NONLINEAR', 'Ordered delivery commits do not equal the first-parent range'));
  }
  let expectedParent = baseSha;
  for (const commit of orderedCommits) {
    const parents = git(worktree, ['rev-list', '--parents', '-n', '1', commit]);
    if (!parents.ok) return parents;
    const tokens = parents.value.stdout.trim().split(/\s+/);
    if (tokens.length !== 2 || tokens[0] !== commit || tokens[1] !== expectedParent) {
      return err(runtimeError('E_DELIVERY_NONLINEAR', 'Delivery contains a merge or non-linear parent chain', {
        commit,
        expectedParent,
      }));
    }
    expectedParent = commit;
  }
  return ok(undefined);
}

interface GitOutput {
  stdout: string;
  stderr: string;
}

function git(cwd: string, argv: readonly string[]): Result<GitOutput> {
  const result = spawnSync('git', [...argv], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    return err(runtimeError('E_DELIVERY_NONLINEAR', 'Git delivery inspection failed', {
      argv,
      exitCode: result.status,
      stderr: result.stderr,
    }));
  }
  return ok({ stdout: result.stdout, stderr: result.stderr });
}

