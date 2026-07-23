import * as crypto from 'crypto';
import { RecoveryWarning, orderedRecoveryWarnings } from '../contracts/resume';
import { canonicalBytesV1, assertSha256 } from '../contracts/state-schemas';

export interface CompactionPackV1 {
  store_kind: 'compaction_pack';
  schema_version: 1;
  repository_id: 'OMA';
  run_id: string;
  aggregate_id: string;
  aggregate_revision: number;
  aggregate_sha256: string;
  generation: number;
  guidance_base64: string;
  guidance_sha256: string;
  receipt_hashes: string[];
  warnings: RecoveryWarning[];
  counters: Record<string, number>;
  unknown_record_hashes: string[];
  created_at: string;
  pack_sha256: string;
}

export interface CreateCompactionPackInput {
  runId: string;
  aggregateId: string;
  aggregateRevision: number;
  aggregateSha256: string;
  generation: number;
  guidance: Buffer;
  receiptHashes: string[];
  warnings: RecoveryWarning[];
  counters: Record<string, number>;
  unknownRecordHashes: string[];
  createdAt: string;
}

export function createCompactionPack(input: Readonly<CreateCompactionPackInput>): CompactionPackV1 {
  const withoutHash: Omit<CompactionPackV1, 'pack_sha256'> = {
    store_kind: 'compaction_pack',
    schema_version: 1,
    repository_id: 'OMA',
    run_id: input.runId,
    aggregate_id: input.aggregateId,
    aggregate_revision: input.aggregateRevision,
    aggregate_sha256: input.aggregateSha256,
    generation: input.generation,
    guidance_base64: input.guidance.toString('base64'),
    guidance_sha256: sha(input.guidance),
    receipt_hashes: [...input.receiptHashes],
    warnings: orderedRecoveryWarnings(input.warnings),
    counters: Object.fromEntries(Object.entries(input.counters).sort(([a], [b]) => a.localeCompare(b))),
    unknown_record_hashes: [...input.unknownRecordHashes],
    created_at: input.createdAt,
  };
  const pack = { ...withoutHash, pack_sha256: sha(canonicalBytesV1(withoutHash)) };
  validateCompactionPack(pack);
  return pack;
}

export function validateCompactionPack(pack: CompactionPackV1): void {
  if (pack.store_kind !== 'compaction_pack' || pack.schema_version !== 1
    || pack.repository_id !== 'OMA' || pack.run_id.trim() === ''
    || !Number.isSafeInteger(pack.aggregate_revision) || pack.aggregate_revision < 0
    || !Number.isSafeInteger(pack.generation) || pack.generation < 1) {
    throw new Error('E_COMPACTION_INVALID: compaction identity is invalid');
  }
  for (const [label, digest] of [
    ['aggregate_id', pack.aggregate_id], ['aggregate_sha256', pack.aggregate_sha256],
    ['guidance_sha256', pack.guidance_sha256], ['pack_sha256', pack.pack_sha256],
  ] as const) assertSha256(digest, label);
  pack.receipt_hashes.forEach((digest, index) => assertSha256(digest, `receipt_hashes[${index}]`));
  pack.unknown_record_hashes.forEach((digest, index) => assertSha256(digest, `unknown_record_hashes[${index}]`));
  const guidance = Buffer.from(pack.guidance_base64, 'base64');
  if (sha(guidance) !== pack.guidance_sha256
    || JSON.stringify(pack.warnings) !== JSON.stringify(orderedRecoveryWarnings(pack.warnings))) {
    throw new Error('E_COMPACTION_INVALID: compaction content binding is invalid');
  }
  const { pack_sha256: ignored, ...material } = pack;
  void ignored;
  if (sha(canonicalBytesV1(material)) !== pack.pack_sha256) {
    throw new Error('E_COMPACTION_INVALID: compaction pack hash does not match');
  }
  const date = new Date(pack.created_at);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== pack.created_at
    || Object.values(pack.counters).some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new Error('E_COMPACTION_INVALID: compaction metadata is invalid');
  }
}

export function assertCompactionPackCurrent(
  pack: Readonly<CompactionPackV1>,
  expected: {
    aggregateId: string;
    aggregateRevision: number;
    aggregateSha256: string;
    generation: number;
  },
): void {
  validateCompactionPack(pack);
  if (pack.aggregate_id !== expected.aggregateId
    || pack.aggregate_revision !== expected.aggregateRevision
    || pack.aggregate_sha256 !== expected.aggregateSha256
    || pack.generation !== expected.generation) {
    throw new Error('E_COMPACTION_INVALID: stale aggregate generation/revision binding');
  }
}

function sha(value: string | Buffer): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}
