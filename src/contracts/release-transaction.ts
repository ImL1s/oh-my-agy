import * as path from 'path';
import { safePathKey } from './path-key';
import {
  ClaimedRegistryPolicyV1,
} from './run-manifest';
import {
  canonicalBytesV1,
  ContractViolation,
  assertCanonicalUtcTimestamp,
  assertExactObjectKeys,
  assertGitObjectId,
  assertNonEmptyString,
  assertSha256,
  assertStringArray,
} from './state-schemas';
import { sha256Hex } from './writer-chain';

export const OMA_REGISTRY_STATE_SUFFIX_SET_V1 = [
  'publish_pending',
  'publish_unknown',
  'publish_failed',
  'published',
  'version_readback_pending',
  'version_readback_unknown',
  'version_readback_failed',
  'version_readback_passed',
  'staging_tag_set_pending',
  'staging_tag_set_unknown',
  'staging_tag_set_failed',
  'staging_tag_set',
  'staging_tag_readback_pending',
  'staging_tag_readback_unknown',
  'staging_tag_readback_failed',
  'staging_tag_readback_passed',
  'final_tag_set_pending',
  'final_tag_set_unknown',
  'final_tag_set_failed',
  'final_tag_set',
  'final_tag_readback_pending',
  'final_tag_readback_unknown',
  'final_tag_readback_failed',
  'final_tag_readback_passed',
  'final_tag_restore_pending',
  'final_tag_restore_unknown',
  'final_tag_restore_failed',
  'final_tag_restored',
  'final_tag_restore_readback_pending',
  'final_tag_restore_readback_unknown',
  'final_tag_restore_readback_failed',
  'final_tag_restore_readback_passed',
  'deprecation_pending',
  'deprecation_unknown',
  'deprecation_failed',
  'deprecated',
  'deprecation_readback_pending',
  'deprecation_readback_unknown',
  'deprecation_readback_failed',
  'deprecation_readback_passed',
  'deprecation_not_applicable',
] as const;

export type RegistryStateSuffixV1 = typeof OMA_REGISTRY_STATE_SUFFIX_SET_V1[number];

export const GITHUB_CHANNEL_STATE_SET_V1 = [
  'external_publisher_conflict',
  'github_promotion_pending',
  'github_promotion_unknown',
  'github_promotion_failed',
  'github_promoted',
  'github_promotion_readback_pending',
  'github_promotion_readback_unknown',
  'github_promotion_readback_failed',
  'github_promotion_readback_passed',
  'github_latest_set_pending',
  'github_latest_set_unknown',
  'github_latest_set_failed',
  'github_latest_set',
  'github_latest_readback_pending',
  'github_latest_readback_unknown',
  'github_latest_readback_failed',
  'github_latest_readback_passed',
  'all_channels_readback_passed',
] as const;

export const REGISTRY_BARRIER_STATE_SET_V1 = [
  'registries_staged_passed',
  'registries_not_applicable',
  'registry_final_tags_readback_passed',
  'registry_final_tags_not_applicable',
] as const;

export const GITHUB_LATEST_RESTORE_STATE_SET_V1 = [
  'github_latest_restore_pending',
  'github_latest_restore_unknown',
  'github_latest_restore_failed',
  'github_latest_restored',
  'github_latest_restore_readback_pending',
  'github_latest_restore_readback_unknown',
  'github_latest_restore_readback_failed',
  'github_latest_restore_readback_passed',
] as const;

export const W6_BRANCH_FREEZE_CHAIN_V1 = [
  'candidate_gates_passed',
  'branch_push_pending',
  'branch_pushed',
  'branch_readback_pending',
  'branch_readback_passed',
  'commit_proof_pending',
  'commit_proof_passed',
  'release_bundle_frozen',
  'frozen_pass',
] as const;

export const RELEASE_TERMINAL_STATES_V1 = [
  'complete',
  'release_blocked',
  'withdrawal_blocked',
  'withdrawn_fix_forward_required',
  'identity_conflict_fix_forward_required',
  'release_inconsistent_fix_forward_required',
  'release_inconsistent_blocked',
] as const;

export const RELEASE_EXTERNAL_OPERATION_ORACLE_V1 = [
  { operation: 'branch_push', pending: 'branch_push_pending', unknown: 'branch_push_unknown', failed: 'branch_push_failed', success: 'branch_pushed' },
  { operation: 'branch_readback', pending: 'branch_readback_pending', unknown: 'branch_readback_unknown', failed: 'branch_readback_failed', success: 'branch_readback_passed' },
  { operation: 'tag_push', pending: 'tag_push_pending', unknown: 'tag_push_unknown', failed: 'tag_push_failed', success: 'tag_pushed' },
  { operation: 'tag_readback', pending: 'tag_readback_pending', unknown: 'tag_readback_unknown', failed: 'tag_readback_failed', success: 'tag_readback_passed' },
  { operation: 'prerelease_create', pending: 'prerelease_create_pending', unknown: 'prerelease_create_unknown', failed: 'prerelease_create_failed', success: 'prerelease_created' },
  { operation: 'prerelease_readback', pending: 'prerelease_readback_pending', unknown: 'prerelease_readback_unknown', failed: 'prerelease_readback_failed', success: 'prerelease_readback_passed' },
  { operation: 'asset_upload', pending: 'asset_upload_pending', unknown: 'asset_upload_unknown', failed: 'asset_upload_failed', success: 'asset_uploaded' },
  { operation: 'asset_readback', pending: 'asset_readback_pending', unknown: 'asset_readback_unknown', failed: 'asset_readback_failed', success: 'asset_readback_passed' },
  { operation: 'attestation', pending: 'attestation_pending', unknown: 'attestation_unknown', failed: 'attestation_failed', success: 'attestation_passed' },
  { operation: 'github_withdrawal', pending: 'github_withdrawal_pending', unknown: 'github_withdrawal_unknown', failed: 'github_withdrawal_failed', success: 'github_withdrawn' },
  { operation: 'github_withdrawal_readback', pending: 'github_withdrawal_readback_pending', unknown: 'github_withdrawal_readback_unknown', failed: 'github_withdrawal_readback_failed', success: 'github_withdrawal_readback_passed' },
  { operation: 'github_promotion', pending: 'github_promotion_pending', unknown: 'github_promotion_unknown', failed: 'github_promotion_failed', success: 'github_promoted' },
  { operation: 'github_promotion_readback', pending: 'github_promotion_readback_pending', unknown: 'github_promotion_readback_unknown', failed: 'github_promotion_readback_failed', success: 'github_promotion_readback_passed' },
  { operation: 'github_latest_set', pending: 'github_latest_set_pending', unknown: 'github_latest_set_unknown', failed: 'github_latest_set_failed', success: 'github_latest_set' },
  { operation: 'github_latest_readback', pending: 'github_latest_readback_pending', unknown: 'github_latest_readback_unknown', failed: 'github_latest_readback_failed', success: 'github_latest_readback_passed' },
  { operation: 'github_latest_restore', pending: 'github_latest_restore_pending', unknown: 'github_latest_restore_unknown', failed: 'github_latest_restore_failed', success: 'github_latest_restored' },
  { operation: 'github_latest_restore_readback', pending: 'github_latest_restore_readback_pending', unknown: 'github_latest_restore_readback_unknown', failed: 'github_latest_restore_readback_failed', success: 'github_latest_restore_readback_passed' },
  { operation: 'canonical_verified_write', pending: 'canonical_verified_write_pending', unknown: 'canonical_verified_write_unknown', failed: 'canonical_verified_write_failed', success: 'canonical_verified_written' },
  { operation: 'canonical_verified_readback', pending: 'canonical_verified_readback_pending', unknown: 'canonical_verified_readback_unknown', failed: 'canonical_verified_readback_failed', success: 'canonical_verified_readback_passed' },
  { operation: 'released_install_readback', pending: 'released_install_readback_pending', unknown: 'released_install_readback_unknown', failed: 'released_install_readback_failed', success: 'released_install_readback_passed' },
  { operation: 'inconsistency_reconciliation', pending: 'release_inconsistent_pending', unknown: 'release_inconsistent_unknown', failed: 'release_inconsistent_blocked', success: 'release_inconsistent_reconciled' },
] as const;

export type ReleaseExternalOperationV1 = typeof RELEASE_EXTERNAL_OPERATION_ORACLE_V1[number]['operation'];
export type ReleaseExternalOutcomeV1 = 'pending' | 'success' | 'hard_failure' | 'timeout';

export const PRODUCTION_REGISTRY_IDS_V1 = ['github-packages', 'npmjs'] as const;

export interface ClaimedRegistryV1 extends ClaimedRegistryPolicyV1 {
  tarball_sha256: string;
  integrity: string;
  provenance_hash: string;
  staging_dist_tag: string;
  prior_final_tag_identity: string | null;
}

export interface ReleaseCallRecordV1 {
  store_kind: 'release_call_record';
  schema_version: 1;
  state: string;
  allowed_predecessor: string;
  attempt: number;
  redacted_external_locator: string;
  expected_identity_digest: string;
  byte_digest: string | null;
  request_digest: string;
  idempotency_key: string;
  prior_mutable_object_identity: string | null;
  dispatched: boolean;
  external_id: string | null;
  external_etag: string | null;
  external_object_digest: string | null;
  readback_at: string | null;
}

export interface ReleaseTransactionV1 {
  store_kind: 'release_transaction';
  schema_version: 1;
  repository_id: 'OMA';
  semver: string;
  frozen_commit: string;
  transaction_nonce: string;
  transaction_identity_hash: string;
  parent_w6_aggregate_hash: string;
  state: string;
  claimed_registry_policy_hash: string;
  claimed_registries: ClaimedRegistryV1[];
  call_records: ReleaseCallRecordV1[];
  channel_states: Record<string, string>;
  supersedes_transaction_hash: string | null;
  canonical_verified: false | true;
}

export interface ReleaseBundleAssetV1 {
  name: string;
  relative_path: string;
  byte_length: number;
  sha256: string;
  media_type: string;
}

export interface ReleaseBuildReceiptV1 {
  argv: string[];
  cwd_realpath_hash: string;
  toolchain: Array<{ name: string; version: string; binary_sha256: string }>;
  sanitized_environment: Array<{ name: string; value_hash: string }>;
  source_date_epoch: string;
  locale: string;
  timezone: string;
  umask: string;
  exit_code: number;
  stdout_sha256: string;
  stderr_sha256: string;
  archive_sha256: string;
  packlist_sha256: string;
  receipt_hash: string;
}

export interface ReleaseBundleManifestV1 {
  store_kind: 'release_bundle_manifest';
  schema_version: 1;
  repository_id: 'OMA';
  run_id: string;
  owner: 'oma-final-composition-owner';
  candidate_commit: string;
  candidate_tree: string;
  semver: string;
  bundle_directory: string;
  public_upload_order: string[];
  assets: ReleaseBundleAssetV1[];
  checksum_bytes: string;
  checksum_byte_length: number;
  checksum_sha256: string;
  build_receipt: ReleaseBuildReceiptV1;
  registry_bindings: ClaimedRegistryV1[];
  release_asset_root: string;
}

const POLICY_KEYS = [
  'registry_id',
  'registry_url',
  'package',
  'final_dist_tag',
  'staging_tag_derivation',
  'credential_preflight_hash',
  'readback_preflight_hash',
] as const;

const CLAIMED_KEYS = [
  ...POLICY_KEYS,
  'tarball_sha256',
  'integrity',
  'provenance_hash',
  'staging_dist_tag',
  'prior_final_tag_identity',
] as const;

const RELEASE_CALL_RECORD_KEYS = [
  'store_kind', 'schema_version', 'state', 'allowed_predecessor', 'attempt',
  'redacted_external_locator', 'expected_identity_digest', 'byte_digest', 'request_digest',
  'idempotency_key', 'prior_mutable_object_identity', 'dispatched', 'external_id',
  'external_etag', 'external_object_digest', 'readback_at',
] as const;

const RELEASE_TRANSACTION_KEYS = [
  'store_kind', 'schema_version', 'repository_id', 'semver', 'frozen_commit',
  'transaction_nonce', 'transaction_identity_hash', 'parent_w6_aggregate_hash', 'state',
  'claimed_registry_policy_hash', 'claimed_registries', 'call_records', 'channel_states',
  'supersedes_transaction_hash', 'canonical_verified',
] as const;

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

const GLOBAL_RELEASE_STATE_SET_V1 = new Set<string>([
  ...W6_BRANCH_FREEZE_CHAIN_V1,
  ...RELEASE_TERMINAL_STATES_V1,
  ...GITHUB_CHANNEL_STATE_SET_V1,
  ...REGISTRY_BARRIER_STATE_SET_V1,
  ...GITHUB_LATEST_RESTORE_STATE_SET_V1,
  ...RELEASE_EXTERNAL_OPERATION_ORACLE_V1.flatMap((row) => [
    row.pending, row.unknown, row.failed, row.success,
  ]),
  'final_readback_passed',
  'withdrawal_registry_cleanup_pending',
]);

function assertPlainRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new ContractViolation('E_SCHEMA_INVALID', `${label} must be a plain object`);
  }
}

function isReleaseStateV1(state: unknown, registryIds: readonly string[]): state is string {
  if (typeof state !== 'string') return false;
  if (GLOBAL_RELEASE_STATE_SET_V1.has(state)) return true;
  try {
    parseQualifiedRegistryState(state, registryIds);
    return true;
  } catch (error) {
    if (error instanceof ContractViolation) return false;
    throw error;
  }
}

function assertConfinedRelativePosixPath(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label);
  if (path.posix.isAbsolute(value) || value.includes('\\') || value.includes('\0')
    || path.posix.normalize(value) !== value
    || value === '.' || value === '..' || value.startsWith('../')
    || value.split('/').some((segment) => segment === '.' || segment === '..' || segment === '')) {
    throw new ContractViolation('E_RELEASE_BUNDLE', `${label} must be a confined relative POSIX path`);
  }
}

export function releaseExternalOperationState(
  operation: ReleaseExternalOperationV1,
  outcome: ReleaseExternalOutcomeV1,
): string {
  const row = RELEASE_EXTERNAL_OPERATION_ORACLE_V1.find((candidate) =>
    candidate.operation === operation);
  if (row === undefined) {
    throw new ContractViolation('E_RELEASE_STATE', 'External release operation is outside the frozen oracle');
  }
  if (outcome === 'hard_failure') return row.failed;
  if (outcome === 'timeout') return row.unknown;
  return row[outcome];
}

export function reconcileReleaseIdentityCardinality(input: {
  exact_matches: number;
  conflicting_matches: number;
}): 'absent' | 'exact' {
  if (!Number.isSafeInteger(input.exact_matches) || input.exact_matches < 0
    || !Number.isSafeInteger(input.conflicting_matches) || input.conflicting_matches < 0) {
    throw new ContractViolation('E_RELEASE_AMBIGUOUS', 'Release readback cardinality is invalid');
  }
  const total = input.exact_matches + input.conflicting_matches;
  if (total > 1 || (input.exact_matches > 0 && input.conflicting_matches > 0)) {
    throw new ContractViolation('E_RELEASE_AMBIGUOUS', 'Release readback returned multiple identities');
  }
  if (input.conflicting_matches === 1) {
    throw new ContractViolation('E_RELEASE_IDENTITY_CONFLICT', 'Release readback conflicts with expected identity');
  }
  return input.exact_matches === 1 ? 'exact' : 'absent';
}

export function releaseTransactionIdentity(input: {
  repository_id: 'OMA';
  semver: string;
  frozen_commit: string;
  transaction_nonce: string;
}): string {
  return sha256Hex(canonicalBytesV1([
    input.repository_id,
    input.semver,
    input.frozen_commit,
    input.transaction_nonce,
  ]));
}

export function releaseIdempotencyKey(input: {
  repository_id: 'OMA';
  semver: string;
  frozen_commit: string;
  transaction_nonce: string;
  step: string;
  expected_identity_digest: string;
}): string {
  return sha256Hex(canonicalBytesV1([
    input.repository_id,
    input.semver,
    input.frozen_commit,
    input.transaction_nonce,
    input.step,
    input.expected_identity_digest,
  ]));
}

export function registryCleanupDispositionKey(input: {
  repository_id: 'OMA';
  semver: string;
  frozen_commit: string;
  transaction_nonce: string;
  registry_id: string;
}): string {
  return sha256Hex(canonicalBytesV1([
    input.repository_id,
    input.semver,
    input.frozen_commit,
    input.transaction_nonce,
    'registry_cleanup_disposition',
    input.registry_id,
  ]));
}

export function claimedRegistryPolicyHash(policies: readonly ClaimedRegistryPolicyV1[]): string {
  policies.forEach((policy) => assertExactObjectKeys(
    policy as unknown as Record<string, unknown>,
    POLICY_KEYS,
    'claimed registry policy',
  ));
  return sha256Hex(canonicalBytesV1(policies));
}

export function stagingDistTag(transactionIdentityHash: string): string {
  assertSha256(transactionIdentityHash, 'transaction_identity_hash');
  return `oma-prerelease-${transactionIdentityHash.slice(0, 12)}`;
}

export function qualifyRegistryState(registryId: string, suffix: RegistryStateSuffixV1): string {
  if (registryId.trim() === '' || registryId.includes('.')) {
    throw new ContractViolation('E_RELEASE_STATE', 'Registry state ID must be non-empty and dot-free');
  }
  return `${registryId}.${suffix}`;
}

export function parseQualifiedRegistryState(
  state: string,
  allowedRegistryIds: readonly string[],
): { registry_id: string; suffix: RegistryStateSuffixV1 } {
  for (const registryId of allowedRegistryIds) {
    const prefix = `${registryId}.`;
    if (!state.startsWith(prefix)) continue;
    const suffix = state.slice(prefix.length) as RegistryStateSuffixV1;
    if (!OMA_REGISTRY_STATE_SUFFIX_SET_V1.includes(suffix)) break;
    return { registry_id: registryId, suffix };
  }
  throw new ContractViolation('E_RELEASE_STATE', 'Registry state is not exact or registry-qualified');
}

const REGISTRY_SUCCESS_PREDECESSOR: Readonly<Partial<Record<RegistryStateSuffixV1, RegistryStateSuffixV1>>> = Object.freeze({
  published: 'publish_pending',
  version_readback_pending: 'published',
  version_readback_passed: 'version_readback_pending',
  staging_tag_set_pending: 'version_readback_passed',
  staging_tag_set: 'staging_tag_set_pending',
  staging_tag_readback_pending: 'staging_tag_set',
  staging_tag_readback_passed: 'staging_tag_readback_pending',
  final_tag_set: 'final_tag_set_pending',
  final_tag_readback_pending: 'final_tag_set',
  final_tag_readback_passed: 'final_tag_readback_pending',
  final_tag_restored: 'final_tag_restore_pending',
  final_tag_restore_readback_pending: 'final_tag_restored',
  final_tag_restore_readback_passed: 'final_tag_restore_readback_pending',
  deprecated: 'deprecation_pending',
  deprecation_readback_pending: 'deprecated',
  deprecation_readback_passed: 'deprecation_readback_pending',
});

const REGISTRY_PENDING_BASES = [
  'publish',
  'version_readback',
  'staging_tag_set',
  'staging_tag_readback',
  'final_tag_set',
  'final_tag_readback',
  'final_tag_restore',
  'final_tag_restore_readback',
  'deprecation',
  'deprecation_readback',
] as const;

const REGISTRY_UNKNOWN_RECONCILIATION: Readonly<Partial<Record<
RegistryStateSuffixV1,
RegistryStateSuffixV1
>>> = Object.freeze({
  publish_unknown: 'version_readback_pending',
  version_readback_unknown: 'version_readback_pending',
  staging_tag_set_unknown: 'staging_tag_readback_pending',
  staging_tag_readback_unknown: 'staging_tag_readback_pending',
  final_tag_set_unknown: 'final_tag_readback_pending',
  final_tag_readback_unknown: 'final_tag_readback_pending',
  final_tag_restore_unknown: 'final_tag_restore_readback_pending',
  final_tag_restore_readback_unknown: 'final_tag_restore_readback_pending',
  deprecation_unknown: 'deprecation_readback_pending',
  deprecation_readback_unknown: 'deprecation_readback_pending',
});

export function registryPendingDerivativeOracle(): Array<{
  pending: RegistryStateSuffixV1;
  unknown: RegistryStateSuffixV1;
  failed: RegistryStateSuffixV1;
}> {
  return REGISTRY_PENDING_BASES.map((base) => ({
    pending: `${base}_pending` as RegistryStateSuffixV1,
    unknown: `${base}_unknown` as RegistryStateSuffixV1,
    failed: `${base}_failed` as RegistryStateSuffixV1,
  }));
}

export function assertRegistryTransition(input: {
  registry_id: string;
  current_suffix: RegistryStateSuffixV1;
  next_suffix: RegistryStateSuffixV1;
  authoritative_no_write?: boolean;
  exact_readback?: 'present' | 'absent' | 'conflict';
}): void {
  const { current_suffix: current, next_suffix: next } = input;
  if (!OMA_REGISTRY_STATE_SUFFIX_SET_V1.includes(current)
    || !OMA_REGISTRY_STATE_SUFFIX_SET_V1.includes(next)) {
    throw new ContractViolation('E_RELEASE_STATE', 'Registry transition uses an unknown suffix');
  }
  const directPredecessor = REGISTRY_SUCCESS_PREDECESSOR[next];
  if (directPredecessor === current) return;
  for (const derivative of registryPendingDerivativeOracle()) {
    if (current === derivative.pending && (next === derivative.unknown || next === derivative.failed)) return;
    if (current === derivative.failed && next === derivative.pending && input.authoritative_no_write === true) return;
    if (current === derivative.unknown) {
      if (input.exact_readback === 'conflict') {
        throw new ContractViolation('E_RELEASE_IDENTITY_CONFLICT', 'Registry readback conflicts with expected identity');
      }
      if (input.exact_readback === 'absent' && next === derivative.pending) return;
      if (input.exact_readback === undefined
        && next === REGISTRY_UNKNOWN_RECONCILIATION[current]) return;
    }
  }
  throw new ContractViolation('E_RELEASE_STATE', 'Registry transition predecessor is invalid', {
    registry_id: input.registry_id,
    current,
    next,
  });
}

export function validateRegistryPolicy(
  policy: ClaimedRegistryPolicyV1,
  allowContractFixtureId = false,
): void {
  assertExactObjectKeys(policy as unknown as Record<string, unknown>, POLICY_KEYS, 'registry policy');
  if (!allowContractFixtureId && !PRODUCTION_REGISTRY_IDS_V1.includes(
    policy.registry_id as typeof PRODUCTION_REGISTRY_IDS_V1[number],
  )) {
    throw new ContractViolation('E_REGISTRY_POLICY', 'Registry is outside the production allowlist');
  }
  if (policy.package !== '@iml1s/oh-my-agy' || policy.final_dist_tag.trim() === ''
    || policy.final_dist_tag === policy.staging_tag_derivation
    || policy.staging_tag_derivation === 'latest') {
    throw new ContractViolation('E_REGISTRY_POLICY', 'Registry package/tag policy is invalid');
  }
  assertSha256(policy.credential_preflight_hash, 'credential_preflight_hash');
  assertSha256(policy.readback_preflight_hash, 'readback_preflight_hash');
}

export function validateClaimedRegistry(
  registry: ClaimedRegistryV1,
  transactionIdentityHash: string,
  allowContractFixtureId = false,
): void {
  assertExactObjectKeys(registry as unknown as Record<string, unknown>, CLAIMED_KEYS, 'claimed registry');
  validateRegistryPolicy({
    registry_id: registry.registry_id,
    registry_url: registry.registry_url,
    package: registry.package,
    final_dist_tag: registry.final_dist_tag,
    staging_tag_derivation: registry.staging_tag_derivation,
    credential_preflight_hash: registry.credential_preflight_hash,
    readback_preflight_hash: registry.readback_preflight_hash,
  }, allowContractFixtureId);
  assertSha256(registry.tarball_sha256, 'tarball_sha256');
  assertSha256(registry.provenance_hash, 'provenance_hash');
  if (registry.integrity.trim() === ''
    || registry.staging_dist_tag !== stagingDistTag(transactionIdentityHash)
    || registry.staging_dist_tag === 'latest') {
    throw new ContractViolation('E_REGISTRY_POLICY', 'Claimed registry materialization is invalid');
  }
}

export function validateReleaseCallRecord(
  record: ReleaseCallRecordV1,
  transaction: Pick<ReleaseTransactionV1, 'repository_id' | 'semver' | 'frozen_commit' | 'transaction_nonce'>,
  step: string,
): void {
  validateReleaseCallRecordShape(record, []);
  assertNonEmptyString(step, 'release call step');
  const derivedStep = releaseCallStepFromState(record.state, []);
  if (step !== derivedStep) {
    throw new ContractViolation('E_RELEASE_IDEMPOTENCY', 'Release call step does not match its immutable state');
  }
  const expectedKey = releaseIdempotencyKey({
    ...transaction,
    step,
    expected_identity_digest: record.expected_identity_digest,
  });
  if (record.idempotency_key !== expectedKey) {
    throw new ContractViolation('E_RELEASE_IDEMPOTENCY', 'Release call idempotency key changed');
  }
}

function releaseCallStepFromState(state: string, registryIds: readonly string[]): string {
  const github = RELEASE_EXTERNAL_OPERATION_ORACLE_V1.find((row) =>
    row.pending === state || row.unknown === state || row.failed === state || row.success === state);
  if (github !== undefined) return github.operation;
  const registry = parseQualifiedRegistryState(state, registryIds);
  const suffix = registry.suffix;
  for (const terminal of ['_pending', '_unknown', '_failed', '_passed'] as const) {
    if (suffix.endsWith(terminal)) {
      return `registry:${registry.registry_id}:${suffix.slice(0, -terminal.length)}`;
    }
  }
  const terminalMap: Readonly<Record<string, string>> = {
    published: 'publish',
    staging_tag_set: 'staging_tag_set',
    final_tag_set: 'final_tag_set',
    final_tag_restored: 'final_tag_restore',
    deprecated: 'deprecation',
    deprecation_not_applicable: 'deprecation',
  };
  const operation = terminalMap[suffix];
  if (operation === undefined) {
    throw new ContractViolation('E_RELEASE_IDEMPOTENCY', 'Release call state has no unambiguous operation');
  }
  return `registry:${registry.registry_id}:${operation}`;
}

function validateReleaseCallRecordShape(
  value: unknown,
  registryIds: readonly string[],
): asserts value is ReleaseCallRecordV1 {
  assertPlainRecord(value, 'release call record');
  assertExactObjectKeys(
    value,
    RELEASE_CALL_RECORD_KEYS,
    'release call record',
  );
  const record = value as unknown as ReleaseCallRecordV1;
  if (record.store_kind !== 'release_call_record' || record.schema_version !== 1
    || !Number.isSafeInteger(record.attempt) || record.attempt <= 0
    || typeof record.dispatched !== 'boolean') {
    throw new ContractViolation('E_RELEASE_CALL', 'Release call record shape is invalid');
  }
  if (!isReleaseStateV1(record.state, registryIds)
    || !isReleaseStateV1(record.allowed_predecessor, registryIds)) {
    throw new ContractViolation('E_RELEASE_STATE', 'Release call record state grammar is invalid');
  }
  assertNonEmptyString(record.redacted_external_locator, 'redacted_external_locator');
  if (!/(?:<redacted>|\[redacted\]|redacted\b)/i.test(record.redacted_external_locator)
    || /(?:token|secret|password|authorization|cookie)\s*[=:]\s*(?!<redacted>|\[redacted\]|redacted\b)\S+/i
      .test(record.redacted_external_locator)) {
    throw new ContractViolation('E_RELEASE_CALL', 'External locator is not safely redacted');
  }
  assertSha256(record.expected_identity_digest, 'expected_identity_digest');
  assertSha256(record.request_digest, 'request_digest');
  if (record.byte_digest !== null) assertSha256(record.byte_digest, 'byte_digest');
  if (record.external_object_digest !== null) {
    assertSha256(record.external_object_digest, 'external_object_digest');
  }
  for (const [label, value] of [
    ['prior_mutable_object_identity', record.prior_mutable_object_identity],
    ['external_id', record.external_id],
    ['external_etag', record.external_etag],
  ] as const) {
    if (value !== null) assertNonEmptyString(value, label);
  }
  if (record.readback_at !== null) assertCanonicalUtcTimestamp(record.readback_at, 'readback_at');
  assertSha256(record.idempotency_key, 'idempotency_key');
  if (!record.dispatched && (record.external_id !== null || record.external_etag !== null
    || record.external_object_digest !== null || record.readback_at !== null)) {
    throw new ContractViolation('E_RELEASE_CALL', 'Pre-dispatch record cannot contain external success');
  }
  if (record.readback_at !== null
    && (record.external_id === null || record.external_object_digest === null)) {
    throw new ContractViolation('E_RELEASE_CALL', 'Readback receipt lacks external identity/digest');
  }
}

export function validateRegistryCleanupDispositions(input: {
  transaction: Pick<ReleaseTransactionV1, 'repository_id' | 'semver' | 'frozen_commit' | 'transaction_nonce'>;
  registry_ids: string[];
  dispositions: Array<{
    registry_id: string;
    state: string;
    record_key: string;
    predecessor: string;
    authoritative_no_write_proof: boolean;
  }>;
}): void {
  if (input.dispositions.length !== input.registry_ids.length) {
    throw new ContractViolation('E_WITHDRAWAL_BARRIER', 'Every registry needs exactly one cleanup disposition');
  }
  input.registry_ids.forEach((registryId, index) => {
    const disposition = input.dispositions[index];
    if (disposition.registry_id !== registryId) {
      throw new ContractViolation('E_WITHDRAWAL_BARRIER', 'Registry cleanup order changed');
    }
    const expectedPredecessor = index === 0
      ? 'withdrawal_registry_cleanup_pending'
      : input.dispositions[index - 1].state;
    if (disposition.predecessor !== expectedPredecessor
      || (index > 0 && ![
        qualifyRegistryState(input.registry_ids[index - 1], 'deprecation_readback_passed'),
        qualifyRegistryState(input.registry_ids[index - 1], 'deprecation_not_applicable'),
      ].includes(expectedPredecessor))) {
      throw new ContractViolation('E_WITHDRAWAL_BARRIER', 'Registry cleanup predecessor is invalid');
    }
    const allowedStates = [
      qualifyRegistryState(registryId, 'deprecation_readback_passed'),
      qualifyRegistryState(registryId, 'deprecation_not_applicable'),
    ];
    if (!allowedStates.includes(disposition.state)) {
      throw new ContractViolation('E_WITHDRAWAL_BARRIER', 'Registry cleanup is not terminal');
    }
    if (disposition.state.endsWith('.deprecation_not_applicable')
      && !disposition.authoritative_no_write_proof) {
      throw new ContractViolation('E_WITHDRAWAL_BARRIER', 'No-call disposition requires no-write proof');
    }
    const expectedKey = registryCleanupDispositionKey({
      ...input.transaction,
      registry_id: registryId,
    });
    if (disposition.record_key !== expectedKey) {
      throw new ContractViolation('E_WITHDRAWAL_BARRIER', 'Registry cleanup disposition key is invalid');
    }
  });
}

export function releaseBundleManifestRelativePath(runId: string): string {
  return path.posix.join(
    '.agy',
    'artifacts',
    'dual-parity',
    safePathKey(runId),
    'OMA-W6',
    'release-bundle-manifest.json',
  );
}

export function releaseAssetRootV1(assets: readonly ReleaseBundleAssetV1[]): string {
  return sha256Hex(canonicalBytesV1(assets.map((asset) => [
    asset.name,
    asset.relative_path,
    asset.byte_length,
    asset.sha256,
    asset.media_type,
  ])));
}

export function validateReleaseBundleManifest(
  manifest: ReleaseBundleManifestV1,
  claimedRegistries: readonly ClaimedRegistryV1[],
): void {
  assertPlainRecord(manifest, 'release bundle manifest');
  assertExactObjectKeys(
    manifest as unknown as Record<string, unknown>,
    RELEASE_BUNDLE_MANIFEST_KEYS,
    'release bundle manifest',
  );
  if (manifest.store_kind !== 'release_bundle_manifest' || manifest.schema_version !== 1
    || manifest.repository_id !== 'OMA' || manifest.owner !== 'oma-final-composition-owner') {
    throw new ContractViolation('E_RELEASE_BUNDLE', 'Release bundle manifest identity is invalid');
  }
  assertNonEmptyString(manifest.run_id, 'run_id');
  assertNonEmptyString(manifest.semver, 'semver');
  assertGitObjectId(manifest.candidate_commit, 'candidate_commit');
  assertGitObjectId(manifest.candidate_tree, 'candidate_tree');
  assertConfinedRelativePosixPath(manifest.bundle_directory, 'bundle_directory');
  assertStringArray(manifest.public_upload_order, 'public_upload_order', {
    nonEmptyValues: true,
    unique: true,
  });
  if (!Array.isArray(manifest.assets) || !Array.isArray(manifest.registry_bindings)) {
    throw new ContractViolation('E_RELEASE_BUNDLE', 'Release bundle collections are invalid');
  }
  const payloadName = `iml1s-oh-my-agy-${manifest.semver}.tgz`;
  const expectedOrder = [payloadName, 'SHA256SUMS'];
  if (JSON.stringify(manifest.public_upload_order) !== JSON.stringify(expectedOrder)
    || manifest.assets.length !== 2
    || manifest.assets.map((asset) => asset.name).join('\0') !== expectedOrder.join('\0')) {
    throw new ContractViolation('E_RELEASE_BUNDLE', 'Release bundle asset set/order is invalid');
  }
  for (const asset of manifest.assets) {
    assertPlainRecord(asset, 'release bundle asset');
    assertExactObjectKeys(
      asset as unknown as Record<string, unknown>,
      RELEASE_BUNDLE_ASSET_KEYS,
      'release bundle asset',
    );
    assertNonEmptyString(asset.name, 'asset.name');
    assertNonEmptyString(asset.media_type, `${asset.name}.media_type`);
    assertConfinedRelativePosixPath(asset.relative_path, `${asset.name}.relative_path`);
    if (asset.relative_path !== path.posix.join(manifest.bundle_directory, asset.name)) {
      throw new ContractViolation('E_RELEASE_BUNDLE', 'Asset path is outside the frozen bundle directory');
    }
    if (!Number.isSafeInteger(asset.byte_length) || asset.byte_length < 0) {
      throw new ContractViolation('E_RELEASE_BUNDLE', 'Asset byte length is invalid');
    }
    assertSha256(asset.sha256, `${asset.name}.sha256`);
  }
  const payload = manifest.assets[0];
  const checksum = manifest.assets[1];
  const expectedChecksumBytes = `${payload.sha256}  ${payloadName}\n`;
  if (manifest.checksum_bytes !== expectedChecksumBytes
    || manifest.checksum_byte_length !== Buffer.byteLength(expectedChecksumBytes)
    || manifest.checksum_sha256 !== sha256Hex(Buffer.from(expectedChecksumBytes, 'utf8'))
    || checksum.byte_length !== manifest.checksum_byte_length
    || checksum.sha256 !== manifest.checksum_sha256) {
    throw new ContractViolation('E_RELEASE_BUNDLE', 'SHA256SUMS bytes/hash do not match');
  }
  if (manifest.release_asset_root !== releaseAssetRootV1(manifest.assets)) {
    throw new ContractViolation('E_RELEASE_BUNDLE', 'Release asset root changed');
  }
  assertPlainRecord(manifest.build_receipt, 'release build receipt');
  assertExactObjectKeys(
    manifest.build_receipt as unknown as Record<string, unknown>,
    RELEASE_BUILD_RECEIPT_KEYS,
    'release build receipt',
  );
  assertStringArray(manifest.build_receipt.argv, 'build receipt argv', { nonEmptyValues: true });
  assertSha256(manifest.build_receipt.cwd_realpath_hash, 'cwd_realpath_hash');
  if (!Array.isArray(manifest.build_receipt.toolchain)
    || !Array.isArray(manifest.build_receipt.sanitized_environment)) {
    throw new ContractViolation('E_RELEASE_BUNDLE', 'Build receipt collections are invalid');
  }
  for (const tool of manifest.build_receipt.toolchain) {
    assertPlainRecord(tool, 'build receipt toolchain entry');
    assertExactObjectKeys(tool as unknown as Record<string, unknown>, RELEASE_TOOLCHAIN_KEYS, 'toolchain entry');
    assertNonEmptyString(tool.name, 'toolchain.name');
    assertNonEmptyString(tool.version, 'toolchain.version');
    assertSha256(tool.binary_sha256, `${tool.name}.binary_sha256`);
  }
  for (const variable of manifest.build_receipt.sanitized_environment) {
    assertPlainRecord(variable, 'build receipt environment entry');
    assertExactObjectKeys(
      variable as unknown as Record<string, unknown>,
      RELEASE_ENVIRONMENT_KEYS,
      'environment entry',
    );
    assertNonEmptyString(variable.name, 'environment.name');
    assertSha256(variable.value_hash, variable.name);
  }
  for (const [label, value] of [
    ['source_date_epoch', manifest.build_receipt.source_date_epoch],
    ['locale', manifest.build_receipt.locale],
    ['timezone', manifest.build_receipt.timezone],
    ['umask', manifest.build_receipt.umask],
  ] as const) assertNonEmptyString(value, label);
  if (!Number.isSafeInteger(manifest.build_receipt.exit_code)) {
    throw new ContractViolation('E_RELEASE_BUNDLE', 'Build receipt exit code is invalid');
  }
  const buildReceipt = { ...manifest.build_receipt, receipt_hash: undefined };
  delete buildReceipt.receipt_hash;
  if (manifest.build_receipt.receipt_hash !== sha256Hex(canonicalBytesV1(buildReceipt))) {
    throw new ContractViolation('E_RELEASE_BUNDLE', 'Build receipt hash is invalid');
  }
  if (manifest.build_receipt.exit_code !== 0) {
    throw new ContractViolation('E_RELEASE_BUNDLE', 'Build receipt must bind a successful npm pack');
  }
  for (const [label, digest] of [
    ['stdout_sha256', manifest.build_receipt.stdout_sha256],
    ['stderr_sha256', manifest.build_receipt.stderr_sha256],
    ['archive_sha256', manifest.build_receipt.archive_sha256],
    ['packlist_sha256', manifest.build_receipt.packlist_sha256],
  ] as const) assertSha256(digest, label);
  if (manifest.build_receipt.archive_sha256 !== payload.sha256) {
    throw new ContractViolation('E_RELEASE_BUNDLE', 'Build receipt archive hash differs from the payload asset');
  }
  manifest.registry_bindings.forEach((registry) => {
    assertPlainRecord(registry, 'release registry binding');
    assertExactObjectKeys(
      registry as unknown as Record<string, unknown>,
      CLAIMED_KEYS,
      'release registry binding',
    );
    validateRegistryPolicy({
      registry_id: registry.registry_id,
      registry_url: registry.registry_url,
      package: registry.package,
      final_dist_tag: registry.final_dist_tag,
      staging_tag_derivation: registry.staging_tag_derivation,
      credential_preflight_hash: registry.credential_preflight_hash,
      readback_preflight_hash: registry.readback_preflight_hash,
    });
    assertSha256(registry.tarball_sha256, 'tarball_sha256');
    assertSha256(registry.provenance_hash, 'provenance_hash');
    assertNonEmptyString(registry.integrity, 'integrity');
    if (!/^oma-prerelease-[0-9a-f]{12}$/.test(registry.staging_dist_tag)) {
      throw new ContractViolation('E_RELEASE_BUNDLE', 'Registry binding staging tag is invalid');
    }
  });
  if (canonicalBytesV1(manifest.registry_bindings).compare(canonicalBytesV1(claimedRegistries)) !== 0) {
    throw new ContractViolation('E_RELEASE_BUNDLE', 'Registry bindings differ from frozen claimed registries');
  }
}

export function validateReleaseTransaction(transaction: ReleaseTransactionV1): void {
  assertExactObjectKeys(
    transaction as unknown as Record<string, unknown>,
    RELEASE_TRANSACTION_KEYS,
    'release transaction',
  );
  if (transaction.store_kind !== 'release_transaction' || transaction.schema_version !== 1
    || transaction.repository_id !== 'OMA') {
    throw new ContractViolation('E_RELEASE_TRANSACTION', 'Release transaction identity is invalid');
  }
  assertNonEmptyString(transaction.semver, 'semver');
  assertNonEmptyString(transaction.transaction_nonce, 'transaction_nonce');
  assertNonEmptyString(transaction.state, 'release transaction state');
  if (!Array.isArray(transaction.claimed_registries) || !Array.isArray(transaction.call_records)
    || typeof transaction.channel_states !== 'object' || transaction.channel_states === null
    || Array.isArray(transaction.channel_states) || typeof transaction.canonical_verified !== 'boolean') {
    throw new ContractViolation('E_RELEASE_TRANSACTION', 'Release transaction collections are invalid');
  }
  if (transaction.supersedes_transaction_hash !== null) {
    assertSha256(transaction.supersedes_transaction_hash, 'supersedes_transaction_hash');
  }
  assertGitObjectId(transaction.frozen_commit, 'frozen_commit');
  for (const [label, hash] of [
    ['transaction_identity_hash', transaction.transaction_identity_hash],
    ['parent_w6_aggregate_hash', transaction.parent_w6_aggregate_hash],
    ['claimed_registry_policy_hash', transaction.claimed_registry_policy_hash],
  ] as const) assertSha256(hash, label);
  const expectedIdentity = releaseTransactionIdentity(transaction);
  if (transaction.transaction_identity_hash !== expectedIdentity) {
    throw new ContractViolation('E_RELEASE_TRANSACTION', 'Release transaction identity hash is invalid');
  }
  const registryIds = transaction.claimed_registries.map((registry) => registry.registry_id);
  if (new Set(registryIds).size !== registryIds.length) {
    throw new ContractViolation('E_RELEASE_TRANSACTION', 'Claimed registry IDs must be unique and ordered');
  }
  transaction.claimed_registries.forEach((registry) =>
    validateClaimedRegistry(registry, transaction.transaction_identity_hash));
  const policies = transaction.claimed_registries.map((registry) => ({
    registry_id: registry.registry_id,
    registry_url: registry.registry_url,
    package: registry.package,
    final_dist_tag: registry.final_dist_tag,
    staging_tag_derivation: registry.staging_tag_derivation,
    credential_preflight_hash: registry.credential_preflight_hash,
    readback_preflight_hash: registry.readback_preflight_hash,
  }));
  if (transaction.claimed_registry_policy_hash !== claimedRegistryPolicyHash(policies)) {
    throw new ContractViolation('E_REGISTRY_POLICY', 'Claimed registry set/order/policy hash changed');
  }
  const forbiddenScalarAliases = ['package_', 'promotion_', 'latest_'];
  if (forbiddenScalarAliases.some((prefix) => transaction.state.startsWith(prefix))) {
    throw new ContractViolation('E_RELEASE_STATE', 'Scalar package/promotion/latest state aliases are forbidden');
  }
  if (!isReleaseStateV1(transaction.state, registryIds)) {
    throw new ContractViolation('E_RELEASE_STATE', 'Release transaction state is outside the frozen grammar');
  }
  transaction.call_records.forEach((record) => {
    validateReleaseCallRecordShape(record, registryIds);
    const step = releaseCallStepFromState(record.state, registryIds);
    const expectedKey = releaseIdempotencyKey({
      repository_id: transaction.repository_id,
      semver: transaction.semver,
      frozen_commit: transaction.frozen_commit,
      transaction_nonce: transaction.transaction_nonce,
      step,
      expected_identity_digest: record.expected_identity_digest,
    });
    if (record.idempotency_key !== expectedKey) {
      throw new ContractViolation(
        'E_RELEASE_IDEMPOTENCY',
        'Release call idempotency key is not bound to this transaction and immutable step',
      );
    }
  });
  for (const [channel, state] of Object.entries(transaction.channel_states)) {
    if (channel === 'github') {
      if (!GLOBAL_RELEASE_STATE_SET_V1.has(state)) {
        throw new ContractViolation('E_RELEASE_STATE', 'GitHub channel state is outside the frozen grammar');
      }
      continue;
    }
    if (!registryIds.includes(channel)) {
      throw new ContractViolation('E_RELEASE_STATE', 'Release channel key is outside the claimed channels');
    }
    const parsed = parseQualifiedRegistryState(state, registryIds);
    if (parsed.registry_id !== channel) {
      throw new ContractViolation('E_RELEASE_STATE', 'Registry channel state belongs to another channel');
    }
  }
  if (transaction.canonical_verified
    && transaction.state !== 'complete'
    && transaction.state !== 'final_readback_passed') {
    throw new ContractViolation('E_RELEASE_TRANSACTION', 'Canonical verified cannot precede final channel proof');
  }
}

export function assertW6BranchFreezeTransition(current: string, next: string): void {
  const index = W6_BRANCH_FREEZE_CHAIN_V1.indexOf(current as typeof W6_BRANCH_FREEZE_CHAIN_V1[number]);
  if (index < 0 || W6_BRANCH_FREEZE_CHAIN_V1[index + 1] !== next) {
    throw new ContractViolation('E_RELEASE_STATE', 'W6 branch/freeze predecessor is invalid');
  }
}
