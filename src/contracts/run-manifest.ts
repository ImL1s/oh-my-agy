import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { spawnSync } from 'child_process';
import { atomicWriteFile } from '../runtime/atomic';
import { acquireOwnerLock, releaseOwnerLock } from '../runtime/lock';
import { safePathKey, resolveConfinedPath } from './path-key';
import {
  canonicalBytesV1,
  ContractViolation,
  parseCanonicalJsonV1,
  assertExactObjectKeys,
  assertGitObjectId,
  assertNonEmptyString,
  assertSha256,
} from './state-schemas';
import {
  AggregateEnvelopeV1,
  HandoffPayloadV1,
  OMA_WAVE_IDS,
  PARENT_HASH_ORACLE_V1,
  OmaWaveId,
  PathProposalV1,
  ProposalIndexV1,
  SignedHandoffV1,
  W6RequestBindingV1,
  createProposalIndex,
  handoffHash,
  merkleRootV1,
  sha256Hex,
  signAggregate,
  signHandoff,
  validateHandoffPayload,
  validateProposalIndex,
  validateParentHandoffHashes,
  verifyAggregate,
  verifyHandoff,
} from './writer-chain';
import {
  collectFinalTreeEvidence,
  collectInclusiveDirtyPaths,
  ownershipForPath,
  validateChangedPathOwnership,
} from '../../scripts/check-writer-ownership';
import {
  ReleaseBundleManifestV1,
  validateReleaseBundleManifest,
} from './release-transaction';

export const FROZEN_OMA_NORMATIVE_PLAN_HASHES_V1: Readonly<NormativePlanHashesV1> = Object.freeze({
  requirements: 'f9ff4cdad865330b2ea6db3443f19ce2ed48567ba3cc5164459822226e11805f',
  prd: '0a9c2c644188bd461ffd96e0fc89f6ca017f2c5e6b15bbd28683b3d978c17952',
  test_spec: '4cc4337225a3dcdb722351aedf573368ea23657e2d9ef9be1aca60f7927566d2',
  execution_plan: '29852abd254d1aa5c51b3a5a98739f0763a195f9c9b9b77ccea69e8ba3a770f5',
});

export const FROZEN_OMA_OWNERSHIP_MANIFEST_HASH_V1 =
  '73c5d7ca4bcc066b1943b9543e2bfb0d47acbc93cdd56399c2d21c67381518d5';

export const RUN_MANIFEST_STATE_SET_V1 = [
  'initializing',
  'writers_active',
  'inputs_verified',
  'composition_active',
  'signing_revoked',
  'release_active',
  'closed',
  'blocked',
] as const;

export type RunManifestStateV1 = typeof RUN_MANIFEST_STATE_SET_V1[number];

export const OMA_OWNER_ROWS_V1 = [
  ['OMA-W0', 'oma-contract-owner'],
  ['OMA-W1', 'oma-install-owner'],
  ['OMA-W2', 'oma-state-owner'],
  ['OMA-W3', 'oma-team-owner'],
  ['OMA-W4', 'oma-native-surface-owner'],
  ['OMA-W5', 'oma-adapter-owner'],
] as const;

const WRITER_WAVES: readonly OmaWriterWaveIdV1[] = OMA_OWNER_ROWS_V1.map(([wave]) => wave);

export interface NormativePlanHashesV1 {
  requirements: string;
  prd: string;
  test_spec: string;
  execution_plan: string;
}

export interface ClaimedRegistryPolicyV1 {
  registry_id: string;
  registry_url: string;
  package: string;
  final_dist_tag: string;
  staging_tag_derivation: string;
  credential_preflight_hash: string;
  readback_preflight_hash: string;
}

export interface ManifestOwnerKeyV1 {
  wave: OmaWaveId;
  owner: string;
  key_id: string;
  key_sha256: string;
}

export interface RunManifestV1 {
  store_kind: 'dual_parity_run_manifest';
  schema_version: 1;
  repository_id: 'OMA';
  repository_realpath_hash: string;
  run_id: string;
  run_key: string;
  revision: number;
  previous_manifest_hash: string | null;
  state: RunManifestStateV1;
  frozen_base_commit: string;
  frozen_base_tree: string;
  approved_branch: string;
  approved_remote: string;
  approved_remote_old_oid: string;
  normative_plan_hashes: NormativePlanHashesV1;
  ownership_manifest_id: 'dual-parity-writers-v1';
  ownership_manifest_hash: string;
  trust_root_path: string;
  trust_root_hash: string;
  owner_keys: ManifestOwnerKeyV1[];
  aggregate_signer_id: 'OMA-W6-aggregate-signer';
  aggregate_verifier_id: 'OMA-W6-aggregate-verifier';
  aggregate_key_id: string;
  claimed_release_channels: readonly string[];
  claimed_registry_policy: readonly ClaimedRegistryPolicyV1[];
  lease_generation: number;
  writer_authority: 'oma_cli';
  created_at: string;
  updated_at: string;
}

export interface WriterTrustRootV1 {
  store_kind: 'dual_parity_writer_trust';
  schema_version: 1;
  repository_id: 'OMA';
  run_id: string;
  run_key: string;
  frozen_base_commit: string;
  frozen_base_tree: string;
  repository_realpath_hash: string;
  approved_branch: string;
  approved_remote: string;
  approved_remote_old_oid: string;
  normative_plan_hashes: NormativePlanHashesV1;
  ownership_manifest_id: 'dual-parity-writers-v1';
  ownership_manifest_hash: string;
  generation: number;
  owner_keys: ManifestOwnerKeyV1[];
  aggregate: {
    signer_id: 'OMA-W6-aggregate-signer';
    verifier_id: 'OMA-W6-aggregate-verifier';
    key_id: string;
    key_sha256: string;
  };
  created_at: string;
}

export interface InitializeRunManifestInputV1 {
  workspace_path: string;
  run_id: string;
  frozen_base_commit: string;
  frozen_base_tree: string;
  approved_branch: string;
  approved_remote: string;
  approved_remote_old_oid: string;
  normative_plan_hashes: NormativePlanHashesV1;
  ownership_manifest_hash: string;
  claimed_release_channels: readonly string[];
  claimed_registry_policy: readonly ClaimedRegistryPolicyV1[];
  created_at?: string;
}

export interface RunManifestLocationV1 {
  manifest_path: string;
  trust_root_path: string;
  run_key: string;
}

export interface WriteWaveHandoffArtifactsInputV1 {
  workspace_path: string;
  run_id: string;
  wave: Exclude<OmaWaveId, 'OMA-W6' | 'OMA-W7'>;
  owner: string;
  expected_manifest_revision: number;
  proposals: PathProposalV1[];
  w6_requests: W6RequestBindingV1[];
  parent_handoffs: SignedHandoffV1[];
  completed_at: string;
}

export interface WaveHandoffArtifactsV1 {
  proposal_index_path: string;
  proposal_index_hash: string;
  proposal_merkle_root: string;
  handoff_path: string;
  handoff_hash: string;
  signature: string;
}

type OmaWriterWaveIdV1 = Exclude<OmaWaveId, 'OMA-W6' | 'OMA-W7'>;

export interface RepositoryAggregateOwnerRootV1 {
  wave: OmaWriterWaveIdV1;
  owner: string;
  key_id: string;
  proposal_index_path: string;
  proposal_index_hash: string;
  proposal_count: number;
  proposal_merkle_root: string;
  handoff_path: string;
  handoff_hash: string;
  signature: string;
  parent_handoff_hashes: string[];
  w6_requests: W6RequestBindingV1[];
}

export interface AcceptedW6ProposalV1 extends W6RequestBindingV1 {
  wave: OmaWriterWaveIdV1;
}

interface RepositoryAggregateManifestBindingV1 {
  repository_id: 'OMA';
  run_id: string;
  run_key: string;
  run_manifest_path: string;
  run_manifest_revision: number;
  run_manifest_hash: string;
  lease_generation: number;
  frozen_base_commit: string;
  frozen_base_tree: string;
  approved_branch: string;
  approved_remote: string;
  approved_remote_old_oid: string;
  trust_root_path: string;
  trust_root_hash: string;
  ownership_manifest_id: 'dual-parity-writers-v1';
  ownership_manifest_hash: string;
  normative_plan_hashes: NormativePlanHashesV1;
  claimed_release_channels: readonly ['github'];
  claimed_registry_policy: readonly [];
}

export interface RepositoryAggregateInputPayloadV1
  extends RepositoryAggregateManifestBindingV1 {
  store_kind: 'repo_aggregate_input_payload';
  schema_version: 1;
  writers_manifest_hash: string;
  ordered_owner_roots: RepositoryAggregateOwnerRootV1[];
  parent_handoff_hashes: string[];
  path_test_merkle_root: string;
  accepted_w6_proposals: AcceptedW6ProposalV1[];
  final_commit: null;
}

export interface RepositoryAggregateFinalPayloadV1
  extends RepositoryAggregateManifestBindingV1 {
  store_kind: 'repo_aggregate_final_payload';
  schema_version: 1;
  input_envelope: AggregateEnvelopeV1<RepositoryAggregateInputPayloadV1>;
  input_aggregate_hash: string;
  candidate_commit: string;
  candidate_tree: string;
  pushed_oid: string;
  complete_delta_root: string;
  semver: string;
  deterministic_proof_hash: string;
  live_proof_hash: string;
  code_review_proof_hash: string;
  ultraqa_proof_hash: string;
  release_nonce: string;
  release_bundle_manifest_path: string;
  release_bundle_manifest_sha256: string;
  release_bundle_manifest_schema: 'release_bundle_manifest/1';
  public_upload_order: [string, 'SHA256SUMS'];
  release_asset_root: string;
}

export type RepositoryAggregatePayloadV1 =
  | RepositoryAggregateInputPayloadV1
  | RepositoryAggregateFinalPayloadV1;

export interface RepositoryAggregateHandoffV1 {
  store_kind: 'repo_aggregate_handoff';
  schema_version: 1;
  repository_id: 'OMA';
  run_id: string;
  revision: 1 | 2;
  previous_aggregate_hash: string | null;
  input_envelope: AggregateEnvelopeV1<RepositoryAggregateInputPayloadV1>;
  final_envelope: AggregateEnvelopeV1<RepositoryAggregateFinalPayloadV1> | null;
}

export type FinalSigningFaultPointV1 =
  | 'before_journal_write'
  | 'after_journal_write'
  | 'before_aggregate_write'
  | 'after_aggregate_write'
  | 'before_manifest_write'
  | 'after_manifest_write';

interface FinalSigningTransactionJournalV1 {
  store_kind: 'repo_aggregate_finalization_journal';
  schema_version: 1;
  repository_id: 'OMA';
  run_id: string;
  base_manifest: RunManifestV1;
  base_aggregate: RepositoryAggregateHandoffV1;
  desired_manifest: RunManifestV1;
  desired_aggregate: RepositoryAggregateHandoffV1;
  signature: string;
}

const NEXT_STATE: Readonly<Partial<Record<RunManifestStateV1, RunManifestStateV1>>> = Object.freeze({
  initializing: 'writers_active',
  writers_active: 'inputs_verified',
  inputs_verified: 'composition_active',
  composition_active: 'signing_revoked',
  signing_revoked: 'release_active',
  release_active: 'closed',
});

const REGISTRY_POLICY_KEYS = [
  'registry_id',
  'registry_url',
  'package',
  'final_dist_tag',
  'staging_tag_derivation',
  'credential_preflight_hash',
  'readback_preflight_hash',
] as const;

const PLAN_HASH_KEYS = ['requirements', 'prd', 'test_spec', 'execution_plan'] as const;

const OWNER_KEY_KEYS = ['wave', 'owner', 'key_id', 'key_sha256'] as const;

const RUN_MANIFEST_KEYS = [
  'store_kind', 'schema_version', 'repository_id', 'repository_realpath_hash', 'run_id',
  'run_key', 'revision', 'previous_manifest_hash', 'state', 'frozen_base_commit',
  'frozen_base_tree', 'approved_branch', 'approved_remote', 'approved_remote_old_oid',
  'normative_plan_hashes', 'ownership_manifest_id', 'ownership_manifest_hash',
  'trust_root_path', 'trust_root_hash', 'owner_keys', 'aggregate_signer_id',
  'aggregate_verifier_id', 'aggregate_key_id', 'claimed_release_channels',
  'claimed_registry_policy', 'lease_generation', 'writer_authority', 'created_at', 'updated_at',
] as const;

const TRUST_ROOT_KEYS = [
  'store_kind', 'schema_version', 'repository_id', 'run_id', 'run_key', 'frozen_base_commit',
  'frozen_base_tree', 'repository_realpath_hash', 'approved_branch', 'approved_remote',
  'approved_remote_old_oid', 'normative_plan_hashes', 'ownership_manifest_id',
  'ownership_manifest_hash', 'generation', 'owner_keys', 'aggregate', 'created_at',
] as const;

const TRUST_AGGREGATE_KEYS = ['signer_id', 'verifier_id', 'key_id', 'key_sha256'] as const;

const HANDOFF_INPUT_KEYS = [
  'workspace_path', 'run_id', 'wave', 'owner', 'expected_manifest_revision', 'proposals',
  'w6_requests', 'parent_handoffs', 'completed_at',
] as const;

const AGGREGATE_MANIFEST_BINDING_KEYS = [
  'repository_id', 'run_id', 'run_key', 'run_manifest_path', 'run_manifest_revision',
  'run_manifest_hash', 'lease_generation', 'frozen_base_commit', 'frozen_base_tree',
  'approved_branch', 'approved_remote', 'approved_remote_old_oid', 'trust_root_path',
  'trust_root_hash', 'ownership_manifest_id', 'ownership_manifest_hash',
  'normative_plan_hashes', 'claimed_release_channels', 'claimed_registry_policy',
] as const;

const AGGREGATE_INPUT_KEYS = [
  'store_kind', 'schema_version', ...AGGREGATE_MANIFEST_BINDING_KEYS, 'writers_manifest_hash',
  'ordered_owner_roots', 'parent_handoff_hashes', 'path_test_merkle_root',
  'accepted_w6_proposals', 'final_commit',
] as const;

const AGGREGATE_FINAL_KEYS = [
  'store_kind', 'schema_version', ...AGGREGATE_MANIFEST_BINDING_KEYS, 'input_envelope',
  'input_aggregate_hash', 'candidate_commit', 'candidate_tree', 'pushed_oid',
  'complete_delta_root', 'semver', 'deterministic_proof_hash', 'live_proof_hash',
  'code_review_proof_hash', 'ultraqa_proof_hash', 'release_nonce',
  'release_bundle_manifest_path', 'release_bundle_manifest_sha256',
  'release_bundle_manifest_schema', 'public_upload_order', 'release_asset_root',
] as const;

const AGGREGATE_OWNER_ROOT_KEYS = [
  'wave', 'owner', 'key_id', 'proposal_index_path', 'proposal_index_hash',
  'proposal_count', 'proposal_merkle_root', 'handoff_path', 'handoff_hash', 'signature',
  'parent_handoff_hashes', 'w6_requests',
] as const;

const ACCEPTED_W6_PROPOSAL_KEYS = ['wave', 'path', 'byte_length', 'sha256'] as const;

const AGGREGATE_ENVELOPE_KEYS = [
  'algorithm', 'signer_id', 'key_id', 'payload_hash', 'signature', 'payload',
] as const;

const AGGREGATE_HANDOFF_KEYS = [
  'store_kind', 'schema_version', 'repository_id', 'run_id', 'revision',
  'previous_aggregate_hash', 'input_envelope', 'final_envelope',
] as const;

const W6_REQUEST_DOCUMENT_KEYS = [
  'store_kind', 'schema_version', 'repository_id', 'run_id', 'from_wave', 'to_wave',
  'owner_boundary', 'requests', 'acceptance', 'validation_argv',
] as const;

const W6_REQUEST_ITEM_KEYS = ['request', 'required_action'] as const;

const RELEASE_BUNDLE_MANIFEST_KEYS = [
  'store_kind', 'schema_version', 'repository_id', 'run_id', 'owner', 'candidate_commit',
  'candidate_tree', 'semver', 'bundle_directory', 'public_upload_order', 'assets',
  'checksum_bytes', 'checksum_byte_length', 'checksum_sha256', 'build_receipt',
  'registry_bindings', 'release_asset_root',
] as const;

const RELEASE_BUNDLE_ASSET_KEYS = [
  'name', 'relative_path', 'byte_length', 'sha256', 'media_type',
] as const;

const RELEASE_BUILD_RECEIPT_KEYS = [
  'argv', 'cwd_realpath_hash', 'toolchain', 'sanitized_environment', 'source_date_epoch',
  'locale', 'timezone', 'umask', 'exit_code', 'stdout_sha256', 'stderr_sha256',
  'archive_sha256', 'packlist_sha256', 'receipt_hash',
] as const;

const RELEASE_TOOLCHAIN_KEYS = ['name', 'version', 'binary_sha256'] as const;
const RELEASE_ENVIRONMENT_KEYS = ['name', 'value_hash'] as const;

const BASIC_RELEASE_PROOF_KEYS = [
  'store_kind', 'schema_version', 'repository_id', 'run_id', 'proof_kind',
  'candidate_commit', 'candidate_tree', 'passed',
] as const;

const REVIEW_RELEASE_PROOF_KEYS = [
  ...BASIC_RELEASE_PROOF_KEYS, 'reviewer_id', 'reviewer_key_id', 'test_argv',
  'test_result', 'evidence', 'attestation_signature',
] as const;

const RELEASE_PROOF_TEST_RESULT_KEYS = [
  'exit_code', 'stdout_sha256', 'stderr_sha256',
] as const;

const RELEASE_PROOF_EVIDENCE_KEYS = [
  'path', 'byte_length', 'sha256',
] as const;

const RELEASE_PROOF_EVIDENCE_DOCUMENT_KEYS = [
  'store_kind', 'schema_version', 'repository_id', 'run_id', 'proof_kind', 'reviewer_id',
  'candidate_commit', 'candidate_tree', 'test_argv', 'test_result',
] as const;

const FINAL_SIGNING_JOURNAL_KEYS = [
  'store_kind', 'schema_version', 'repository_id', 'run_id', 'base_manifest',
  'base_aggregate', 'desired_manifest', 'desired_aggregate', 'signature',
] as const;

const RELEASE_PROOF_BINDINGS = [
  ['deterministic', 'deterministic_proof_hash'],
  ['live', 'live_proof_hash'],
  ['code_review', 'code_review_proof_hash'],
  ['ultraqa', 'ultraqa_proof_hash'],
] as const;

const RELEASE_ENVIRONMENT_NAMES = [
  'LANG', 'LC_ALL', 'SOURCE_DATE_EPOCH', 'TZ', 'npm_config_loglevel',
] as const;

const AGGREGATE_PHASE_STATES: Readonly<Record<'input' | 'final', readonly RunManifestStateV1[]>> = {
  input: ['inputs_verified', 'composition_active', 'signing_revoked', 'release_active', 'closed'],
  final: ['composition_active', 'signing_revoked', 'release_active', 'closed'],
};

const SEMVER_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

function assertCanonicalTimestamp(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new ContractViolation('E_RUN_MANIFEST', `${label} must be a canonical UTC timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ContractViolation('E_RUN_MANIFEST', `${label} must be a canonical UTC timestamp`);
  }
}

function validateNormativePlanHashes(value: unknown): asserts value is NormativePlanHashesV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractViolation('E_RUN_MANIFEST', 'normative_plan_hashes must be an object');
  }
  assertExactObjectKeys(value as Record<string, unknown>, PLAN_HASH_KEYS, 'normative plan hashes');
  for (const key of PLAN_HASH_KEYS) assertSha256((value as Record<string, unknown>)[key], key);
}

function validateOwnerKeys(value: unknown): asserts value is ManifestOwnerKeyV1[] {
  if (!Array.isArray(value) || value.length !== OMA_OWNER_ROWS_V1.length) {
    throw new ContractViolation('E_RUN_MANIFEST', 'Run manifest must pin six ordered owner keys');
  }
  const keyIds = new Set<string>();
  const keyHashes = new Set<string>();
  for (let index = 0; index < OMA_OWNER_ROWS_V1.length; index += 1) {
    const entry = value[index] as ManifestOwnerKeyV1;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ContractViolation('E_RUN_MANIFEST', 'Owner key entry must be an object');
    }
    assertExactObjectKeys(entry as unknown as Record<string, unknown>, OWNER_KEY_KEYS, 'owner key');
    const [wave, owner] = OMA_OWNER_ROWS_V1[index];
    if (entry.wave !== wave || entry.owner !== owner) {
      throw new ContractViolation('E_RUN_MANIFEST', 'Owner key order/identity is invalid');
    }
    assertSha256(entry.key_id, 'owner key_id');
    assertSha256(entry.key_sha256, 'owner key_sha256');
    if (keyIds.has(entry.key_id) || keyHashes.has(entry.key_sha256)) {
      throw new ContractViolation('E_RUN_MANIFEST', 'Owner keys must be independent and unique');
    }
    keyIds.add(entry.key_id);
    keyHashes.add(entry.key_sha256);
  }
}

function manifestLocation(workspacePath: string, runId: string): RunManifestLocationV1 {
  const workspace = fs.realpathSync(path.resolve(workspacePath));
  const runKey = safePathKey(runId);
  return {
    run_key: runKey,
    manifest_path: resolveConfinedPath(
      workspace,
      path.join('.agy', 'state', 'runs', runKey, 'run-manifest.json'),
    ),
    trust_root_path: resolveConfinedPath(
      workspace,
      path.join('.agy', 'artifacts', 'dual-parity', runKey, 'trust', 'writer-trust.json'),
    ),
  };
}

export function locateRunManifest(workspacePath: string, runId: string): RunManifestLocationV1 {
  return manifestLocation(workspacePath, runId);
}

function keyPath(workspacePath: string, runId: string, keyName: string): string {
  const location = manifestLocation(workspacePath, runId);
  return resolveConfinedPath(
    fs.realpathSync(path.resolve(workspacePath)),
    path.join('.agy', 'artifacts', 'dual-parity', location.run_key, 'trust', 'keys', keyName),
  );
}

function assertRegistryPolicy(policy: ClaimedRegistryPolicyV1): void {
  assertExactObjectKeys(policy as unknown as Record<string, unknown>, REGISTRY_POLICY_KEYS, 'registry policy');
  if (!['github-packages', 'npmjs'].includes(policy.registry_id)) {
    throw new ContractViolation('E_REGISTRY_POLICY', 'Production registry ID is not allowed');
  }
  if (policy.package !== '@iml1s/oh-my-agy' || policy.final_dist_tag.trim() === ''
    || policy.staging_tag_derivation.trim() === '') {
    throw new ContractViolation('E_REGISTRY_POLICY', 'OMA registry package/tag policy is invalid');
  }
  assertSha256(policy.credential_preflight_hash, 'credential_preflight_hash');
  assertSha256(policy.readback_preflight_hash, 'readback_preflight_hash');
}

function validateInitializeInput(input: InitializeRunManifestInputV1): void {
  if (input.run_id.trim() === '' || input.approved_branch.trim() === '' || input.approved_remote.trim() === '') {
    throw new ContractViolation('E_RUN_MANIFEST', 'Run ID, branch, and remote must be non-empty');
  }
  for (const [label, value] of [
    ['frozen_base_commit', input.frozen_base_commit],
    ['frozen_base_tree', input.frozen_base_tree],
    ['approved_remote_old_oid', input.approved_remote_old_oid],
  ]) assertGitObjectId(value, label);
  validateNormativePlanHashes(input.normative_plan_hashes);
  if (!canonicalEqual(input.normative_plan_hashes, FROZEN_OMA_NORMATIVE_PLAN_HASHES_V1)
    || input.ownership_manifest_hash !== FROZEN_OMA_OWNERSHIP_MANIFEST_HASH_V1) {
    throw new ContractViolation('E_RUN_MANIFEST', 'OMA normative plan/ownership hashes are not the frozen release contract');
  }
  assertOmaReleasePolicy(input.claimed_release_channels, input.claimed_registry_policy);
}

function runGit(workspacePath: string, args: readonly string[]): Buffer {
  const result = spawnSync('git', ['-C', workspacePath, ...args], {
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new ContractViolation('E_GIT_BINDING', `git ${args.join(' ')} failed`, {
      stderr: Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8').trim() : String(result.stderr),
    });
  }
  return result.stdout as Buffer;
}

function gitText(workspacePath: string, args: readonly string[]): string {
  return runGit(workspacePath, args).toString('utf8').trim();
}

function assertGitBindings(
  workspacePath: string,
  binding: Pick<InitializeRunManifestInputV1,
  'frozen_base_commit' | 'frozen_base_tree' | 'approved_branch' | 'approved_remote' | 'approved_remote_old_oid'>,
  requireHeadAtBase = false,
  expectedRemoteOid = binding.approved_remote_old_oid,
): void {
  assertGitObjectId(expectedRemoteOid, 'expected_remote_oid');
  const workspace = fs.realpathSync(path.resolve(workspacePath));
  const commit = gitText(workspace, ['rev-parse', '--verify', `${binding.frozen_base_commit}^{commit}`]);
  const head = gitText(workspace, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const tree = gitText(workspace, ['rev-parse', '--verify', `${commit}^{tree}`]);
  const branch = gitText(workspace, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const remote = gitText(workspace, [
    'ls-remote', '--exit-code', binding.approved_remote, `refs/heads/${binding.approved_branch}`,
  ]);
  const expectedRemote = `${expectedRemoteOid}\trefs/heads/${binding.approved_branch}`;
  if (commit !== binding.frozen_base_commit || (requireHeadAtBase && head !== commit) || tree !== binding.frozen_base_tree
    || branch !== binding.approved_branch || remote !== expectedRemote || remote.includes('\n')) {
    throw new ContractViolation(
      'E_GIT_BINDING',
      'Frozen base commit/tree/branch or expected remote OID differs from the actual repository',
    );
  }
}

function writeCanonical0600(targetPath: string, value: unknown): void {
  atomicWriteFile(targetPath, canonicalBytesV1(value), { mode: 0o600 });
}

function readCanonicalObject(targetPath: string): Record<string, unknown> {
  const stat = fs.lstatSync(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    throw new ContractViolation('E_RUN_MANIFEST', 'Contract file must be regular, non-symlink, and 0600');
  }
  const value = parseCanonicalJsonV1(fs.readFileSync(targetPath));
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractViolation('E_RUN_MANIFEST', 'Contract file must contain an object');
  }
  return value as Record<string, unknown>;
}

export function validateRunManifest(value: unknown): RunManifestV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractViolation('E_RUN_MANIFEST', 'Run manifest must be an object');
  }
  assertExactObjectKeys(value as Record<string, unknown>, RUN_MANIFEST_KEYS, 'run manifest');
  const manifest = value as Partial<RunManifestV1>;
  if (manifest.store_kind !== 'dual_parity_run_manifest' || manifest.schema_version !== 1
    || manifest.repository_id !== 'OMA' || manifest.writer_authority !== 'oma_cli') {
    throw new ContractViolation('E_RUN_MANIFEST', 'Run manifest identity/authority is invalid');
  }
  if (!RUN_MANIFEST_STATE_SET_V1.includes(manifest.state as RunManifestStateV1)) {
    throw new ContractViolation('E_RUN_MANIFEST', 'Run manifest state is invalid');
  }
  if (!Number.isInteger(manifest.revision) || (manifest.revision as number) < 0
    || !Number.isInteger(manifest.lease_generation) || (manifest.lease_generation as number) <= 0) {
    throw new ContractViolation('E_RUN_MANIFEST', 'Run manifest revision/generation is invalid');
  }
  if (typeof manifest.run_id !== 'string' || manifest.run_id.trim() === ''
    || manifest.run_key !== safePathKey(manifest.run_id)
    || typeof manifest.approved_branch !== 'string' || manifest.approved_branch.trim() === ''
    || typeof manifest.approved_remote !== 'string' || manifest.approved_remote.trim() === '') {
    throw new ContractViolation('E_RUN_MANIFEST', 'Run/branch/remote identity is invalid');
  }
  for (const [label, hash] of [
    ['repository_realpath_hash', manifest.repository_realpath_hash],
    ['run_key', manifest.run_key],
    ['ownership_manifest_hash', manifest.ownership_manifest_hash],
    ['trust_root_hash', manifest.trust_root_hash],
  ] as const) assertSha256(hash, label);
  for (const [label, oid] of [
    ['frozen_base_commit', manifest.frozen_base_commit],
    ['frozen_base_tree', manifest.frozen_base_tree],
    ['approved_remote_old_oid', manifest.approved_remote_old_oid],
  ] as const) assertGitObjectId(oid, label);
  if (manifest.previous_manifest_hash !== null) assertSha256(manifest.previous_manifest_hash, 'previous_manifest_hash');
  if (manifest.ownership_manifest_id !== 'dual-parity-writers-v1'
    || manifest.aggregate_signer_id !== 'OMA-W6-aggregate-signer'
    || manifest.aggregate_verifier_id !== 'OMA-W6-aggregate-verifier') {
    throw new ContractViolation('E_RUN_MANIFEST', 'Run manifest frozen identities are invalid');
  }
  assertSha256(manifest.aggregate_key_id, 'aggregate_key_id');
  validateNormativePlanHashes(manifest.normative_plan_hashes);
  if (!canonicalEqual(manifest.normative_plan_hashes, FROZEN_OMA_NORMATIVE_PLAN_HASHES_V1)
    || manifest.ownership_manifest_hash !== FROZEN_OMA_OWNERSHIP_MANIFEST_HASH_V1) {
    throw new ContractViolation('E_RUN_MANIFEST', 'Run manifest plan/ownership policy is not frozen OMA');
  }
  validateOwnerKeys(manifest.owner_keys);
  if (!Array.isArray(manifest.claimed_release_channels)
    || manifest.claimed_release_channels.some((channel) => typeof channel !== 'string' || channel.trim() === '')
    || new Set(manifest.claimed_release_channels).size !== manifest.claimed_release_channels.length) {
    throw new ContractViolation('E_RUN_MANIFEST', 'Claimed release channels must be unique non-empty strings');
  }
  if (!Array.isArray(manifest.claimed_registry_policy)) {
    throw new ContractViolation('E_RUN_MANIFEST', 'Claimed registry policy must be an array');
  }
  const registryIds = new Set<string>();
  for (const policy of manifest.claimed_registry_policy) {
    assertRegistryPolicy(policy);
    if (registryIds.has(policy.registry_id)) {
      throw new ContractViolation('E_REGISTRY_POLICY', 'Duplicate registry policy ID');
    }
    registryIds.add(policy.registry_id);
  }
  assertOmaReleasePolicy(manifest.claimed_release_channels, manifest.claimed_registry_policy);
  if (typeof manifest.trust_root_path !== 'string' || path.isAbsolute(manifest.trust_root_path)
    || path.posix.normalize(manifest.trust_root_path) !== manifest.trust_root_path
    || !manifest.trust_root_path.startsWith(`.agy/artifacts/dual-parity/${manifest.run_key}/trust/`)) {
    throw new ContractViolation('E_RUN_MANIFEST', 'Trust root path is outside the run artifact root');
  }
  assertCanonicalTimestamp(manifest.created_at, 'created_at');
  assertCanonicalTimestamp(manifest.updated_at, 'updated_at');
  return manifest as RunManifestV1;
}

export function readRunManifest(targetPath: string): RunManifestV1 {
  return validateRunManifest(readCanonicalObject(targetPath));
}

export function verifyRunManifestAtPath(targetPath: string): RunManifestV1 {
  const absolute = path.resolve(targetPath);
  const manifest = readRunManifest(absolute);
  const workspace = path.resolve(path.dirname(absolute), '..', '..', '..', '..');
  const location = manifestLocation(workspace, manifest.run_id);
  if (absolute !== location.manifest_path) {
    throw new ContractViolation('E_RUN_MANIFEST_BINDING', 'Manifest is outside its exact repository run path');
  }
  assertManifestBindings(manifest, workspace, manifest.run_id, location);
  return manifest;
}

export async function initializeRunManifest(
  input: InitializeRunManifestInputV1,
  randomBytes: (size: number) => Buffer = crypto.randomBytes,
): Promise<{ manifest: RunManifestV1; manifest_path: string; trust_root_path: string }> {
  validateInitializeInput(input);
  const workspace = fs.realpathSync(path.resolve(input.workspace_path));
  assertGitBindings(workspace, input, true);
  const location = manifestLocation(workspace, input.run_id);
  const lock = await acquireOwnerLock(`${location.manifest_path}.lock`);
  if (!lock.ok) throw new ContractViolation(lock.error.code, lock.error.message, lock.error.details);
  try {
    if (fs.existsSync(location.manifest_path)) {
      throw new ContractViolation('E_ALREADY_EXISTS', 'Run manifest already exists');
    }
    const createdAt = input.created_at ?? new Date().toISOString();
    const ownerKeys: ManifestOwnerKeyV1[] = [];
    for (const [wave, owner] of OMA_OWNER_ROWS_V1) {
      const bytes = randomBytes(32);
      if (bytes.length !== 32) throw new ContractViolation('E_KEY_LENGTH', 'Key generator returned wrong length');
      const digest = sha256Hex(bytes);
      const keyId = sha256Hex(canonicalBytesV1(['OMA', input.run_id, wave, owner, digest]));
      writeCanonicalKey(keyPath(workspace, input.run_id, `${wave}.hmac`), bytes);
      ownerKeys.push({ wave, owner, key_id: keyId, key_sha256: digest });
    }
    const aggregateBytes = randomBytes(32);
    if (aggregateBytes.length !== 32) throw new ContractViolation('E_KEY_LENGTH', 'Key generator returned wrong length');
    const aggregateDigest = sha256Hex(aggregateBytes);
    const aggregateKeyId = sha256Hex(canonicalBytesV1([
      'OMA',
      input.run_id,
      'OMA-W6-aggregate',
      aggregateDigest,
    ]));
    writeCanonicalKey(keyPath(workspace, input.run_id, 'OMA-W6-aggregate.hmac'), aggregateBytes);

    const trustRoot: WriterTrustRootV1 = {
      store_kind: 'dual_parity_writer_trust',
      schema_version: 1,
      repository_id: 'OMA',
      run_id: input.run_id,
      run_key: location.run_key,
      frozen_base_commit: input.frozen_base_commit,
      frozen_base_tree: input.frozen_base_tree,
      repository_realpath_hash: sha256Hex(Buffer.from(workspace, 'utf8')),
      approved_branch: input.approved_branch,
      approved_remote: input.approved_remote,
      approved_remote_old_oid: input.approved_remote_old_oid,
      normative_plan_hashes: input.normative_plan_hashes,
      ownership_manifest_id: 'dual-parity-writers-v1',
      ownership_manifest_hash: input.ownership_manifest_hash,
      generation: 1,
      owner_keys: ownerKeys,
      aggregate: {
        signer_id: 'OMA-W6-aggregate-signer',
        verifier_id: 'OMA-W6-aggregate-verifier',
        key_id: aggregateKeyId,
        key_sha256: aggregateDigest,
      },
      created_at: createdAt,
    };
    writeCanonical0600(location.trust_root_path, trustRoot);
    const relativeTrustPath = path.relative(workspace, location.trust_root_path).split(path.sep).join('/');
    const manifest: RunManifestV1 = {
      store_kind: 'dual_parity_run_manifest',
      schema_version: 1,
      repository_id: 'OMA',
      repository_realpath_hash: sha256Hex(Buffer.from(workspace, 'utf8')),
      run_id: input.run_id,
      run_key: location.run_key,
      revision: 0,
      previous_manifest_hash: null,
      state: 'initializing',
      frozen_base_commit: input.frozen_base_commit,
      frozen_base_tree: input.frozen_base_tree,
      approved_branch: input.approved_branch,
      approved_remote: input.approved_remote,
      approved_remote_old_oid: input.approved_remote_old_oid,
      normative_plan_hashes: input.normative_plan_hashes,
      ownership_manifest_id: 'dual-parity-writers-v1',
      ownership_manifest_hash: input.ownership_manifest_hash,
      trust_root_path: relativeTrustPath,
      trust_root_hash: sha256Hex(canonicalBytesV1(trustRoot)),
      owner_keys: ownerKeys,
      aggregate_signer_id: 'OMA-W6-aggregate-signer',
      aggregate_verifier_id: 'OMA-W6-aggregate-verifier',
      aggregate_key_id: aggregateKeyId,
      claimed_release_channels: [...input.claimed_release_channels],
      claimed_registry_policy: input.claimed_registry_policy.map((policy) => ({ ...policy })),
      lease_generation: 1,
      writer_authority: 'oma_cli',
      created_at: createdAt,
      updated_at: createdAt,
    };
    validateRunManifest(manifest);
    writeCanonical0600(location.manifest_path, manifest);
    return { manifest, manifest_path: location.manifest_path, trust_root_path: location.trust_root_path };
  } finally {
    releaseOwnerLock(lock.value);
  }
}

function writeCanonicalKey(targetPath: string, bytes: Buffer): void {
  if (bytes.length !== 32) throw new ContractViolation('E_KEY_LENGTH', 'Key must be exactly 32 bytes');
  atomicWriteFile(targetPath, bytes, { mode: 0o600 });
}

function expectedRemoteOidForManifestState(
  workspacePath: string,
  manifest: RunManifestV1,
): string {
  if (!['signing_revoked', 'release_active', 'closed'].includes(manifest.state)) {
    return manifest.approved_remote_old_oid;
  }
  const stored = readRepositoryAggregateStore(workspacePath, manifest);
  if (stored.store.revision !== 2 || stored.store.final_envelope === null) {
    throw new ContractViolation(
      'E_AGGREGATE_CAS',
      'Post-signing manifest requires a canonical revision-2 final aggregate',
    );
  }
  return validateFinalAggregatePayload(stored.store.final_envelope.payload).pushed_oid;
}

function assertManifestBindings(
  manifest: RunManifestV1,
  workspacePath: string,
  runId: string,
  location: RunManifestLocationV1,
  expectedRemoteOid?: string,
): void {
  const workspace = fs.realpathSync(path.resolve(workspacePath));
  if (manifest.run_id !== runId || manifest.run_key !== location.run_key
    || manifest.repository_realpath_hash !== sha256Hex(Buffer.from(workspace, 'utf8'))
    || path.resolve(workspace, manifest.trust_root_path) !== location.trust_root_path) {
    throw new ContractViolation('E_RUN_MANIFEST_BINDING', 'Run manifest path/repository/run binding is invalid');
  }
  assertGitBindings(
    workspace,
    manifest,
    false,
    expectedRemoteOid ?? expectedRemoteOidForManifestState(workspace, manifest),
  );
  const trust = readCanonicalObject(location.trust_root_path);
  if (sha256Hex(canonicalBytesV1(trust)) !== manifest.trust_root_hash) {
    throw new ContractViolation('E_TRUST_ROOT', 'Writer trust root hash changed');
  }
  const root = trust as unknown as WriterTrustRootV1;
  assertExactObjectKeys(trust, TRUST_ROOT_KEYS, 'writer trust root');
  if (root.store_kind !== 'dual_parity_writer_trust' || root.schema_version !== 1
    || root.generation !== 1) {
    throw new ContractViolation('E_TRUST_ROOT', 'Writer trust root schema identity is invalid');
  }
  validateNormativePlanHashes(root.normative_plan_hashes);
  validateOwnerKeys(root.owner_keys);
  assertExactObjectKeys(
    root.aggregate as unknown as Record<string, unknown>,
    TRUST_AGGREGATE_KEYS,
    'aggregate trust key',
  );
  assertSha256(root.aggregate.key_id, 'aggregate key_id');
  assertSha256(root.aggregate.key_sha256, 'aggregate key_sha256');
  assertCanonicalTimestamp(root.created_at, 'trust created_at');
  if (root.repository_id !== 'OMA' || root.run_id !== manifest.run_id
    || root.run_key !== manifest.run_key || root.repository_realpath_hash !== manifest.repository_realpath_hash
    || root.frozen_base_commit !== manifest.frozen_base_commit
    || root.frozen_base_tree !== manifest.frozen_base_tree
    || root.approved_branch !== manifest.approved_branch
    || root.approved_remote !== manifest.approved_remote
    || root.approved_remote_old_oid !== manifest.approved_remote_old_oid
    || root.ownership_manifest_id !== manifest.ownership_manifest_id
    || root.ownership_manifest_hash !== manifest.ownership_manifest_hash
    || canonicalBytesV1(root.normative_plan_hashes).compare(canonicalBytesV1(manifest.normative_plan_hashes)) !== 0
    || canonicalBytesV1(root.owner_keys).compare(canonicalBytesV1(manifest.owner_keys)) !== 0
    || root.aggregate.key_id !== manifest.aggregate_key_id
    || root.aggregate.signer_id !== manifest.aggregate_signer_id
    || root.aggregate.verifier_id !== manifest.aggregate_verifier_id) {
    throw new ContractViolation('E_TRUST_ROOT', 'Run manifest drifted from its immutable trust root');
  }
  for (const ownerKey of root.owner_keys) {
    readAndValidateKey(
      keyPath(workspacePath, runId, `${ownerKey.wave}.hmac`),
      ownerKey.key_sha256,
    );
  }
  readAndValidateKey(
    keyPath(workspacePath, runId, 'OMA-W6-aggregate.hmac'),
    root.aggregate.key_sha256,
  );
}

export async function advanceRunManifest(options: {
  workspace_path: string;
  run_id: string;
  expected_revision: number;
  expected_previous_hash: string;
  expected_state: RunManifestStateV1;
  next_state: RunManifestStateV1;
  updated_at?: string;
}): Promise<RunManifestV1> {
  const location = manifestLocation(options.workspace_path, options.run_id);
  const lock = await acquireOwnerLock(`${location.manifest_path}.lock`, { staleAfterMs: 0 });
  if (!lock.ok) throw new ContractViolation(lock.error.code, lock.error.message, lock.error.details);
  try {
    reconcileFinalizationJournal(options.workspace_path, options.run_id, location);
    const current = readRunManifest(location.manifest_path);
    assertManifestBindings(current, options.workspace_path, options.run_id, location);
    const currentHash = sha256Hex(canonicalBytesV1(current));
    if (current.revision !== options.expected_revision || currentHash !== options.expected_previous_hash
      || current.state !== options.expected_state) {
      throw new ContractViolation('E_RUN_MANIFEST_CAS', 'Run manifest CAS predecessor does not match');
    }
    assertLifecyclePrerequisites(
      options.workspace_path,
      current,
      location,
      options.next_state,
    );
    const next = buildManifestTransition(
      current,
      currentHash,
      options.next_state,
      options.updated_at,
      false,
    );
    writeCanonical0600(location.manifest_path, next);
    return next;
  } finally {
    releaseOwnerLock(lock.value);
  }
}

function buildManifestTransition(
  current: RunManifestV1,
  currentHash: string,
  nextState: RunManifestStateV1,
  updatedAt: string | undefined,
  allowFinalSigningTransition: boolean,
): RunManifestV1 {
  const allowed = nextState === 'blocked'
    ? current.state !== 'closed' && current.state !== 'blocked'
    : NEXT_STATE[current.state] === nextState;
  if (!allowed || (current.state === 'composition_active'
    && nextState === 'signing_revoked' && !allowFinalSigningTransition)) {
    throw new ContractViolation('E_RUN_MANIFEST_STATE', 'Run manifest state transition is not allowed', {
      current: current.state,
      next: nextState,
    });
  }
  const timestamp = updatedAt ?? new Date().toISOString();
  assertCanonicalTimestamp(timestamp, 'updated_at');
  const next: RunManifestV1 = {
    ...current,
    revision: current.revision + 1,
    previous_manifest_hash: currentHash,
    state: nextState,
    lease_generation: current.lease_generation + 1,
    updated_at: timestamp,
  };
  validateRunManifest(next);
  return next;
}

function assertLifecyclePrerequisites(
  workspacePath: string,
  current: RunManifestV1,
  location: RunManifestLocationV1,
  nextState: RunManifestStateV1,
): void {
  if (nextState === 'blocked' || current.state === 'initializing') return;
  if (current.state === 'writers_active' && nextState === 'inputs_verified') {
    authenticatedInputEvidence(workspacePath, current);
    return;
  }
  if (current.state === 'inputs_verified' && nextState === 'composition_active') {
    const stored = readRepositoryAggregateStore(workspacePath, current);
    if (stored.store.revision !== 1 || stored.store.final_envelope !== null) {
      throw new ContractViolation(
        'E_AGGREGATE_CAS',
        'Composition requires the canonical revision-1 input aggregate CAS',
      );
    }
    verifyRepositoryAggregateInternal({
      workspace_path: workspacePath,
      phase: 'input',
      envelope: stored.store.input_envelope,
      manifest: current,
      location,
    });
    return;
  }
  if (current.state === 'composition_active' && nextState === 'signing_revoked') {
    throw new ContractViolation(
      'E_RUN_MANIFEST_STATE',
      'signing_revoked is reachable only through atomic final aggregate signing',
    );
  }
  if ((current.state === 'signing_revoked' && nextState === 'release_active')
    || (current.state === 'release_active' && nextState === 'closed')) {
    const stored = readRepositoryAggregateStore(workspacePath, current);
    if (stored.store.revision !== 2 || stored.store.final_envelope === null) {
      throw new ContractViolation(
        'E_AGGREGATE_CAS',
        'Release lifecycle requires the canonical revision-2 final aggregate CAS',
      );
    }
    verifyRepositoryAggregateInternal({
      workspace_path: workspacePath,
      phase: 'final',
      envelope: stored.store.final_envelope,
      manifest: current,
      location,
    });
  }
}

function readAndValidateKey(targetPath: string, expectedHash: string): Buffer {
  const stat = fs.lstatSync(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    throw new ContractViolation('E_TRUST_KEY', 'Trust key must be a regular 0600 file');
  }
  const bytes = fs.readFileSync(targetPath);
  if (bytes.length !== 32 || sha256Hex(bytes) !== expectedHash) {
    throw new ContractViolation('E_TRUST_KEY', 'Trust key bytes do not match the trust root');
  }
  return bytes;
}

export function signWaveHandoff(options: {
  workspace_path: string;
  run_id: string;
  wave: Exclude<OmaWaveId, 'OMA-W6' | 'OMA-W7'>;
  owner: string;
  expected_manifest_revision: number;
  payload: HandoffPayloadV1;
}): SignedHandoffV1 {
  const location = manifestLocation(options.workspace_path, options.run_id);
  const manifest = readRunManifest(location.manifest_path);
  assertManifestBindings(manifest, options.workspace_path, options.run_id, location);
  if (!['initializing', 'writers_active'].includes(manifest.state)
    || manifest.revision !== options.expected_manifest_revision) {
    throw new ContractViolation('E_SIGN_CAPABILITY', 'Owner sign capability is stale or inactive');
  }
  const identity = manifest.owner_keys.find((entry) => entry.wave === options.wave);
  if (identity === undefined || identity.owner !== options.owner
    || options.payload.wave !== options.wave || options.payload.owner !== options.owner
    || options.payload.run_id !== options.run_id || options.payload.repository_id !== 'OMA') {
    throw new ContractViolation('E_SIGN_CAPABILITY', 'Owner sign capability binding is invalid');
  }
  const manifestHash = sha256Hex(canonicalBytesV1(manifest));
  if (options.payload.key_id !== identity.key_id
    || options.payload.frozen_base_commit !== manifest.frozen_base_commit
    || options.payload.frozen_base_tree !== manifest.frozen_base_tree
    || options.payload.manifest_revision !== manifest.revision
    || options.payload.lease_generation !== manifest.lease_generation
    || options.payload.manifest_hash !== manifestHash) {
    throw new ContractViolation('E_SIGN_CAPABILITY', 'Handoff immutable manifest binding is invalid');
  }
  const key = readAndValidateKey(
    keyPath(options.workspace_path, options.run_id, `${options.wave}.hmac`),
    identity.key_sha256,
  );
  return signHandoff(options.payload, key, identity.key_id);
}

function assertHandoffManifestBinding(
  manifest: RunManifestV1,
  payload: HandoffPayloadV1,
): void {
  const currentHash = sha256Hex(canonicalBytesV1(manifest));
  const current = payload.manifest_revision === manifest.revision
    && payload.lease_generation === manifest.lease_generation
    && payload.manifest_hash === currentHash;
  const immediatePredecessor = manifest.previous_manifest_hash !== null
    && payload.manifest_revision + 1 === manifest.revision
    && payload.lease_generation + 1 === manifest.lease_generation
    && payload.manifest_hash === manifest.previous_manifest_hash;
  if (!current && !immediatePredecessor) {
    throw new ContractViolation(
      'E_HANDOFF_SIGNATURE',
      'Handoff manifest revision, hash, or lease generation is stale or foreign',
    );
  }
}

export function verifyWaveHandoff(options: {
  workspace_path: string;
  run_id: string;
  envelope: SignedHandoffV1;
}): void {
  if (typeof options.envelope !== 'object' || options.envelope === null
    || typeof options.envelope.signed_payload !== 'object'
    || options.envelope.signed_payload === null) {
    throw new ContractViolation('E_HANDOFF_SIGNATURE', 'Signed handoff envelope is malformed');
  }
  validateHandoffPayload(options.envelope.signed_payload);
  const location = manifestLocation(options.workspace_path, options.run_id);
  const manifest = readRunManifest(location.manifest_path);
  assertManifestBindings(manifest, options.workspace_path, options.run_id, location);
  const identity = manifest.owner_keys.find((entry) => entry.wave === options.envelope.signed_payload.wave);
  if (identity === undefined || identity.owner !== options.envelope.signed_payload.owner
    || identity.key_id !== options.envelope.signed_payload.key_id
    || options.envelope.signed_payload.run_id !== options.run_id
    || options.envelope.signed_payload.repository_id !== 'OMA'
    || options.envelope.signed_payload.frozen_base_commit !== manifest.frozen_base_commit
    || options.envelope.signed_payload.frozen_base_tree !== manifest.frozen_base_tree) {
    throw new ContractViolation('E_HANDOFF_SIGNATURE', 'Handoff is foreign to this run');
  }
  assertHandoffManifestBinding(manifest, options.envelope.signed_payload);
  const key = readAndValidateKey(
    keyPath(options.workspace_path, options.run_id, `${identity.wave}.hmac`),
    identity.key_sha256,
  );
  verifyHandoff(options.envelope, key, identity.key_id);
}

function waveArtifactRoot(workspacePath: string, runId: string, wave: OmaWaveId): string {
  const workspace = fs.realpathSync(path.resolve(workspacePath));
  const location = manifestLocation(workspace, runId);
  return resolveConfinedPath(
    workspace,
    path.join('.agy', 'artifacts', 'dual-parity', location.run_key, wave),
  );
}

export function expectedRepositoryAggregatePath(workspacePath: string, runId: string): string {
  const workspace = fs.realpathSync(path.resolve(workspacePath));
  const location = manifestLocation(workspace, runId);
  return resolveConfinedPath(
    workspace,
    path.join(
      '.agy',
      'artifacts',
      'dual-parity',
      location.run_key,
      'OMA-W6',
      'aggregate-handoff.json',
    ),
  );
}

export function expectedFinalSigningJournalPath(workspacePath: string, runId: string): string {
  const workspace = fs.realpathSync(path.resolve(workspacePath));
  const location = manifestLocation(workspace, runId);
  return resolveConfinedPath(
    workspace,
    path.join(
      '.agy',
      'artifacts',
      'dual-parity',
      location.run_key,
      'OMA-W6',
      'finalization-journal.json',
    ),
  );
}

function validateRepositoryAggregateStore(
  value: unknown,
  manifest: RunManifestV1,
): RepositoryAggregateHandoffV1 {
  const store = aggregateObject(value, 'repository aggregate handoff');
  assertExactObjectKeys(store, AGGREGATE_HANDOFF_KEYS, 'repository aggregate handoff');
  if (store.store_kind !== 'repo_aggregate_handoff' || store.schema_version !== 1
    || store.repository_id !== 'OMA' || store.run_id !== manifest.run_id) {
    throw new ContractViolation('E_AGGREGATE_CAS', 'Repository aggregate handoff identity is invalid');
  }
  if (store.revision !== 1 && store.revision !== 2) {
    throw new ContractViolation('E_AGGREGATE_CAS', 'Repository aggregate revision must be 1 or 2');
  }
  validateAggregateEnvelopeShape(store.input_envelope, 'repository input aggregate envelope');
  if (store.revision === 1) {
    if (store.previous_aggregate_hash !== null || store.final_envelope !== null) {
      throw new ContractViolation(
        'E_AGGREGATE_CAS',
        'Revision-1 repository aggregate must have null predecessor and final envelope',
      );
    }
  } else {
    assertSha256(store.previous_aggregate_hash, 'previous_aggregate_hash');
    validateAggregateEnvelopeShape(store.final_envelope, 'repository final aggregate envelope');
    const predecessor = {
      ...store,
      revision: 1,
      previous_aggregate_hash: null,
      final_envelope: null,
    };
    if (store.previous_aggregate_hash !== sha256Hex(canonicalBytesV1(predecessor))) {
      throw new ContractViolation(
        'E_AGGREGATE_CAS',
        'Repository aggregate predecessor hash does not bind revision 1',
      );
    }
  }
  return store as unknown as RepositoryAggregateHandoffV1;
}

function readRepositoryAggregateStore(
  workspacePath: string,
  manifest: RunManifestV1,
): { store: RepositoryAggregateHandoffV1; path: string; bytes: Buffer } {
  const target = expectedRepositoryAggregatePath(workspacePath, manifest.run_id);
  const object = readAggregateArtifact(target, 'repository aggregate handoff');
  const bytes = fs.readFileSync(target);
  return {
    store: validateRepositoryAggregateStore(object, manifest),
    path: target,
    bytes,
  };
}

function finalizationJournalSignature(
  journal: Omit<FinalSigningTransactionJournalV1, 'signature'>,
  key: Buffer,
): string {
  return crypto.createHmac('sha256', key)
    .update('OMA_REPO_AGGREGATE_FINALIZATION_JOURNAL_V1', 'utf8')
    .update(Buffer.from([0]))
    .update(canonicalBytesV1(journal))
    .digest('hex');
}

function removeDurableFile(targetPath: string): void {
  fs.unlinkSync(targetPath);
  const descriptor = fs.openSync(path.dirname(targetPath), 'r');
  try {
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readFinalizationJournal(
  workspacePath: string,
  runId: string,
): { journal: FinalSigningTransactionJournalV1; path: string } | null {
  const target = expectedFinalSigningJournalPath(workspacePath, runId);
  if (!fs.existsSync(target)) return null;
  const object = readAggregateArtifact(target, 'repository aggregate finalization journal');
  assertExactObjectKeys(object, FINAL_SIGNING_JOURNAL_KEYS, 'repository aggregate finalization journal');
  if (object.store_kind !== 'repo_aggregate_finalization_journal'
    || object.schema_version !== 1 || object.repository_id !== 'OMA' || object.run_id !== runId) {
    throw new ContractViolation('E_AGGREGATE_TRANSACTION', 'Finalization journal identity is invalid');
  }
  assertSha256(object.signature, 'finalization journal signature');
  return { journal: object as unknown as FinalSigningTransactionJournalV1, path: target };
}

interface ReconciledFinalizationV1 {
  envelope: AggregateEnvelopeV1<RepositoryAggregateFinalPayloadV1>;
  base_revision: number;
  base_lease_generation: number;
}

function reconcileFinalizationJournal(
  workspacePath: string,
  runId: string,
  location: RunManifestLocationV1,
): ReconciledFinalizationV1 | null {
  const located = readFinalizationJournal(workspacePath, runId);
  if (located === null) return null;
  const { journal, path: journalPath } = located;
  const baseManifest = validateRunManifest(journal.base_manifest);
  const desiredManifest = validateRunManifest(journal.desired_manifest);
  const baseAggregate = validateRepositoryAggregateStore(journal.base_aggregate, baseManifest);
  const desiredAggregate = validateRepositoryAggregateStore(journal.desired_aggregate, desiredManifest);
  if (baseManifest.run_id !== runId || desiredManifest.run_id !== runId
    || baseManifest.state !== 'composition_active' || desiredManifest.state !== 'signing_revoked'
    || baseAggregate.revision !== 1 || baseAggregate.final_envelope !== null
    || desiredAggregate.revision !== 2 || desiredAggregate.final_envelope === null) {
    throw new ContractViolation('E_AGGREGATE_TRANSACTION', 'Finalization journal phase is invalid');
  }
  const expectedManifest = buildManifestTransition(
    baseManifest,
    sha256Hex(canonicalBytesV1(baseManifest)),
    'signing_revoked',
    desiredManifest.updated_at,
    true,
  );
  const expectedAggregate: RepositoryAggregateHandoffV1 = {
    ...baseAggregate,
    revision: 2,
    previous_aggregate_hash: sha256Hex(canonicalBytesV1(baseAggregate)),
    final_envelope: desiredAggregate.final_envelope,
  };
  if (!canonicalEqual(desiredManifest, expectedManifest)
    || !canonicalEqual(desiredAggregate, expectedAggregate)) {
    throw new ContractViolation('E_AGGREGATE_TRANSACTION', 'Finalization journal transition is not exact');
  }
  const finalPayload = validateFinalAggregatePayload(desiredAggregate.final_envelope.payload);
  assertManifestBindings(baseManifest, workspacePath, runId, location, finalPayload.pushed_oid);
  const key = aggregateKey(workspacePath, baseManifest, location);
  const unsigned = { ...journal } as Partial<FinalSigningTransactionJournalV1>;
  delete unsigned.signature;
  const expectedSignature = finalizationJournalSignature(
    unsigned as Omit<FinalSigningTransactionJournalV1, 'signature'>,
    key,
  );
  if (!crypto.timingSafeEqual(
    Buffer.from(journal.signature, 'hex'),
    Buffer.from(expectedSignature, 'hex'),
  )) {
    throw new ContractViolation('E_AGGREGATE_TRANSACTION', 'Finalization journal signature is invalid');
  }
  verifyRepositoryAggregateInternal({
    workspace_path: workspacePath,
    phase: 'final',
    envelope: desiredAggregate.final_envelope,
    manifest: baseManifest,
    location,
  });

  const aggregatePath = expectedRepositoryAggregatePath(workspacePath, runId);
  const manifestStat = fs.lstatSync(location.manifest_path);
  const aggregateStat = fs.lstatSync(aggregatePath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink()
    || !aggregateStat.isFile() || aggregateStat.isSymbolicLink()) {
    throw new ContractViolation('E_AGGREGATE_TRANSACTION', 'Finalization targets must be regular files');
  }
  const actualManifestBytes = fs.readFileSync(location.manifest_path);
  const actualAggregateBytes = fs.readFileSync(aggregatePath);
  const baseManifestBytes = canonicalBytesV1(baseManifest);
  const desiredManifestBytes = canonicalBytesV1(desiredManifest);
  const baseAggregateBytes = canonicalBytesV1(baseAggregate);
  const desiredAggregateBytes = canonicalBytesV1(desiredAggregate);
  if ((!actualManifestBytes.equals(baseManifestBytes) && !actualManifestBytes.equals(desiredManifestBytes))
    || (!actualAggregateBytes.equals(baseAggregateBytes) && !actualAggregateBytes.equals(desiredAggregateBytes))) {
    throw new ContractViolation(
      'E_AGGREGATE_TRANSACTION',
      'Finalization targets diverged from both the journal predecessor and desired bytes',
    );
  }
  if (!actualAggregateBytes.equals(desiredAggregateBytes) || (aggregateStat.mode & 0o777) !== 0o600) {
    atomicWriteFile(aggregatePath, desiredAggregateBytes, { mode: 0o600 });
  }
  if (!actualManifestBytes.equals(desiredManifestBytes) || (manifestStat.mode & 0o777) !== 0o600) {
    atomicWriteFile(location.manifest_path, desiredManifestBytes, { mode: 0o600 });
  }
  if (!fs.readFileSync(aggregatePath).equals(desiredAggregateBytes)
    || !fs.readFileSync(location.manifest_path).equals(desiredManifestBytes)
    || (fs.lstatSync(aggregatePath).mode & 0o777) !== 0o600
    || (fs.lstatSync(location.manifest_path).mode & 0o777) !== 0o600) {
    throw new ContractViolation('E_AGGREGATE_TRANSACTION', 'Finalization reconciliation did not converge');
  }
  removeDurableFile(journalPath);
  return {
    envelope: desiredAggregate.final_envelope,
    base_revision: baseManifest.revision,
    base_lease_generation: baseManifest.lease_generation,
  };
}

function validateOmaW6RequestDocument(
  value: unknown,
  index: Pick<ProposalIndexV1, 'repository_id' | 'run_id' | 'wave'>,
): void {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractViolation('E_W6_REQUEST_SCHEMA', 'W6 request must be a canonical JSON object');
  }
  const request = value as Record<string, unknown>;
  assertExactObjectKeys(request, W6_REQUEST_DOCUMENT_KEYS, 'OMA W6 request');
  if (request.store_kind !== 'oma_cross_wave_packaging_request'
    || request.schema_version !== 1
    || request.repository_id !== index.repository_id
    || request.run_id !== index.run_id
    || request.from_wave !== index.wave
    || request.to_wave !== 'OMA-W6') {
    throw new ContractViolation(
      'E_W6_REQUEST_SCHEMA',
      'OMA W6 request identity does not match its proposal index',
    );
  }
  assertNonEmptyString(request.owner_boundary, 'OMA W6 request owner_boundary');
  if (!Array.isArray(request.requests) || request.requests.length === 0
    || !Array.isArray(request.acceptance) || request.acceptance.length === 0
    || !Array.isArray(request.validation_argv) || request.validation_argv.length === 0) {
    throw new ContractViolation(
      'E_W6_REQUEST_SCHEMA',
      'OMA W6 request requires non-empty requests, acceptance, and validation argv',
    );
  }
  const requestIds = new Set<string>();
  request.requests.forEach((value, position) => {
    const row = aggregateObject(value, `OMA W6 request requests[${position}]`);
    assertExactObjectKeys(row, W6_REQUEST_ITEM_KEYS, `OMA W6 request requests[${position}]`);
    assertNonEmptyString(row.request, `OMA W6 request requests[${position}].request`);
    assertNonEmptyString(row.required_action, `OMA W6 request requests[${position}].required_action`);
    if (!/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/.test(row.request as string)
      || requestIds.has(row.request as string)) {
      throw new ContractViolation(
        'E_W6_REQUEST_SCHEMA',
        'OMA W6 request IDs must be unique canonical snake_case identifiers',
      );
    }
    requestIds.add(row.request as string);
  });
  for (const [label, values] of [
    ['acceptance', request.acceptance],
    ['validation_argv', request.validation_argv],
  ] as const) {
    if ((values as unknown[]).some((entry) => typeof entry !== 'string' || entry.trim() === '')
      || new Set(values as string[]).size !== (values as unknown[]).length) {
      throw new ContractViolation(
        'E_W6_REQUEST_SCHEMA',
        `OMA W6 request ${label} must be unique non-empty strings`,
      );
    }
  }
}

export function verifyW6RequestBindings(options: {
  workspace_path: string;
  index: ProposalIndexV1;
}): void {
  validateProposalIndex(options.index);
  const workspace = fs.realpathSync(path.resolve(options.workspace_path));
  const expectedRoot = waveArtifactRoot(workspace, options.index.run_id, options.index.wave);
  for (const binding of options.index.w6_requests) {
    const requestPath = resolveConfinedPath(workspace, binding.path);
    if (!requestPath.startsWith(`${expectedRoot}${path.sep}`)) {
      throw new ContractViolation(
        'E_W6_REQUEST_PATH',
        'W6 request path is outside its exact run/wave artifact root',
      );
    }
    if (!fs.existsSync(requestPath)) {
      throw new ContractViolation('E_W6_REQUEST_BYTES', 'Bound W6 request file does not exist');
    }
    const stat = fs.lstatSync(requestPath);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
      throw new ContractViolation(
        'E_W6_REQUEST_MODE',
        'W6 request must be a regular, non-symlink 0600 file',
      );
    }
    const bytes = fs.readFileSync(requestPath);
    if (stat.size !== binding.byte_length || bytes.length !== binding.byte_length
      || sha256Hex(bytes) !== binding.sha256) {
      throw new ContractViolation(
        'E_W6_REQUEST_BYTES',
        'W6 request bytes do not match their exact length/hash binding',
      );
    }
    validateOmaW6RequestDocument(parseCanonicalJsonV1(bytes), options.index);
  }
}

function writeOnceCanonical0600(targetPath: string, value: unknown): void {
  const bytes = canonicalBytesV1(value);
  if (fs.existsSync(targetPath)) {
    const current = fs.readFileSync(targetPath);
    if (current.compare(bytes) !== 0) {
      throw new ContractViolation('E_ALREADY_EXISTS', 'Immutable handoff artifact already has different bytes');
    }
    return;
  }
  atomicWriteFile(targetPath, bytes, { mode: 0o600 });
}

export function writeWaveHandoffArtifacts(
  input: WriteWaveHandoffArtifactsInputV1,
): WaveHandoffArtifactsV1 {
  assertExactObjectKeys(
    input as unknown as Record<string, unknown>,
    HANDOFF_INPUT_KEYS,
    'wave handoff input',
  );
  const location = manifestLocation(input.workspace_path, input.run_id);
  const manifest = readRunManifest(location.manifest_path);
  assertManifestBindings(manifest, input.workspace_path, input.run_id, location);
  const identity = manifest.owner_keys.find((entry) => entry.wave === input.wave);
  if (identity === undefined || identity.owner !== input.owner
    || manifest.revision !== input.expected_manifest_revision) {
    throw new ContractViolation('E_SIGN_CAPABILITY', 'Wave handoff request is stale or has the wrong owner');
  }
  const expectedParentWaves = PARENT_HASH_ORACLE_V1[input.wave];
  if (input.parent_handoffs.length !== expectedParentWaves.length) {
    throw new ContractViolation('E_HANDOFF_PARENT_ORDER', 'Every exact parent handoff is required');
  }
  const parentHandoffs = expectedParentWaves.map((parentWave, index) => {
    const expectedParentPath = path.join(
      waveArtifactRoot(input.workspace_path, input.run_id, parentWave),
      'handoff.json',
    );
    verifyWaveHandoffArtifacts({
      workspace_path: input.workspace_path,
      run_id: input.run_id,
      handoff_path: expectedParentPath,
    });
    const onDisk = readCanonicalObject(expectedParentPath) as unknown as SignedHandoffV1;
    const supplied = input.parent_handoffs[index];
    if (onDisk.signed_payload.wave !== parentWave
      || canonicalBytesV1(onDisk).compare(canonicalBytesV1(supplied)) !== 0) {
      throw new ContractViolation(
        'E_HANDOFF_PARENT_HASH',
        'Caller-supplied parent is not the verified current on-disk parent envelope',
      );
    }
    return onDisk;
  });
  const parentHashes = parentHandoffs.map((parent) => handoffHash(parent));
  validateParentHandoffHashes(
    input.wave,
    expectedParentWaves,
    parentHashes,
    parentHandoffs,
    {
      repository_id: 'OMA',
      run_id: manifest.run_id,
      frozen_base_commit: manifest.frozen_base_commit,
      frozen_base_tree: manifest.frozen_base_tree,
      current_manifest_revision: manifest.revision,
      current_lease_generation: manifest.lease_generation,
      current_manifest_hash: sha256Hex(canonicalBytesV1(manifest)),
      previous_manifest_hash: manifest.previous_manifest_hash,
    },
  );
  const index = createProposalIndex({
    store_kind: 'dual_parity_proposal_index',
    schema_version: 1,
    repository_id: 'OMA',
    run_id: input.run_id,
    wave: input.wave,
    owner: input.owner,
    frozen_base_commit: manifest.frozen_base_commit,
    frozen_base_tree: manifest.frozen_base_tree,
    proposals: input.proposals,
    w6_requests: input.w6_requests,
    created_at: input.completed_at,
  });
  verifyW6RequestBindings({ workspace_path: input.workspace_path, index });
  const proposalIndexHash = sha256Hex(canonicalBytesV1(index));
  const payload: HandoffPayloadV1 = {
    store_kind: 'dual_parity_handoff',
    schema_version: 1,
    repository_id: 'OMA',
    run_id: input.run_id,
    wave: input.wave,
    owner: input.owner,
    key_id: identity.key_id,
    frozen_base_commit: manifest.frozen_base_commit,
    frozen_base_tree: manifest.frozen_base_tree,
    manifest_revision: manifest.revision,
    lease_generation: manifest.lease_generation,
    manifest_hash: sha256Hex(canonicalBytesV1(manifest)),
    proposal_index_hash: proposalIndexHash,
    proposal_merkle_root: index.proposal_merkle_root,
    parent_waves: [...expectedParentWaves],
    parent_handoff_hashes: parentHashes,
    completed_at: input.completed_at,
  };
  const envelope = signWaveHandoff({
    workspace_path: input.workspace_path,
    run_id: input.run_id,
    wave: input.wave,
    owner: input.owner,
    expected_manifest_revision: input.expected_manifest_revision,
    payload,
  });
  const root = waveArtifactRoot(input.workspace_path, input.run_id, input.wave);
  const proposalIndexPath = path.join(root, 'proposal-index.json');
  const handoffPath = path.join(root, 'handoff.json');
  writeOnceCanonical0600(proposalIndexPath, index);
  writeOnceCanonical0600(handoffPath, envelope);
  verifyWaveHandoffArtifacts({
    workspace_path: input.workspace_path,
    run_id: input.run_id,
    handoff_path: handoffPath,
  });
  return {
    proposal_index_path: proposalIndexPath,
    proposal_index_hash: proposalIndexHash,
    proposal_merkle_root: index.proposal_merkle_root,
    handoff_path: handoffPath,
    handoff_hash: handoffHash(envelope),
    signature: envelope.signature,
  };
}

export function verifyWaveHandoffArtifacts(input: {
  workspace_path: string;
  run_id: string;
  handoff_path: string;
}): WaveHandoffArtifactsV1 {
  const envelope = readCanonicalObject(input.handoff_path) as unknown as SignedHandoffV1;
  if (typeof envelope.signed_payload !== 'object' || envelope.signed_payload === null) {
    throw new ContractViolation('E_HANDOFF_SIGNATURE', 'Signed handoff envelope is malformed');
  }
  validateHandoffPayload(envelope.signed_payload);
  const wave = envelope.signed_payload.wave;
  const expectedRoot = waveArtifactRoot(input.workspace_path, input.run_id, wave);
  const expectedHandoffPath = path.join(expectedRoot, 'handoff.json');
  if (path.resolve(input.handoff_path) !== expectedHandoffPath) {
    throw new ContractViolation('E_HANDOFF_PATH', 'Handoff path is outside its exact run/wave root');
  }
  const proposalIndexPath = path.join(expectedRoot, 'proposal-index.json');
  const index = readCanonicalObject(proposalIndexPath) as unknown as ProposalIndexV1;
  validateProposalIndex(index);
  verifyW6RequestBindings({ workspace_path: input.workspace_path, index });
  if (index.repository_id !== envelope.signed_payload.repository_id
    || index.run_id !== envelope.signed_payload.run_id || index.wave !== wave
    || index.owner !== envelope.signed_payload.owner
    || index.frozen_base_commit !== envelope.signed_payload.frozen_base_commit
    || index.frozen_base_tree !== envelope.signed_payload.frozen_base_tree
    || sha256Hex(canonicalBytesV1(index)) !== envelope.signed_payload.proposal_index_hash
    || index.proposal_merkle_root !== envelope.signed_payload.proposal_merkle_root) {
    throw new ContractViolation('E_HANDOFF_PROPOSAL', 'Handoff does not bind its exact proposal index');
  }
  verifyWaveHandoff({
    workspace_path: input.workspace_path,
    run_id: input.run_id,
    envelope,
  });
  return {
    proposal_index_path: proposalIndexPath,
    proposal_index_hash: envelope.signed_payload.proposal_index_hash,
    proposal_merkle_root: envelope.signed_payload.proposal_merkle_root,
    handoff_path: expectedHandoffPath,
    handoff_hash: handoffHash(envelope),
    signature: envelope.signature,
  };
}

function aggregateObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype
      && Object.getPrototypeOf(value) !== null)) {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', `${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  return canonicalBytesV1(left).compare(canonicalBytesV1(right)) === 0;
}

function assertOmaReleasePolicy(
  channels: readonly string[],
  registries: readonly ClaimedRegistryPolicyV1[],
): void {
  if (!canonicalEqual(channels, ['github']) || !canonicalEqual(registries, [])) {
    throw new ContractViolation(
      'E_AGGREGATE_RELEASE_POLICY',
      'OMA aggregates are GitHub Release-only and must claim an explicitly empty registry policy',
    );
  }
}

function validateAggregateManifestBindingShape(
  payload: Record<string, unknown>,
): asserts payload is Record<string, unknown> & RepositoryAggregateManifestBindingV1 {
  if (payload.repository_id !== 'OMA' || typeof payload.run_id !== 'string'
    || payload.run_id.trim() === '' || payload.run_key !== safePathKey(payload.run_id)
    || payload.ownership_manifest_id !== 'dual-parity-writers-v1') {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', 'Aggregate repository/run/ownership identity is invalid');
  }
  for (const field of [
    'run_manifest_path', 'approved_branch', 'approved_remote', 'trust_root_path',
  ] as const) assertNonEmptyString(payload[field], field);
  if (!Number.isSafeInteger(payload.run_manifest_revision)
    || (payload.run_manifest_revision as number) < 1
    || !Number.isSafeInteger(payload.lease_generation)
    || (payload.lease_generation as number) < 1) {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', 'Aggregate manifest revision/lease is invalid');
  }
  for (const field of [
    'run_manifest_hash', 'trust_root_hash', 'ownership_manifest_hash',
  ] as const) assertSha256(payload[field], field);
  for (const field of [
    'frozen_base_commit', 'frozen_base_tree', 'approved_remote_old_oid',
  ] as const) assertGitObjectId(payload[field], field);
  validateNormativePlanHashes(payload.normative_plan_hashes);
  if (!Array.isArray(payload.claimed_release_channels)
    || !Array.isArray(payload.claimed_registry_policy)) {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', 'Aggregate release policy arrays are invalid');
  }
  assertOmaReleasePolicy(
    payload.claimed_release_channels as string[],
    payload.claimed_registry_policy as ClaimedRegistryPolicyV1[],
  );
}

function validateW6RequestRow(value: unknown, label: string): W6RequestBindingV1 {
  const row = aggregateObject(value, label);
  assertExactObjectKeys(row, ['path', 'byte_length', 'sha256'], label);
  assertNonEmptyString(row.path, `${label}.path`);
  if (!Number.isSafeInteger(row.byte_length) || (row.byte_length as number) <= 0) {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', `${label}.byte_length must be positive`);
  }
  assertSha256(row.sha256, `${label}.sha256`);
  return row as unknown as W6RequestBindingV1;
}

function validateAggregateOwnerRoot(
  value: unknown,
  index: number,
): RepositoryAggregateOwnerRootV1 {
  const label = `ordered_owner_roots[${index}]`;
  const row = aggregateObject(value, label);
  assertExactObjectKeys(row, AGGREGATE_OWNER_ROOT_KEYS, label);
  const expected = OMA_OWNER_ROWS_V1[index];
  if (expected === undefined || row.wave !== expected[0] || row.owner !== expected[1]) {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', 'Owner roots must be exact ordered OMA-W0..W5 rows');
  }
  for (const field of [
    'key_id', 'proposal_index_hash', 'proposal_merkle_root', 'handoff_hash', 'signature',
  ] as const) assertSha256(row[field], `${label}.${field}`);
  for (const field of ['proposal_index_path', 'handoff_path'] as const) {
    assertNonEmptyString(row[field], `${label}.${field}`);
  }
  if (!Number.isSafeInteger(row.proposal_count) || (row.proposal_count as number) <= 0) {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', `${label}.proposal_count must be positive`);
  }
  if (!Array.isArray(row.parent_handoff_hashes) || !Array.isArray(row.w6_requests)) {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', `${label} arrays are invalid`);
  }
  const expectedParentCount = PARENT_HASH_ORACLE_V1[expected[0]].length;
  if (row.parent_handoff_hashes.length !== expectedParentCount) {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', `${label} parent DAG cardinality is invalid`);
  }
  row.parent_handoff_hashes.forEach((hash, position) =>
    assertSha256(hash, `${label}.parent_handoff_hashes[${position}]`));
  const requests = row.w6_requests.map((request, position) =>
    validateW6RequestRow(request, `${label}.w6_requests[${position}]`));
  return { ...(row as unknown as RepositoryAggregateOwnerRootV1), w6_requests: requests };
}

function validateInputAggregatePayload(value: unknown): RepositoryAggregateInputPayloadV1 {
  const payload = aggregateObject(value, 'input aggregate payload');
  assertExactObjectKeys(payload, AGGREGATE_INPUT_KEYS, 'input aggregate payload');
  if (payload.store_kind !== 'repo_aggregate_input_payload' || payload.schema_version !== 1) {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', 'Input aggregate schema identity is invalid');
  }
  validateAggregateManifestBindingShape(payload);
  assertSha256(payload.writers_manifest_hash, 'writers_manifest_hash');
  if (!Array.isArray(payload.ordered_owner_roots) || payload.ordered_owner_roots.length !== 6) {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', 'Input aggregate requires exactly six owner roots');
  }
  const roots = payload.ordered_owner_roots.map(validateAggregateOwnerRoot);
  const known = new Map<OmaWriterWaveIdV1, string>();
  for (const root of roots) {
    const expectedParents = PARENT_HASH_ORACLE_V1[root.wave]
      .map((wave) => known.get(wave as OmaWriterWaveIdV1));
    if (expectedParents.some((hash) => hash === undefined)
      || !canonicalEqual(root.parent_handoff_hashes, expectedParents)) {
      throw new ContractViolation('E_AGGREGATE_SCHEMA', 'Owner root parent DAG hashes are missing or substituted');
    }
    known.set(root.wave, root.handoff_hash);
  }
  const rootHashes = roots.map((root) => root.handoff_hash);
  if (new Set(rootHashes).size !== rootHashes.length
    || !Array.isArray(payload.parent_handoff_hashes)
    || !canonicalEqual(payload.parent_handoff_hashes, rootHashes)) {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', 'Aggregate parent hashes must equal six unique owner roots');
  }
  const expectedPathTestRoot = merkleRootV1(roots.map((root) => ({
    path: root.wave,
    hash: root.proposal_merkle_root,
  })));
  assertSha256(payload.path_test_merkle_root, 'path_test_merkle_root');
  if (payload.path_test_merkle_root !== expectedPathTestRoot) {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', 'path_test_merkle_root differs from owner proposal roots');
  }
  if (!Array.isArray(payload.accepted_w6_proposals)) {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', 'accepted_w6_proposals must be an array');
  }
  const accepted = payload.accepted_w6_proposals.map((value, index) => {
    const label = `accepted_w6_proposals[${index}]`;
    const row = aggregateObject(value, label);
    assertExactObjectKeys(row, ACCEPTED_W6_PROPOSAL_KEYS, label);
    if (!OMA_OWNER_ROWS_V1.some(([wave]) => wave === row.wave)) {
      throw new ContractViolation('E_AGGREGATE_SCHEMA', `${label}.wave is invalid`);
    }
    const request = validateW6RequestRow({
      path: row.path,
      byte_length: row.byte_length,
      sha256: row.sha256,
    }, label);
    return { wave: row.wave as OmaWriterWaveIdV1, ...request };
  });
  const expectedAccepted = roots.flatMap((root) =>
    root.w6_requests.map((request) => ({ wave: root.wave, ...request })));
  if (!canonicalEqual(accepted, expectedAccepted)) {
    throw new ContractViolation(
      'E_AGGREGATE_SCHEMA',
      'accepted_w6_proposals must exactly equal the ordered owner request bindings',
    );
  }
  if (payload.final_commit !== null) {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', 'Input aggregate final_commit must be null');
  }
  return payload as unknown as RepositoryAggregateInputPayloadV1;
}

function validateAggregateEnvelopeShape(value: unknown, label: string): AggregateEnvelopeV1<unknown> {
  const envelope = aggregateObject(value, label);
  assertExactObjectKeys(envelope, AGGREGATE_ENVELOPE_KEYS, label);
  if (envelope.algorithm !== 'HMAC-SHA256') {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', `${label} algorithm is invalid`);
  }
  for (const field of ['signer_id', 'key_id'] as const) assertNonEmptyString(envelope[field], field);
  for (const field of ['payload_hash', 'signature'] as const) assertSha256(envelope[field], field);
  aggregateObject(envelope.payload, `${label}.payload`);
  return envelope as unknown as AggregateEnvelopeV1<unknown>;
}

function validateFinalAggregatePayload(value: unknown): RepositoryAggregateFinalPayloadV1 {
  const payload = aggregateObject(value, 'final aggregate payload');
  assertExactObjectKeys(payload, AGGREGATE_FINAL_KEYS, 'final aggregate payload');
  if (payload.store_kind !== 'repo_aggregate_final_payload' || payload.schema_version !== 1) {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', 'Final aggregate schema identity is invalid');
  }
  validateAggregateManifestBindingShape(payload);
  validateAggregateEnvelopeShape(payload.input_envelope, 'input aggregate envelope');
  for (const field of ['candidate_commit', 'candidate_tree', 'pushed_oid'] as const) {
    assertGitObjectId(payload[field], field);
  }
  if (payload.candidate_commit !== payload.pushed_oid) {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', 'pushed_oid must equal candidate_commit');
  }
  for (const field of [
    'input_aggregate_hash', 'complete_delta_root', 'deterministic_proof_hash', 'live_proof_hash',
    'code_review_proof_hash', 'ultraqa_proof_hash', 'release_bundle_manifest_sha256',
    'release_asset_root',
  ] as const) assertSha256(payload[field], field);
  assertNonEmptyString(payload.semver, 'semver');
  if (!SEMVER_PATTERN.test(payload.semver)) {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', 'semver is invalid');
  }
  assertNonEmptyString(payload.release_nonce, 'release_nonce');
  safePathKey(payload.release_nonce);
  assertNonEmptyString(payload.release_bundle_manifest_path, 'release_bundle_manifest_path');
  if (payload.release_bundle_manifest_schema !== 'release_bundle_manifest/1') {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', 'release bundle manifest schema is invalid');
  }
  const expectedOrder = [`iml1s-oh-my-agy-${payload.semver}.tgz`, 'SHA256SUMS'];
  if (!Array.isArray(payload.public_upload_order)
    || !canonicalEqual(payload.public_upload_order, expectedOrder)) {
    throw new ContractViolation('E_AGGREGATE_SCHEMA', 'public_upload_order is not OMA release exact');
  }
  return payload as unknown as RepositoryAggregateFinalPayloadV1;
}

function readAggregateArtifact(targetPath: string, label: string): Record<string, unknown> {
  if (!fs.existsSync(targetPath)) {
    throw new ContractViolation('E_AGGREGATE_ARTIFACT', `${label} is missing`);
  }
  const stat = fs.lstatSync(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    throw new ContractViolation('E_AGGREGATE_ARTIFACT', `${label} must be a canonical 0600 regular file`);
  }
  return readCanonicalObject(targetPath);
}

function withWorkspace<T>(workspacePath: string, callback: () => T): T {
  const previous = process.cwd();
  process.chdir(fs.realpathSync(path.resolve(workspacePath)));
  try {
    return callback();
  } finally {
    process.chdir(previous);
  }
}

function frozenBasePathBytes(
  workspace: string,
  baseCommit: string,
  repositoryPath: string,
): Buffer | null {
  const exists = spawnSync(
    'git',
    ['-C', workspace, 'cat-file', '-e', `${baseCommit}:${repositoryPath}`],
    { encoding: 'utf8' },
  );
  if (exists.status !== 0) {
    if (exists.status === 128) return null;
    throw new ContractViolation('E_GIT_BINDING', 'Unable to inspect frozen-base proposal path', {
      path: repositoryPath,
      stderr: String(exists.stderr).trim(),
    });
  }
  return runGit(workspace, ['show', `${baseCommit}:${repositoryPath}`]);
}

function verifyCurrentProposalProduct(
  workspace: string,
  manifest: RunManifestV1,
  expectedWave: OmaWriterWaveIdV1,
  proposal: PathProposalV1,
  ownedPaths: Set<string>,
): void {
  if (ownedPaths.has(proposal.path)) {
    throw new ContractViolation('E_AGGREGATE_ARTIFACT', `Product path has multiple owners: ${proposal.path}`);
  }
  ownedPaths.add(proposal.path);
  let ownership: ReturnType<typeof ownershipForPath>;
  try {
    ownership = ownershipForPath(proposal.path);
  } catch (error) {
    throw new ContractViolation('E_AGGREGATE_OWNERSHIP', 'Proposal path is not owned by the frozen ownership oracle', {
      path: proposal.path,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (ownership.wave !== expectedWave || ownership.owner !== proposal.owner) {
    throw new ContractViolation(
      'E_AGGREGATE_OWNERSHIP',
      `Proposal path owner differs from the frozen oracle: ${proposal.path}`,
    );
  }
  if (proposal.targeted_tests.some((receipt) => receipt.exit_code !== 0)) {
    throw new ContractViolation(
      'E_AGGREGATE_ARTIFACT',
      `Every targeted test must pass for proposal path: ${proposal.path}`,
    );
  }
  const initial = frozenBasePathBytes(workspace, manifest.frozen_base_commit, proposal.path);
  const expectedInitial = initial === null ? 'ABSENT' : sha256Hex(initial);
  if (proposal.initial_sha256 !== expectedInitial) {
    throw new ContractViolation(
      'E_AGGREGATE_ARTIFACT',
      `Proposal frozen-base bytes differ from signed initial hash: ${proposal.path}`,
    );
  }
  const target = resolveConfinedPath(workspace, proposal.path);
  if (proposal.final_sha256 === 'ABSENT') {
    try {
      fs.lstatSync(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    throw new ContractViolation('E_AGGREGATE_ARTIFACT', `Product path expected absent but exists: ${proposal.path}`);
  }
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    throw new ContractViolation('E_AGGREGATE_ARTIFACT', `Product path is missing or unsafe: ${proposal.path}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) {
      throw new ContractViolation('E_AGGREGATE_ARTIFACT', `Product path is not a regular file: ${proposal.path}`);
    }
    if (sha256Hex(fs.readFileSync(descriptor)) !== proposal.final_sha256) {
      throw new ContractViolation(
        'E_AGGREGATE_ARTIFACT',
        `Product path current bytes differ from signed final hash: ${proposal.path}`,
      );
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function assertCompleteOwnerPathUnion(
  workspace: string,
  manifest: RunManifestV1,
  ownedPaths: Set<string>,
): void {
  let dirtyPaths: string[];
  let grouped: ReturnType<typeof validateChangedPathOwnership>;
  try {
    dirtyPaths = withWorkspace(workspace, () => collectInclusiveDirtyPaths(manifest.frozen_base_commit));
    grouped = validateChangedPathOwnership(dirtyPaths);
  } catch (error) {
    throw new ContractViolation('E_AGGREGATE_OWNERSHIP', 'Inclusive changed-path ownership proof failed', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const expected = WRITER_WAVES.flatMap((wave) => grouped[wave])
    .sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
  const supplied = [...ownedPaths].sort((left, right) =>
    Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
  if (!canonicalEqual(supplied, expected)) {
    throw new ContractViolation(
      'E_AGGREGATE_OWNERSHIP',
      'Signed proposal path union differs from the inclusive ownership oracle',
      { supplied, expected },
    );
  }
}

interface AuthenticatedInputEvidenceV1 {
  ordered_owner_roots: RepositoryAggregateOwnerRootV1[];
  parent_handoff_hashes: string[];
  path_test_merkle_root: string;
  accepted_w6_proposals: AcceptedW6ProposalV1[];
}

function authenticatedInputEvidence(
  workspacePath: string,
  manifest: RunManifestV1,
  payload?: RepositoryAggregateInputPayloadV1,
): AuthenticatedInputEvidenceV1 {
  const workspace = fs.realpathSync(path.resolve(workspacePath));
  const roots: RepositoryAggregateOwnerRootV1[] = [];
  const rootHashes = new Map<OmaWriterWaveIdV1, string>();
  const ownedPaths = new Set<string>();
  const expectedWriterRevision = payload === undefined
    ? manifest.revision : payload.run_manifest_revision - 1;
  const expectedWriterLease = payload === undefined
    ? manifest.lease_generation : payload.lease_generation - 1;
  const expectedWriterHash = payload === undefined
    ? sha256Hex(canonicalBytesV1(manifest)) : payload.writers_manifest_hash;
  if (expectedWriterRevision < 0 || expectedWriterLease < 1) {
    throw new ContractViolation('E_AGGREGATE_ARTIFACT', 'Input aggregate writer predecessor is invalid');
  }
  for (const [wave, owner] of OMA_OWNER_ROWS_V1) {
    const root = waveArtifactRoot(workspace, manifest.run_id, wave);
    const proposalPath = path.join(root, 'proposal-index.json');
    const handoffPath = path.join(root, 'handoff.json');
    const index = readAggregateArtifact(proposalPath, `${wave} proposal index`) as unknown as ProposalIndexV1;
    validateProposalIndex(index);
    verifyW6RequestBindings({ workspace_path: workspace, index });
    if (index.repository_id !== 'OMA' || index.run_id !== manifest.run_id || index.wave !== wave
      || index.owner !== owner || index.frozen_base_commit !== manifest.frozen_base_commit
      || index.frozen_base_tree !== manifest.frozen_base_tree) {
      throw new ContractViolation('E_AGGREGATE_ARTIFACT', `${wave} proposal index is foreign to this run`);
    }
    const envelope = readAggregateArtifact(handoffPath, `${wave} handoff`) as unknown as SignedHandoffV1;
    assertExactObjectKeys(
      envelope as unknown as Record<string, unknown>,
      ['signed_payload', 'signature'],
      `${wave} handoff envelope`,
    );
    assertSha256(envelope.signature, `${wave} handoff signature`);
    aggregateObject(envelope.signed_payload, `${wave} handoff payload`);
    validateHandoffPayload(envelope.signed_payload);
    const identity = manifest.owner_keys.find((entry) => entry.wave === wave);
    if (identity === undefined || identity.owner !== owner
      || envelope.signed_payload.repository_id !== 'OMA'
      || envelope.signed_payload.run_id !== manifest.run_id
      || envelope.signed_payload.wave !== wave || envelope.signed_payload.owner !== owner
      || envelope.signed_payload.key_id !== identity.key_id
      || envelope.signed_payload.frozen_base_commit !== manifest.frozen_base_commit
      || envelope.signed_payload.frozen_base_tree !== manifest.frozen_base_tree
      || envelope.signed_payload.manifest_revision !== expectedWriterRevision
      || envelope.signed_payload.lease_generation !== expectedWriterLease
      || envelope.signed_payload.manifest_hash !== expectedWriterHash) {
      throw new ContractViolation('E_AGGREGATE_ARTIFACT', `${wave} handoff manifest/run identity is stale`);
    }
    const proposalIndexHash = sha256Hex(canonicalBytesV1(index));
    if (envelope.signed_payload.proposal_index_hash !== proposalIndexHash
      || envelope.signed_payload.proposal_merkle_root !== index.proposal_merkle_root) {
      throw new ContractViolation('E_AGGREGATE_ARTIFACT', `${wave} handoff does not bind its proposal index`);
    }
    const expectedParents = PARENT_HASH_ORACLE_V1[wave]
      .map((parent) => rootHashes.get(parent as OmaWriterWaveIdV1));
    if (expectedParents.some((hash) => hash === undefined)
      || !canonicalEqual(envelope.signed_payload.parent_handoff_hashes, expectedParents)) {
      throw new ContractViolation('E_AGGREGATE_ARTIFACT', `${wave} handoff parent DAG differs from current roots`);
    }
    const key = readAndValidateKey(
      keyPath(workspace, manifest.run_id, `${wave}.hmac`),
      identity.key_sha256,
    );
    verifyHandoff(envelope, key, identity.key_id);
    index.proposals.forEach((proposal) =>
      verifyCurrentProposalProduct(workspace, manifest, wave, proposal, ownedPaths));
    const digest = handoffHash(envelope);
    rootHashes.set(wave, digest);
    roots.push({
      wave,
      owner,
      key_id: identity.key_id,
      proposal_index_path: path.relative(workspace, proposalPath).split(path.sep).join('/'),
      proposal_index_hash: proposalIndexHash,
      proposal_count: index.proposal_count,
      proposal_merkle_root: index.proposal_merkle_root,
      handoff_path: path.relative(workspace, handoffPath).split(path.sep).join('/'),
      handoff_hash: digest,
      signature: envelope.signature,
      parent_handoff_hashes: [...envelope.signed_payload.parent_handoff_hashes],
      w6_requests: index.w6_requests.map((request) => ({ ...request })),
    });
  }
  assertCompleteOwnerPathUnion(workspace, manifest, ownedPaths);
  const accepted = roots.flatMap((root) =>
    root.w6_requests.map((request) => ({ wave: root.wave, ...request })));
  return {
    ordered_owner_roots: roots,
    parent_handoff_hashes: roots.map((root) => root.handoff_hash),
    path_test_merkle_root: merkleRootV1(roots.map((root) => ({
      path: root.wave,
      hash: root.proposal_merkle_root,
    }))),
    accepted_w6_proposals: accepted,
  };
}

function expectedAggregateBinding(
  manifest: RunManifestV1,
  phase: 'input' | 'final',
): { revision: number; lease: number; hash: string | null } {
  const states = AGGREGATE_PHASE_STATES[phase];
  const offset = states.indexOf(manifest.state);
  if (offset < 0) {
    throw new ContractViolation(
      'E_AGGREGATE_STATE',
      'Aggregate verification is inactive for the current manifest state',
    );
  }
  const revision = manifest.revision - offset;
  const lease = manifest.lease_generation - offset;
  const hash = offset === 0
    ? sha256Hex(canonicalBytesV1(manifest))
    : offset === 1 ? manifest.previous_manifest_hash : null;
  return { revision, lease, hash };
}

function validateAggregateManifestBinding(
  payload: RepositoryAggregateManifestBindingV1,
  manifest: RunManifestV1,
  location: RunManifestLocationV1,
  workspacePath: string,
  phase: 'input' | 'final',
): void {
  const workspace = fs.realpathSync(path.resolve(workspacePath));
  const expectedStatic = {
    repository_id: manifest.repository_id,
    run_id: manifest.run_id,
    run_key: manifest.run_key,
    run_manifest_path: path.relative(workspace, location.manifest_path).split(path.sep).join('/'),
    frozen_base_commit: manifest.frozen_base_commit,
    frozen_base_tree: manifest.frozen_base_tree,
    approved_branch: manifest.approved_branch,
    approved_remote: manifest.approved_remote,
    approved_remote_old_oid: manifest.approved_remote_old_oid,
    trust_root_path: manifest.trust_root_path,
    trust_root_hash: manifest.trust_root_hash,
    ownership_manifest_id: manifest.ownership_manifest_id,
    ownership_manifest_hash: manifest.ownership_manifest_hash,
    normative_plan_hashes: manifest.normative_plan_hashes,
    claimed_release_channels: manifest.claimed_release_channels,
    claimed_registry_policy: manifest.claimed_registry_policy,
  };
  assertOmaReleasePolicy(manifest.claimed_release_channels, manifest.claimed_registry_policy);
  for (const [field, expected] of Object.entries(expectedStatic)) {
    if (!canonicalEqual(payload[field as keyof RepositoryAggregateManifestBindingV1], expected)) {
      throw new ContractViolation(
        'E_AGGREGATE_BINDING',
        `Aggregate payload ${field} differs from the current run manifest`,
      );
    }
  }
  const expected = expectedAggregateBinding(manifest, phase);
  if (payload.run_manifest_revision !== expected.revision
    || payload.lease_generation !== expected.lease
    || (expected.hash !== null && payload.run_manifest_hash !== expected.hash)) {
    throw new ContractViolation(
      'E_AGGREGATE_BINDING',
      'Aggregate payload manifest state, revision, hash, or lease is stale',
    );
  }
}

function assertAuthenticatedEvidence(
  workspacePath: string,
  manifest: RunManifestV1,
  payload: RepositoryAggregateInputPayloadV1,
): void {
  const evidence = authenticatedInputEvidence(workspacePath, manifest, payload);
  const supplied = {
    ordered_owner_roots: payload.ordered_owner_roots,
    parent_handoff_hashes: payload.parent_handoff_hashes,
    path_test_merkle_root: payload.path_test_merkle_root,
    accepted_w6_proposals: payload.accepted_w6_proposals,
  };
  if (!canonicalEqual(supplied, evidence)) {
    throw new ContractViolation(
      'E_AGGREGATE_ARTIFACT',
      'Input aggregate differs from authenticated current OMA-W0..W5 artifacts',
    );
  }
}

function releaseProofSignature(
  proof: Record<string, unknown>,
  key: Buffer,
): string {
  return crypto.createHmac('sha256', key)
    .update('OMA_RELEASE_REVIEW_PROOF_V1', 'utf8')
    .update(Buffer.from([0]))
    .update(canonicalBytesV1(proof))
    .digest('hex');
}

function readImmutableEvidence(targetPath: string, label: string): Buffer {
  if (!fs.existsSync(targetPath)) {
    throw new ContractViolation('E_AGGREGATE_FINAL_PROOF', `${label} is missing`);
  }
  const stat = fs.lstatSync(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o400) {
    throw new ContractViolation(
      'E_AGGREGATE_FINAL_PROOF',
      `${label} must be an immutable 0400 regular file`,
    );
  }
  return fs.readFileSync(targetPath);
}

function validateFinalRepositoryEvidence(
  workspacePath: string,
  manifest: RunManifestV1,
  payload: RepositoryAggregateFinalPayloadV1,
): void {
  const workspace = fs.realpathSync(path.resolve(workspacePath));
  const head = gitText(workspace, ['rev-parse', '--verify', 'HEAD^{commit}']);
  const candidate = gitText(workspace, [
    'rev-parse', '--verify', `${payload.candidate_commit}^{commit}`,
  ]);
  const candidateTree = gitText(workspace, [
    'rev-parse', '--verify', `${candidate}^{tree}`,
  ]);
  if (head !== candidate || candidate !== payload.candidate_commit
    || candidateTree !== payload.candidate_tree || payload.pushed_oid !== candidate) {
    throw new ContractViolation(
      'E_AGGREGATE_FINAL_TREE',
      'Final candidate commit/tree/pushed OID does not match the actual checked-out Git object',
    );
  }
  let evidence: ReturnType<typeof collectFinalTreeEvidence>;
  try {
    evidence = withWorkspace(workspace, () => collectFinalTreeEvidence({
      base: manifest.frozen_base_commit,
      candidate,
      remote: manifest.approved_remote,
      approvedBranch: manifest.approved_branch,
      approvedRemoteOldOid: payload.pushed_oid,
    }));
  } catch (error) {
    throw new ContractViolation('E_AGGREGATE_FINAL_TREE', 'Final-tree ownership proof failed', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const expectedDeltaRoot = sha256Hex(canonicalBytesV1(evidence.deltaRecords));
  if (payload.complete_delta_root !== expectedDeltaRoot) {
    throw new ContractViolation(
      'E_AGGREGATE_FINAL_TREE',
      'complete_delta_root does not bind the exact mode/OID-preserving base-to-candidate delta',
    );
  }
  const packageBytes = runGit(workspace, ['show', `${candidate}:package.json`]);
  let packageJson: Record<string, unknown>;
  try {
    packageJson = JSON.parse(packageBytes.toString('utf8')) as Record<string, unknown>;
  } catch (error) {
    throw new ContractViolation('E_AGGREGATE_FINAL_TREE', 'Candidate package.json is not valid JSON', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (packageJson.name !== '@iml1s/oh-my-agy' || packageJson.version !== payload.semver) {
    throw new ContractViolation(
      'E_AGGREGATE_FINAL_TREE',
      'Final semver differs from the actual candidate package.json',
    );
  }
  const proofRoot = path.posix.join(
    '.agy', 'artifacts', 'dual-parity', manifest.run_key, 'OMA-W6',
  );
  const proofKey = aggregateKey(workspace, manifest, manifestLocation(workspace, manifest.run_id));
  for (const [kind, hashField] of RELEASE_PROOF_BINDINGS) {
    const relative = path.posix.join(proofRoot, `${kind.replace('_', '-')}-proof.json`);
    const target = resolveConfinedPath(workspace, relative);
    const proof = readAggregateArtifact(target, `${kind} release proof`);
    const isIndependentReview = kind === 'code_review' || kind === 'ultraqa';
    assertExactObjectKeys(
      proof,
      isIndependentReview ? REVIEW_RELEASE_PROOF_KEYS : BASIC_RELEASE_PROOF_KEYS,
      `${kind} release proof`,
    );
    if (proof.store_kind !== 'oma_release_proof' || proof.schema_version !== 1
      || proof.repository_id !== 'OMA' || proof.run_id !== manifest.run_id
      || proof.proof_kind !== kind || proof.candidate_commit !== candidate
      || proof.candidate_tree !== candidateTree || proof.passed !== true
      || sha256Hex(fs.readFileSync(target)) !== payload[hashField]) {
      throw new ContractViolation(
        'E_AGGREGATE_FINAL_PROOF',
        `${kind} proof does not bind the exact final candidate`,
      );
    }
    if (!isIndependentReview) continue;
    if (proof.reviewer_id !== manifest.aggregate_verifier_id
      || String(proof.reviewer_id) === manifest.aggregate_signer_id
      || proof.reviewer_key_id !== manifest.aggregate_key_id
      || !Array.isArray(proof.test_argv) || proof.test_argv.length === 0
      || proof.test_argv.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
      throw new ContractViolation(
        'E_AGGREGATE_FINAL_PROOF',
        `${kind} proof reviewer identity or exact test argv is invalid`,
      );
    }
    const result = aggregateObject(proof.test_result, `${kind} proof test_result`);
    assertExactObjectKeys(result, RELEASE_PROOF_TEST_RESULT_KEYS, `${kind} proof test_result`);
    if (result.exit_code !== 0) {
      throw new ContractViolation('E_AGGREGATE_FINAL_PROOF', `${kind} proof test did not pass`);
    }
    assertSha256(result.stdout_sha256, `${kind} proof stdout_sha256`);
    assertSha256(result.stderr_sha256, `${kind} proof stderr_sha256`);
    const evidence = aggregateObject(proof.evidence, `${kind} proof evidence`);
    assertExactObjectKeys(evidence, RELEASE_PROOF_EVIDENCE_KEYS, `${kind} proof evidence`);
    const expectedEvidencePath = path.posix.join(
      proofRoot,
      `${kind.replace('_', '-')}-evidence.log`,
    );
    if (evidence.path !== expectedEvidencePath
      || !Number.isSafeInteger(evidence.byte_length) || (evidence.byte_length as number) < 0) {
      throw new ContractViolation('E_AGGREGATE_FINAL_PROOF', `${kind} proof evidence binding is invalid`);
    }
    assertSha256(evidence.sha256, `${kind} proof evidence sha256`);
    const evidenceBytes = readImmutableEvidence(
      resolveConfinedPath(workspace, expectedEvidencePath),
      `${kind} proof evidence`,
    );
    if (evidenceBytes.length !== evidence.byte_length
      || sha256Hex(evidenceBytes) !== evidence.sha256) {
      throw new ContractViolation('E_AGGREGATE_FINAL_PROOF', `${kind} immutable evidence drifted`);
    }
    const evidenceDocument = aggregateObject(
      parseCanonicalJsonV1(evidenceBytes),
      `${kind} proof evidence document`,
    );
    assertExactObjectKeys(
      evidenceDocument,
      RELEASE_PROOF_EVIDENCE_DOCUMENT_KEYS,
      `${kind} proof evidence document`,
    );
    const expectedEvidenceDocument = {
      store_kind: 'oma_release_test_evidence',
      schema_version: 1,
      repository_id: 'OMA',
      run_id: manifest.run_id,
      proof_kind: kind,
      reviewer_id: proof.reviewer_id,
      candidate_commit: candidate,
      candidate_tree: candidateTree,
      test_argv: proof.test_argv,
      test_result: proof.test_result,
    };
    if (!canonicalEqual(evidenceDocument, expectedEvidenceDocument)) {
      throw new ContractViolation(
        'E_AGGREGATE_FINAL_PROOF',
        `${kind} immutable evidence does not bind its exact reviewer/candidate/test result`,
      );
    }
    assertSha256(proof.attestation_signature, `${kind} proof attestation_signature`);
    const signatureMaterial = { ...proof };
    delete signatureMaterial.attestation_signature;
    const expectedSignature = releaseProofSignature(signatureMaterial, proofKey);
    if (!crypto.timingSafeEqual(
      Buffer.from(proof.attestation_signature as string, 'hex'),
      Buffer.from(expectedSignature, 'hex'),
    )) {
      throw new ContractViolation('E_AGGREGATE_FINAL_PROOF', `${kind} proof signature is invalid`);
    }
  }
}

function releaseToolchain(): Array<{ name: string; version: string; binary_sha256: string }> {
  const npmLookup = spawnSync('which', ['npm'], { encoding: 'utf8' });
  if (npmLookup.status !== 0 || npmLookup.stdout.trim() === '') {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm executable is unavailable for receipt authentication');
  }
  const npmPath = fs.realpathSync(npmLookup.stdout.trim());
  const npmVersion = spawnSync(npmPath, ['--version'], { encoding: 'utf8' });
  if (npmVersion.status !== 0 || npmVersion.stdout.trim() === '') {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm version readback failed');
  }
  const nodePath = fs.realpathSync(process.execPath);
  return [
    {
      name: 'node',
      version: process.version,
      binary_sha256: sha256Hex(fs.readFileSync(nodePath)),
    },
    {
      name: 'npm',
      version: npmVersion.stdout.trim(),
      binary_sha256: sha256Hex(fs.readFileSync(npmPath)),
    },
  ];
}

interface NpmPacklistEntryV1 {
  path: string;
  size: number;
  mode: number;
}

interface NpmTarFileV1 extends NpmPacklistEntryV1 {
  bytes: Buffer;
}

function canonicalPackEnvironment(epoch: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LANG: 'C',
    LC_ALL: 'C',
    SOURCE_DATE_EPOCH: epoch,
    TZ: 'UTC',
    npm_config_loglevel: 'silent',
  };
}

function canonicalReleaseEnvironment(epoch: string): Array<{ name: string; value_hash: string }> {
  const values: Readonly<Record<typeof RELEASE_ENVIRONMENT_NAMES[number], string>> = {
    LANG: 'C',
    LC_ALL: 'C',
    SOURCE_DATE_EPOCH: epoch,
    TZ: 'UTC',
    npm_config_loglevel: 'silent',
  };
  return RELEASE_ENVIRONMENT_NAMES.map((name) => ({
    name,
    value_hash: sha256Hex(Buffer.from(values[name], 'utf8')),
  }));
}

function npmPacklist(
  workspacePath: string,
  payload: RepositoryAggregateFinalPayloadV1,
  epoch: string,
): NpmPacklistEntryV1[] {
  const result = spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: workspacePath,
    encoding: 'utf8',
    env: canonicalPackEnvironment(epoch),
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.status !== 0 || result.stderr !== '') {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm pack dry-run oracle failed', {
      status: result.status,
      stderr: result.stderr,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm pack dry-run JSON is invalid', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm pack dry-run must return exactly one package');
  }
  const pack = aggregateObject(parsed[0], 'npm pack dry-run result');
  const expectedFilename = `iml1s-oh-my-agy-${payload.semver}.tgz`;
  if (pack.name !== '@iml1s/oh-my-agy' || pack.version !== payload.semver
    || pack.filename !== expectedFilename || !Array.isArray(pack.files) || pack.files.length === 0) {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm pack dry-run identity/files are invalid');
  }
  const seen = new Set<string>();
  return pack.files.map((value, index) => {
    const row = aggregateObject(value, `npm pack dry-run files[${index}]`);
    if (typeof row.path !== 'string' || row.path === '' || path.posix.isAbsolute(row.path)
      || path.posix.normalize(row.path) !== row.path || row.path.startsWith('../')
      || seen.has(row.path) || !Number.isSafeInteger(row.size) || (row.size as number) < 0
      || !Number.isSafeInteger(row.mode) || ![0o644, 0o755].includes(row.mode as number)) {
      throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm pack dry-run file surface is invalid');
    }
    seen.add(row.path);
    return { path: row.path, size: row.size as number, mode: row.mode as number };
  });
}

function tarString(bytes: Buffer, offset: number, length: number): string {
  const field = bytes.subarray(offset, offset + length);
  const terminator = field.indexOf(0);
  return field.subarray(0, terminator < 0 ? field.length : terminator).toString('utf8');
}

function tarOctal(bytes: Buffer, offset: number, length: number, label: string): number {
  const text = tarString(bytes, offset, length).trim();
  if (!/^[0-7]+$/.test(text)) {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', `npm tar ${label} is not canonical octal`);
  }
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', `npm tar ${label} is invalid`);
  }
  return value;
}

function parsePaxPath(bytes: Buffer): string | undefined {
  let offset = 0;
  let paxPath: string | undefined;
  while (offset < bytes.length) {
    const space = bytes.indexOf(0x20, offset);
    if (space < 0) throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm tar PAX record is malformed');
    const lengthText = bytes.subarray(offset, space).toString('ascii');
    if (!/^[1-9]\d*$/.test(lengthText)) {
      throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm tar PAX length is invalid');
    }
    const length = Number.parseInt(lengthText, 10);
    const end = offset + length;
    if (!Number.isSafeInteger(length) || end > bytes.length || bytes[end - 1] !== 0x0a) {
      throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm tar PAX record is truncated');
    }
    const record = bytes.subarray(space + 1, end - 1).toString('utf8');
    const separator = record.indexOf('=');
    if (separator < 1) throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm tar PAX key is invalid');
    if (record.slice(0, separator) === 'path') paxPath = record.slice(separator + 1);
    offset = end;
  }
  return paxPath;
}

function parseNpmTarball(archiveBytes: Buffer): NpmTarFileV1[] {
  if (archiveBytes.length < 2 || archiveBytes[0] !== 0x1f || archiveBytes[1] !== 0x8b) {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm package asset is not gzip data');
  }
  let tar: Buffer;
  try {
    tar = zlib.gunzipSync(archiveBytes);
  } catch (error) {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm package gzip stream is invalid', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  const files: NpmTarFileV1[] = [];
  const seen = new Set<string>();
  let offset = 0;
  let pendingPaxPath: string | undefined;
  let pendingLongPath: string | undefined;
  let ended = false;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      if (offset + 1024 > tar.length
        || !tar.subarray(offset + 512, offset + 1024).every((byte) => byte === 0)
        || !tar.subarray(offset + 1024).every((byte) => byte === 0)) {
        throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm tar end markers are invalid');
      }
      ended = true;
      break;
    }
    if (tarString(header, 257, 6) !== 'ustar' || tarString(header, 263, 2) !== '00') {
      throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm tar header is not canonical ustar');
    }
    const storedChecksum = tarOctal(header, 148, 8, 'checksum');
    const checksumHeader = Buffer.from(header);
    checksumHeader.fill(0x20, 148, 156);
    const computedChecksum = checksumHeader.reduce((sum, byte) => sum + byte, 0);
    if (storedChecksum !== computedChecksum) {
      throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm tar header checksum is invalid');
    }
    const size = tarOctal(header, 124, 12, 'size');
    const mode = tarOctal(header, 100, 8, 'mode') & 0o777;
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm tar entry is truncated');
    const data = Buffer.from(tar.subarray(dataStart, dataEnd));
    const prefix = tarString(header, 345, 155);
    const headerPath = `${prefix === '' ? '' : `${prefix}/`}${tarString(header, 0, 100)}`;
    const type = String.fromCharCode(header[156] || 0x30);
    if (type === 'x') {
      pendingPaxPath = parsePaxPath(data);
    } else if (type === 'L') {
      pendingLongPath = data.subarray(0, data[data.length - 1] === 0 ? -1 : undefined).toString('utf8');
    } else if (type === '0') {
      const archivePath = pendingPaxPath ?? pendingLongPath ?? headerPath;
      pendingPaxPath = undefined;
      pendingLongPath = undefined;
      if (!archivePath.startsWith('package/')) {
        throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm tar entry is outside package/');
      }
      const packagePath = archivePath.slice('package/'.length);
      if (packagePath === '' || path.posix.isAbsolute(packagePath)
        || path.posix.normalize(packagePath) !== packagePath || packagePath.startsWith('../')
        || seen.has(packagePath) || ![0o644, 0o755].includes(mode)) {
        throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm tar file surface is unsafe or duplicate');
      }
      seen.add(packagePath);
      files.push({ path: packagePath, size, mode, bytes: data });
    } else if (type !== '5') {
      throw new ContractViolation('E_AGGREGATE_BUNDLE', `npm tar entry type ${type} is not a regular file`);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  if (!ended || pendingPaxPath !== undefined || pendingLongPath !== undefined || files.length === 0) {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm tar structure is incomplete');
  }
  return files;
}

function validatePackedCandidateSurface(
  workspacePath: string,
  payload: RepositoryAggregateFinalPayloadV1,
  archiveBytes: Buffer,
  expectedPacklist: readonly NpmPacklistEntryV1[],
): void {
  const files = parseNpmTarball(archiveBytes);
  if (files.length !== expectedPacklist.length) {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'npm tar files differ from the actual packlist');
  }
  const actualByPath = new Map(files.map((file) => [file.path, file] as const));
  for (let index = 0; index < expectedPacklist.length; index += 1) {
    const expected = expectedPacklist[index];
    const actual = actualByPath.get(expected.path);
    if (actual === undefined || actual.size !== expected.size || actual.mode !== expected.mode) {
      throw new ContractViolation(
        'E_AGGREGATE_BUNDLE',
        `npm tar path/size/mode differs from the actual packlist at ${index}: ${expected.path}`,
      );
    }
    const candidateBytes = runGit(workspacePath, ['show', `${payload.candidate_commit}:${expected.path}`]);
    const currentPath = resolveConfinedPath(workspacePath, expected.path);
    if (!fs.existsSync(currentPath)) {
      throw new ContractViolation('E_AGGREGATE_BUNDLE', `Packed candidate file is missing: ${expected.path}`);
    }
    const stat = fs.lstatSync(currentPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ContractViolation('E_AGGREGATE_BUNDLE', `Packed candidate file is unsafe: ${expected.path}`);
    }
    const currentBytes = fs.readFileSync(currentPath);
    const treeRow = gitText(workspacePath, ['ls-tree', payload.candidate_commit, '--', expected.path]);
    const treeMode = treeRow.split(/\s+/, 1)[0];
    const expectedMode = treeMode === '100755' ? 0o755 : treeMode === '100644' ? 0o644 : -1;
    if (expectedMode !== expected.mode || !actual.bytes.equals(candidateBytes)
      || !currentBytes.equals(candidateBytes)) {
      throw new ContractViolation(
        'E_AGGREGATE_BUNDLE',
        `npm tar bytes/mode differ from candidate/current tracked file: ${expected.path}`,
      );
    }
  }
}

function validateReleaseBuildReceipt(
  value: unknown,
  workspacePath: string,
  payload: RepositoryAggregateFinalPayloadV1,
  archiveBytes: Buffer,
): void {
  const receipt = aggregateObject(value, 'release build receipt');
  assertExactObjectKeys(receipt, RELEASE_BUILD_RECEIPT_KEYS, 'release build receipt');
  if (!Array.isArray(receipt.argv) || receipt.argv.length === 0
    || receipt.argv.some((entry) => typeof entry !== 'string' || entry.length === 0)
    || !Array.isArray(receipt.toolchain) || receipt.toolchain.length === 0
    || !Array.isArray(receipt.sanitized_environment)) {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'Release build receipt collections are invalid');
  }
  assertSha256(receipt.cwd_realpath_hash, 'release build cwd_realpath_hash');
  assertSha256(receipt.receipt_hash, 'release build receipt_hash');
  for (const field of [
    'stdout_sha256', 'stderr_sha256', 'archive_sha256', 'packlist_sha256',
  ] as const) assertSha256(receipt[field], `release build ${field}`);
  if (!Number.isSafeInteger(receipt.exit_code)) {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'Release build exit_code is invalid');
  }
  for (const field of ['source_date_epoch', 'locale', 'timezone', 'umask'] as const) {
    assertNonEmptyString(receipt[field], `release build ${field}`);
  }
  receipt.toolchain.forEach((value, index) => {
    const tool = aggregateObject(value, `release toolchain[${index}]`);
    assertExactObjectKeys(tool, RELEASE_TOOLCHAIN_KEYS, `release toolchain[${index}]`);
    assertNonEmptyString(tool.name, 'release tool name');
    assertNonEmptyString(tool.version, 'release tool version');
    assertSha256(tool.binary_sha256, 'release tool binary_sha256');
  });
  const environmentNames = new Set<string>();
  receipt.sanitized_environment.forEach((value, index) => {
    const variable = aggregateObject(value, `release environment[${index}]`);
    assertExactObjectKeys(variable, RELEASE_ENVIRONMENT_KEYS, `release environment[${index}]`);
    assertNonEmptyString(variable.name, 'release environment name');
    assertSha256(variable.value_hash, 'release environment value_hash');
    if (environmentNames.has(variable.name as string)) {
      throw new ContractViolation('E_AGGREGATE_BUNDLE', 'Release environment names must be unique');
    }
    environmentNames.add(variable.name as string);
  });
  const material = { ...receipt };
  delete material.receipt_hash;
  if (receipt.receipt_hash !== sha256Hex(canonicalBytesV1(material))) {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'Release build receipt hash is invalid');
  }
  const workspace = fs.realpathSync(path.resolve(workspacePath));
  const expectedEpoch = gitText(workspace, [
    'show', '-s', '--format=%ct', payload.candidate_commit,
  ]);
  const expectedEnvironment = canonicalReleaseEnvironment(expectedEpoch);
  const expectedUmask = process.umask().toString(8).padStart(3, '0');
  const expectedFilename = `iml1s-oh-my-agy-${payload.semver}.tgz`;
  const packlist = npmPacklist(workspace, payload, expectedEpoch);
  const expectedBindings: Record<string, unknown> = {
    argv: ['npm', 'pack', '--ignore-scripts'],
    cwd_realpath_hash: sha256Hex(Buffer.from(workspace, 'utf8')),
    toolchain: releaseToolchain(),
    sanitized_environment: expectedEnvironment,
    source_date_epoch: expectedEpoch,
    locale: 'C',
    timezone: 'UTC',
    umask: expectedUmask,
    exit_code: 0,
    stdout_sha256: sha256Hex(Buffer.from(`${expectedFilename}\n`, 'utf8')),
    stderr_sha256: sha256Hex(Buffer.alloc(0)),
    archive_sha256: sha256Hex(archiveBytes),
    packlist_sha256: sha256Hex(canonicalBytesV1(packlist)),
  };
  for (const [field, expected] of Object.entries(expectedBindings)) {
    if (!canonicalEqual(receipt[field], expected)) {
      throw new ContractViolation(
        'E_AGGREGATE_BUNDLE',
        `Release build receipt ${field} differs from actual argv/cwd/toolchain/environment/output/package surface`,
      );
    }
  }
  validatePackedCandidateSurface(workspace, payload, archiveBytes, packlist);
}

function validateReleaseBundle(
  workspacePath: string,
  manifest: RunManifestV1,
  payload: RepositoryAggregateFinalPayloadV1,
): void {
  const expectedRelative = path.posix.join(
    '.agy', 'artifacts', 'dual-parity', manifest.run_key, 'OMA-W6', 'release-bundle-manifest.json',
  );
  if (payload.release_bundle_manifest_path !== expectedRelative) {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'Release bundle manifest path is not run exact');
  }
  const workspace = fs.realpathSync(path.resolve(workspacePath));
  const target = resolveConfinedPath(workspace, expectedRelative);
  const bundle = readAggregateArtifact(target, 'release bundle manifest');
  assertExactObjectKeys(bundle, RELEASE_BUNDLE_MANIFEST_KEYS, 'release bundle manifest');
  const bytes = fs.readFileSync(target);
  const expectedBundleDirectory = path.posix.join(
    '.agy', 'artifacts', 'dual-parity', manifest.run_key, 'OMA-W6', 'release-bundle',
  );
  if (sha256Hex(bytes) !== payload.release_bundle_manifest_sha256
    || bundle.store_kind !== 'release_bundle_manifest' || bundle.schema_version !== 1
    || bundle.repository_id !== 'OMA' || bundle.run_id !== manifest.run_id
    || bundle.owner !== 'oma-final-composition-owner'
    || bundle.candidate_commit !== payload.candidate_commit
    || bundle.candidate_tree !== payload.candidate_tree || bundle.semver !== payload.semver
    || !canonicalEqual(bundle.public_upload_order, payload.public_upload_order)
    || bundle.release_asset_root !== payload.release_asset_root
    || bundle.bundle_directory !== expectedBundleDirectory
    || !canonicalEqual(bundle.registry_bindings, [])) {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'Release bundle manifest identity/hash differs from final payload');
  }
  if (!Array.isArray(bundle.assets) || bundle.assets.length !== 2) {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'Release bundle must contain exactly two public assets');
  }
  const assetRows = bundle.assets.map((value, index) => {
    const row = aggregateObject(value, `release bundle assets[${index}]`);
    assertExactObjectKeys(
      row,
      RELEASE_BUNDLE_ASSET_KEYS,
      `release bundle assets[${index}]`,
    );
    assertNonEmptyString(row.name, 'release asset name');
    assertNonEmptyString(row.relative_path, 'release asset relative_path');
    assertNonEmptyString(row.media_type, 'release asset media_type');
    if (row.relative_path !== path.posix.join(expectedBundleDirectory, row.name as string)) {
      throw new ContractViolation('E_AGGREGATE_BUNDLE', 'Release asset path is outside the exact bundle directory');
    }
    if (!Number.isSafeInteger(row.byte_length) || (row.byte_length as number) < 0) {
      throw new ContractViolation('E_AGGREGATE_BUNDLE', 'Release asset byte length is invalid');
    }
    assertSha256(row.sha256, 'release asset sha256');
    const assetPath = resolveConfinedPath(workspace, row.relative_path as string);
    if (!fs.existsSync(assetPath)) {
      throw new ContractViolation('E_AGGREGATE_BUNDLE', `Release asset is missing: ${row.name}`);
    }
    const stat = fs.lstatSync(assetPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new ContractViolation('E_AGGREGATE_BUNDLE', `Release asset is unsafe: ${row.name}`);
    }
    const assetBytes = fs.readFileSync(assetPath);
    if (assetBytes.length !== row.byte_length || sha256Hex(assetBytes) !== row.sha256) {
      throw new ContractViolation('E_AGGREGATE_BUNDLE', `Release asset bytes drifted: ${row.name}`);
    }
    return row;
  });
  const bundleDirectoryPath = resolveConfinedPath(workspace, expectedBundleDirectory);
  if (!fs.existsSync(bundleDirectoryPath)) {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'Release bundle directory is missing');
  }
  const directoryStat = fs.lstatSync(bundleDirectoryPath);
  const expectedFileNames = [...payload.public_upload_order].sort();
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()
    || !canonicalEqual(fs.readdirSync(bundleDirectoryPath).sort(), expectedFileNames)) {
    throw new ContractViolation(
      'E_AGGREGATE_BUNDLE',
      'Release bundle directory contains missing, extra, renamed, or unsafe entries',
    );
  }
  if (!canonicalEqual(assetRows.map((row) => row.name), payload.public_upload_order)) {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'Release asset order differs from public upload order');
  }
  const [archive, checksum] = assetRows;
  if (archive.media_type !== 'application/gzip' || checksum.media_type !== 'text/plain') {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'Release asset media types are invalid');
  }
  const archiveBytes = fs.readFileSync(resolveConfinedPath(workspace, archive.relative_path as string));
  validateReleaseBuildReceipt(bundle.build_receipt, workspace, payload, archiveBytes);
  const checksumBytes = `${archive.sha256}  ${archive.name}\n`;
  if (bundle.checksum_bytes !== checksumBytes
    || bundle.checksum_byte_length !== Buffer.byteLength(checksumBytes)
    || bundle.checksum_sha256 !== sha256Hex(Buffer.from(checksumBytes, 'utf8'))
    || checksum.byte_length !== bundle.checksum_byte_length
    || checksum.sha256 !== bundle.checksum_sha256) {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'Release checksum bytes/hash are invalid');
  }
  const actualAssetRoot = sha256Hex(canonicalBytesV1(assetRows.map((row) => [
    row.name, row.relative_path, row.byte_length, row.sha256, row.media_type,
  ])));
  if (actualAssetRoot !== payload.release_asset_root) {
    throw new ContractViolation('E_AGGREGATE_BUNDLE', 'Release asset root differs from current asset bytes');
  }
  validateReleaseBundleManifest(bundle as unknown as ReleaseBundleManifestV1, []);
}

function aggregateKey(
  workspacePath: string,
  manifest: RunManifestV1,
  location: RunManifestLocationV1,
): Buffer {
  const trust = readCanonicalObject(location.trust_root_path) as unknown as WriterTrustRootV1;
  return readAndValidateKey(
    keyPath(workspacePath, manifest.run_id, 'OMA-W6-aggregate.hmac'),
    trust.aggregate.key_sha256,
  );
}

function verifyRepositoryAggregateInternal(options: {
  workspace_path: string;
  phase: 'input' | 'final';
  envelope: AggregateEnvelopeV1<unknown>;
  manifest: RunManifestV1;
  location: RunManifestLocationV1;
}): void {
  const shapedEnvelope = validateAggregateEnvelopeShape(options.envelope, 'repository aggregate envelope');
  const payload = options.phase === 'input'
    ? validateInputAggregatePayload(shapedEnvelope.payload)
    : validateFinalAggregatePayload(shapedEnvelope.payload);
  validateAggregateManifestBinding(
    payload,
    options.manifest,
    options.location,
    options.workspace_path,
    options.phase,
  );
  const key = aggregateKey(options.workspace_path, options.manifest, options.location);
  verifyAggregate(
    shapedEnvelope,
    key,
    options.manifest.aggregate_signer_id,
    options.manifest.aggregate_key_id,
    options.phase,
  );
  if (options.phase === 'input') {
    assertAuthenticatedEvidence(
      options.workspace_path,
      options.manifest,
      payload as RepositoryAggregateInputPayloadV1,
    );
    return;
  }
  const finalPayload = payload as RepositoryAggregateFinalPayloadV1;
  verifyRepositoryAggregateInternal({
    workspace_path: options.workspace_path,
    phase: 'input',
    envelope: finalPayload.input_envelope,
    manifest: options.manifest,
    location: options.location,
  });
  if (finalPayload.input_aggregate_hash !== finalPayload.input_envelope.payload_hash
    || !canonicalEqual(finalPayload.claimed_release_channels, finalPayload.input_envelope.payload.claimed_release_channels)
    || !canonicalEqual(finalPayload.claimed_registry_policy, finalPayload.input_envelope.payload.claimed_registry_policy)) {
    throw new ContractViolation('E_AGGREGATE_BINDING', 'Final aggregate does not preserve its exact input aggregate');
  }
  validateFinalRepositoryEvidence(options.workspace_path, options.manifest, finalPayload);
  validateReleaseBundle(options.workspace_path, options.manifest, finalPayload);
}

export function signRepositoryAggregate(options: {
  workspace_path: string;
  run_id: string;
  expected_manifest_revision: number;
  expected_lease_generation: number;
  phase: 'input';
  payload: RepositoryAggregateInputPayloadV1;
}): Promise<AggregateEnvelopeV1<RepositoryAggregateInputPayloadV1>>;
export function signRepositoryAggregate(options: {
  workspace_path: string;
  run_id: string;
  expected_manifest_revision: number;
  expected_lease_generation: number;
  phase: 'final';
  payload: RepositoryAggregateFinalPayloadV1;
  fault_injection?: (point: FinalSigningFaultPointV1) => void;
}): Promise<AggregateEnvelopeV1<RepositoryAggregateFinalPayloadV1>>;
export async function signRepositoryAggregate(options: {
  workspace_path: string;
  run_id: string;
  expected_manifest_revision: number;
  expected_lease_generation: number;
  phase: 'input' | 'final';
  payload: RepositoryAggregatePayloadV1;
  fault_injection?: (point: FinalSigningFaultPointV1) => void;
}): Promise<AggregateEnvelopeV1<RepositoryAggregatePayloadV1>> {
  const location = manifestLocation(options.workspace_path, options.run_id);
  const lock = await acquireOwnerLock(`${location.manifest_path}.lock`, { staleAfterMs: 0 });
  if (!lock.ok) throw new ContractViolation(lock.error.code, lock.error.message, lock.error.details);
  try {
    reconcileFinalizationJournal(options.workspace_path, options.run_id, location);
    const manifest = readRunManifest(location.manifest_path);
    const payload = options.phase === 'input'
      ? validateInputAggregatePayload(options.payload)
      : validateFinalAggregatePayload(options.payload);
    const expectedRemoteOid = options.phase === 'final'
      ? (payload as RepositoryAggregateFinalPayloadV1).pushed_oid
      : undefined;
    assertManifestBindings(
      manifest,
      options.workspace_path,
      options.run_id,
      location,
      expectedRemoteOid,
    );
    if (options.phase === 'final' && manifest.state === 'signing_revoked') {
      const finalPayload = payload as RepositoryAggregateFinalPayloadV1;
      const stored = readRepositoryAggregateStore(options.workspace_path, manifest);
      if (stored.store.revision === 2 && stored.store.final_envelope !== null
        && options.expected_manifest_revision === finalPayload.run_manifest_revision
        && options.expected_lease_generation === finalPayload.lease_generation
        && canonicalEqual(stored.store.final_envelope.payload, finalPayload)) {
        verifyRepositoryAggregateInternal({
          workspace_path: options.workspace_path,
          phase: 'final',
          envelope: stored.store.final_envelope,
          manifest,
          location,
        });
        return stored.store.final_envelope;
      }
    }
    const allowedState = options.phase === 'input' ? 'inputs_verified' : 'composition_active';
    if (manifest.state !== allowedState || manifest.revision !== options.expected_manifest_revision
      || manifest.lease_generation !== options.expected_lease_generation) {
      throw new ContractViolation('E_SIGN_CAPABILITY', 'Aggregate sign capability is stale, revoked, or inactive');
    }
    validateAggregateManifestBinding(
      payload,
      manifest,
      location,
      options.workspace_path,
      options.phase,
    );
    if (options.phase === 'input') {
      const inputPayload = payload as RepositoryAggregateInputPayloadV1;
      if (manifest.previous_manifest_hash === null
        || inputPayload.writers_manifest_hash !== manifest.previous_manifest_hash) {
        throw new ContractViolation('E_AGGREGATE_BINDING', 'Input aggregate writer predecessor hash is stale');
      }
      assertAuthenticatedEvidence(options.workspace_path, manifest, inputPayload);
      const key = aggregateKey(options.workspace_path, manifest, location);
      const envelope = signAggregate(
        inputPayload,
        key,
        manifest.aggregate_signer_id,
        manifest.aggregate_key_id,
        'input',
      );
      verifyRepositoryAggregateInternal({
        workspace_path: options.workspace_path,
        phase: 'input',
        envelope,
        manifest,
        location,
      });
      const desired: RepositoryAggregateHandoffV1 = {
        store_kind: 'repo_aggregate_handoff',
        schema_version: 1,
        repository_id: 'OMA',
        run_id: manifest.run_id,
        revision: 1,
        previous_aggregate_hash: null,
        input_envelope: envelope,
        final_envelope: null,
      };
      const desiredBytes = canonicalBytesV1(desired);
      const target = expectedRepositoryAggregatePath(options.workspace_path, manifest.run_id);
      if (fs.existsSync(target)) {
        const current = readRepositoryAggregateStore(options.workspace_path, manifest);
        if (current.store.revision !== 1 || current.bytes.compare(desiredBytes) !== 0) {
          throw new ContractViolation(
            'E_AGGREGATE_CAS',
            'Conflicting repository input aggregate signature already exists',
          );
        }
      } else {
        atomicWriteFile(target, desiredBytes, { mode: 0o600 });
      }
      return envelope;
    }

    const finalPayload = payload as RepositoryAggregateFinalPayloadV1;
    const stored = readRepositoryAggregateStore(options.workspace_path, manifest);
    if (stored.store.revision !== 1 || stored.store.final_envelope !== null
      || !canonicalEqual(stored.store.input_envelope, finalPayload.input_envelope)) {
      throw new ContractViolation(
        'E_AGGREGATE_CAS',
        'Final aggregate requires the exact canonical revision-1 input aggregate CAS',
      );
    }
    verifyRepositoryAggregateInternal({
      workspace_path: options.workspace_path,
      phase: 'input',
      envelope: finalPayload.input_envelope,
      manifest,
      location,
    });
    if (finalPayload.input_aggregate_hash !== finalPayload.input_envelope.payload_hash
      || !canonicalEqual(finalPayload.claimed_release_channels, finalPayload.input_envelope.payload.claimed_release_channels)
      || !canonicalEqual(finalPayload.claimed_registry_policy, finalPayload.input_envelope.payload.claimed_registry_policy)) {
      throw new ContractViolation('E_AGGREGATE_BINDING', 'Final aggregate does not preserve its exact input aggregate');
    }
    validateFinalRepositoryEvidence(options.workspace_path, manifest, finalPayload);
    validateReleaseBundle(options.workspace_path, manifest, finalPayload);
    const key = aggregateKey(options.workspace_path, manifest, location);
    const envelope = signAggregate(
      finalPayload,
      key,
      manifest.aggregate_signer_id,
      manifest.aggregate_key_id,
      'final',
    );
    verifyRepositoryAggregateInternal({
      workspace_path: options.workspace_path,
      phase: 'final',
      envelope,
      manifest,
      location,
    });
    const desired: RepositoryAggregateHandoffV1 = {
      ...stored.store,
      revision: 2,
      previous_aggregate_hash: sha256Hex(stored.bytes),
      final_envelope: envelope,
    };
    const manifestBytes = fs.readFileSync(location.manifest_path);
    if (sha256Hex(manifestBytes) !== sha256Hex(canonicalBytesV1(manifest))) {
      throw new ContractViolation('E_SIGN_CAPABILITY', 'Aggregate manifest changed while evidence was verified');
    }
    const next = buildManifestTransition(
      manifest,
      sha256Hex(manifestBytes),
      'signing_revoked',
      undefined,
      true,
    );
    const unsignedJournal: Omit<FinalSigningTransactionJournalV1, 'signature'> = {
      store_kind: 'repo_aggregate_finalization_journal',
      schema_version: 1,
      repository_id: 'OMA',
      run_id: manifest.run_id,
      base_manifest: manifest,
      base_aggregate: stored.store,
      desired_manifest: next,
      desired_aggregate: desired,
    };
    const journal: FinalSigningTransactionJournalV1 = {
      ...unsignedJournal,
      signature: finalizationJournalSignature(unsignedJournal, key),
    };
    const journalPath = expectedFinalSigningJournalPath(options.workspace_path, manifest.run_id);
    options.fault_injection?.('before_journal_write');
    atomicWriteFile(journalPath, canonicalBytesV1(journal), { mode: 0o600 });
    options.fault_injection?.('after_journal_write');
    options.fault_injection?.('before_aggregate_write');
    atomicWriteFile(stored.path, canonicalBytesV1(desired), { mode: 0o600 });
    options.fault_injection?.('after_aggregate_write');
    options.fault_injection?.('before_manifest_write');
    atomicWriteFile(location.manifest_path, canonicalBytesV1(next), { mode: 0o600 });
    options.fault_injection?.('after_manifest_write');
    removeDurableFile(journalPath);
    return envelope;
  } finally {
    releaseOwnerLock(lock.value);
  }
}

export function verifyRepositoryAggregate(options: {
  workspace_path: string;
  run_id: string;
  phase: 'input' | 'final';
  envelope: AggregateEnvelopeV1<unknown>;
}): void {
  const location = manifestLocation(options.workspace_path, options.run_id);
  const manifest = readRunManifest(location.manifest_path);
  assertManifestBindings(manifest, options.workspace_path, options.run_id, location);
  const stored = readRepositoryAggregateStore(options.workspace_path, manifest);
  const canonicalEnvelope = options.phase === 'input'
    ? stored.store.input_envelope : stored.store.final_envelope;
  if (canonicalEnvelope === null || !canonicalEqual(canonicalEnvelope, options.envelope)) {
    throw new ContractViolation(
      'E_AGGREGATE_CAS',
      'Aggregate envelope differs from the canonical repository handoff',
    );
  }
  verifyRepositoryAggregateInternal({
    workspace_path: options.workspace_path,
    phase: options.phase,
    envelope: options.envelope,
    manifest,
    location,
  });
}

async function cli(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  const option = (name: string): string => {
    const index = rest.indexOf(name);
    if (index < 0 || rest[index + 1] === undefined) {
      throw new ContractViolation('E_CLI_USAGE', `Missing ${name}`);
    }
    return rest[index + 1];
  };
  if (command === 'create') {
    const inputPath = option('--input');
    const parsed = parseCanonicalJsonV1(fs.readFileSync(inputPath)) as unknown as InitializeRunManifestInputV1;
    const result = await initializeRunManifest(parsed);
    process.stdout.write(`${canonicalBytesV1({
      manifest_path: result.manifest_path,
      trust_root_path: result.trust_root_path,
      revision: result.manifest.revision,
      state: result.manifest.state,
    }).toString('utf8')}\n`);
    return 0;
  }
  if (command === 'advance') {
    const workspacePath = option('--workspace');
    const runId = option('--run-id');
    const location = manifestLocation(workspacePath, runId);
    const current = readRunManifest(location.manifest_path);
    const next = await advanceRunManifest({
      workspace_path: workspacePath,
      run_id: runId,
      expected_revision: Number(option('--expected-revision')),
      expected_previous_hash: option('--expected-previous-hash'),
      expected_state: option('--expected-state') as RunManifestStateV1,
      next_state: option('--next-state') as RunManifestStateV1,
    });
    process.stdout.write(`${canonicalBytesV1({ revision: next.revision, state: next.state }).toString('utf8')}\n`);
    return current.revision + 1 === next.revision ? 0 : 1;
  }
  if (command === 'verify') {
    const manifestPath = option('--path');
    const manifest = verifyRunManifestAtPath(manifestPath);
    process.stdout.write(`${canonicalBytesV1({
      ok: true,
      repository_id: manifest.repository_id,
      revision: manifest.revision,
      state: manifest.state,
    }).toString('utf8')}\n`);
    return 0;
  }
  if (command === 'handoff') {
    const inputPath = option('--input');
    const parsed = parseCanonicalJsonV1(
      fs.readFileSync(inputPath),
    ) as unknown as WriteWaveHandoffArtifactsInputV1;
    const result = writeWaveHandoffArtifacts(parsed);
    process.stdout.write(`${canonicalBytesV1(result).toString('utf8')}\n`);
    return 0;
  }
  if (command === 'verify-handoff') {
    const result = verifyWaveHandoffArtifacts({
      workspace_path: option('--workspace'),
      run_id: option('--run-id'),
      handoff_path: option('--path'),
    });
    process.stdout.write(`${canonicalBytesV1({ ...result, ok: true }).toString('utf8')}\n`);
    return 0;
  }
  throw new ContractViolation(
    'E_CLI_USAGE',
    'Usage: run-manifest.ts create|advance|verify|handoff|verify-handoff',
  );
}

if (require.main === module) {
  cli(process.argv.slice(2)).then(
    (code) => { process.exitCode = code; },
    (error: unknown) => {
      const message = error instanceof ContractViolation
        ? `${error.code}: ${error.message}`
        : error instanceof Error ? error.message : String(error);
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    },
  );
}
