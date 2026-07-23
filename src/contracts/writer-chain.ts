import * as crypto from 'crypto';
import * as path from 'path';
import {
  canonicalBytesV1,
  canonicalJsonV1,
  ContractViolation,
  assertExactObjectKeys,
  assertGitObjectId,
  assertNonEmptyString,
  assertSha256,
} from './state-schemas';
import { safePathKey } from './path-key';

export const HANDOFF_DOMAIN_V1 = Buffer.from('OMG-OMA-HANDOFF-V1\0', 'utf8');
export const REPOSITORY_AGGREGATE_INPUT_DOMAIN_V1 = Buffer.from(
  'OMG-OMA-REPO-AGGREGATE-INPUT-V1\0',
  'utf8',
);
export const REPOSITORY_AGGREGATE_FINAL_DOMAIN_V1 = Buffer.from(
  'OMG-OMA-REPO-AGGREGATE-FINAL-V1\0',
  'utf8',
);

export const OMA_WAVE_IDS = [
  'OMA-W0',
  'OMA-W1',
  'OMA-W2',
  'OMA-W3',
  'OMA-W4',
  'OMA-W5',
  'OMA-W6',
  'OMA-W7',
] as const;

export type OmaWaveId = typeof OMA_WAVE_IDS[number];

export const PARENT_HASH_ORACLE_V1: Readonly<Record<OmaWaveId, readonly OmaWaveId[]>> = Object.freeze({
  'OMA-W0': [],
  'OMA-W1': ['OMA-W0'],
  'OMA-W2': ['OMA-W0'],
  'OMA-W3': ['OMA-W2'],
  'OMA-W4': ['OMA-W1', 'OMA-W2'],
  'OMA-W5': ['OMA-W3', 'OMA-W4'],
  'OMA-W6': ['OMA-W0', 'OMA-W1', 'OMA-W2', 'OMA-W3', 'OMA-W4', 'OMA-W5'],
  'OMA-W7': ['OMA-W6'],
});

export interface TargetedTestReceiptV1 {
  argv: string[];
  exit_code: number;
  stdout_sha256: string;
  stderr_sha256: string;
}

export interface PathProposalV1 {
  store_kind: 'dual_parity_path_proposal';
  schema_version: 1;
  repository_id: 'OMA';
  run_id: string;
  wave: OmaWaveId;
  owner: string;
  path: string;
  initial_sha256: string | 'ABSENT';
  final_sha256: string | 'ABSENT';
  disposition: 'changed' | 'no_change';
  reason: string;
  proposal_id: string;
  proposal_hash: string;
  targeted_tests: TargetedTestReceiptV1[];
}

export interface W6RequestBindingV1 {
  path: string;
  byte_length: number;
  sha256: string;
}

export interface ProposalIndexV1 {
  store_kind: 'dual_parity_proposal_index';
  schema_version: 1;
  repository_id: 'OMA';
  run_id: string;
  wave: OmaWaveId;
  owner: string;
  frozen_base_commit: string;
  frozen_base_tree: string;
  proposal_count: number;
  proposals: PathProposalV1[];
  proposal_merkle_root: string;
  w6_requests: W6RequestBindingV1[];
  created_at: string;
}

export interface HandoffPayloadV1 {
  store_kind: 'dual_parity_handoff';
  schema_version: 1;
  repository_id: 'OMA';
  run_id: string;
  wave: OmaWaveId;
  owner: string;
  key_id: string;
  frozen_base_commit: string;
  frozen_base_tree: string;
  manifest_revision: number;
  lease_generation: number;
  manifest_hash: string;
  proposal_index_hash: string;
  proposal_merkle_root: string;
  parent_waves: OmaWaveId[];
  parent_handoff_hashes: string[];
  completed_at: string;
}

export interface SignedHandoffV1 {
  signed_payload: HandoffPayloadV1;
  signature: string;
}

const TEST_RECEIPT_KEYS = [
  'argv', 'exit_code', 'stdout_sha256', 'stderr_sha256',
] as const;

const PATH_PROPOSAL_KEYS = [
  'store_kind', 'schema_version', 'repository_id', 'run_id', 'wave', 'owner', 'path',
  'initial_sha256', 'final_sha256', 'disposition', 'reason', 'proposal_id', 'proposal_hash',
  'targeted_tests',
] as const;

const W6_REQUEST_BINDING_KEYS = ['path', 'byte_length', 'sha256'] as const;

const PROPOSAL_INDEX_KEYS = [
  'store_kind', 'schema_version', 'repository_id', 'run_id', 'wave', 'owner',
  'frozen_base_commit', 'frozen_base_tree', 'proposal_count', 'proposals',
  'proposal_merkle_root', 'w6_requests', 'created_at',
] as const;

const HANDOFF_PAYLOAD_KEYS = [
  'store_kind', 'schema_version', 'repository_id', 'run_id', 'wave', 'owner', 'key_id',
  'frozen_base_commit', 'frozen_base_tree', 'manifest_revision', 'lease_generation', 'manifest_hash',
  'proposal_index_hash', 'proposal_merkle_root', 'parent_waves', 'parent_handoff_hashes',
  'completed_at',
] as const;

const SIGNED_HANDOFF_KEYS = ['signed_payload', 'signature'] as const;

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function assertRepositoryPath(repositoryPath: string): void {
  assertNonEmptyString(repositoryPath, 'proposal path');
  if (path.isAbsolute(repositoryPath) || repositoryPath.includes('\\')
    || repositoryPath.includes('\0')) {
    throw new ContractViolation('E_PROPOSAL_PATH', 'Proposal path must be repository-relative POSIX syntax');
  }
  const normalized = path.posix.normalize(repositoryPath);
  if (normalized !== repositoryPath || normalized === '..' || normalized.startsWith('../')) {
    throw new ContractViolation('E_PROPOSAL_PATH', 'Proposal path escapes or is not normalized');
  }
  if (repositoryPath.split('/').includes('AGENTS.md')) {
    throw new ContractViolation('E_PROPOSAL_PATH', 'Immutable AGENTS.md cannot appear in a proposal');
  }
}

function assertIsoTimestamp(value: string, label: string): void {
  assertNonEmptyString(value, label);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new ContractViolation('E_SCHEMA_INVALID', `${label} must be canonical ISO-8601 UTC`);
  }
}

function validateTargetedTestReceipt(receipt: TargetedTestReceiptV1): void {
  assertExactObjectKeys(
    receipt as unknown as Record<string, unknown>,
    TEST_RECEIPT_KEYS,
    'targeted test receipt',
  );
  if (!Array.isArray(receipt.argv) || receipt.argv.length === 0
    || receipt.argv.some((entry) => typeof entry !== 'string' || entry === '')) {
    throw new ContractViolation('E_PROPOSAL_TEST', 'Targeted test argv must be a non-empty argv vector');
  }
  if (!Number.isSafeInteger(receipt.exit_code) || receipt.exit_code < 0) {
    throw new ContractViolation('E_PROPOSAL_TEST', 'Targeted test exit code must be a non-negative integer');
  }
  assertSha256(receipt.stdout_sha256, 'stdout_sha256');
  assertSha256(receipt.stderr_sha256, 'stderr_sha256');
}

function validateW6RequestBinding(
  binding: W6RequestBindingV1,
  index: Pick<ProposalIndexV1, 'run_id' | 'wave'>,
): void {
  if (typeof binding !== 'object' || binding === null || Array.isArray(binding)) {
    throw new ContractViolation('E_W6_REQUEST', 'W6 request binding must be an object');
  }
  assertExactObjectKeys(
    binding as unknown as Record<string, unknown>,
    W6_REQUEST_BINDING_KEYS,
    'W6 request binding',
  );
  assertRepositoryPath(binding.path);
  const expectedRoot = `.agy/artifacts/dual-parity/${safePathKey(index.run_id)}/${index.wave}`;
  if (!binding.path.startsWith(`${expectedRoot}/`)) {
    throw new ContractViolation(
      'E_W6_REQUEST_PATH',
      'W6 request path is outside its exact run/wave artifact root',
    );
  }
  if (!Number.isSafeInteger(binding.byte_length) || binding.byte_length <= 0) {
    throw new ContractViolation(
      'E_W6_REQUEST_LENGTH',
      'W6 request byte length must be a positive safe integer',
    );
  }
  assertSha256(binding.sha256, 'W6 request sha256');
}

export function pathProposalId(input: Pick<
PathProposalV1,
'repository_id' | 'run_id' | 'wave' | 'owner' | 'path' | 'initial_sha256' | 'final_sha256'
>): string {
  return sha256Hex(canonicalBytesV1([
    input.repository_id,
    input.run_id,
    input.wave,
    input.owner,
    input.path,
    input.initial_sha256,
    input.final_sha256,
  ]));
}

export function createPathProposal(
  input: Omit<PathProposalV1, 'proposal_id' | 'proposal_hash'>,
): PathProposalV1 {
  const withId = { ...input, proposal_id: pathProposalId(input) };
  const proposal = { ...withId, proposal_hash: proposalHash(withId) };
  validatePathProposal(proposal);
  return proposal;
}

export function validatePathProposal(proposal: PathProposalV1): void {
  assertExactObjectKeys(
    proposal as unknown as Record<string, unknown>,
    PATH_PROPOSAL_KEYS,
    'path proposal',
  );
  if (proposal.store_kind !== 'dual_parity_path_proposal' || proposal.schema_version !== 1
    || proposal.repository_id !== 'OMA' || !OMA_WAVE_IDS.includes(proposal.wave)) {
    throw new ContractViolation('E_PROPOSAL_SCHEMA', 'Path proposal schema identity is invalid');
  }
  assertNonEmptyString(proposal.run_id, 'run_id');
  assertNonEmptyString(proposal.owner, 'owner');
  assertRepositoryPath(proposal.path);
  for (const [label, value] of [
    ['initial_sha256', proposal.initial_sha256],
    ['final_sha256', proposal.final_sha256],
  ] as const) {
    if (value !== 'ABSENT') assertSha256(value, label);
  }
  if (proposal.initial_sha256 === 'ABSENT' && proposal.final_sha256 === 'ABSENT') {
    throw new ContractViolation('E_PROPOSAL_SCHEMA', 'A path cannot be absent in both trees');
  }
  const expectedDisposition = proposal.initial_sha256 === proposal.final_sha256
    ? 'no_change'
    : 'changed';
  if (proposal.disposition !== expectedDisposition) {
    throw new ContractViolation('E_PROPOSAL_SCHEMA', 'Proposal disposition does not match its hashes');
  }
  assertNonEmptyString(proposal.reason, 'reason');
  if (!Array.isArray(proposal.targeted_tests) || proposal.targeted_tests.length === 0) {
    throw new ContractViolation('E_PROPOSAL_TEST', 'Every path proposal needs targeted test receipts');
  }
  proposal.targeted_tests.forEach(validateTargetedTestReceipt);
  if (proposal.proposal_id !== pathProposalId(proposal)) {
    throw new ContractViolation('E_PROPOSAL_ID', 'Path proposal ID does not match immutable identity');
  }
  const { proposal_hash: ignored, ...material } = proposal;
  void ignored;
  if (proposal.proposal_hash !== proposalHash(material)) {
    throw new ContractViolation('E_PROPOSAL_HASH', 'Path proposal hash does not match canonical bytes');
  }
}

export function createProposalIndex(input: Omit<
ProposalIndexV1,
'proposal_count' | 'proposal_merkle_root'
>): ProposalIndexV1 {
  const proposals = [...input.proposals].sort((left, right) => compareUtf8(left.path, right.path));
  if (!Array.isArray(input.w6_requests)) {
    throw new ContractViolation('E_W6_REQUEST', 'W6 requests must be an array');
  }
  input.w6_requests.forEach((binding) => validateW6RequestBinding(binding, input));
  const w6Requests = [...input.w6_requests]
    .sort((left, right) => compareUtf8(left.path, right.path));
  const index: ProposalIndexV1 = {
    ...input,
    proposals,
    w6_requests: w6Requests,
    proposal_count: proposals.length,
    proposal_merkle_root: merkleRootV1(
      proposals.map((proposal) => ({ path: proposal.path, hash: proposal.proposal_hash })),
    ),
  };
  validateProposalIndex(index);
  return index;
}

export function validateProposalIndex(index: ProposalIndexV1): void {
  assertExactObjectKeys(
    index as unknown as Record<string, unknown>,
    PROPOSAL_INDEX_KEYS,
    'proposal index',
  );
  if (index.store_kind !== 'dual_parity_proposal_index' || index.schema_version !== 1
    || index.repository_id !== 'OMA' || !OMA_WAVE_IDS.includes(index.wave)) {
    throw new ContractViolation('E_PROPOSAL_INDEX', 'Proposal index schema identity is invalid');
  }
  assertNonEmptyString(index.run_id, 'run_id');
  assertNonEmptyString(index.owner, 'owner');
  assertGitObjectId(index.frozen_base_commit, 'frozen_base_commit');
  assertGitObjectId(index.frozen_base_tree, 'frozen_base_tree');
  assertIsoTimestamp(index.created_at, 'created_at');
  if (!Array.isArray(index.proposals) || index.proposals.length === 0
    || !Number.isSafeInteger(index.proposal_count)
    || index.proposal_count !== index.proposals.length) {
    throw new ContractViolation('E_PROPOSAL_INDEX', 'Proposal index must enumerate every owned path');
  }
  const seen = new Set<string>();
  for (let position = 0; position < index.proposals.length; position += 1) {
    const proposal = index.proposals[position];
    validatePathProposal(proposal);
    if (proposal.repository_id !== index.repository_id || proposal.run_id !== index.run_id
      || proposal.wave !== index.wave || proposal.owner !== index.owner) {
      throw new ContractViolation('E_PROPOSAL_INDEX', 'Proposal binding differs from its index');
    }
    if (seen.has(proposal.path)
      || (position > 0 && compareUtf8(index.proposals[position - 1].path, proposal.path) >= 0)) {
      throw new ContractViolation('E_PROPOSAL_INDEX', 'Proposal paths must be unique and byte-sorted');
    }
    seen.add(proposal.path);
  }
  const expectedRoot = merkleRootV1(
    index.proposals.map((proposal) => ({ path: proposal.path, hash: proposal.proposal_hash })),
  );
  if (index.proposal_merkle_root !== expectedRoot) {
    throw new ContractViolation('E_PROPOSAL_INDEX', 'Proposal Merkle root does not match exact path rows');
  }
  if (!Array.isArray(index.w6_requests)) {
    throw new ContractViolation('E_W6_REQUEST', 'W6 requests must be an array');
  }
  const requestPaths = new Set<string>();
  for (let position = 0; position < index.w6_requests.length; position += 1) {
    const binding = index.w6_requests[position];
    validateW6RequestBinding(binding, index);
    if (requestPaths.has(binding.path)
      || (position > 0 && compareUtf8(index.w6_requests[position - 1].path, binding.path) >= 0)) {
      throw new ContractViolation(
        'E_W6_REQUEST_ORDER',
        'W6 request paths must be unique and byte-sorted',
      );
    }
    requestPaths.add(binding.path);
  }
}

export function validateHandoffPayload(payload: HandoffPayloadV1): void {
  assertExactObjectKeys(
    payload as unknown as Record<string, unknown>,
    HANDOFF_PAYLOAD_KEYS,
    'handoff payload',
  );
  if (payload.store_kind !== 'dual_parity_handoff' || payload.schema_version !== 1
    || payload.repository_id !== 'OMA' || !OMA_WAVE_IDS.includes(payload.wave)) {
    throw new ContractViolation('E_HANDOFF_SCHEMA', 'Handoff payload schema identity is invalid');
  }
  assertNonEmptyString(payload.run_id, 'run_id');
  assertNonEmptyString(payload.owner, 'owner');
  assertSha256(payload.key_id, 'key_id');
  assertGitObjectId(payload.frozen_base_commit, 'frozen_base_commit');
  assertGitObjectId(payload.frozen_base_tree, 'frozen_base_tree');
  if (!Number.isSafeInteger(payload.manifest_revision) || payload.manifest_revision < 0) {
    throw new ContractViolation(
      'E_HANDOFF_SCHEMA',
      'Canonical handoff revisions accept non-negative integers only',
    );
  }
  if (!Number.isSafeInteger(payload.lease_generation) || payload.lease_generation <= 0) {
    throw new ContractViolation(
      'E_HANDOFF_SCHEMA',
      'Canonical handoff lease generations accept positive integers only',
    );
  }
  for (const [label, value] of [
    ['manifest_hash', payload.manifest_hash],
    ['proposal_index_hash', payload.proposal_index_hash],
    ['proposal_merkle_root', payload.proposal_merkle_root],
  ] as const) assertSha256(value, label);
  if (!Array.isArray(payload.parent_waves) || !Array.isArray(payload.parent_handoff_hashes)
    || JSON.stringify(payload.parent_waves) !== JSON.stringify(PARENT_HASH_ORACLE_V1[payload.wave])
    || payload.parent_handoff_hashes.length !== payload.parent_waves.length) {
    throw new ContractViolation('E_HANDOFF_PARENT_ORDER', 'Handoff parent wave order is invalid');
  }
  payload.parent_handoff_hashes.forEach((value) => assertSha256(value, 'parent_handoff_hash'));
  if (new Set(payload.parent_handoff_hashes).size !== payload.parent_handoff_hashes.length) {
    throw new ContractViolation('E_HANDOFF_PARENT_HASH', 'Duplicate parent handoff hash');
  }
  assertIsoTimestamp(payload.completed_at, 'completed_at');
}

export function sha256Hex(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function hmacSha256Hex(key: Buffer, domain: Buffer, payload: unknown): string {
  if (key.length !== 32) {
    throw new ContractViolation('E_KEY_LENGTH', 'HMAC key must be exactly 32 bytes');
  }
  return crypto.createHmac('sha256', key).update(domain).update(canonicalBytesV1(payload)).digest('hex');
}

export function proposalHash(proposal: Omit<PathProposalV1, 'proposal_hash'>): string {
  return sha256Hex(canonicalBytesV1(proposal));
}

export function merkleRootV1(items: readonly { path: string; hash: string }[]): string {
  const sorted = [...items].sort((left, right) => Buffer.compare(
    Buffer.from(left.path, 'utf8'),
    Buffer.from(right.path, 'utf8'),
  ));
  if (sorted.length === 0) return sha256Hex(canonicalJsonV1([]));
  let level = sorted.map((item) => sha256Hex(canonicalBytesV1([item.path, item.hash])));
  while (level.length > 1) {
    const next: string[] = [];
    for (let index = 0; index < level.length; index += 2) {
      const right = level[index + 1] ?? level[index];
      next.push(sha256Hex(Buffer.from(`${level[index]}${right}`, 'ascii')));
    }
    level = next;
  }
  return level[0];
}

export interface ParentHandoffRunBindingV1 {
  repository_id: 'OMA';
  run_id: string;
  frozen_base_commit: string;
  frozen_base_tree: string;
  current_manifest_revision: number;
  current_lease_generation: number;
  current_manifest_hash: string;
  previous_manifest_hash: string | null;
}

export function validateParentHandoffHashes(
  wave: OmaWaveId,
  parentWaves: readonly OmaWaveId[],
  parentHashes: readonly string[],
  parentHandoffs: readonly SignedHandoffV1[],
  binding: Readonly<ParentHandoffRunBindingV1>,
): void {
  const expectedWaves = PARENT_HASH_ORACLE_V1[wave];
  if (JSON.stringify(parentWaves) !== JSON.stringify(expectedWaves)) {
    throw new ContractViolation('E_HANDOFF_PARENT_ORDER', 'Handoff parent wave order is invalid', {
      wave,
      expectedWaves,
      parentWaves,
    });
  }
  if (parentHandoffs.length !== expectedWaves.length) {
    throw new ContractViolation('E_HANDOFF_PARENT_HASH', 'Every exact parent handoff must be supplied');
  }
  assertSha256(binding.current_manifest_hash, 'current_manifest_hash');
  if (binding.previous_manifest_hash !== null) {
    assertSha256(binding.previous_manifest_hash, 'previous_manifest_hash');
  }
  const expectedHashes = parentHandoffs.map((parent, index) => {
    validateHandoffPayload(parent.signed_payload);
    const payload = parent.signed_payload;
    if (payload.wave !== expectedWaves[index]
      || payload.repository_id !== binding.repository_id
      || payload.run_id !== binding.run_id
      || payload.frozen_base_commit !== binding.frozen_base_commit
      || payload.frozen_base_tree !== binding.frozen_base_tree) {
      throw new ContractViolation(
        'E_HANDOFF_PARENT_HASH',
        'Parent handoff identity is foreign, relabelled, or reordered',
      );
    }
    const current = payload.manifest_revision === binding.current_manifest_revision
      && payload.lease_generation === binding.current_lease_generation
      && payload.manifest_hash === binding.current_manifest_hash;
    const immediatePredecessor = binding.previous_manifest_hash !== null
      && payload.manifest_revision + 1 === binding.current_manifest_revision
      && payload.lease_generation + 1 === binding.current_lease_generation
      && payload.manifest_hash === binding.previous_manifest_hash;
    if (!current && !immediatePredecessor) {
      throw new ContractViolation(
        'E_HANDOFF_PARENT_HASH',
        'Parent handoff manifest revision, hash, or lease generation is stale',
      );
    }
    return handoffHash(parent);
  });
  if (JSON.stringify(parentHashes) !== JSON.stringify(expectedHashes)) {
    throw new ContractViolation('E_HANDOFF_PARENT_HASH', 'Handoff parent hashes are missing, stale, or reordered');
  }
  if (new Set(parentHashes).size !== parentHashes.length) {
    throw new ContractViolation('E_HANDOFF_PARENT_HASH', 'Duplicate parent handoff hash');
  }
}

export function signHandoff(
  payload: HandoffPayloadV1,
  key: Buffer,
  keyId: string,
): SignedHandoffV1 {
  validateHandoffPayload(payload);
  if (payload.key_id !== keyId) {
    throw new ContractViolation('E_HANDOFF_SIGNATURE', 'Handoff payload key identity is invalid');
  }
  return {
    signed_payload: payload,
    signature: hmacSha256Hex(key, HANDOFF_DOMAIN_V1, payload),
  };
}

export function handoffHash(envelope: Readonly<SignedHandoffV1>): string {
  return sha256Hex(canonicalBytesV1(envelope.signed_payload));
}

export function verifyHandoff(
  envelope: Readonly<SignedHandoffV1>,
  key: Buffer,
  expectedKeyId: string,
): void {
  assertExactObjectKeys(
    envelope as unknown as Record<string, unknown>,
    SIGNED_HANDOFF_KEYS,
    'signed handoff envelope',
  );
  validateHandoffPayload(envelope.signed_payload);
  if (envelope.signed_payload.key_id !== expectedKeyId) {
    throw new ContractViolation('E_HANDOFF_SIGNATURE', 'Handoff signer identity is invalid');
  }
  const expectedSignature = hmacSha256Hex(key, HANDOFF_DOMAIN_V1, envelope.signed_payload);
  assertSha256(handoffHash(envelope), 'handoff_hash');
  if (!/^[0-9a-f]{64}$/.test(envelope.signature)
    || !crypto.timingSafeEqual(Buffer.from(envelope.signature, 'hex'), Buffer.from(expectedSignature, 'hex'))) {
    throw new ContractViolation('E_HANDOFF_SIGNATURE', 'Handoff hash or signature is invalid');
  }
}

export interface AggregateEnvelopeV1<T> {
  algorithm: 'HMAC-SHA256';
  signer_id: string;
  key_id: string;
  payload_hash: string;
  signature: string;
  payload: T;
}

export function signAggregate<T>(
  payload: T,
  key: Buffer,
  signerId: string,
  keyId: string,
  phase: 'input' | 'final',
): AggregateEnvelopeV1<T> {
  const domain = phase === 'input'
    ? REPOSITORY_AGGREGATE_INPUT_DOMAIN_V1
    : REPOSITORY_AGGREGATE_FINAL_DOMAIN_V1;
  return {
    algorithm: 'HMAC-SHA256',
    signer_id: signerId,
    key_id: keyId,
    payload_hash: sha256Hex(canonicalBytesV1(payload)),
    signature: hmacSha256Hex(key, domain, payload),
    payload,
  };
}

export function verifyAggregate<T>(
  envelope: Readonly<AggregateEnvelopeV1<T>>,
  key: Buffer,
  signerId: string,
  keyId: string,
  phase: 'input' | 'final',
): void {
  const expected = signAggregate(envelope.payload, key, signerId, keyId, phase);
  if (envelope.algorithm !== expected.algorithm || envelope.signer_id !== signerId
    || envelope.key_id !== keyId || envelope.payload_hash !== expected.payload_hash
    || !/^[0-9a-f]{64}$/.test(envelope.signature)
    || !crypto.timingSafeEqual(Buffer.from(envelope.signature, 'hex'), Buffer.from(expected.signature, 'hex'))) {
    throw new ContractViolation('E_AGGREGATE_SIGNATURE', 'Repository aggregate signature is invalid');
  }
}
