import * as fs from 'fs';
import * as path from 'path';
import { sha256 } from '../../src/runtime/atomic';
import {
  TEAM_API_OPERATIONS_P0,
  executeTeamApiOperation,
  wrapTeamApiCliEnvelope,
} from '../../src/team/api-interop';
import { parseTeamCommand, teamCommand } from '../../src/team/commands';
import { TeamStateStore } from '../../src/team/state';
import { WorkerAuthorityBindingV1 } from '../../src/team/types';
import { validateTeamManifest } from '../../src/team/manifest';
import { RuntimeContext } from '../../src/team/types';
import { GitFixture } from '../helpers/git-fixture';

function rawManifest() {
  return {
    schema: 'oma.team-manifest/v1',
    teamId: 'alpha',
    revision: 1,
    tasks: [
      {
        id: 'first', dependencies: [], write_scope: 'none', mode: 'read_only',
        verification: { version: 1, commands: [], requiredArtifacts: [] },
      },
      {
        id: 'second', dependencies: ['first'], write_scope: [{ kind: 'file', path: 'second.txt' }], mode: 'headless',
        verification: { version: 1, commands: [], requiredArtifacts: [] },
      },
    ],
  };
}

async function fixtureStore() {
  const fixture = GitFixture.create();
  const manifest = validateTeamManifest(rawManifest(), fixture.repo);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const store = new TeamStateStore(fixture.stateRoot, 'repo-key', 'workspace-key', 'alpha');
  const created = await store.create(manifest.value, 'owner-nonce');
  if (!created.ok) throw new Error(created.error.message);
  return { fixture, store, revision: created.value.revision };
}

describe('team api-interop P0', () => {
  test('exports P0 op table (not full OMX 33)', () => {
    expect(TEAM_API_OPERATIONS_P0).toEqual([
      'send-message',
      'mailbox-list',
      'mailbox-mark-delivered',
      'create-task',
      'list-tasks',
      'claim-task',
      'transition-task-status',
      'release-task-claim',
      'get-summary',
      'write-worker-inbox',
    ]);
    expect(TEAM_API_OPERATIONS_P0).not.toContain('broadcast');
  });

  test('unknown op → ok:false / E_TEAM_API_UNKNOWN', async () => {
    const { fixture, store } = await fixtureStore();
    try {
      const result = await executeTeamApiOperation('broadcast', { team_name: 'alpha' }, { store });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.operation).toBe('unknown');
      expect(result.error.code).toBe('E_TEAM_API_UNKNOWN');
    } finally {
      fixture.cleanup();
    }
  });

  test('send-message + mailbox-list roundtrip', async () => {
    const { fixture, store } = await fixtureStore();
    try {
      const sent = await executeTeamApiOperation('send-message', {
        team_name: 'alpha',
        from_worker: 'leader',
        to_worker: 'worker-a',
        body: 'hello mailbox',
        message_id: 'm-roundtrip',
        expected_revision: 0,
      }, { store, nowMs: 1_000 });
      expect(sent.ok).toBe(true);
      if (!sent.ok) return;

      const listed = await executeTeamApiOperation('mailbox-list', {
        team_name: 'alpha',
        worker: 'worker-a',
      }, { store });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.data.count).toBe(1);
      const messages = listed.data.messages as Array<Record<string, unknown>>;
      expect(messages[0]).toEqual(expect.objectContaining({
        message_id: 'm-roundtrip',
        from_worker: 'leader',
        to_worker: 'worker-a',
        body: 'hello mailbox',
        body_digest: sha256('hello mailbox'),
      }));
    } finally {
      fixture.cleanup();
    }
  });

  test('ordered mailbox sequence + ack cursor via mark-delivered', async () => {
    const { fixture, store } = await fixtureStore();
    try {
      const claimed = await store.claimTask('first', 'worker-1', 0, 1_000, 5_000, 'claim-1');
      if (!claimed.ok) throw new Error(claimed.error.message);
      const binding: WorkerAuthorityBindingV1 = {
        schemaVersion: 1,
        taskId: 'first',
        claimTokenDigest: sha256('claim-1'),
        generation: 1,
        provider: 'agy_headless',
        providerReceiptHash: sha256('provider-1'),
        process: { pid: 42, startMarker: 'start-1' },
        state: 'claimed',
        transitionSequence: 0,
        boundAtMs: 1_000,
      };
      const bound = await store.bindWorkerAuthority(claimed.value.revision, 'claim-1', binding);
      if (!bound.ok) throw new Error(bound.error.message);

      const sent = await executeTeamApiOperation('send-message', {
        from_worker: 'leader',
        to_worker: 'first',
        body: 'ordered-1',
        message_id: 'ord-1',
        generation: 1,
        claim_token: 'claim-1',
        expected_revision: bound.value.revision,
      }, { store, nowMs: 1_100 });
      expect(sent.ok).toBe(true);
      if (!sent.ok) return;

      const listed = await executeTeamApiOperation('mailbox-list', {
        worker: 'first',
        claim_token: 'claim-1',
        generation: 1,
        after_cursor: 0,
      }, { store });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.data.count).toBe(1);
      expect((listed.data.messages as Array<Record<string, unknown>>)[0].sequence).toBe(1);

      const marked = await executeTeamApiOperation('mailbox-mark-delivered', {
        worker: 'first',
        message_id: 'ord-1',
        claim_token: 'claim-1',
        generation: 1,
        expected_cursor: 0,
        expected_revision: sent.data.revision,
      }, { store, nowMs: 1_200 });
      expect(marked.ok).toBe(true);
      if (!marked.ok) return;
      expect(marked.data.ack).toEqual(expect.objectContaining({ acknowledged: true, next_cursor: 1 }));

      const after = await executeTeamApiOperation('mailbox-list', {
        worker: 'first',
        claim_token: 'claim-1',
        generation: 1,
        after_cursor: 1,
      }, { store });
      expect(after.ok).toBe(true);
      if (after.ok) expect(after.data.count).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });

  test('mailbox fencing: partial args + unfenced ordered leak fail closed', async () => {
    const { fixture, store } = await fixtureStore();
    try {
      const claimed = await store.claimTask('first', 'worker-1', 0, 1_000, 5_000, 'claim-1');
      if (!claimed.ok) throw new Error(claimed.error.message);
      const binding: WorkerAuthorityBindingV1 = {
        schemaVersion: 1,
        taskId: 'first',
        claimTokenDigest: sha256('claim-1'),
        generation: 1,
        provider: 'agy_headless',
        providerReceiptHash: sha256('provider-1'),
        process: { pid: 42, startMarker: 'start-1' },
        state: 'claimed',
        transitionSequence: 0,
        boundAtMs: 1_000,
      };
      const bound = await store.bindWorkerAuthority(claimed.value.revision, 'claim-1', binding);
      if (!bound.ok) throw new Error(bound.error.message);

      const sent = await executeTeamApiOperation('send-message', {
        from_worker: 'leader',
        to_worker: 'first',
        body: 'secret-ordered',
        message_id: 'ord-secret',
        generation: 1,
        claim_token: 'claim-1',
        expected_revision: bound.value.revision,
      }, { store, nowMs: 1_100 });
      expect(sent.ok).toBe(true);

      const partial = await executeTeamApiOperation('mailbox-list', {
        worker: 'first',
        claim_token: 'claim-1',
      }, { store });
      expect(partial.ok).toBe(false);
      if (!partial.ok) expect(partial.error.code).toBe('E_TEAM_API_INVALID_INPUT');

      const unfenced = await executeTeamApiOperation('mailbox-list', {
        worker: 'first',
      }, { store });
      expect(unfenced.ok).toBe(true);
      if (unfenced.ok) {
        expect(unfenced.data.count).toBe(0);
        expect(unfenced.data.mode).toBe('unordered');
      }

      const markNoClaim = await executeTeamApiOperation('mailbox-mark-delivered', {
        worker: 'first',
        message_id: 'ord-secret',
        expected_revision: sent.ok ? sent.data.revision : 0,
      }, { store, nowMs: 1_200 });
      expect(markNoClaim.ok).toBe(false);
      if (!markNoClaim.ok) expect(markNoClaim.error.code).toBe('E_TEAM_API_INVALID_INPUT');

      const snap = store.read();
      expect(snap.ok).toBe(true);
      if (snap.ok) {
        expect(snap.value.value.mailbox['ord-secret']?.deliveredAtMs).toBeUndefined();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('claim-task + transition-task-status enforces claim token', async () => {
    const { fixture, store } = await fixtureStore();
    try {
      const claimed = await executeTeamApiOperation('claim-task', {
        task_id: 'first',
        worker: 'worker-1',
        claim_token: 'tok-good',
        expected_revision: 0,
        lease_ms: 5_000,
      }, { store, nowMs: 1_000 });
      expect(claimed.ok).toBe(true);
      if (!claimed.ok) return;
      expect(claimed.data.claim_token).toBe('tok-good');
      expect(claimed.data.generation).toBe(1);

      const bad = await executeTeamApiOperation('transition-task-status', {
        task_id: 'first',
        from: 'in_progress',
        to: 'awaiting_interaction',
        claim_token: 'tok-wrong',
        expected_revision: claimed.data.revision,
      }, { store });
      expect(bad.ok).toBe(false);
      if (bad.ok) return;
      expect(bad.error.code).toBe('E_REVISION_CONFLICT');

      const good = await executeTeamApiOperation('transition-task-status', {
        task_id: 'first',
        from: 'in_progress',
        to: 'awaiting_interaction',
        claim_token: 'tok-good',
        expected_revision: claimed.data.revision,
      }, { store });
      expect(good.ok).toBe(true);
      if (good.ok) expect(good.data.status).toBe('awaiting_interaction');
    } finally {
      fixture.cleanup();
    }
  });

  test('release-task-claim returns task to pending', async () => {
    const { fixture, store } = await fixtureStore();
    try {
      const claimed = await executeTeamApiOperation('claim-task', {
        task_id: 'first',
        worker: 'worker-1',
        claim_token: 'tok-rel',
        expected_revision: 0,
      }, { store, nowMs: 1_000, tokenFactory: () => 'tok-rel' });
      expect(claimed.ok).toBe(true);
      if (!claimed.ok) return;

      const released = await executeTeamApiOperation('release-task-claim', {
        task_id: 'first',
        worker: 'worker-1',
        claim_token: 'tok-rel',
        expected_revision: claimed.data.revision,
      }, { store });
      expect(released.ok).toBe(true);
      if (!released.ok) return;
      expect(released.data.status).toBe('pending');
    } finally {
      fixture.cleanup();
    }
  });

  test('create-task + list-tasks + get-summary shape', async () => {
    const { fixture, store } = await fixtureStore();
    try {
      const created = await executeTeamApiOperation('create-task', {
        subject: 'Extra Probe',
        description: 'P0 create-task probe',
        task_id: 'extra-probe',
        expected_revision: 0,
      }, { store });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      expect(created.data.task).toEqual(expect.objectContaining({
        id: 'extra-probe',
        subject: 'Extra Probe',
        description: 'P0 create-task probe',
      }));

      const listed = await executeTeamApiOperation('list-tasks', {}, { store });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.data.count).toBe(3);
      const tasks = listed.data.tasks as Array<Record<string, unknown>>;
      const ids = tasks.map((task) => task.id);
      expect(ids).toEqual(expect.arrayContaining(['first', 'second', 'extra-probe']));
      const extra = tasks.find((task) => task.id === 'extra-probe');
      expect(extra).toEqual(expect.objectContaining({
        subject: 'Extra Probe',
        description: 'P0 create-task probe',
      }));

      const manifest = store.read();
      expect(manifest.ok).toBe(true);
      if (manifest.ok) {
        const spec = manifest.value.value.manifest.tasks.find((entry) => entry.id === 'extra-probe');
        expect(spec?.subject).toBe('Extra Probe');
        expect(spec?.description).toBe('P0 create-task probe');
      }

      const summary = await executeTeamApiOperation('get-summary', {}, { store });
      expect(summary.ok).toBe(true);
      if (!summary.ok) return;
      expect(summary.data).toEqual(expect.objectContaining({
        team_id: 'alpha',
        complete: false,
        task_count: 3,
      }));
      expect(Array.isArray(summary.data.blockers)).toBe(true);
      expect(typeof summary.data.revision).toBe('number');
    } finally {
      fixture.cleanup();
    }
  });

  test('write-worker-inbox requires team aggregate', async () => {
    const fixture = GitFixture.create();
    try {
      const store = new TeamStateStore(fixture.stateRoot, 'repo-key', 'workspace-key', 'alpha');
      const written = await executeTeamApiOperation('write-worker-inbox', {
        worker: 'worker-1',
        content: '# inbox\nhello\n',
      }, { store });
      expect(written.ok).toBe(false);
      if (written.ok) return;
      expect(written.error.code).toBe('E_NOT_FOUND');
    } finally {
      fixture.cleanup();
    }
  });

  test('mailbox-list fails closed on body digest mismatch', async () => {
    const { fixture, store } = await fixtureStore();
    try {
      const sent = await executeTeamApiOperation('send-message', {
        from_worker: 'leader',
        to_worker: 'worker-a',
        body: 'intact body',
        message_id: 'm-corrupt',
        expected_revision: 0,
      }, { store, nowMs: 2_000 });
      expect(sent.ok).toBe(true);
      if (!sent.ok) return;

      const bodyPath = path.join(store.teamDirectory(), 'mailbox-bodies', 'm-corrupt.txt');
      fs.writeFileSync(bodyPath, 'tampered body', 'utf8');

      const listed = await executeTeamApiOperation('mailbox-list', {
        worker: 'worker-a',
      }, { store });
      expect(listed.ok).toBe(false);
      if (listed.ok) return;
      expect(listed.error.code).toBe('E_TEAM_MAILBOX_CORRUPT');
      expect(listed.error.details).toEqual(expect.objectContaining({ message_id: 'm-corrupt' }));
    } finally {
      fixture.cleanup();
    }
  });

  test('write-worker-inbox writes under team partition', async () => {
    const { fixture, store } = await fixtureStore();
    try {
      const written = await executeTeamApiOperation('write-worker-inbox', {
        worker: 'worker-1',
        content: '# inbox\nhello\n',
      }, { store });
      expect(written.ok).toBe(true);
      if (!written.ok) return;
      const target = written.data.path as string;
      expect(target.startsWith(store.teamDirectory())).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe('# inbox\nhello\n');
      expect(path.basename(target)).toBe('inbox.md');
    } finally {
      fixture.cleanup();
    }
  });

  test('CLI envelope includes schema_version + parse team api', async () => {
    const parsed = parseTeamCommand([
      'api', 'send-message', '--input', '{"team_name":"alpha","from_worker":"a","to_worker":"b","body":"x"}', '--json',
    ]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toEqual({
      kind: 'api',
      operation: 'send-message',
      inputJson: '{"team_name":"alpha","from_worker":"a","to_worker":"b","body":"x"}',
      json: true,
    });

    const { fixture, store } = await fixtureStore();
    try {
      const result = await executeTeamApiOperation('get-summary', {}, { store });
      const envelope = wrapTeamApiCliEnvelope(result, { timestamp: '2026-07-24T00:00:00.000Z' });
      expect(envelope).toEqual(expect.objectContaining({
        schema_version: 1,
        timestamp: '2026-07-24T00:00:00.000Z',
        command: 'team api',
        ok: true,
        operation: 'get-summary',
      }));
      expect(envelope.data).toBeDefined();
    } finally {
      fixture.cleanup();
    }
  });

  test('path-traversal message_id rejected on send-message', async () => {
    const { fixture, store } = await fixtureStore();
    try {
      const sent = await executeTeamApiOperation('send-message', {
        from_worker: 'leader',
        to_worker: 'worker-a',
        body: 'escape attempt',
        message_id: '../outside',
        expected_revision: 0,
      }, { store, nowMs: 3_000 });
      expect(sent.ok).toBe(false);
      if (!sent.ok) {
        expect(sent.error.code).toBe('E_TEAM_API_INVALID_INPUT');
        expect(sent.error.details).toEqual(expect.objectContaining({ message_id: '../outside' }));
      }
      const bodiesDir = path.join(store.teamDirectory(), 'mailbox-bodies');
      expect(fs.existsSync(path.join(bodiesDir, '..', 'outside.txt'))).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test('send-message rejects generation without claim_token', async () => {
    const { fixture, store } = await fixtureStore();
    try {
      const claimed = await store.claimTask('first', 'worker-1', 0, 1_000, 5_000, 'claim-1');
      if (!claimed.ok) throw new Error(claimed.error.message);

      const sent = await executeTeamApiOperation('send-message', {
        from_worker: 'leader',
        to_worker: 'first',
        body: 'no claim',
        message_id: 'ord-noclaim',
        generation: 1,
        expected_revision: claimed.value.revision,
      }, { store, nowMs: 3_100 });
      expect(sent.ok).toBe(false);
      if (!sent.ok) expect(sent.error.code).toBe('E_TEAM_API_INVALID_INPUT');
    } finally {
      fixture.cleanup();
    }
  });

  test('second ordered mark-delivered with claim still works after cursor advance', async () => {
    const { fixture, store } = await fixtureStore();
    try {
      const claimed = await store.claimTask('first', 'worker-1', 0, 1_000, 5_000, 'claim-1');
      if (!claimed.ok) throw new Error(claimed.error.message);
      const binding: WorkerAuthorityBindingV1 = {
        schemaVersion: 1,
        taskId: 'first',
        claimTokenDigest: sha256('claim-1'),
        generation: 1,
        provider: 'agy_headless',
        providerReceiptHash: sha256('provider-1'),
        process: { pid: 42, startMarker: 'start-1' },
        state: 'claimed',
        transitionSequence: 0,
        boundAtMs: 1_000,
      };
      const bound = await store.bindWorkerAuthority(claimed.value.revision, 'claim-1', binding);
      if (!bound.ok) throw new Error(bound.error.message);

      let revision = bound.value.revision;
      for (const [index, messageId] of ['ord-a', 'ord-b'].entries()) {
        const sent = await executeTeamApiOperation('send-message', {
          from_worker: 'leader',
          to_worker: 'first',
          body: `ordered-${index + 1}`,
          message_id: messageId,
          generation: 1,
          claim_token: 'claim-1',
          expected_revision: revision,
        }, { store, nowMs: 1_100 + index * 100 });
        expect(sent.ok).toBe(true);
        if (!sent.ok) return;
        revision = sent.data.revision as number;

        const marked = await executeTeamApiOperation('mailbox-mark-delivered', {
          worker: 'first',
          message_id: messageId,
          claim_token: 'claim-1',
          generation: 1,
          expected_revision: revision,
        }, { store, nowMs: 1_300 + index * 100 });
        expect(marked.ok).toBe(true);
        if (!marked.ok) return;
        revision = marked.data.revision as number;
      }

      const snap = store.read();
      expect(snap.ok).toBe(true);
      if (snap.ok) {
        expect(snap.value.value.mailboxCursors?.first?.cursor).toBe(2);
        expect(snap.value.value.mailbox['ord-a']?.deliveredAtMs).toBeDefined();
        expect(snap.value.value.mailbox['ord-b']?.deliveredAtMs).toBeDefined();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('teamCommand rejects malformed team_name with path traversal', async () => {
    const fixture = GitFixture.create();
    try {
      let stdout = '';
      let stderr = '';
      const context: RuntimeContext = {
        stateRoot: fixture.stateRoot,
        workspaceRoot: fixture.repo,
        repoKey: 'repo-key',
        workspaceKey: 'workspace-key',
        tokenFactory: () => 'cli-token',
      };
      const code = await teamCommand([
        'api', 'get-summary',
        '--input', JSON.stringify({ team_name: '../escape' }),
        '--json',
      ], {
        context,
        stdout: (value) => { stdout += value; },
        stderr: (value) => { stderr += value; },
      });
      expect(stderr).toBe('');
      expect(code).toBe(2);
      const payload = JSON.parse(stdout);
      expect(payload.ok).toBe(false);
      expect(payload.error.code).toBe('E_TEAM_API_INVALID_INPUT');
      expect(payload.error.details).toEqual(expect.objectContaining({ team_name: '../escape' }));
    } finally {
      fixture.cleanup();
    }
  });

  test('teamCommand api path returns structured JSON', async () => {
    const { fixture, store } = await fixtureStore();
    try {
      // touch store so aggregate exists for context keys
      expect(store.read().ok).toBe(true);
      let stdout = '';
      let stderr = '';
      const context: RuntimeContext = {
        stateRoot: fixture.stateRoot,
        workspaceRoot: fixture.repo,
        repoKey: 'repo-key',
        workspaceKey: 'workspace-key',
        tokenFactory: () => 'cli-token',
      };
      const code = await teamCommand([
        'api', 'get-summary',
        '--input', JSON.stringify({ team_name: 'alpha' }),
        '--json',
      ], {
        context,
        stdout: (value) => { stdout += value; },
        stderr: (value) => { stderr += value; },
      });
      expect(stderr).toBe('');
      expect(code).toBe(0);
      const payload = JSON.parse(stdout);
      expect(payload.ok).toBe(true);
      expect(payload.operation).toBe('get-summary');
      expect(payload.schema_version).toBe(1);
      expect(payload.data.team_id).toBe('alpha');
    } finally {
      fixture.cleanup();
    }
  });
});
