import * as path from 'path';
import {
  ContractViolation,
  assertExactObjectKeys,
  assertNonEmptyString,
  assertSafeRepositoryWritePath,
  assertSha256,
  assertStringArray,
} from './state-schemas';

export const RECOVERY_LIMITS_V1 = Object.freeze({
  source_bytes: 16_777_216,
  physical_line_bytes: 1_048_576,
  physical_lines: 900,
  parsed_records: 900,
  complete_turns: 256,
  context_bytes: 2_097_152,
});

export const RECOVERY_WARNING_ORDER_V1 = [
  'W_BROKEN_CHAIN',
  'W_PARTIAL_RECOVERY',
  'W_TRUNCATED_SOURCE',
  'W_PARSED_RECORDS_TRUNCATED',
  'W_TURNS_TRUNCATED',
  'W_CONTEXT_TRUNCATED',
  'W_UNKNOWN_RECORD_TYPE',
] as const;

export type RecoveryWarning = typeof RECOVERY_WARNING_ORDER_V1[number];

export type RecoveryLimitNameV1 = keyof typeof RECOVERY_LIMITS_V1;

export interface RecoveryLimitEventV1 {
  limit: RecoveryLimitNameV1;
  observed: number;
  maximum: number;
  retained: number;
  omitted: number;
  warning: RecoveryWarning | null;
  error: 'E_RESUME_NO_COMPLETE_TURNS' | 'E_RESUME_CONTEXT_OVER_CAP' | null;
}

export const RESUME_SELECTOR_PRECEDENCE_V1 = [
  'immutable_recovery_manifest',
  'run_id',
  'native_session',
  'current_run_manifest',
  'signed_portable_handoff',
  'best_effort_repository_search',
] as const;

export type ResumeSelectorKind = typeof RESUME_SELECTOR_PRECEDENCE_V1[number];

export const RESUME_SELECTOR_ERROR_CODES_V1 = [
  'E_RESUME_SELECTOR_CONFLICT',
  'E_RESUME_AMBIGUOUS',
  'E_RESUME_NOT_FOUND',
] as const;

export type ResumeSelectorErrorCodeV1 = typeof RESUME_SELECTOR_ERROR_CODES_V1[number];

export const RESUME_SELECTOR_INVALID_REASONS_V1 = [
  'selector_conflict',
  'repository_mismatch',
  'host_mismatch',
  'sha256_mismatch',
  'safe_key_mismatch',
  'cwd_mismatch',
  'generation_mismatch',
  'stale_generation',
  'stale_lease',
  'lineage_mismatch',
  'expired',
  'duplicate_binding',
  'not_bound',
  'forked_lineage',
  'equal_top_candidates',
  'broken_parent',
] as const;

export type ResumeSelectorInvalidReasonV1 = typeof RESUME_SELECTOR_INVALID_REASONS_V1[number];

export interface ResumeCandidateV1 {
  kind: ResumeSelectorKind;
  valid: boolean;
  binding_count: number;
  repository_id: string;
  cwd_hash: string;
  generation: number;
  lineage_hash: string;
  invalid_reason?: ResumeSelectorInvalidReasonV1;
  diagnostics_only?: boolean;
}

export interface RecoveryCountersV1 {
  source_bytes_total: number;
  source_bytes_considered: number;
  source_prefix_bytes_omitted: number;
  leading_fragment_bytes_omitted: number;
  physical_lines_seen: number;
  physical_lines_retained: number;
  physical_lines_omitted_oldest: number;
  oversized_lines_omitted: number;
  parsed_records_seen: number;
  parsed_records_retained: number;
  parsed_records_omitted_oldest: number;
  recognized_records_seen: number;
  recognized_records_retained: number;
  unknown_records_seen: number;
  unknown_records_retained: number;
  malformed_lines_seen: number;
  complete_turns_seen: number;
  complete_turns_retained: number;
  complete_turns_omitted_oldest: number;
  context_bytes_before: number;
  context_bytes_after: number;
  context_turns_omitted_oldest: number;
}

export interface RecoveryManifestV1 {
  store_kind: 'recovery_manifest';
  schema_version: 1;
  repository_id: 'OMA';
  host: 'antigravity';
  source_path_hash: string;
  source_sha256: string;
  immutable_copy_path: string;
  immutable_copy_sha256: string;
  immutable_copy_mode: '0400';
  source_device_before: number;
  source_inode_before: number;
  source_size_before: number;
  source_mtime_ns_before: number;
  source_device_after: number;
  source_inode_after: number;
  source_size_after: number;
  source_mtime_ns_after: number;
  copied_byte_start: number;
  copied_byte_end: number;
  warnings: RecoveryWarning[];
  counters: RecoveryCountersV1;
  unknown_type_names: string[];
  unknown_type_counts: Record<string, number>;
  unknown_record_hashes: string[];
  malformed_line_hashes: string[];
  omitted_line_hashes: string[];
  first_accepted_event_id: string | null;
  last_accepted_event_id: string | null;
  limit_events: RecoveryLimitEventV1[];
}

const RECOVERY_COUNTER_KEYS = [
  'source_bytes_total', 'source_bytes_considered', 'source_prefix_bytes_omitted',
  'leading_fragment_bytes_omitted', 'physical_lines_seen', 'physical_lines_retained',
  'physical_lines_omitted_oldest', 'oversized_lines_omitted', 'parsed_records_seen',
  'parsed_records_retained', 'parsed_records_omitted_oldest', 'recognized_records_seen',
  'recognized_records_retained', 'unknown_records_seen', 'unknown_records_retained',
  'malformed_lines_seen', 'complete_turns_seen', 'complete_turns_retained',
  'complete_turns_omitted_oldest', 'context_bytes_before', 'context_bytes_after',
  'context_turns_omitted_oldest',
] as const;

const RECOVERY_MANIFEST_KEYS = [
  'store_kind', 'schema_version', 'repository_id', 'host', 'source_path_hash', 'source_sha256',
  'immutable_copy_path', 'immutable_copy_sha256', 'immutable_copy_mode',
  'source_device_before', 'source_inode_before', 'source_size_before', 'source_mtime_ns_before',
  'source_device_after', 'source_inode_after', 'source_size_after', 'source_mtime_ns_after',
  'copied_byte_start', 'copied_byte_end', 'warnings', 'counters', 'unknown_type_names',
  'unknown_type_counts', 'unknown_record_hashes', 'malformed_line_hashes',
  'omitted_line_hashes', 'first_accepted_event_id', 'last_accepted_event_id', 'limit_events',
] as const;

const RECOVERY_LIMIT_EVENT_KEYS = [
  'limit', 'observed', 'maximum', 'retained', 'omitted', 'warning', 'error',
] as const;

const RECOVERY_WARNING_BY_LIMIT: Readonly<Record<RecoveryLimitNameV1, RecoveryWarning>> = Object.freeze({
  source_bytes: 'W_TRUNCATED_SOURCE',
  physical_line_bytes: 'W_TRUNCATED_SOURCE',
  physical_lines: 'W_TRUNCATED_SOURCE',
  parsed_records: 'W_PARSED_RECORDS_TRUNCATED',
  complete_turns: 'W_TURNS_TRUNCATED',
  context_bytes: 'W_CONTEXT_TRUNCATED',
});

export function recoveryBoundaryEvent(
  limit: RecoveryLimitNameV1,
  observed: number,
): RecoveryLimitEventV1 {
  if (!Number.isSafeInteger(observed) || observed < 0) {
    throw new ContractViolation('E_RECOVERY_LIMIT', 'Recovery boundary observation must be non-negative');
  }
  const maximum = RECOVERY_LIMITS_V1[limit];
  const exceeded = observed > maximum;
  const wholeLineOmitted = limit === 'physical_line_bytes' && exceeded;
  return {
    limit,
    observed,
    maximum,
    retained: wholeLineOmitted ? 0 : Math.min(observed, maximum),
    omitted: wholeLineOmitted ? observed : Math.max(0, observed - maximum),
    warning: exceeded ? RECOVERY_WARNING_BY_LIMIT[limit] : null,
    error: null,
  };
}

export function orderedRecoveryWarnings(warnings: readonly RecoveryWarning[]): RecoveryWarning[] {
  const unique = new Set(warnings);
  return RECOVERY_WARNING_ORDER_V1.filter((warning) => unique.has(warning));
}

export function selectResumeCandidate(
  candidates: readonly ResumeCandidateV1[],
  options: { bestEffort: boolean },
): ResumeCandidateV1 {
  for (const kind of RESUME_SELECTOR_PRECEDENCE_V1) {
    const matching = candidates.filter((candidate) => candidate.kind === kind);
    if (matching.length === 0) continue;
    if (kind === 'best_effort_repository_search' && !options.bestEffort) {
      throw new ContractViolation('E_RESUME_NOT_FOUND', 'Repository search requires --best-effort');
    }
    if (matching.length !== 1) {
      throw new ContractViolation('E_RESUME_AMBIGUOUS', 'Resume selector has ambiguous bindings', {
        kind,
        candidates: matching.length,
      });
    }
    const candidate = matching[0];
    if (!Number.isSafeInteger(candidate.binding_count) || candidate.binding_count < 0) {
      throw new ContractViolation(
        'E_RESUME_SELECTOR_CONFLICT',
        'Resume selector binding count is invalid',
        { kind, binding_count: candidate.binding_count },
      );
    }
    if (candidate.valid && candidate.invalid_reason !== undefined) {
      throw new ContractViolation(
        'E_RESUME_SELECTOR_CONFLICT',
        'A valid resume selector cannot carry an invalid reason',
        { kind, invalid_reason: candidate.invalid_reason },
      );
    }
    if (!candidate.valid && candidate.invalid_reason !== undefined) {
      const ambiguousReasons: readonly ResumeSelectorInvalidReasonV1[] = [
        'duplicate_binding', 'forked_lineage', 'equal_top_candidates', 'broken_parent',
      ];
      if (ambiguousReasons.includes(candidate.invalid_reason)) {
        throw new ContractViolation('E_RESUME_AMBIGUOUS', 'Resume selector is ambiguous', {
          kind,
          invalid_reason: candidate.invalid_reason,
        });
      }
      if (candidate.invalid_reason === 'not_bound') {
        throw new ContractViolation('E_RESUME_NOT_FOUND', 'Resume selector has no bound aggregate', {
          kind,
          invalid_reason: candidate.invalid_reason,
        });
      }
      throw new ContractViolation('E_RESUME_SELECTOR_CONFLICT', 'Resume selector conflicts with its binding', {
        kind,
        invalid_reason: candidate.invalid_reason,
      });
    }
    if (candidate.binding_count > 1) {
      throw new ContractViolation('E_RESUME_AMBIGUOUS', 'Resume selector has ambiguous bindings', {
        kind,
        bindings: candidate.binding_count,
      });
    }
    if (candidate.binding_count === 0) {
      throw new ContractViolation('E_RESUME_NOT_FOUND', 'Resume selector has no bound aggregate', { kind });
    }
    if (!candidate.valid) {
      throw new ContractViolation('E_RESUME_SELECTOR_CONFLICT', 'Resume selector conflicts with its binding', {
        kind,
      });
    }
    return kind === 'best_effort_repository_search'
      ? { ...candidate, diagnostics_only: true }
      : candidate;
  }
  throw new ContractViolation('E_RESUME_NOT_FOUND', 'No valid resume selector was found');
}

export function validateRecoveryManifest(manifest: RecoveryManifestV1): void {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new ContractViolation('E_RECOVERY_MANIFEST', 'Recovery manifest must be an object');
  }
  assertExactObjectKeys(
    manifest as unknown as Record<string, unknown>,
    RECOVERY_MANIFEST_KEYS,
    'recovery manifest',
  );
  if (manifest.store_kind !== 'recovery_manifest' || manifest.schema_version !== 1
    || manifest.repository_id !== 'OMA' || manifest.host !== 'antigravity'
    || manifest.immutable_copy_mode !== '0400') {
    throw new ContractViolation('E_RECOVERY_MANIFEST', 'Recovery manifest identity is invalid');
  }
  for (const [label, value] of [
    ['source_path_hash', manifest.source_path_hash],
    ['source_sha256', manifest.source_sha256],
    ['immutable_copy_sha256', manifest.immutable_copy_sha256],
  ] as const) assertSha256(value, label);
  assertSafeRepositoryWritePath(manifest.immutable_copy_path, 'immutable_copy_path');
  if (!path.posix.basename(manifest.immutable_copy_path).includes(manifest.immutable_copy_sha256)) {
    throw new ContractViolation('E_RECOVERY_MANIFEST', 'Immutable copy path is not content-addressed');
  }
  const metadataFields = [
    manifest.source_device_before, manifest.source_inode_before, manifest.source_size_before,
    manifest.source_mtime_ns_before, manifest.source_device_after, manifest.source_inode_after,
    manifest.source_size_after, manifest.source_mtime_ns_after, manifest.copied_byte_start,
    manifest.copied_byte_end,
  ];
  if (metadataFields.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new ContractViolation('E_RECOVERY_MANIFEST', 'Recovery source metadata/range is invalid');
  }
  if (manifest.source_device_before !== manifest.source_device_after
    || manifest.source_inode_before !== manifest.source_inode_after
    || manifest.source_size_before !== manifest.source_size_after
    || manifest.source_mtime_ns_before !== manifest.source_mtime_ns_after) {
    throw new ContractViolation(
      'E_RESUME_SOURCE_CHANGED_DURING_COPY',
      'Recovery source metadata changed during immutable copy',
    );
  }
  if (manifest.copied_byte_start > manifest.copied_byte_end
    || manifest.copied_byte_end > manifest.source_size_before) {
    throw new ContractViolation('E_RECOVERY_MANIFEST', 'Recovery copied byte range is invalid');
  }
  if (!Array.isArray(manifest.warnings)
    || manifest.warnings.some((warning) => !RECOVERY_WARNING_ORDER_V1.includes(warning))) {
    throw new ContractViolation('E_RECOVERY_MANIFEST', 'Recovery warnings contain an unknown value');
  }
  if (JSON.stringify(manifest.warnings) !== JSON.stringify(orderedRecoveryWarnings(manifest.warnings))) {
    throw new ContractViolation('E_RECOVERY_MANIFEST', 'Recovery warnings are duplicated or out of order');
  }
  if (typeof manifest.counters !== 'object' || manifest.counters === null
    || Array.isArray(manifest.counters)) {
    throw new ContractViolation('E_RECOVERY_MANIFEST', 'Recovery counters must be an object');
  }
  assertExactObjectKeys(
    manifest.counters as unknown as Record<string, unknown>,
    RECOVERY_COUNTER_KEYS,
    'recovery counters',
  );
  for (const value of Object.values(manifest.counters)) {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new ContractViolation('E_RECOVERY_MANIFEST', 'Recovery counters must be non-negative integers');
    }
  }
  const counters = manifest.counters;
  if (counters.source_bytes_total !== manifest.source_size_before
    || counters.source_bytes_considered + counters.source_prefix_bytes_omitted
      !== counters.source_bytes_total
    || counters.physical_lines_retained + counters.physical_lines_omitted_oldest
      + counters.oversized_lines_omitted !== counters.physical_lines_seen
    || counters.parsed_records_retained + counters.parsed_records_omitted_oldest
      !== counters.parsed_records_seen
    || counters.recognized_records_seen + counters.unknown_records_seen
      !== counters.parsed_records_seen
    || counters.recognized_records_retained + counters.unknown_records_retained
      !== counters.parsed_records_retained
    || counters.complete_turns_retained + counters.complete_turns_omitted_oldest
      !== counters.complete_turns_seen
    || counters.source_bytes_considered > RECOVERY_LIMITS_V1.source_bytes
    || counters.physical_lines_retained > RECOVERY_LIMITS_V1.physical_lines
    || counters.parsed_records_retained > RECOVERY_LIMITS_V1.parsed_records
    || counters.complete_turns_retained > RECOVERY_LIMITS_V1.complete_turns
    || counters.context_bytes_after > RECOVERY_LIMITS_V1.context_bytes
    || counters.context_bytes_after > counters.context_bytes_before) {
    throw new ContractViolation('E_RECOVERY_MANIFEST', 'Recovery counters violate retention invariants');
  }
  assertStringArray(manifest.unknown_type_names, 'unknown_type_names', {
    nonEmptyValues: true,
    unique: true,
  });
  for (const [label, hashes] of [
    ['unknown_record_hashes', manifest.unknown_record_hashes],
    ['malformed_line_hashes', manifest.malformed_line_hashes],
    ['omitted_line_hashes', manifest.omitted_line_hashes],
  ] as const) {
    if (!Array.isArray(hashes)) {
      throw new ContractViolation('E_RECOVERY_MANIFEST', `${label} must be an array`);
    }
    hashes.forEach((hash, index) => assertSha256(hash, `${label}[${index}]`));
  }
  if (typeof manifest.unknown_type_counts !== 'object' || manifest.unknown_type_counts === null
    || Array.isArray(manifest.unknown_type_counts)) {
    throw new ContractViolation('E_RECOVERY_MANIFEST', 'unknown_type_counts must be an object');
  }
  const countNames = Object.keys(manifest.unknown_type_counts);
  if (JSON.stringify(countNames) !== JSON.stringify(manifest.unknown_type_names)
    || countNames.some((name) => !Number.isSafeInteger(manifest.unknown_type_counts[name])
      || manifest.unknown_type_counts[name] <= 0)
    || Object.values(manifest.unknown_type_counts).reduce((sum, count) => sum + count, 0)
      !== counters.unknown_records_retained
    || manifest.unknown_record_hashes.length !== counters.unknown_records_retained
    || manifest.malformed_line_hashes.length !== counters.malformed_lines_seen
    || manifest.omitted_line_hashes.length
      !== counters.physical_lines_omitted_oldest + counters.oversized_lines_omitted) {
    throw new ContractViolation('E_RECOVERY_MANIFEST', 'Recovery unknown/malformed/omitted evidence is inconsistent');
  }
  if ((manifest.first_accepted_event_id === null) !== (manifest.last_accepted_event_id === null)) {
    throw new ContractViolation('E_RECOVERY_MANIFEST', 'Recovery first/last event IDs must be paired');
  }
  if (manifest.first_accepted_event_id !== null) {
    assertNonEmptyString(manifest.first_accepted_event_id, 'first_accepted_event_id');
    assertNonEmptyString(manifest.last_accepted_event_id, 'last_accepted_event_id');
  }
  if (!Array.isArray(manifest.limit_events)) {
    throw new ContractViolation('E_RECOVERY_MANIFEST', 'limit_events must be an array');
  }
  const limitOrder = Object.keys(RECOVERY_LIMITS_V1) as RecoveryLimitNameV1[];
  const seenLimits = new Set<RecoveryLimitNameV1>();
  const recordedErrors = new Set<NonNullable<RecoveryLimitEventV1['error']>>();
  let previousLimitIndex = -1;
  for (const event of manifest.limit_events) {
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      throw new ContractViolation('E_RECOVERY_MANIFEST', 'Recovery limit event must be an object');
    }
    assertExactObjectKeys(
      event as unknown as Record<string, unknown>,
      RECOVERY_LIMIT_EVENT_KEYS,
      'recovery limit event',
    );
    if (!(event.limit in RECOVERY_LIMITS_V1)
      || [event.observed, event.retained, event.omitted]
        .some((value) => !Number.isSafeInteger(value) || value < 0)
      || (event.error !== null && ![
        'E_RESUME_NO_COMPLETE_TURNS', 'E_RESUME_CONTEXT_OVER_CAP',
      ].includes(event.error))) {
      throw new ContractViolation('E_RECOVERY_MANIFEST', 'Recovery limit event is invalid');
    }
    const expected = recoveryBoundaryEvent(event.limit, event.observed);
    if (event.maximum !== expected.maximum || event.retained !== expected.retained
      || event.omitted !== expected.omitted || event.warning !== expected.warning) {
      throw new ContractViolation('E_RECOVERY_MANIFEST', 'Recovery limit event retention is not exact');
    }
    const orderIndex = limitOrder.indexOf(event.limit);
    if (seenLimits.has(event.limit) || orderIndex <= previousLimitIndex) {
      throw new ContractViolation('E_RECOVERY_MANIFEST', 'Recovery limit events are duplicate or out of order');
    }
    seenLimits.add(event.limit);
    previousLimitIndex = orderIndex;
    if (event.warning !== null && !manifest.warnings.includes(event.warning)) {
      throw new ContractViolation('E_RECOVERY_MANIFEST', 'Recovery limit warning is missing from manifest warnings');
    }
    if (event.error !== null) recordedErrors.add(event.error);
  }
  if ((counters.complete_turns_retained === 0)
      !== recordedErrors.has('E_RESUME_NO_COMPLETE_TURNS')) {
    throw new ContractViolation('E_RECOVERY_MANIFEST', 'Zero complete-turn error evidence is inconsistent');
  }
  if (recordedErrors.has('E_RESUME_CONTEXT_OVER_CAP')
    && !(counters.context_bytes_before > RECOVERY_LIMITS_V1.context_bytes
      && counters.context_bytes_after === 0)) {
    throw new ContractViolation('E_RECOVERY_MANIFEST', 'Context-over-cap error evidence is inconsistent');
  }
}
