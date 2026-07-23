import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createLifecycleEvent, LifecycleJournal, TrackerProjector } from '../../src/runtime/tracker';

describe('generation-fenced tracker projector', () => {
  test('projects source journals once, persists cursor, and diagnoses missing children', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-tracker-'));
    try {
      const journal = new LifecycleJournal(path.join(root, 'sources', 'hook.jsonl'), 'hook');
      journal.append(createLifecycleEvent({
        source: 'hook', sourceSequence: 1, eventType: 'spawn_requested', repositoryId: 'OMA',
        runId: 'run-1', generation: 1, parentId: 'parent', nativeIdentity: 'child-1',
        payload: { task: 'x' }, observedAt: '2026-07-22T00:00:00.000Z',
      }));
      const fallback = new LifecycleJournal(path.join(root, 'sources', 'fallback.jsonl'), 'fallback');
      fallback.append(createLifecycleEvent({
        source: 'fallback', sourceSequence: 1, eventType: 'spawn_requested', repositoryId: 'OMA',
        runId: 'run-1', generation: 1, parentId: 'parent', nativeIdentity: 'child-1',
        payload: { task: 'x' }, observedAt: '2026-07-22T00:00:00.500Z',
      }));
      const projector = new TrackerProjector(path.join(root, 'tracker.json'));
      const first = await projector.project({
        runId: 'run-1', generation: 1, ownerToken: 'owner', journals: [journal, fallback],
        now: '2026-07-22T00:00:01.000Z',
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.value.revision).toBe(1);
      expect(first.value.events).toHaveLength(1);
      expect(first.value.source_cursors).toHaveLength(2);
      expect(first.value.missing_children).toEqual(['child-1']);
      const replay = await projector.project({
        runId: 'run-1', generation: 1, ownerToken: 'owner', journals: [journal, fallback],
        now: '2026-07-22T00:00:02.000Z',
      });
      expect(replay.ok && replay.value.revision).toBe(1);
      journal.append(createLifecycleEvent({
        source: 'hook', sourceSequence: 2, eventType: 'session_started', repositoryId: 'OMA',
        runId: 'run-1', generation: 1, parentId: 'parent', nativeIdentity: 'child-1',
        payload: { task: 'x' }, observedAt: '2026-07-22T00:00:03.000Z',
      }));
      const reconciled = await projector.project({
        runId: 'run-1', generation: 1, ownerToken: 'owner', journals: [journal, fallback],
        now: '2026-07-22T00:00:04.000Z',
      });
      expect(reconciled.ok && reconciled.value.missing_children).toEqual([]);
      const wrongOwner = await projector.project({
        runId: 'run-1', generation: 1, ownerToken: 'other', journals: [journal, fallback],
        now: '2026-07-22T00:00:05.000Z',
      });
      expect(wrongOwner).toEqual(expect.objectContaining({
        ok: false, error: expect.objectContaining({ code: 'E_TRACKER_GENERATION_FENCED' }),
      }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects stale generation and conflicting source sequence', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-tracker-fence-'));
    try {
      const journal = new LifecycleJournal(path.join(root, 'event.jsonl'), 'hook');
      journal.append(createLifecycleEvent({
        source: 'hook', sourceSequence: 1, eventType: 'turn_started', repositoryId: 'OMA',
        runId: 'run-1', generation: 2, parentId: null, nativeIdentity: 'native', payload: {},
        observedAt: '2026-07-22T00:00:00.000Z',
      }));
      expect(() => journal.append(createLifecycleEvent({
        source: 'hook', sourceSequence: 1, eventType: 'turn_completed', repositoryId: 'OMA',
        runId: 'run-1', generation: 2, parentId: null, nativeIdentity: 'native', payload: {},
        observedAt: '2026-07-22T00:00:01.000Z',
      }))).toThrow();
      const projector = new TrackerProjector(path.join(root, 'tracker.json'));
      const result = await projector.project({
        runId: 'run-1', generation: 1, ownerToken: 'owner', journals: [journal],
        now: '2026-07-22T00:00:02.000Z',
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('E_TRACKER_GENERATION_FENCED');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
