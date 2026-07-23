import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recoverTranscript } from '../../src/continuation/recovery';

describe('bounded immutable transcript recovery', () => {
  test('golden retains newest 900 lines, 124 turns, and exact warning order', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-recovery-'));
    try {
      const source = path.join(__dirname, '../fixtures/recovery/bounded-900-lines-broken-chain-v1.jsonl');
      const result = recoverTranscript({ sourcePath: source, recoveryRoot: root });
      expect(result.manifest.counters.physical_lines_retained).toBe(900);
      expect(result.manifest.counters.physical_lines_omitted_oldest).toBe(13);
      expect(result.manifest.counters.recognized_records_seen).toBe(897);
      expect(result.manifest.counters.unknown_records_seen).toBe(3);
      expect(result.manifest.counters.complete_turns_retained).toBe(124);
      expect(result.manifest.copied_byte_start).toBe(1997);
      expect(result.manifest.warnings).toEqual([
        'W_BROKEN_CHAIN', 'W_PARTIAL_RECOVERY', 'W_TRUNCATED_SOURCE', 'W_UNKNOWN_RECORD_TYPE',
      ]);
      expect(result.prompt).not.toContain('future_unknown');
      expect(fs.statSync(result.immutableCopyPath).mode & 0o777).toBe(0o400);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('symlink/nonregular source fails closed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-recovery-link-'));
    try {
      const source = path.join(root, 'source.jsonl');
      const link = path.join(root, 'link.jsonl');
      fs.writeFileSync(source, '{}\n');
      fs.symlinkSync(source, link);
      expect(() => recoverTranscript({ sourcePath: link, recoveryRoot: path.join(root, 'out') }))
        .toThrow(expect.objectContaining({ code: 'E_RESUME_SOURCE_NOT_REGULAR' }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('newest single complete turn over context cap emits no prompt pack', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-recovery-context-'));
    try {
      const source = path.join(root, 'source.jsonl');
      const huge = 'x'.repeat(900_000);
      fs.writeFileSync(source, [
        JSON.stringify({ store_kind: 'transcript_record', schema_version: 1, type: 'turn', event_id: '1', parent_event_id: null, turn_id: 't', role: 'user', complete: true, payload: { text: huge } }),
        JSON.stringify({ store_kind: 'transcript_record', schema_version: 1, type: 'turn', event_id: '2', parent_event_id: '1', turn_id: 't', role: 'tool', complete: true, payload: { text: huge } }),
        JSON.stringify({ store_kind: 'transcript_record', schema_version: 1, type: 'turn', event_id: '3', parent_event_id: '2', turn_id: 't', role: 'assistant', complete: true, payload: { text: huge } }),
      ].join('\n') + '\n');
      const result = recoverTranscript({ sourcePath: source, recoveryRoot: path.join(root, 'out') });
      expect(result.prompt).toBeNull();
      expect(result.errors).toContain('E_RESUME_CONTEXT_OVER_CAP');
      expect(result.manifest.counters.context_bytes_after).toBe(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('local callers cannot redefine a W0 recovery maximum', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-recovery-frozen-'));
    try {
      const source = path.join(root, 'source.jsonl');
      fs.writeFileSync(source, '{}\n');
      expect(() => recoverTranscript({
        sourcePath: source,
        recoveryRoot: path.join(root, 'out'),
        limits: { physical_lines: 899 },
      })).toThrow('Recovery limit physical_lines is frozen by resume/v1');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('large sparse sources hash fully while retaining only the bounded suffix', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-recovery-sparse-'));
    try {
      const source = path.join(root, 'source.jsonl');
      const descriptor = fs.openSync(source, 'w');
      fs.ftruncateSync(descriptor, 64 * 1024 * 1024);
      fs.closeSync(descriptor);
      fs.appendFileSync(source, [
        JSON.stringify({ store_kind: 'transcript_record', schema_version: 1, type: 'lifecycle', event_id: 'seed', parent_event_id: null }),
        JSON.stringify({ store_kind: 'transcript_record', schema_version: 1, type: 'turn', event_id: 'user', parent_event_id: 'seed', turn_id: 'tail', role: 'user', complete: true }),
        JSON.stringify({ store_kind: 'transcript_record', schema_version: 1, type: 'turn', event_id: 'assistant', parent_event_id: 'user', turn_id: 'tail', role: 'assistant', complete: true }),
      ].join('\n') + '\n');

      const result = recoverTranscript({ sourcePath: source, recoveryRoot: path.join(root, 'out') });

      expect(result.manifest.counters.source_bytes_total).toBeGreaterThan(64 * 1024 * 1024);
      expect(result.manifest.counters.source_bytes_considered).toBe(16_777_216);
      expect(result.manifest.counters.source_prefix_bytes_omitted).toBeGreaterThan(0);
      expect(result.manifest.source_sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(fs.statSync(result.immutableCopyPath).size).toBeLessThanOrEqual(16_777_216);
      expect(result.manifest.counters.complete_turns_retained).toBe(1);
      expect(result.prompt).toContain('tail');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when the opened source changes before the final fstat', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-recovery-race-'));
    try {
      const source = path.join(root, 'source.jsonl');
      fs.writeFileSync(source, '{}\n');
      expect(() => recoverTranscript({
        sourcePath: source,
        recoveryRoot: path.join(root, 'out'),
        afterCopy: () => fs.appendFileSync(source, '{}\n'),
      })).toThrow(expect.objectContaining({ code: 'E_RESUME_SOURCE_CHANGED_DURING_COPY' }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails closed when the source path is replaced after bounded reading', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-recovery-replaced-'));
    try {
      const source = path.join(root, 'source.jsonl');
      const moved = path.join(root, 'moved.jsonl');
      fs.writeFileSync(source, '{}\n');
      expect(() => recoverTranscript({
        sourcePath: source,
        recoveryRoot: path.join(root, 'out'),
        afterCopy: () => {
          fs.renameSync(source, moved);
          fs.writeFileSync(source, '{}\n');
        },
      })).toThrow(expect.objectContaining({ code: 'E_RESUME_SOURCE_CHANGED_DURING_COPY' }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
