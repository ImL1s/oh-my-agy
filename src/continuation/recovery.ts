import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  RECOVERY_LIMITS_V1,
  RecoveryCountersV1,
  RecoveryLimitEventV1,
  RecoveryManifestV1,
  RecoveryWarning,
  orderedRecoveryWarnings,
  recoveryBoundaryEvent,
  validateRecoveryManifest,
} from '../contracts/resume';
import { canonicalBytesV1 } from '../contracts/state-schemas';
import { writeImmutableFile } from '../runtime/atomic';

type RecoveryErrorCode =
  | 'E_RESUME_SOURCE_NOT_REGULAR'
  | 'E_RESUME_SOURCE_CHANGED_DURING_COPY'
  | 'E_RESUME_NO_COMPLETE_TURNS'
  | 'E_RESUME_CONTEXT_OVER_CAP';

export class RecoveryError extends Error {
  readonly code: RecoveryErrorCode;
  constructor(code: RecoveryErrorCode, message: string) {
    super(message);
    this.name = 'RecoveryError';
    this.code = code;
  }
}

export interface RecoveryLimitsOverride {
  source_bytes?: number;
  physical_line_bytes?: number;
  physical_lines?: number;
  parsed_records?: number;
  complete_turns?: number;
  context_bytes?: number;
}

interface EffectiveRecoveryLimits {
  source_bytes: number;
  physical_line_bytes: number;
  physical_lines: number;
  parsed_records: number;
  complete_turns: number;
  context_bytes: number;
}

export interface RecoverTranscriptInput {
  sourcePath: string;
  recoveryRoot: string;
  limits?: RecoveryLimitsOverride;
  afterCopy?: () => void;
}

export interface RecoveryResultV1 {
  manifest: RecoveryManifestV1;
  immutableCopyPath: string;
  prompt: string | null;
  promptBytes: Buffer | null;
  errors: RecoveryErrorCode[];
}

interface PhysicalLine {
  raw: Buffer;
  content: Buffer;
  start: number;
  end: number;
}

interface ParsedRecord {
  line: PhysicalLine;
  value: Record<string, unknown>;
  recognized: boolean;
  type: string;
}

interface RecoveredTurn {
  turn_id: string;
  records: Record<string, unknown>[];
}

export function recoverTranscript(input: Readonly<RecoverTranscriptInput>): RecoveryResultV1 {
  const limits = loweredLimits(input.limits);
  const sourcePath = path.resolve(input.sourcePath);
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      sourcePath,
      fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
    );
  } catch {
    throw new RecoveryError('E_RESUME_SOURCE_NOT_REGULAR', 'Recovery source cannot be opened safely');
  }
  let before: fs.Stats;
  let after: fs.Stats;
  let source: Buffer;
  let sourceHash: string;
  let precedingByte: number | null = null;
  try {
    before = fs.fstatSync(descriptor);
    if (!before.isFile()) {
      throw new RecoveryError(
        'E_RESUME_SOURCE_NOT_REGULAR',
        'Recovery source must be a regular non-symlink file',
      );
    }
    sourceHash = hashDescriptor(descriptor, before.size);
    const suffixStart = Math.max(0, before.size - limits.source_bytes);
    source = readDescriptorRange(descriptor, suffixStart, before.size - suffixStart);
    if (suffixStart > 0) {
      precedingByte = readDescriptorRange(descriptor, suffixStart - 1, 1)[0] ?? null;
    }
    input.afterCopy?.();
    after = fs.fstatSync(descriptor);
    const pathAfter = fs.lstatSync(sourcePath);
    if (pathAfter.isSymbolicLink()
      || !sameSourceIdentity(before, after)
      || !sameSourceIdentity(after, pathAfter)) {
      throw new RecoveryError(
        'E_RESUME_SOURCE_CHANGED_DURING_COPY',
        'Recovery source changed while creating the immutable snapshot',
      );
    }
  } catch (error) {
    if (error instanceof RecoveryError) throw error;
    throw new RecoveryError(
      'E_RESUME_SOURCE_CHANGED_DURING_COPY',
      'Recovery source changed while creating the immutable snapshot',
    );
  } finally {
    fs.closeSync(descriptor);
  }
  const beforeIdentity = sourceIdentity(before);
  const afterIdentity = sourceIdentity(after);

  const warnings: RecoveryWarning[] = [];
  const errors: RecoveryErrorCode[] = [];
  const sourceBytesTotal = before.size;
  const suffixStart = sourceBytesTotal - source.length;
  let consideredStart = 0;
  let leadingFragmentBytes = 0;
  if (suffixStart > 0) {
    if (precedingByte !== 0x0a) {
      const firstNewline = source.indexOf(0x0a);
      const nextStart = firstNewline < 0 ? source.length : firstNewline + 1;
      leadingFragmentBytes = nextStart;
      consideredStart = nextStart;
    }
  }
  if (suffixStart > 0 || leadingFragmentBytes > 0) warnings.push('W_TRUNCATED_SOURCE');

  const allLines = splitPhysicalLines(source, consideredStart, suffixStart);
  const oversized = allLines.filter((line) => line.content.length > limits.physical_line_bytes);
  const sizeEligible = allLines.filter((line) => line.content.length <= limits.physical_line_bytes);
  const physicalOmitted = Math.max(0, sizeEligible.length - limits.physical_lines);
  const retainedLines = sizeEligible.slice(physicalOmitted);
  if (oversized.length > 0 || physicalOmitted > 0) warnings.push('W_TRUNCATED_SOURCE');

  const retainedBytes = Buffer.concat(retainedLines.map((line) => line.raw));
  const immutableHash = sha(retainedBytes);
  const immutableRelativePath = `.agy/recovery/${immutableHash}.jsonl`;
  const immutableCopyPath = path.join(path.resolve(input.recoveryRoot), `${immutableHash}.jsonl`);
  writeImmutableFile(immutableCopyPath, retainedBytes);

  const malformedLineHashes: string[] = [];
  const decoded: ParsedRecord[] = [];
  for (const line of retainedLines) {
    try {
      const value = JSON.parse(line.content.toString('utf8')) as unknown;
      if (typeof value !== 'object' || value === null || Array.isArray(value)
        || typeof (value as Record<string, unknown>).type !== 'string') {
        malformedLineHashes.push(sha(line.content));
        continue;
      }
      const object = value as Record<string, unknown>;
      const type = object.type as string;
      decoded.push({
        line,
        value: object,
        recognized: object.store_kind === 'transcript_record'
          && object.schema_version === 1 && (type === 'turn' || type === 'lifecycle'),
        type,
      });
    } catch {
      malformedLineHashes.push(sha(line.content));
    }
  }

  const parsedOmitted = Math.max(0, decoded.length - limits.parsed_records);
  const parsedRetained = decoded.slice(parsedOmitted);
  if (parsedOmitted > 0) warnings.push('W_PARSED_RECORDS_TRUNCATED');
  const recognizedSeen = decoded.filter((record) => record.recognized);
  const unknownSeen = decoded.filter((record) => !record.recognized);
  const recognizedRetained = parsedRetained.filter((record) => record.recognized);
  const unknownRetained = parsedRetained.filter((record) => !record.recognized);
  if (unknownRetained.length > 0) warnings.push('W_UNKNOWN_RECORD_TYPE');

  const brokenChain = hasBrokenChain(recognizedRetained);
  const markedPartial = recognizedRetained.some((record) => record.value.truncated === true);
  if (brokenChain) warnings.push('W_BROKEN_CHAIN');

  const turnsSeen = reconstructTurns(recognizedRetained);
  const turnsOmitted = Math.max(0, turnsSeen.length - limits.complete_turns);
  let retainedTurns = turnsSeen.slice(turnsOmitted);
  if (turnsOmitted > 0) warnings.push('W_TURNS_TRUNCATED');
  if (malformedLineHashes.length > 0 || markedPartial || brokenChain || warnings.length > 0) {
    warnings.push('W_PARTIAL_RECOVERY');
  }

  const contextBytesBefore = serializePrompt(retainedTurns).length;
  let promptBytes = serializePrompt(retainedTurns);
  let contextTurnsOmitted = 0;
  while (promptBytes.length > limits.context_bytes && retainedTurns.length > 1) {
    retainedTurns = retainedTurns.slice(1);
    contextTurnsOmitted += 1;
    promptBytes = serializePrompt(retainedTurns);
  }
  if (contextTurnsOmitted > 0) warnings.push('W_CONTEXT_TRUNCATED');
  if (turnsSeen.length === 0) {
    errors.push('E_RESUME_NO_COMPLETE_TURNS');
    promptBytes = Buffer.alloc(0);
  } else if (promptBytes.length > limits.context_bytes) {
    errors.push('E_RESUME_CONTEXT_OVER_CAP');
    warnings.push('W_CONTEXT_TRUNCATED', 'W_PARTIAL_RECOVERY');
    promptBytes = Buffer.alloc(0);
  }

  const unknownTypeCounts: Record<string, number> = {};
  for (const record of unknownRetained) unknownTypeCounts[record.type] = (unknownTypeCounts[record.type] ?? 0) + 1;
  const unknownTypeNames = Object.keys(unknownTypeCounts).sort();
  const sortedCounts = Object.fromEntries(unknownTypeNames.map((name) => [name, unknownTypeCounts[name]]));
  const omittedLines = [
    ...sizeEligible.slice(0, physicalOmitted),
    ...oversized,
  ].sort((a, b) => a.start - b.start);
  const counters: RecoveryCountersV1 = {
    source_bytes_total: sourceBytesTotal,
    source_bytes_considered: source.length,
    source_prefix_bytes_omitted: suffixStart,
    leading_fragment_bytes_omitted: leadingFragmentBytes,
    physical_lines_seen: allLines.length,
    physical_lines_retained: retainedLines.length,
    physical_lines_omitted_oldest: physicalOmitted,
    oversized_lines_omitted: oversized.length,
    parsed_records_seen: decoded.length,
    parsed_records_retained: parsedRetained.length,
    parsed_records_omitted_oldest: parsedOmitted,
    recognized_records_seen: recognizedSeen.length,
    recognized_records_retained: recognizedRetained.length,
    unknown_records_seen: unknownSeen.length,
    unknown_records_retained: unknownRetained.length,
    malformed_lines_seen: malformedLineHashes.length,
    complete_turns_seen: turnsSeen.length,
    complete_turns_retained: retainedTurns.length,
    complete_turns_omitted_oldest: turnsOmitted,
    context_bytes_before: contextBytesBefore,
    context_bytes_after: promptBytes.length,
    context_turns_omitted_oldest: contextTurnsOmitted,
  };
  const limitEvents = buildLimitEvents({
    sourceBytesTotal,
    maximumPhysicalLine: allLines.reduce((max, line) => Math.max(max, line.content.length), 0),
    physicalLines: allLines.length,
    parsedRecords: decoded.length,
    completeTurns: turnsSeen.length,
    contextBytes: contextBytesBefore,
    errors,
    limits,
  });
  const acceptedIds = recognizedRetained
    .map((record) => record.value.event_id)
    .filter((value): value is string => typeof value === 'string' && value !== '');
  const copiedStart = retainedLines[0]?.start ?? consideredStart;
  const copiedEnd = retainedLines[retainedLines.length - 1]?.end ?? consideredStart;
  const manifest: RecoveryManifestV1 = {
    store_kind: 'recovery_manifest',
    schema_version: 1,
    repository_id: 'OMA',
    host: 'antigravity',
    source_path_hash: sha(Buffer.from(sourcePath, 'utf8')),
    source_sha256: sourceHash,
    immutable_copy_path: immutableRelativePath,
    immutable_copy_sha256: immutableHash,
    immutable_copy_mode: '0400',
    source_device_before: beforeIdentity.device,
    source_inode_before: beforeIdentity.inode,
    source_size_before: beforeIdentity.size,
    source_mtime_ns_before: beforeIdentity.mtime,
    source_device_after: afterIdentity.device,
    source_inode_after: afterIdentity.inode,
    source_size_after: afterIdentity.size,
    source_mtime_ns_after: afterIdentity.mtime,
    copied_byte_start: copiedStart,
    copied_byte_end: copiedEnd,
    warnings: orderedRecoveryWarnings(warnings),
    counters,
    unknown_type_names: unknownTypeNames,
    unknown_type_counts: sortedCounts,
    unknown_record_hashes: unknownRetained.map((record) => sha(record.line.content)),
    malformed_line_hashes: malformedLineHashes,
    omitted_line_hashes: omittedLines.map((line) => sha(line.content)),
    first_accepted_event_id: acceptedIds[0] ?? null,
    last_accepted_event_id: acceptedIds[acceptedIds.length - 1] ?? null,
    limit_events: limitEvents,
  };
  validateRecoveryManifest(manifest);
  return {
    manifest,
    immutableCopyPath,
    prompt: promptBytes.length > 0 ? promptBytes.toString('utf8') : null,
    promptBytes: promptBytes.length > 0 ? promptBytes : null,
    errors,
  };
}

function loweredLimits(override: RecoveryLimitsOverride | undefined): EffectiveRecoveryLimits {
  const result: EffectiveRecoveryLimits = { ...RECOVERY_LIMITS_V1 };
  if (override === undefined) return result;
  for (const key of Object.keys(result) as Array<keyof typeof RECOVERY_LIMITS_V1>) {
    const value = override[key];
    if (value === undefined) continue;
    // W0 signs the exact boundary event including its maximum. A locally
    // lowered value would produce a manifest that the shared validator must
    // reject, so production recovery never accepts a second limit authority.
    if (value !== RECOVERY_LIMITS_V1[key]) {
      throw new Error(`Recovery limit ${key} is frozen by resume/v1`);
    }
  }
  return result;
}

function splitPhysicalLines(source: Buffer, start: number, sourceOffset = 0): PhysicalLine[] {
  const lines: PhysicalLine[] = [];
  let cursor = start;
  while (cursor < source.length) {
    const newline = source.indexOf(0x0a, cursor);
    const end = newline < 0 ? source.length : newline + 1;
    const raw = source.subarray(cursor, end);
    let contentEnd = raw.length;
    if (contentEnd > 0 && raw[contentEnd - 1] === 0x0a) contentEnd -= 1;
    if (contentEnd > 0 && raw[contentEnd - 1] === 0x0d) contentEnd -= 1;
    if (contentEnd > 0) lines.push({
      raw,
      content: raw.subarray(0, contentEnd),
      start: sourceOffset + cursor,
      end: sourceOffset + end,
    });
    cursor = end;
  }
  return lines;
}

function hasBrokenChain(records: readonly ParsedRecord[]): boolean {
  let previous: string | null = null;
  for (const record of records) {
    const id = typeof record.value.event_id === 'string' ? record.value.event_id : null;
    const parent = typeof record.value.parent_event_id === 'string'
      ? record.value.parent_event_id
      : record.value.parent_event_id === null ? null : undefined;
    if (id === null || parent === undefined) return true;
    if (previous === null) {
      if (parent !== null) return true;
    } else if (parent !== previous) {
      return true;
    }
    previous = id;
  }
  return false;
}

function reconstructTurns(records: readonly ParsedRecord[]): RecoveredTurn[] {
  const byId = new Map<string, Record<string, unknown>[]>();
  const order: string[] = [];
  for (const record of records) {
    if (record.type !== 'turn' || record.value.complete !== true
      || typeof record.value.turn_id !== 'string' || typeof record.value.role !== 'string') continue;
    const id = record.value.turn_id;
    if (!byId.has(id)) order.push(id);
    const values = byId.get(id) ?? [];
    values.push(record.value);
    byId.set(id, values);
  }
  const turns: RecoveredTurn[] = [];
  for (const id of order) {
    const recordsForTurn = byId.get(id) as Record<string, unknown>[];
    const roles = recordsForTurn.map((record) => record.role);
    if (roles[0] === 'user' && roles.includes('assistant')) {
      turns.push({ turn_id: id, records: recordsForTurn });
    }
  }
  return turns;
}

function serializePrompt(turns: readonly RecoveredTurn[]): Buffer {
  if (turns.length === 0) return Buffer.alloc(0);
  return canonicalBytesV1({
    store_kind: 'recovery_prompt',
    schema_version: 1,
    partial_recovery: true,
    turns,
  });
}

function buildLimitEvents(input: {
  sourceBytesTotal: number;
  maximumPhysicalLine: number;
  physicalLines: number;
  parsedRecords: number;
  completeTurns: number;
  contextBytes: number;
  errors: RecoveryErrorCode[];
  limits: EffectiveRecoveryLimits;
}): RecoveryLimitEventV1[] {
  const values: Array<[keyof typeof RECOVERY_LIMITS_V1, number]> = [
    ['source_bytes', input.sourceBytesTotal],
    ['physical_line_bytes', input.maximumPhysicalLine],
    ['physical_lines', input.physicalLines],
    ['parsed_records', input.parsedRecords],
    ['complete_turns', input.completeTurns],
    ['context_bytes', input.contextBytes],
  ];
  const out: RecoveryLimitEventV1[] = [];
  for (const [limit, observed] of values) {
    const boundary = recoveryBoundaryEvent(limit, observed);
    const event: RecoveryLimitEventV1 = {
      ...boundary,
      error: null,
    };
    if (limit === 'complete_turns' && input.errors.includes('E_RESUME_NO_COMPLETE_TURNS')) {
      event.error = 'E_RESUME_NO_COMPLETE_TURNS';
    }
    if (limit === 'context_bytes' && input.errors.includes('E_RESUME_CONTEXT_OVER_CAP')) {
      event.error = 'E_RESUME_CONTEXT_OVER_CAP';
    }
    if (event.warning !== null || event.error !== null) out.push(event);
  }
  return out;
}

function sourceIdentity(stat: fs.Stats): { device: number; inode: number; size: number; mtime: number } {
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    // Contract integers are safe; microsecond precision is stable across the
    // before/after descriptor stat pair while still detecting ordinary source mutation.
    mtime: Math.trunc(stat.mtimeMs * 1_000),
  };
}

function sameSourceIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

function hashDescriptor(descriptor: number, expectedSize: number): string {
  const hash = crypto.createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let position = 0;
  while (position < expectedSize) {
    const requested = Math.min(chunk.length, expectedSize - position);
    const count = fs.readSync(descriptor, chunk, 0, requested, position);
    if (count <= 0) {
      throw new RecoveryError(
        'E_RESUME_SOURCE_CHANGED_DURING_COPY',
        'Recovery source changed while computing its digest',
      );
    }
    hash.update(chunk.subarray(0, count));
    position += count;
  }
  return hash.digest('hex');
}

function readDescriptorRange(descriptor: number, start: number, length: number): Buffer {
  const bytes = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const count = fs.readSync(descriptor, bytes, offset, length - offset, start + offset);
    if (count <= 0) {
      throw new RecoveryError(
        'E_RESUME_SOURCE_CHANGED_DURING_COPY',
        'Recovery source changed while reading its bounded suffix',
      );
    }
    offset += count;
  }
  return bytes;
}

function sha(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
