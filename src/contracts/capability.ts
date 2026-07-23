import {
  ContractViolation,
  assertCanonicalUtcTimestamp,
  assertExactObjectKeys,
  assertNonEmptyString,
  assertSha256,
  assertStringArray,
} from './state-schemas';

export const CAPABILITY_TIERS = [
  'configured',
  'installed',
  'enabled',
  'loadable',
  'observed',
  'healthy',
  'verified',
] as const;

export type CapabilityTier = typeof CAPABILITY_TIERS[number];

export interface CapabilityRecordV1 {
  store_kind: 'capability_record';
  schema_version: 1;
  canonical_name: string;
  aliases: string[];
  origin: string;
  resolution_priority: number;
  version: string | null;
  digest: string | null;
  probe_timestamp: string;
  bounded_result: string;
  redacted_diagnostic: string;
  configured: boolean;
  installed: boolean;
  enabled: boolean;
  loadable: boolean;
  observed: boolean;
  healthy: boolean;
  verified: boolean;
  shadowed_by: string | null;
}

const CAPABILITY_RECORD_KEYS = [
  'store_kind', 'schema_version', 'canonical_name', 'aliases', 'origin',
  'resolution_priority', 'version', 'digest', 'probe_timestamp', 'bounded_result',
  'redacted_diagnostic', ...CAPABILITY_TIERS, 'shadowed_by',
] as const;

function assertRedactedDiagnostic(value: string): void {
  const unredactedAssignment = /(?:authorization|cookie|token|secret|password|account|model|quota)[^=:\n]{0,16}[=:]\s*(?!<redacted>|\[redacted\]|redacted\b)[^;\s]+/i;
  if (unredactedAssignment.test(value) || /\bbearer\s+(?!<redacted>|\[redacted\])\S+/i.test(value)) {
    throw new ContractViolation('E_CAPABILITY_REDACTION', 'Capability diagnostic contains unredacted sensitive data');
  }
}

export function validateCapabilityRecord(value: unknown): CapabilityRecordV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractViolation('E_CAPABILITY_RECORD', 'Capability record must be an object');
  }
  assertExactObjectKeys(value as Record<string, unknown>, CAPABILITY_RECORD_KEYS, 'capability record');
  const record = value as Partial<CapabilityRecordV1>;
  if (record.store_kind !== 'capability_record' || record.schema_version !== 1) {
    throw new ContractViolation('E_CAPABILITY_RECORD', 'Capability schema identity is invalid');
  }
  for (const field of CAPABILITY_TIERS) {
    if (typeof record[field] !== 'boolean') {
      throw new ContractViolation('E_CAPABILITY_RECORD', `${field} must be recorded independently`);
    }
  }
  for (const [label, candidate] of [
    ['canonical_name', record.canonical_name],
    ['origin', record.origin],
    ['bounded_result', record.bounded_result],
  ] as const) assertNonEmptyString(candidate, label);
  assertCanonicalUtcTimestamp(record.probe_timestamp, 'probe_timestamp');
  assertStringArray(record.aliases, 'aliases', { nonEmptyValues: true, unique: true });
  if (record.aliases.includes(record.canonical_name as string)) {
    throw new ContractViolation('E_CAPABILITY_RECORD', 'aliases cannot duplicate canonical_name');
  }
  if (!Number.isSafeInteger(record.resolution_priority) || (record.resolution_priority as number) < 0) {
    throw new ContractViolation('E_CAPABILITY_RECORD', 'resolution_priority must be a non-negative integer');
  }
  if (record.version !== null && typeof record.version !== 'string') {
    throw new ContractViolation('E_CAPABILITY_RECORD', 'version must be string or null');
  }
  if (record.version !== null) assertNonEmptyString(record.version, 'version');
  if (record.digest !== null) assertSha256(record.digest, 'digest');
  if (typeof record.redacted_diagnostic !== 'string'
    || (record.redacted_diagnostic as string).length > 4096) {
    throw new ContractViolation('E_CAPABILITY_RECORD', 'redacted_diagnostic must be a string');
  }
  if ((record.bounded_result as string).length > 4096 || /\bunbounded\b/i.test(record.bounded_result as string)) {
    throw new ContractViolation('E_CAPABILITY_RECORD', 'bounded_result must describe a bounded probe');
  }
  if (record.shadowed_by !== null && typeof record.shadowed_by !== 'string') {
    throw new ContractViolation('E_CAPABILITY_RECORD', 'shadowed_by must be string or null');
  }
  if (record.shadowed_by !== null) assertNonEmptyString(record.shadowed_by, 'shadowed_by');
  assertRedactedDiagnostic(record.redacted_diagnostic as string);
  return record as CapabilityRecordV1;
}

export function resolveCapabilityProviders(records: readonly CapabilityRecordV1[]): CapabilityRecordV1[] {
  const ordered = [...records].sort((left, right) =>
    left.resolution_priority - right.resolution_priority
      || left.origin.localeCompare(right.origin, 'en'));
  const winner = ordered[0]?.origin ?? null;
  return ordered.map((record, index) => ({
    ...record,
    shadowed_by: index === 0 ? null : winner,
  }));
}

export function capabilityTier(record: Readonly<CapabilityRecordV1>, tier: CapabilityTier): boolean {
  return record[tier];
}
