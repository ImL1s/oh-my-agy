import {
  ContractViolation,
  assertCanonicalUtcTimestamp,
  assertExactObjectKeys,
  assertNonEmptyString,
  assertSha256,
} from './state-schemas';

export const LIFECYCLE_EVENT_TYPES = [
  'spawn_requested',
  'session_started',
  'turn_started',
  'turn_completed',
  'agent_closed',
  'agent_failed',
] as const;

export type LifecycleEventType = typeof LIFECYCLE_EVENT_TYPES[number];

export interface LifecycleEventV1 {
  store_kind: 'lifecycle_event';
  schema_version: 1;
  source: string;
  source_cursor: string;
  source_sequence: number;
  event_id: string;
  event_type: LifecycleEventType;
  repository_id: string;
  run_id: string;
  generation: number;
  parent_id: string | null;
  native_identity: string | null;
  observed_at: string;
  payload_hash: string;
}

export interface TrackerSourceCursorV1 {
  source: string;
  cursor: string;
  sequence: number;
}

export interface TrackerProjectorLeaseV1 {
  store_kind: 'tracker_projector_lease';
  schema_version: 1;
  repository_id: 'OMA';
  run_id: string;
  owner_token: string;
  generation: number;
  source_cursors: TrackerSourceCursorV1[];
  acquired_at: string;
  lease_expires_at: string;
}

export interface PrimaryPollerLeaseV1 {
  store_kind: 'primary_poller_lease';
  schema_version: 1;
  repository_id: 'OMA';
  run_id: string;
  pid: number;
  process_start_identity: string;
  owner_token: string;
  generation: number;
  last_successful_poll_at: string | null;
  cursor: string;
  error: string | null;
  acquired_at: string;
  lease_expires_at: string;
}

const LIFECYCLE_EVENT_KEYS = [
  'store_kind', 'schema_version', 'source', 'source_cursor', 'source_sequence', 'event_id',
  'event_type', 'repository_id', 'run_id', 'generation', 'parent_id', 'native_identity',
  'observed_at', 'payload_hash',
] as const;

const PROJECTOR_LEASE_KEYS = [
  'store_kind', 'schema_version', 'repository_id', 'run_id', 'owner_token', 'generation',
  'source_cursors', 'acquired_at', 'lease_expires_at',
] as const;

const SOURCE_CURSOR_KEYS = ['source', 'cursor', 'sequence'] as const;

const POLLER_LEASE_KEYS = [
  'store_kind', 'schema_version', 'repository_id', 'run_id', 'pid', 'process_start_identity',
  'owner_token', 'generation', 'last_successful_poll_at', 'cursor', 'error', 'acquired_at',
  'lease_expires_at',
] as const;

function assertPositiveSafeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new ContractViolation('E_TRACKER_LEASE', `${label} must be a positive safe integer`);
  }
}

function assertLeaseWindow(acquiredAt: string, expiresAt: string, lastPoll?: string | null): void {
  const acquired = Date.parse(acquiredAt);
  const expires = Date.parse(expiresAt);
  if (expires <= acquired || (lastPoll !== undefined && lastPoll !== null
    && (Date.parse(lastPoll) < acquired || Date.parse(lastPoll) > expires))) {
    throw new ContractViolation('E_TRACKER_LEASE', 'Tracker lease timestamps are out of order');
  }
}

export function validateLifecycleEvent(value: unknown): LifecycleEventV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractViolation('E_LIFECYCLE_EVENT', 'Lifecycle event must be an object');
  }
  assertExactObjectKeys(value as Record<string, unknown>, LIFECYCLE_EVENT_KEYS, 'lifecycle event');
  const event = value as Partial<LifecycleEventV1>;
  if (event.store_kind !== 'lifecycle_event' || event.schema_version !== 1) {
    throw new ContractViolation('E_LIFECYCLE_EVENT', 'Lifecycle schema identity is invalid');
  }
  for (const [key, candidate] of [
    ['source', event.source],
    ['source_cursor', event.source_cursor],
    ['event_id', event.event_id],
    ['repository_id', event.repository_id],
    ['run_id', event.run_id],
  ] as const) assertNonEmptyString(candidate, key);
  if (!LIFECYCLE_EVENT_TYPES.includes(event.event_type as LifecycleEventType)) {
    throw new ContractViolation('E_LIFECYCLE_EVENT', 'Unknown lifecycle event type');
  }
  if (!Number.isSafeInteger(event.source_sequence) || (event.source_sequence as number) < 0
    || !Number.isSafeInteger(event.generation) || (event.generation as number) <= 0) {
    throw new ContractViolation('E_LIFECYCLE_EVENT', 'Lifecycle sequence/generation is invalid');
  }
  if ((event.parent_id !== null && typeof event.parent_id !== 'string')
    || (event.native_identity !== null && typeof event.native_identity !== 'string')) {
    throw new ContractViolation('E_LIFECYCLE_EVENT', 'Lifecycle parent/native identity is invalid');
  }
  if (event.parent_id !== null) assertNonEmptyString(event.parent_id, 'parent_id');
  if (event.native_identity !== null) assertNonEmptyString(event.native_identity, 'native_identity');
  assertCanonicalUtcTimestamp(event.observed_at, 'observed_at');
  assertSha256(event.payload_hash, 'payload_hash');
  return event as LifecycleEventV1;
}

export function validateTrackerProjectorLease(value: unknown): TrackerProjectorLeaseV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractViolation('E_TRACKER_LEASE', 'Tracker projector lease must be an object');
  }
  assertExactObjectKeys(value as Record<string, unknown>, PROJECTOR_LEASE_KEYS, 'tracker projector lease');
  const lease = value as Partial<TrackerProjectorLeaseV1>;
  if (lease.store_kind !== 'tracker_projector_lease' || lease.schema_version !== 1
    || lease.repository_id !== 'OMA') {
    throw new ContractViolation('E_TRACKER_LEASE', 'Tracker projector lease identity is invalid');
  }
  assertNonEmptyString(lease.run_id, 'run_id');
  assertNonEmptyString(lease.owner_token, 'owner_token');
  assertPositiveSafeInteger(lease.generation, 'generation');
  assertCanonicalUtcTimestamp(lease.acquired_at, 'acquired_at');
  assertCanonicalUtcTimestamp(lease.lease_expires_at, 'lease_expires_at');
  assertLeaseWindow(lease.acquired_at, lease.lease_expires_at);
  if (!Array.isArray(lease.source_cursors)) {
    throw new ContractViolation('E_TRACKER_LEASE', 'Projector source_cursors must be an array');
  }
  if (lease.source_cursors.length > 64) {
    throw new ContractViolation('E_TRACKER_LEASE', 'Projector source cursor set exceeds the frozen bound');
  }
  const sources = new Set<string>();
  for (const cursor of lease.source_cursors) {
    if (typeof cursor !== 'object' || cursor === null || Array.isArray(cursor)) {
      throw new ContractViolation('E_TRACKER_LEASE', 'Projector source cursor must be an object');
    }
    assertExactObjectKeys(cursor as unknown as Record<string, unknown>, SOURCE_CURSOR_KEYS, 'tracker source cursor');
    assertNonEmptyString(cursor.source, 'source');
    assertNonEmptyString(cursor.cursor, 'cursor');
    if (!Number.isSafeInteger(cursor.sequence) || cursor.sequence < 0 || sources.has(cursor.source)) {
      throw new ContractViolation('E_TRACKER_LEASE', 'Projector cursor sequence/source is invalid or duplicate');
    }
    sources.add(cursor.source);
  }
  return lease as TrackerProjectorLeaseV1;
}

export function validatePrimaryPollerLease(value: unknown): PrimaryPollerLeaseV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ContractViolation('E_TRACKER_LEASE', 'Primary poller lease must be an object');
  }
  assertExactObjectKeys(value as Record<string, unknown>, POLLER_LEASE_KEYS, 'primary poller lease');
  const lease = value as Partial<PrimaryPollerLeaseV1>;
  if (lease.store_kind !== 'primary_poller_lease' || lease.schema_version !== 1
    || lease.repository_id !== 'OMA') {
    throw new ContractViolation('E_TRACKER_LEASE', 'Primary poller lease identity is invalid');
  }
  assertNonEmptyString(lease.run_id, 'run_id');
  assertPositiveSafeInteger(lease.pid, 'pid');
  assertNonEmptyString(lease.process_start_identity, 'process_start_identity');
  assertNonEmptyString(lease.owner_token, 'owner_token');
  assertPositiveSafeInteger(lease.generation, 'generation');
  assertNonEmptyString(lease.cursor, 'cursor');
  if (lease.error !== null && (typeof lease.error !== 'string' || lease.error.length > 4096
    || /(?:authorization|cookie|token|secret|password)\s*[=:]\s*(?!<redacted>|\[redacted\]|redacted\b)\S+/i
      .test(lease.error))) {
    throw new ContractViolation('E_TRACKER_LEASE', 'Primary poller error must be bounded and redacted');
  }
  assertCanonicalUtcTimestamp(lease.acquired_at, 'acquired_at');
  assertCanonicalUtcTimestamp(lease.lease_expires_at, 'lease_expires_at');
  if (lease.last_successful_poll_at !== null) {
    assertCanonicalUtcTimestamp(lease.last_successful_poll_at, 'last_successful_poll_at');
  }
  assertLeaseWindow(lease.acquired_at, lease.lease_expires_at, lease.last_successful_poll_at);
  return lease as PrimaryPollerLeaseV1;
}
