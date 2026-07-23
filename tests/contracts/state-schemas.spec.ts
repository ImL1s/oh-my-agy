import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
  CAPABILITY_TIERS,
  ContractViolation,
  RECOVERY_LIMITS_V1,
  RECOVERY_WARNING_ORDER_V1,
  RESUME_SELECTOR_ERROR_CODES_V1,
  RESUME_SELECTOR_PRECEDENCE_V1,
  ResumeCandidateV1,
  ResumeSelectorErrorCodeV1,
  canonicalJsonV1,
  parseCanonicalJsonV1,
  assertVersionedStore,
  orderedRecoveryWarnings,
  recoveryBoundaryEvent,
  selectResumeCandidate,
  validateCapabilityRecord,
  resolveCapabilityProviders,
  validateLifecycleEvent,
  validatePrimaryPollerLease,
  validateRecoveryManifest,
  validateTrackerProjectorLease,
  validateWorkerEnvelope,
} from '../../src/contracts';

const fixtures = (...parts: string[]): string => path.join(__dirname, '..', 'fixtures', ...parts);

interface ResumeSelectorFixtureV1 {
  schema_version: 1;
  error_vectors: Array<{
    name: string;
    best_effort: boolean;
    expected_error: ResumeSelectorErrorCodeV1;
    candidates: ResumeCandidateV1[];
  }>;
  selection_vectors: Array<{
    name: string;
    best_effort: boolean;
    expected_kind: ResumeCandidateV1['kind'];
    candidates: ResumeCandidateV1[];
  }>;
}

function capturedContractCode(operation: () => unknown): string {
  let captured: unknown;
  try {
    operation();
  } catch (error: unknown) {
    captured = error;
  }
  expect(captured).toBeInstanceOf(ContractViolation);
  return (captured as ContractViolation).code;
}

describe('OMA W0 state and shared schema contracts', () => {
  test('canonical JSON v1 is integer-only, code-point sorted, compact, and byte exact', () => {
    const value = { '\u{10000}': 2, '\ue000': 1, z: [true, null, 'line\n'] };
    expect(canonicalJsonV1(value)).toBe('{"z":[true,null,"line\\n"],"":1,"𐀀":2}');
    expect(canonicalJsonV1({ n: -0 })).toBe('{"n":0}');
    expect(() => canonicalJsonV1({ n: 1.5 })).toThrow('integers only');
    expect(() => canonicalJsonV1({ n: Number.NaN })).toThrow('integers only');
    expect(() => canonicalJsonV1({ n: undefined })).toThrow('undefined');
    expect(() => parseCanonicalJsonV1('{"b":1,"a":2}')).toThrow('not canonical');
    expect(() => parseCanonicalJsonV1('{"a":1}\n')).toThrow('not canonical');
    expect(() => parseCanonicalJsonV1('\ufeff{"a":1}')).toThrow('BOM');
    expect(parseCanonicalJsonV1('{"a":1}')).toEqual({ a: 1 });
  });

  test('versioned stores reject missing, nonpositive, and future schemas', () => {
    expect(() => assertVersionedStore({ store_kind: 'x', schema_version: 1 }, 'x')).not.toThrow();
    expect(() => assertVersionedStore({ store_kind: 'x', schema_version: 0 }, 'x')).toThrow();
    expect(() => assertVersionedStore({ store_kind: 'x', schema_version: 2 }, 'x')).toThrow('newer');
    expect(() => assertVersionedStore({ store_kind: 'y', schema_version: 1 }, 'x')).toThrow('store_kind');
  });

  test('capability tiers remain independent and duplicate providers retain visible shadows', () => {
    const record = JSON.parse(fs.readFileSync(fixtures('capabilities', 'independent-tiers.json'), 'utf8'));
    const valid = validateCapabilityRecord(record);
    expect(CAPABILITY_TIERS).toEqual([
      'configured', 'installed', 'enabled', 'loadable', 'observed', 'healthy', 'verified',
    ]);
    expect(valid.configured).toBe(true);
    expect(valid.installed).toBe(false);

    const providers = ['global', 'workspace', 'plugin'].map((origin, index) => ({
      ...valid,
      origin,
      resolution_priority: [20, 10, 30][index],
    }));
    const resolved = resolveCapabilityProviders(providers);
    expect(resolved.map((entry) => entry.origin)).toEqual(['workspace', 'global', 'plugin']);
    expect(resolved.map((entry) => entry.shadowed_by)).toEqual([null, 'workspace', 'workspace']);
    expect(valid.redacted_diagnostic).not.toMatch(/bearer|token-|account-123/i);
    expect(() => validateCapabilityRecord({ ...record, probe_timestamp: 'not-a-time' })).toThrow();
    expect(() => validateCapabilityRecord({ ...record, aliases: ['agy', 'agy'] })).toThrow();
    expect(() => validateCapabilityRecord({ ...record, bounded_result: 'unbounded output' })).toThrow();
    expect(() => validateCapabilityRecord({ ...record, redacted_diagnostic: 'secret=raw-value' }))
      .toThrow('unredacted');
    expect(() => validateCapabilityRecord({ ...record, extra: true })).toThrow('keys');
  });

  test('lifecycle event set and generation/sequence are frozen', () => {
    const event = {
      store_kind: 'lifecycle_event', schema_version: 1, source: 'hook', source_cursor: 'c1',
      source_sequence: 1, event_id: 'e1', event_type: 'turn_completed', repository_id: 'OMA',
      run_id: 'r1', generation: 1, parent_id: null, native_identity: null,
      observed_at: '2026-07-22T00:00:00.000Z',
      payload_hash: crypto.createHash('sha256').update('payload').digest('hex'),
    };
    expect(validateLifecycleEvent(event).event_type).toBe('turn_completed');
    expect(() => validateLifecycleEvent({ ...event, event_type: 'stop' })).toThrow('Unknown');
    expect(() => validateLifecycleEvent({ ...event, generation: 0 })).toThrow();
    expect(() => validateLifecycleEvent({ ...event, observed_at: '2026-07-22' })).toThrow();
    expect(() => validateLifecycleEvent({ ...event, parent_id: 1 })).toThrow();
    expect(() => validateLifecycleEvent({ ...event, extra: true })).toThrow('keys');
  });

  test('projector and primary-poller leases are distinct, generation-fenced, and cursor complete', () => {
    const projector = {
      store_kind: 'tracker_projector_lease', schema_version: 1, repository_id: 'OMA', run_id: 'run',
      owner_token: 'projector-owner', generation: 2,
      source_cursors: [{ source: 'hook-journal', cursor: 'offset:5', sequence: 5 }],
      acquired_at: '2026-07-22T00:00:00.000Z', lease_expires_at: '2026-07-22T00:01:00.000Z',
    } as const;
    const poller = {
      store_kind: 'primary_poller_lease', schema_version: 1, repository_id: 'OMA', run_id: 'run',
      pid: 123, process_start_identity: 'pid-123-start-1', owner_token: 'poller-owner', generation: 3,
      last_successful_poll_at: '2026-07-22T00:00:30.000Z', cursor: 'native:9', error: null,
      acquired_at: '2026-07-22T00:00:00.000Z', lease_expires_at: '2026-07-22T00:01:00.000Z',
    } as const;
    expect(validateTrackerProjectorLease(projector).owner_token).toBe('projector-owner');
    expect(validatePrimaryPollerLease(poller).owner_token).toBe('poller-owner');
    expect(() => validateTrackerProjectorLease({
      ...projector,
      source_cursors: [...projector.source_cursors, { ...projector.source_cursors[0] }],
    })).toThrow('duplicate');
    expect(() => validatePrimaryPollerLease({
      ...poller, last_successful_poll_at: '2026-07-22T00:02:00.000Z',
    })).toThrow('out of order');
    expect(() => validatePrimaryPollerLease({ ...poller, error: 'token=raw-secret' }))
      .toThrow('redacted');
    expect(() => validatePrimaryPollerLease({ ...poller, authority: 'hud' })).toThrow('keys');
  });

  test('resume limits, selector precedence, and global warning order are exact', () => {
    expect(RECOVERY_LIMITS_V1).toEqual({
      source_bytes: 16_777_216,
      physical_line_bytes: 1_048_576,
      physical_lines: 900,
      parsed_records: 900,
      complete_turns: 256,
      context_bytes: 2_097_152,
    });
    expect(orderedRecoveryWarnings([
      'W_UNKNOWN_RECORD_TYPE', 'W_TRUNCATED_SOURCE', 'W_BROKEN_CHAIN', 'W_TRUNCATED_SOURCE',
    ])).toEqual(['W_BROKEN_CHAIN', 'W_TRUNCATED_SOURCE', 'W_UNKNOWN_RECORD_TYPE']);
    expect(RECOVERY_WARNING_ORDER_V1).toHaveLength(7);
    expect(RESUME_SELECTOR_PRECEDENCE_V1).toEqual([
      'immutable_recovery_manifest',
      'run_id',
      'native_session',
      'current_run_manifest',
      'signed_portable_handoff',
      'best_effort_repository_search',
    ]);
    expect(RESUME_SELECTOR_ERROR_CODES_V1).toEqual([
      'E_RESUME_SELECTOR_CONFLICT',
      'E_RESUME_AMBIGUOUS',
      'E_RESUME_NOT_FOUND',
    ]);
  });

  test('resume selector failures are exact and never fall through to a lower rank', () => {
    const fixture = JSON.parse(fs.readFileSync(
      fixtures('recovery', 'resume-selector-no-fallback-v1.json'),
      'utf8',
    )) as ResumeSelectorFixtureV1;
    expect(fixture.schema_version).toBe(1);
    expect(fixture.error_vectors).toHaveLength(22);
    for (const vector of fixture.error_vectors) {
      const actual = capturedContractCode(() => selectResumeCandidate(
        vector.candidates,
        { bestEffort: vector.best_effort },
      ));
      expect({ name: vector.name, actual }).toEqual({
        name: vector.name,
        actual: vector.expected_error,
      });
    }
  });

  test('valid higher selectors suppress lower diagnostics without merging stale pointer fields', () => {
    const fixture = JSON.parse(fs.readFileSync(
      fixtures('recovery', 'resume-selector-no-fallback-v1.json'),
      'utf8',
    )) as ResumeSelectorFixtureV1;
    expect(fixture.selection_vectors).toHaveLength(6);
    for (const vector of fixture.selection_vectors) {
      const selected = selectResumeCandidate(
        vector.candidates,
        { bestEffort: vector.best_effort },
      );
      const expected = vector.candidates.find((candidate) => candidate.kind === vector.expected_kind);
      expect(expected).toBeDefined();
      expect(selected).toEqual(vector.expected_kind === 'best_effort_repository_search'
        ? { ...expected, diagnostics_only: true }
        : expected);
    }
  });

  test('bounded-900-lines-broken-chain-v1 has the exact 913/900/897/3/124 oracle', () => {
    const lines = fs.readFileSync(fixtures('recovery', 'bounded-900-lines-broken-chain-v1.jsonl'), 'utf8')
      .trimEnd().split('\n');
    const expected = JSON.parse(fs.readFileSync(
      fixtures('recovery', 'bounded-900-lines-broken-chain-v1.expected.json'), 'utf8',
    ));
    expect(lines).toHaveLength(913);
    const retained = lines.slice(-900).map((line) => JSON.parse(line));
    const recognized = retained.filter((record) => ['turn', 'lifecycle'].includes(record.type));
    const unknown = retained.filter((record) => !['turn', 'lifecycle'].includes(record.type));
    const turnRoles = recognized.filter((record) => record.type === 'turn');
    const completeTurnIds = new Set(turnRoles.map((record) => record.turn_id));
    expect(recognized).toHaveLength(897);
    expect(unknown).toHaveLength(3);
    expect(completeTurnIds.size).toBe(124);
    expect(recognized.at(-1)).toEqual(expect.objectContaining({
      event_id: expected.marked_truncated_event_id,
      truncated: true,
    }));
    expect(recognized[0].parent_event_id).toBe('old-013');
    expect(retained.some((record) => record.event_id === 'old-013')).toBe(false);
    expect(unknown.map((record) => record.type)).toEqual(expected.unknown_types);
    const prompt = turnRoles.map((record) => record.payload.text).join('\n');
    expect(prompt).not.toContain('must-not-enter-prompt');
    expect(expected.warnings).toEqual([
      'W_BROKEN_CHAIN', 'W_PARTIAL_RECOVERY', 'W_TRUNCATED_SOURCE', 'W_UNKNOWN_RECORD_TYPE',
    ]);
    expect(crypto.createHash('sha256').update(lines.join('\n') + '\n').digest('hex'))
      .toBe(expected.source_sha256);
    expect(crypto.createHash('sha256').update(lines.slice(-900).join('\n') + '\n').digest('hex'))
      .toBe(expected.retained_copy_sha256);
  });

  test('recovery manifest is complete and every frozen cap has below/exact/+1 semantics', () => {
    const manifest = JSON.parse(fs.readFileSync(
      fixtures('recovery', 'recovery-manifest-complete-v1.json'),
      'utf8',
    ));
    expect(() => validateRecoveryManifest(manifest)).not.toThrow();
    expect(() => validateRecoveryManifest({ ...manifest, extra: true })).toThrow('keys');
    expect(capturedContractCode(() => validateRecoveryManifest({
      ...manifest, source_mtime_ns_after: manifest.source_mtime_ns_after + 1,
    }))).toBe('E_RESUME_SOURCE_CHANGED_DURING_COPY');
    expect(() => validateRecoveryManifest({
      ...manifest, immutable_copy_path: '.agy/recovery/not-content-addressed.jsonl',
    })).toThrow('content-addressed');
    expect(() => validateRecoveryManifest({
      ...manifest,
      warnings: ['W_TRUNCATED_SOURCE', 'W_BROKEN_CHAIN'],
    })).toThrow('out of order');
    expect(() => validateRecoveryManifest({
      ...manifest,
      counters: { ...manifest.counters, parsed_records_retained: 1 },
    })).toThrow('invariants');

    for (const [limit, maximum] of Object.entries(RECOVERY_LIMITS_V1)) {
      const below = recoveryBoundaryEvent(limit as keyof typeof RECOVERY_LIMITS_V1, maximum - 1);
      const exact = recoveryBoundaryEvent(limit as keyof typeof RECOVERY_LIMITS_V1, maximum);
      const over = recoveryBoundaryEvent(limit as keyof typeof RECOVERY_LIMITS_V1, maximum + 1);
      expect({ limit, below: below.warning, exact: exact.warning, over: over.warning }).toEqual({
        limit, below: null, exact: null,
        over: limit === 'parsed_records' ? 'W_PARSED_RECORDS_TRUNCATED'
          : limit === 'complete_turns' ? 'W_TURNS_TRUNCATED'
            : limit === 'context_bytes' ? 'W_CONTEXT_TRUNCATED' : 'W_TRUNCATED_SOURCE',
      });
      expect(over.retained + over.omitted).toBe(maximum + 1);
      expect(over.retained).toBe(limit === 'physical_line_bytes' ? 0 : maximum);
    }
  });

  test('complete worker envelope is versioned and read-only cannot widen write scope', () => {
    const envelope = {
      store_kind: 'oma_worker_envelope', schema_version: 1, repository_id: 'OMA', run_id: 'run',
      team_id: 'team', task_id: 'task', task_text: 'Review safely', dependencies: [], write_scope: [],
      verification_argv: [['npm', 'test']],
      artifact_contract: { proposal_root: '.agy/artifacts/x', required_files: [], terminal_receipt_path: 'terminal.json' },
      contributor_guidance_hashes: [{ path: 'AGENTS.md', sha256: 'a'.repeat(64) }],
      mailbox_cursor: 0, claim_id: 'claim', generation: 1, state_endpoint: 'oma://state/run',
      cancellation_token_hash: 'b'.repeat(64), provider: 'agy_headless', native_role: 'reviewer',
      capability_mode: 'read-only', deadline_ms: 60_000,
    } as const;
    expect(validateWorkerEnvelope(envelope).provider).toBe('agy_headless');
    expect(() => validateWorkerEnvelope({ ...envelope, write_scope: ['src/**'] })).toThrow('Read-only');
    expect(() => validateWorkerEnvelope({ ...envelope, provider: 'codex' })).toThrow('provider');

    const writable = { ...envelope, capability_mode: 'read-write', write_scope: ['src/contracts/index.ts'] } as const;
    expect(() => validateWorkerEnvelope(writable)).not.toThrow();
    expect(() => validateWorkerEnvelope({ ...writable, write_scope: ['AGENTS.md'] })).toThrow();
    expect(() => validateWorkerEnvelope({ ...writable, write_scope: ['../escape'] })).toThrow();
    expect(() => validateWorkerEnvelope({
      ...writable, verification_argv: [['sh', '-c', 'echo ok; whoami']],
    })).toThrow();
    expect(() => validateWorkerEnvelope({ ...writable, artifact_contract: {} })).toThrow('keys');
    expect(() => validateWorkerEnvelope({ ...writable, extra: true })).toThrow('keys');
  });
});
