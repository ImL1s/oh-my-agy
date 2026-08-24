import * as path from 'path';
import {
  ContractViolation,
  assertExactObjectKeys,
  assertNonEmptyString,
  assertSafeArgvVector,
  assertSafeRepositoryWritePath,
  assertSha256,
  assertStringArray,
} from './state-schemas';
import { inspectOmaRolePosture, type OmaRoleV1 } from '../team/roles';

export type WorkerProvider = 'antigravity_native' | 'agy_headless' | 'tmux_agy';

export interface WorkerDependencyResultV1 {
  task_id: string;
  result_hash: string;
  artifact_roots: string[];
}

export interface WorkerArtifactContractV1 {
  proposal_root: string;
  required_files: string[];
  terminal_receipt_path: string;
}

export interface WorkerEnvelopeV1 {
  store_kind: 'oma_worker_envelope';
  schema_version: 1;
  repository_id: string;
  run_id: string;
  team_id: string;
  task_id: string;
  task_text: string;
  dependencies: WorkerDependencyResultV1[];
  write_scope: string[];
  verification_argv: string[][];
  artifact_contract: WorkerArtifactContractV1;
  contributor_guidance_hashes: Array<{ path: string; sha256: string }>;
  mailbox_cursor: number;
  claim_id: string;
  generation: number;
  state_endpoint: string;
  cancellation_token_hash: string;
  provider: WorkerProvider;
  /** Profile-backed route authority. Required for newly constructed Team envelopes. */
  provider_profile_digest?: string;
  /** Selector-issued HostRouteReceiptV1 digest. Required for newly constructed Team envelopes. */
  route_receipt_digest?: string;
  native_role: OmaRoleV1;
  capability_mode: 'read-only' | 'read-write';
  deadline_ms: number;
}

const WORKER_ENVELOPE_KEYS = [
  'store_kind', 'schema_version', 'repository_id', 'run_id', 'team_id', 'task_id',
  'task_text', 'dependencies', 'write_scope', 'verification_argv', 'artifact_contract',
  'contributor_guidance_hashes', 'mailbox_cursor', 'claim_id', 'generation', 'state_endpoint',
  'cancellation_token_hash', 'provider', 'native_role', 'capability_mode', 'deadline_ms',
] as const;

const RECEIPT_BOUND_WORKER_ENVELOPE_KEYS = [
  ...WORKER_ENVELOPE_KEYS,
  'provider_profile_digest', 'route_receipt_digest',
] as const;

const DEPENDENCY_KEYS = ['task_id', 'result_hash', 'artifact_roots'] as const;
const ARTIFACT_CONTRACT_KEYS = ['proposal_root', 'required_files', 'terminal_receipt_path'] as const;
const GUIDANCE_HASH_KEYS = ['path', 'sha256'] as const;

function assertGuidancePath(value: string): void {
  const normalized = path.posix.normalize(value);
  if (path.isAbsolute(value) || value.includes('\0') || value.includes('\\')
    || normalized === '..' || normalized.startsWith('../')
    || path.posix.basename(normalized).toLowerCase() !== 'agents.md') {
    throw new ContractViolation('E_WORKER_ENVELOPE', 'Contributor guidance path must be confined AGENTS.md');
  }
}

export function validateWorkerEnvelope(value: unknown): WorkerEnvelopeV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractViolation('E_WORKER_ENVELOPE', 'Worker envelope must be an object');
  }
  const record = value as Record<string, unknown>;
  const receiptBound = Object.prototype.hasOwnProperty.call(record, 'provider_profile_digest')
    || Object.prototype.hasOwnProperty.call(record, 'route_receipt_digest');
  assertExactObjectKeys(
    record,
    receiptBound ? RECEIPT_BOUND_WORKER_ENVELOPE_KEYS : WORKER_ENVELOPE_KEYS,
    'worker envelope',
  );
  const envelope = value as Partial<WorkerEnvelopeV1>;
  if (envelope.store_kind !== 'oma_worker_envelope' || envelope.schema_version !== 1
    || envelope.repository_id !== 'OMA') {
    throw new ContractViolation('E_WORKER_ENVELOPE', 'Worker envelope schema identity is invalid');
  }
  for (const [label, candidate] of [
    ['run_id', envelope.run_id],
    ['team_id', envelope.team_id],
    ['task_id', envelope.task_id],
    ['task_text', envelope.task_text],
    ['claim_id', envelope.claim_id],
    ['state_endpoint', envelope.state_endpoint],
    ['native_role', envelope.native_role],
  ] as const) assertNonEmptyString(candidate, label);
  if (!['antigravity_native', 'agy_headless', 'tmux_agy'].includes(envelope.provider as string)) {
    throw new ContractViolation('E_WORKER_ENVELOPE', 'Worker provider is not allowed');
  }
  if (envelope.capability_mode !== 'read-only' && envelope.capability_mode !== 'read-write') {
    throw new ContractViolation('E_WORKER_ENVELOPE', 'Worker capability mode is not allowed');
  }
  if (!Array.isArray(envelope.write_scope) || !Array.isArray(envelope.verification_argv)
    || !Array.isArray(envelope.dependencies) || !Array.isArray(envelope.contributor_guidance_hashes)) {
    throw new ContractViolation('E_WORKER_ENVELOPE', 'Worker arrays are missing');
  }
  if (envelope.capability_mode === 'read-only' && envelope.write_scope.length !== 0) {
    throw new ContractViolation('E_WORKER_ENVELOPE', 'Read-only worker cannot receive write paths');
  }
  // 設計概念映射：OMG posture 由 native_role 推導；envelope 一律視為 child worker。
  const rolePosture = inspectOmaRolePosture({
    role: envelope.native_role,
    capabilityMode: envelope.capability_mode,
    writeScopeNone: envelope.write_scope.length === 0,
    asChild: true,
  });
  if (!rolePosture.ok) {
    throw new ContractViolation('E_WORKER_ENVELOPE', rolePosture.message, rolePosture.details);
  }
  assertStringArray(envelope.write_scope, 'write_scope', { nonEmptyValues: true, unique: true });
  envelope.write_scope.forEach((entry, index) => assertSafeRepositoryWritePath(entry, `write_scope[${index}]`));
  envelope.verification_argv.forEach((argv, index) => assertSafeArgvVector(argv, `verification_argv[${index}]`));
  if (!Number.isSafeInteger(envelope.mailbox_cursor) || (envelope.mailbox_cursor as number) < 0
    || !Number.isSafeInteger(envelope.generation) || (envelope.generation as number) <= 0
    || !Number.isSafeInteger(envelope.deadline_ms) || (envelope.deadline_ms as number) <= 0
    || (envelope.deadline_ms as number) > 86_400_000) {
    throw new ContractViolation('E_WORKER_ENVELOPE', 'Worker cursor/generation/deadline is invalid');
  }
  assertSha256(envelope.cancellation_token_hash, 'cancellation_token_hash');
  if (receiptBound) {
    assertSha256(envelope.provider_profile_digest, 'provider_profile_digest');
    assertSha256(envelope.route_receipt_digest, 'route_receipt_digest');
  }
  const dependencyIds = new Set<string>();
  for (const dependency of envelope.dependencies) {
    if (typeof dependency !== 'object' || dependency === null || Array.isArray(dependency)) {
      throw new ContractViolation('E_WORKER_ENVELOPE', 'Worker dependency must be an object');
    }
    assertExactObjectKeys(dependency as unknown as Record<string, unknown>, DEPENDENCY_KEYS, 'worker dependency');
    assertNonEmptyString(dependency.task_id, 'dependency.task_id');
    if (dependencyIds.has(dependency.task_id)) {
      throw new ContractViolation('E_WORKER_ENVELOPE', 'Worker dependency task IDs must be unique');
    }
    dependencyIds.add(dependency.task_id);
    assertSha256(dependency.result_hash, 'dependency.result_hash');
    assertStringArray(dependency.artifact_roots, 'dependency.artifact_roots', {
      nonEmptyValues: true,
      unique: true,
    });
    dependency.artifact_roots.forEach((entry, index) =>
      assertSafeRepositoryWritePath(entry, `dependency.artifact_roots[${index}]`));
  }
  if (typeof envelope.artifact_contract !== 'object' || envelope.artifact_contract === null
    || Array.isArray(envelope.artifact_contract)) {
    throw new ContractViolation('E_WORKER_ENVELOPE', 'Worker artifact contract must be an object');
  }
  assertExactObjectKeys(
    envelope.artifact_contract as unknown as Record<string, unknown>,
    ARTIFACT_CONTRACT_KEYS,
    'worker artifact contract',
  );
  assertSafeRepositoryWritePath(envelope.artifact_contract.proposal_root, 'artifact_contract.proposal_root');
  assertSafeRepositoryWritePath(
    envelope.artifact_contract.terminal_receipt_path,
    'artifact_contract.terminal_receipt_path',
  );
  assertStringArray(envelope.artifact_contract.required_files, 'artifact_contract.required_files', {
    nonEmptyValues: true,
    unique: true,
  });
  envelope.artifact_contract.required_files.forEach((entry, index) =>
    assertSafeRepositoryWritePath(entry, `artifact_contract.required_files[${index}]`));
  const guidancePaths = new Set<string>();
  for (const item of envelope.contributor_guidance_hashes) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new ContractViolation('E_WORKER_ENVELOPE', 'Contributor guidance hash must be an object');
    }
    assertExactObjectKeys(item as unknown as Record<string, unknown>, GUIDANCE_HASH_KEYS, 'guidance hash');
    assertNonEmptyString(item.path, 'guidance path');
    assertGuidancePath(item.path);
    if (guidancePaths.has(item.path)) {
      throw new ContractViolation('E_WORKER_ENVELOPE', 'Contributor guidance paths must be unique');
    }
    guidancePaths.add(item.path);
    assertSha256(item.sha256, item.path);
  }
  return envelope as WorkerEnvelopeV1;
}
