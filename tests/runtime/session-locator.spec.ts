import {
  SessionLocator,
  reconcileNativeConversationReceipt,
} from '../../src/continuation/state';
import { SessionAggregateStore, sessionAggregatePath } from '../../src/continuation/session-aggregate';
import { createStateFixture } from '../helpers/state-fixture';

describe('generation-aware SessionLocator contract', () => {
  test('missing exact env fails open without mutation; resume increments generation', async () => {
    const fixture = createStateFixture('oma-locator-');
    const locator = new SessionLocator(fixture.root, 'workspace-A', {
      now: () => 1_000,
      nonceFactory: () => 'resume-nonce',
      processLiveness: () => 'alive',
    });
    try {
      const pending = await locator.createPending({
        sessionId: 'session-1',
        repoKey: null,
        workspaceKey: 'workspace-A',
        workspacePath: '/workspace/a',
        launchNonce: 'launch-nonce',
        owner: { pid: process.pid, startMarker: 'fixture' },
        ttlMs: 30_000,
      });
      expect(pending).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ revision: 0, invocationGeneration: 1 }),
      }));

      const missing = await locator.bindPreInvocation({
        conversationId: 'conversation-1',
        workspaceKeys: ['workspace-A'],
      }, undefined);
      expect(missing).toEqual(expect.objectContaining({
        kind: 'AllowDiagnostic',
        error: expect.objectContaining({ code: 'E_BINDING_ENV_MISSING' }),
      }));

      if (!pending.ok) return;
      expect(locator.managedLaunch(pending.value).recordChildSpawned({
        pid: 41,
        parentPid: process.pid,
        startMarker: 'child-fixture',
      }).ok).toBe(true);

      const bound = await locator.bindPreInvocation({
        conversationId: 'conversation-1',
        workspaceKeys: ['workspace-A'],
      }, {
        OMA_SESSION_ID: 'session-1',
        OMA_LAUNCH_NONCE: 'launch-nonce',
        OMA_INVOCATION_GENERATION: '1',
      });
      expect(bound).toEqual(expect.objectContaining({
        kind: 'BoundExactEnv',
        session: expect.objectContaining({ revision: 1, invocationGeneration: 1 }),
      }));
      expect(locator.resolveStop({
        conversationId: 'conversation-1',
        invocationGeneration: 1,
        workspaceKeys: ['workspace-A'],
      }).kind).toBe('ExactBoundSession');

      const resumed = await locator.prepareResume('conversation-1', 1);
      expect(resumed).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          revision: 2,
          invocationGeneration: 2,
          launchNonce: 'resume-nonce',
          state: 'resume_pending',
        }),
      }));
      expect(locator.resolveStop({
        conversationId: 'conversation-1',
        invocationGeneration: 1,
        workspaceKeys: ['workspace-A'],
      })).toEqual(expect.objectContaining({ kind: 'AllowDiagnostic' }));
    } finally {
      fixture.cleanup();
    }
  });

  test('child-runs-first race waits for durable spawn evidence before binding', async () => {
    const fixture = createStateFixture('oma-locator-handshake-');
    const locator = new SessionLocator(fixture.root, 'workspace-A', {
      now: () => 1_000,
      processLiveness: () => 'alive',
      childSpawnWaitMs: 500,
      childSpawnPollMs: 5,
    });
    try {
      const created = await locator.createManagedLaunch({
        sessionId: 'race-session',
        repoKey: null,
        workspaceKey: 'workspace-A',
        workspacePath: '/workspace/a',
        launchNonce: 'race-nonce',
        owner: { pid: process.pid, startMarker: 'fixture', ownerNonce: 'owner' },
        ttlMs: 30_000,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const before = new SessionAggregateStore(sessionAggregatePath(
        fixture.root, 'workspace-A', 'race-session',
      )).read();
      expect(before.ok && before.value.revision).toBe(0);

      const binding = locator.bindPreInvocation({
        conversationId: 'race-conversation', workspaceKeys: ['workspace-A'],
      }, created.value.transaction.env);
      setTimeout(() => {
        const recorded = created.value.transaction.recordChildSpawned({
          pid: 42,
          parentPid: process.pid,
          startMarker: 'child-race',
          ownerNonce: 'owner',
        });
        expect(recorded.ok).toBe(true);
      }, 30);
      await expect(binding).resolves.toEqual(expect.objectContaining({ kind: 'BoundExactEnv' }));
    } finally {
      fixture.cleanup();
    }
  });

  test('ordinary or missing-handshake invocation fails open without consuming pending state', async () => {
    const fixture = createStateFixture('oma-locator-unmanaged-');
    const locator = new SessionLocator(fixture.root, 'workspace-A', {
      now: () => 1_000,
      processLiveness: () => 'alive',
      childSpawnWaitMs: 15,
      childSpawnPollMs: 2,
    });
    try {
      const pending = await locator.createPending({
        sessionId: 'pending', repoKey: null, workspaceKey: 'workspace-A',
        workspacePath: '/workspace/a', launchNonce: 'nonce',
        owner: { pid: process.pid, startMarker: 'fixture' }, ttlMs: 30_000,
      });
      expect(pending.ok).toBe(true);
      const unmanaged = await locator.bindPreInvocation({
        conversationId: 'ordinary', workspaceKeys: ['workspace-A'],
      }, undefined);
      expect(unmanaged).toEqual(expect.objectContaining({
        kind: 'AllowDiagnostic', error: expect.objectContaining({ code: 'E_BINDING_ENV_MISSING' }),
      }));
      const earlyManaged = await locator.bindPreInvocation({
        conversationId: 'managed', workspaceKeys: ['workspace-A'],
      }, {
        OMA_SESSION_ID: 'pending', OMA_LAUNCH_NONCE: 'nonce', OMA_INVOCATION_GENERATION: '1',
      });
      expect(earlyManaged).toEqual(expect.objectContaining({
        kind: 'AllowDiagnostic', error: expect.objectContaining({ code: 'E_RETRYABLE_BLOCKER' }),
      }));
      const state = new SessionAggregateStore(sessionAggregatePath(
        fixture.root, 'workspace-A', 'pending',
      )).read();
      expect(state).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          revision: 0,
          binding: expect.objectContaining({ state: 'launch_pending', conversationId: null }),
        }),
      }));
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects a second live pending launch in the same workspace', async () => {
    const fixture = createStateFixture('oma-locator-single-pending-');
    const locator = new SessionLocator(fixture.root, 'workspace-A', {
      now: () => 1_000,
      processLiveness: () => 'alive',
    });
    const base = {
      repoKey: null,
      workspaceKey: 'workspace-A',
      workspacePath: '/workspace/a',
      owner: { pid: process.pid, startMarker: 'fixture' },
      ttlMs: 30_000,
    };
    try {
      expect((await locator.createPending({
        ...base, sessionId: 'one', launchNonce: 'one',
      })).ok).toBe(true);
      expect(await locator.createPending({
        ...base, sessionId: 'two', launchNonce: 'two',
      })).toEqual(expect.objectContaining({
        ok: false, error: expect.objectContaining({ code: 'E_PENDING_LAUNCH_EXISTS' }),
      }));
    } finally {
      fixture.cleanup();
    }
  });
});

describe('native receipt cardinality and imported-carrier boundary', () => {
  const receipt = (hash: string, generation = 2) => ({
    store_kind: 'antigravity_native_receipt' as const,
    schema_version: 1 as const,
    provider: 'antigravity_native' as const,
    run_id: 'run', parent_conversation_id: 'parent', child_conversation_id: `child-${hash[0]}`,
    task_id: 'task', generation, receipt_hash: hash.repeat(64),
  });
  const imported = {
    kind: 'imported_carrier' as const,
    carrier: {
      source: 'typed' as const, role: 'executor', token: 'a'.repeat(32),
      native_authority: false as const, imported_only: true as const,
    },
  };
  const expected = { runId: 'run', taskId: 'task', generation: 2, parentConversationId: 'parent' };

  test('zero native receipts remains unbound even with imported provenance', () => {
    expect(reconcileNativeConversationReceipt([imported], expected)).toEqual(expect.objectContaining({
      ok: false, error: expect.objectContaining({ code: 'E_CONVERSATION_UNBOUND' }),
    }));
  });

  test('one exact receipt binds; stale and many receipts fail closed', () => {
    expect(reconcileNativeConversationReceipt([
      imported, { kind: 'antigravity_native_receipt', receipt: receipt('a') },
    ], expected)).toEqual(expect.objectContaining({
      ok: true, value: expect.objectContaining({ receipt_hash: 'a'.repeat(64) }),
    }));
    expect(reconcileNativeConversationReceipt([
      { kind: 'antigravity_native_receipt', receipt: receipt('a', 1) },
    ], expected)).toEqual(expect.objectContaining({
      ok: false, error: expect.objectContaining({ code: 'E_INVOCATION_GENERATION_MISMATCH' }),
    }));
    expect(reconcileNativeConversationReceipt([
      { kind: 'antigravity_native_receipt', receipt: receipt('a') },
      { kind: 'antigravity_native_receipt', receipt: receipt('b') },
    ], expected)).toEqual(expect.objectContaining({
      ok: false, error: expect.objectContaining({ code: 'E_BINDING_CONFLICT' }),
    }));
  });
});
