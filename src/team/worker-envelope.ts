import * as fs from 'fs';
import * as path from 'path';
import {
  WorkerArtifactContractV1,
  WorkerDependencyResultV1,
  WorkerEnvelopeV1,
  validateWorkerEnvelope,
} from '../contracts/worker-envelope';
import { sha256 } from '../runtime/atomic';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import { CanonicalTeamTaskV1 } from './types';
import { ProviderSelectionV1 } from './provider';

export interface ContributorGuidanceHashV1 {
  path: string;
  sha256: string;
}

export interface BuildWorkerEnvelopeInputV1 {
  repositoryRoot: string;
  runId: string;
  teamId: string;
  task: CanonicalTeamTaskV1;
  taskText: string;
  dependencyResults: readonly WorkerDependencyResultV1[];
  artifactContract: WorkerArtifactContractV1;
  contributorGuidancePaths: readonly string[];
  mailboxCursor: number;
  claimId: string;
  generation: number;
  stateEndpoint: string;
  cancellationTokenHash: string;
  selection: ProviderSelectionV1;
  nativeRole: string;
  deadlineMs: number;
}

export function buildWorkerEnvelope(
  input: Readonly<BuildWorkerEnvelopeInputV1>,
): Result<WorkerEnvelopeV1, RuntimeError> {
  let repositoryRoot: string;
  try { repositoryRoot = fs.realpathSync(input.repositoryRoot); } catch (_) {
    return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'Worker envelope repository root is unavailable'));
  }
  if (input.selection.generation !== input.generation) {
    return err(runtimeError('E_REVISION_CONFLICT', 'Provider selection generation is stale'));
  }
  const expectedDependencies = [...input.task.dependencies];
  if (input.dependencyResults.length !== expectedDependencies.length
    || input.dependencyResults.some((item, index) => item.task_id !== expectedDependencies[index])) {
    return err(runtimeError('E_TASK_DEPENDENCY_BLOCKED', 'Worker envelope requires exact ordered dependency results'));
  }
  const guidance = hashContributorGuidance(repositoryRoot, input.contributorGuidancePaths);
  if (!guidance.ok) return guidance;
  const writeScope = input.task.write_scope === 'none'
    ? []
    : input.task.write_scope.map((entry) => entry.path);
  const capabilityMode = input.task.write_scope === 'none' ? 'read-only' : 'read-write';
  const verificationArgv = input.task.verification.commands.map((command) => [
    command.command,
    ...command.argv,
  ]);
  const envelope: WorkerEnvelopeV1 = {
    store_kind: 'oma_worker_envelope',
    schema_version: 1,
    repository_id: 'OMA',
    run_id: input.runId,
    team_id: input.teamId,
    task_id: input.task.id,
    task_text: input.taskText,
    dependencies: input.dependencyResults.map((item) => ({
      task_id: item.task_id,
      result_hash: item.result_hash,
      artifact_roots: [...item.artifact_roots],
    })),
    write_scope: writeScope,
    verification_argv: verificationArgv,
    artifact_contract: {
      proposal_root: input.artifactContract.proposal_root,
      required_files: [...input.artifactContract.required_files],
      terminal_receipt_path: input.artifactContract.terminal_receipt_path,
    },
    contributor_guidance_hashes: guidance.value,
    mailbox_cursor: input.mailboxCursor,
    claim_id: input.claimId,
    generation: input.generation,
    state_endpoint: input.stateEndpoint,
    cancellation_token_hash: input.cancellationTokenHash,
    provider: input.selection.provider,
    native_role: input.nativeRole,
    capability_mode: capabilityMode,
    deadline_ms: input.deadlineMs,
  };
  try {
    return ok(validateWorkerEnvelope(envelope));
  } catch (error) {
    return err(runtimeError('E_CORRUPT_STATE', 'Worker envelope failed the frozen v1 contract', {
      cause: error instanceof Error ? error.message : String(error),
    }));
  }
}

export function hashContributorGuidance(
  repositoryRoot: string,
  relativePaths: readonly string[],
): Result<ContributorGuidanceHashV1[], RuntimeError> {
  const unique = new Set<string>();
  const output: ContributorGuidanceHashV1[] = [];
  for (const relative of relativePaths) {
    if (relative === '' || path.isAbsolute(relative) || relative.includes('\0') || relative.includes('\\')) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'Contributor guidance path is invalid'));
    }
    const normalized = path.posix.normalize(relative);
    if (normalized === '..' || normalized.startsWith('../')
      || path.posix.basename(normalized).toLowerCase() !== 'agents.md' || unique.has(normalized)) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'Contributor guidance must be unique confined AGENTS.md files'));
    }
    const absolute = path.resolve(repositoryRoot, ...normalized.split('/'));
    if (!contained(repositoryRoot, absolute)) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'Contributor guidance escapes repository'));
    }
    let resolved: string;
    try { resolved = fs.realpathSync(absolute); } catch (_) {
      return err(runtimeError('E_NOT_FOUND', 'Contributor guidance file does not exist', { path: normalized }));
    }
    if (!contained(repositoryRoot, resolved) || !fs.statSync(resolved).isFile()) {
      return err(runtimeError('E_PATH_OUTSIDE_ROOT', 'Contributor guidance resolves outside repository'));
    }
    unique.add(normalized);
    output.push({ path: normalized, sha256: sha256(fs.readFileSync(resolved)) });
  }
  return ok(output);
}

function contained(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}
