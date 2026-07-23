import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  LifecycleEventType,
  LifecycleEventV1,
  TrackerSourceCursorV1,
  validateLifecycleEvent,
} from '../contracts/lifecycle';
import { canonicalBytesV1 } from '../contracts/state-schemas';
import {
  appendJsonLineUnderLock,
  atomicWriteContractBytes,
  withDurableJsonLineLock,
} from './atomic';
import { RuntimeError, runtimeError } from './errors';
import { acquireOwnerLock, releaseOwnerLock } from './lock';
import { redactValue } from './redaction';
import { Result, err, ok } from './types';

export interface CreateLifecycleEventInput {
  source: string;
  sourceSequence: number;
  eventType: LifecycleEventType;
  repositoryId: string;
  runId: string;
  generation: number;
  parentId: string | null;
  nativeIdentity: string | null;
  payload: unknown;
  observedAt: string;
}

export interface TrackerProjectionV1 {
  store_kind: 'tracker_projection';
  schema_version: 1;
  repository_id: 'OMA';
  run_id: string;
  generation: number;
  owner_token: string;
  revision: number;
  source_cursors: TrackerSourceCursorV1[];
  events: LifecycleEventV1[];
  missing_children: string[];
  strict_diagnostics: string[];
  projected_at: string;
  projection_sha256: string;
}

export interface TrackerProjectInput {
  runId: string;
  generation: number;
  ownerToken: string;
  journals: readonly LifecycleJournal[];
  now: string;
}

export function createLifecycleEvent(input: Readonly<CreateLifecycleEventInput>): LifecycleEventV1 {
  const payload = redactValue(input.payload);
  const identity = {
    source: input.source,
    source_sequence: input.sourceSequence,
    event_type: input.eventType,
    repository_id: input.repositoryId,
    run_id: input.runId,
    generation: input.generation,
    parent_id: input.parentId,
    native_identity: input.nativeIdentity,
    observed_at: input.observedAt,
    payload_hash: sha(canonicalBytesV1(payload)),
  };
  const event: LifecycleEventV1 = {
    store_kind: 'lifecycle_event',
    schema_version: 1,
    source: input.source,
    source_cursor: `${input.sourceSequence}:${sha(canonicalBytesV1(identity))}`,
    source_sequence: input.sourceSequence,
    event_id: sha(canonicalBytesV1(identity)),
    event_type: input.eventType,
    repository_id: input.repositoryId,
    run_id: input.runId,
    generation: input.generation,
    parent_id: input.parentId,
    native_identity: input.nativeIdentity,
    observed_at: input.observedAt,
    payload_hash: identity.payload_hash,
  };
  return validateLifecycleEvent(event);
}

export class LifecycleJournal {
  readonly journalPath: string;
  readonly source: string;

  constructor(journalPath: string, source: string) {
    this.journalPath = path.resolve(journalPath);
    this.source = source;
  }

  append(event: LifecycleEventV1): void {
    validateLifecycleEvent(event);
    if (event.source !== this.source) throw new Error('E_TRACKER_CURSOR_CONFLICT: source differs');
    withDurableJsonLineLock(this.journalPath, () => {
      const events = this.readUnsafe();
      const sameSequence = events.find((candidate) => candidate.source_sequence === event.source_sequence);
      if (sameSequence !== undefined) {
        if (sameSequence.event_id === event.event_id) return;
        throw new Error('E_TRACKER_CURSOR_CONFLICT: source sequence was reused');
      }
      const last = events[events.length - 1];
      if (last !== undefined && event.source_sequence !== last.source_sequence + 1) {
        throw new Error('E_TRACKER_CURSOR_CONFLICT: source sequence is not contiguous');
      }
      appendJsonLineUnderLock(this.journalPath, event);
    });
  }

  appendNext(
    create: (nextSequence: number, existing: readonly LifecycleEventV1[]) => LifecycleEventV1,
    isReplay?: (candidate: LifecycleEventV1, proposed: LifecycleEventV1) => boolean,
  ): LifecycleEventV1 {
    return withDurableJsonLineLock(this.journalPath, () => {
      const events = this.readUnsafe();
      const nextSequence = (events[events.length - 1]?.source_sequence ?? 0) + 1;
      const event = validateLifecycleEvent(create(nextSequence, events));
      if (event.source !== this.source || event.source_sequence !== nextSequence) {
        throw new Error('E_TRACKER_CURSOR_CONFLICT: generated lifecycle sequence/source differs');
      }
      const replay = isReplay === undefined
        ? undefined
        : events.find((candidate) => isReplay(candidate, event));
      if (replay !== undefined) return replay;
      appendJsonLineUnderLock(this.journalPath, event);
      return event;
    });
  }

  read(afterSequence = -1): LifecycleEventV1[] {
    return this.readUnsafe().filter((event) => event.source_sequence > afterSequence);
  }

  private readUnsafe(): LifecycleEventV1[] {
    if (!fs.existsSync(this.journalPath)) return [];
    const stat = fs.lstatSync(this.journalPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16_777_216) {
      throw new Error('E_TRACKER_CURSOR_CONFLICT: lifecycle journal is unsafe or over bound');
    }
    const lines = fs.readFileSync(this.journalPath, 'utf8').split('\n').filter(Boolean);
    if (lines.length > 100_000) throw new Error('E_TRACKER_CURSOR_CONFLICT: lifecycle journal exceeds record bound');
    const events = lines.map((line) => validateLifecycleEvent(JSON.parse(line)));
    let previous = -1;
    const identities = new Set<string>();
    for (const event of events) {
      if (event.source !== this.source || (previous >= 0 && event.source_sequence !== previous + 1)
        || identities.has(event.event_id)) {
        throw new Error('E_TRACKER_CURSOR_CONFLICT: lifecycle journal ordering is invalid');
      }
      previous = event.source_sequence;
      identities.add(event.event_id);
    }
    return events;
  }
}

export class TrackerProjector {
  readonly projectionPath: string;
  private readonly lockTimeoutMs: number;

  constructor(projectionPath: string, options: { lockTimeoutMs?: number } = {}) {
    this.projectionPath = path.resolve(projectionPath);
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
  }

  async project(input: Readonly<TrackerProjectInput>): Promise<Result<TrackerProjectionV1, RuntimeError>> {
    if (!Number.isSafeInteger(input.generation) || input.generation < 1
      || input.ownerToken.trim() === '' || input.runId.trim() === '') {
      return err(runtimeError('E_TRACKER_GENERATION_FENCED', 'Tracker projector input is invalid'));
    }
    const lock = await acquireOwnerLock(`${this.projectionPath}.projector.lock`, {
      timeoutMs: this.lockTimeoutMs,
    });
    if (!lock.ok) return lock;
    try {
      const current = this.read();
      if (!current.ok && current.error.code !== 'E_NOT_FOUND') return current;
      if (current.ok && current.value.run_id !== input.runId) {
        return err(runtimeError('E_TRACKER_GENERATION_FENCED', 'Tracker run identity differs'));
      }
      if (current.ok && current.value.generation > input.generation) {
        return err(runtimeError('E_TRACKER_GENERATION_FENCED', 'Stale tracker generation cannot project', {
          expected: current.value.generation,
          actual: input.generation,
        }));
      }
      if (current.ok && current.value.generation === input.generation
        && current.value.owner_token !== input.ownerToken) {
        return err(runtimeError('E_TRACKER_GENERATION_FENCED', 'Tracker generation is owned by another token'));
      }
      if (current.ok && input.generation > current.value.generation + 1) {
        return err(runtimeError('E_TRACKER_GENERATION_FENCED', 'Tracker takeover skipped a generation'));
      }

      const previousCursors = new Map((current.ok ? current.value.source_cursors : [])
        .map((cursor) => [cursor.source, cursor.sequence]));
      const newEvents: LifecycleEventV1[] = [];
      for (const journal of [...input.journals].sort((a, b) => a.source.localeCompare(b.source))) {
        const events = journal.read(previousCursors.get(journal.source) ?? -1);
        for (const event of events) {
          if (event.run_id !== input.runId || event.generation !== input.generation) {
            return err(runtimeError('E_TRACKER_GENERATION_FENCED', 'Journal event does not match projection generation', {
              source: journal.source,
              eventGeneration: event.generation,
              generation: input.generation,
            }));
          }
          newEvents.push(event);
        }
      }
      if (current.ok && newEvents.length === 0
        && current.value.generation === input.generation
        && current.value.owner_token === input.ownerToken) return current;

      const rawEvents = dedupeEvents([...(current.ok ? current.value.events : []), ...newEvents]);
      const sourceCursors = mergeCursors(
        current.ok ? current.value.source_cursors : [],
        buildCursors(newEvents),
      );
      const allEvents = dedupeSemanticEvents(rawEvents);
      const missing = reconcileMissingChildren(allEvents);
      const material: Omit<TrackerProjectionV1, 'projection_sha256'> = {
        store_kind: 'tracker_projection',
        schema_version: 1,
        repository_id: 'OMA',
        run_id: input.runId,
        generation: input.generation,
        owner_token: input.ownerToken,
        revision: (current.ok ? current.value.revision : 0) + 1,
        source_cursors: sourceCursors,
        events: allEvents,
        missing_children: missing,
        strict_diagnostics: missing.map((identity) => `E_TRACKER_MISSING_CHILD:${identity}`),
        projected_at: input.now,
      };
      const projection: TrackerProjectionV1 = {
        ...material,
        projection_sha256: sha(canonicalBytesV1(material)),
      };
      atomicWriteContractBytes(this.projectionPath, canonicalBytesV1(projection));
      return ok(projection);
    } catch (error) {
      return err(runtimeError('E_TRACKER_CURSOR_CONFLICT', 'Tracker projection failed closed', {
        cause: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      releaseOwnerLock(lock.value);
    }
  }

  read(): Result<TrackerProjectionV1, RuntimeError> {
    if (!fs.existsSync(this.projectionPath)) {
      return err(runtimeError('E_NOT_FOUND', 'Tracker projection does not exist'));
    }
    try {
      const value = JSON.parse(fs.readFileSync(this.projectionPath, 'utf8')) as TrackerProjectionV1;
      if (value.store_kind !== 'tracker_projection' || value.schema_version !== 1
        || value.repository_id !== 'OMA' || !Number.isSafeInteger(value.revision)
        || typeof value.owner_token !== 'string' || value.owner_token.trim() === ''
        || value.revision < 1 || !Array.isArray(value.events)
        || !Array.isArray(value.source_cursors) || !Array.isArray(value.missing_children)) {
        throw new Error('projection shape is invalid');
      }
      value.events.forEach(validateLifecycleEvent);
      const { projection_sha256: ignored, ...material } = value;
      void ignored;
      if (sha(canonicalBytesV1(material)) !== value.projection_sha256) {
        throw new Error('projection hash does not match');
      }
      return ok(value);
    } catch (error) {
      return err(runtimeError('E_CORRUPT_STATE', 'Tracker projection is corrupt', {
        cause: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

function buildCursors(events: readonly LifecycleEventV1[]): TrackerSourceCursorV1[] {
  const latest = new Map<string, LifecycleEventV1>();
  for (const event of events) {
    const current = latest.get(event.source);
    if (current === undefined || event.source_sequence > current.source_sequence) latest.set(event.source, event);
  }
  return [...latest.values()].sort((a, b) => a.source.localeCompare(b.source)).map((event) => ({
    source: event.source,
    cursor: event.source_cursor,
    sequence: event.source_sequence,
  }));
}

function mergeCursors(
  previous: readonly TrackerSourceCursorV1[],
  next: readonly TrackerSourceCursorV1[],
): TrackerSourceCursorV1[] {
  const merged = new Map(previous.map((cursor) => [cursor.source, cursor]));
  for (const cursor of next) {
    const current = merged.get(cursor.source);
    if (current === undefined || cursor.sequence > current.sequence) merged.set(cursor.source, cursor);
  }
  return [...merged.values()].sort((left, right) => left.source.localeCompare(right.source));
}

function dedupeEvents(events: readonly LifecycleEventV1[]): LifecycleEventV1[] {
  const seen = new Map<string, LifecycleEventV1>();
  for (const event of events) {
    const current = seen.get(event.event_id);
    if (current !== undefined && canonicalBytesV1(current).compare(canonicalBytesV1(event)) !== 0) {
      throw new Error('event identity was reused with different bytes');
    }
    seen.set(event.event_id, event);
  }
  return [...seen.values()].sort((a, b) => a.observed_at.localeCompare(b.observed_at)
    || a.source.localeCompare(b.source) || a.source_sequence - b.source_sequence);
}

function dedupeSemanticEvents(events: readonly LifecycleEventV1[]): LifecycleEventV1[] {
  const sorted = [...events].sort((a, b) => a.observed_at.localeCompare(b.observed_at)
    || a.source.localeCompare(b.source) || a.source_sequence - b.source_sequence);
  const seen = new Map<string, LifecycleEventV1>();
  for (const event of sorted) {
    const semantic = sha(canonicalBytesV1({
      event_type: event.event_type,
      repository_id: event.repository_id,
      run_id: event.run_id,
      generation: event.generation,
      parent_id: event.parent_id,
      native_identity: event.native_identity,
      payload_hash: event.payload_hash,
    }));
    if (!seen.has(semantic)) seen.set(semantic, event);
  }
  return [...seen.values()];
}

function reconcileMissingChildren(events: readonly LifecycleEventV1[]): string[] {
  const requested = new Set<string>();
  const observed = new Set<string>();
  for (const event of events) {
    if (event.native_identity === null) continue;
    if (event.event_type === 'spawn_requested') requested.add(event.native_identity);
    if (['session_started', 'agent_closed', 'agent_failed'].includes(event.event_type)) {
      observed.add(event.native_identity);
    }
  }
  return [...requested].filter((identity) => !observed.has(identity)).sort();
}

function sha(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}
