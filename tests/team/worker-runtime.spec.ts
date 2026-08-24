import * as fs from 'fs';
import * as path from 'path';
import { sha256 } from '../../src/runtime/atomic';
import { executeTeamApiOperation } from '../../src/team/api-interop';
import { parseTeamCommand, teamCommand } from '../../src/team/commands';
import { TeamStateStore } from '../../src/team/state';
import {
  CanonicalTeamManifestV1,
  CanonicalTeamTaskV1,
  WorkerAuthorityBindingV1,
} from '../../src/team/types';
import { GitWorktreeManager } from '../../src/team/worktree';
import { TeamWorkerRuntimeHost, runTeamWorker } from '../../src/team/worker-runtime';
import { runWorkerProtocolLoop } from '../../src/team/worker-loop';
import { createStateFixture } from '../helpers/state-fixture';
import { GitFixture } from '../helpers/git-fixture';

const PROCESS = { pid: 123, startMarker: 'start-1' };

function writableTask(overrides: Partial<CanonicalTeamTaskV1> = {}): CanonicalTeamTaskV1 {
  return {
    id: 'task',
    dependencies: [],
    mode: 'headless',
    write_scope: [{ kind: 'dir', path: 'src' }],
    verification: { version: 1, commands: [], requiredArtifacts: [] },
    ...overrides,
  };
}

function manifestFor(task: CanonicalTeamTaskV1, teamId = 'alpha'): CanonicalTeamManifestV1 {
  return {
    schema: 'oma.team-manifest/v1',
    teamId,
    revision: 1,
    repoRoot: '/tmp',
    tasks: [task],
  };
}

function mailboxCursor(store: TeamStateStore): number | undefined {
  const snapshot = store.read();
  if (!snapshot.ok) return undefined;
  return snapshot.value.value.mailboxCursors?.task.cursor;
}

function binding(generation = 1): WorkerAuthorityBindingV1 {
  return {
    schemaVersion: 1,
    taskId: 'task',
    claimTokenDigest: sha256(`claim-${generation}`),
    generation,
    provider: 'agy_headless',
    providerReceiptHash: sha256(`provider-${generation}`),
    process: PROCESS,
    state: 'claimed',
    transitionSequence: 0,
    boundAtMs: 100,
  };
}

async function claimedBoundStore(task: CanonicalTeamTaskV1 = writableTask()) {
  const fixture = createStateFixture('oma-worker-runtime-');
  const store = new TeamStateStore(fixture.root, 'repo', 'workspace', 'alpha');
  const created = await store.create(manifestFor(task), 'owner');
  if (!created.ok) throw new Error(created.error.message);
  const claimed = await store.claimTask('task', 'worker', created.value.revision, 100, 50_000, 'claim-1');
  if (!claimed.ok) throw new Error(claimed.error.message);
  const bound = await store.bindWorkerAuthority(claimed.value.revision, 'claim-1', binding());
  if (!bound.ok) throw new Error(bound.error.message);
  const host = new TeamWorkerRuntimeHost({
    store,
    teamId: 'alpha',
    taskId: 'task',
    claimToken: 'claim-1',
    generation: 1,
    worktreePath: fixture.root,
    processMarker: PROCESS,
    nowMs: () => 1_000,
  });
  return { fixture, store, host, revision: bound.value.revision };
}

describe('team worker runtime host (real TeamStateStore)', () => {
  test('parseTeamCommand accepts worker run fencing flags and rejects incomplete argv', () => {
    expect(parseTeamCommand([
      'worker', 'run', '--team', 'alpha', '--task', 'task', '--claim-token', 'tok', '--generation', '2',
    ])).toEqual({
      ok: true,
      value: {
        kind: 'worker-run',
        teamId: 'alpha',
        taskId: 'task',
        claimToken: 'tok',
        generation: 2,
      },
    });
    expect(parseTeamCommand(['worker', 'run', '--team', 'alpha', '--task', 'task']).ok).toBe(false);
    expect(parseTeamCommand(['worker', 'own', '--team', 'alpha']).ok).toBe(false);
  });

  test('advances claimed → launched → running → verifying → delivery_ready in program order', async () => {
    const { fixture, store, host } = await claimedBoundStore();
    try {
      expect((await host.transition('claimed', 'launched')).ok).toBe(true);
      const launched = store.read();
      expect(launched.ok).toBe(true);
      if (launched.ok) expect(launched.value.value.workerBindings?.task.state).toBe('launched');
      expect((await host.heartbeat()).ok).toBe(true);
      expect((await host.transition('launched', 'running')).ok).toBe(true);
      expect((await host.transition('running', 'verifying')).ok).toBe(true);
      expect((await host.transition('verifying', 'delivery_ready')).ok).toBe(true);
      const ready = store.read();
      expect(ready.ok).toBe(true);
      if (ready.ok) {
        expect(ready.value.value.workerBindings?.task.state).toBe('delivery_ready');
        expect(ready.value.value.workerBindings?.task.transitionSequence).toBe(4);
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('rejects out-of-order authority transitions without advancing state', async () => {
    const { fixture, store, host } = await claimedBoundStore();
    try {
      const before = store.read();
      if (!before.ok) throw new Error(before.error.message);
      const skipped = await host.transition('running', 'verifying');
      expect(skipped.ok).toBe(false);
      if (!skipped.ok) expect(skipped.error.code).toBe('E_REVISION_CONFLICT');
      const after = store.read();
      if (!after.ok) throw new Error(after.error.message);
      expect(after.value.revision).toBe(before.value.revision);
      expect(after.value.value.workerBindings?.task.state).toBe('claimed');
    } finally {
      fixture.cleanup();
    }
  });

  test('missing verification evidence rejects delivery with E_DELIVERY_UNINTEGRATED', async () => {
    const { fixture, host, store } = await claimedBoundStore(writableTask({
      verification: {
        version: 1,
        commands: [{
          command: 'node', argv: ['-e', 'process.exit(0)'], cwd: '.', deadlineMs: 5_000, expectedExit: 0,
        }],
        requiredArtifacts: [],
      },
    }));
    try {
      const before = store.read();
      if (!before.ok) throw new Error(before.error.message);
      const delivery = await host.createImmutableDelivery();
      expect(delivery.ok).toBe(false);
      if (!delivery.ok) {
        expect(delivery.error.code).toBe('E_DELIVERY_UNINTEGRATED');
        expect(delivery.error.message).toContain('missing required verification command evidence');
      }
      const after = store.read();
      if (!after.ok) throw new Error(after.error.message);
      expect(after.value.revision).toBe(before.value.revision);
      expect(after.value.value.tasks.task.delivery).toBeUndefined();
    } finally {
      fixture.cleanup();
    }
  });

  test('mailbox cursor is monotonic and duplicate ack is idempotent', async () => {
    const { fixture, store, host } = await claimedBoundStore();
    try {
      const current = store.read();
      if (!current.ok) throw new Error(current.error.message);
      const first = await executeTeamApiOperation('send-message', {
        from_worker: 'leader',
        to_worker: 'task',
        body: 'one',
        message_id: 'm1',
        generation: 1,
        claim_token: 'claim-1',
        expected_revision: current.value.revision,
      }, { store, nowMs: 110 });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      const second = await executeTeamApiOperation('send-message', {
        from_worker: 'leader',
        to_worker: 'task',
        body: 'two',
        message_id: 'm2',
        generation: 1,
        claim_token: 'claim-1',
      }, { store, nowMs: 120 });
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      const listed = await host.listMailbox(0);
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.map((message) => [message.id, message.sequence])).toEqual([['m1', 1], ['m2', 2]]);
      const body = await host.readMailbox(listed.value[0]);
      expect(body.ok).toBe(true);
      if (body.ok) expect(body.value).toBe('one');

      expect((await host.acknowledgeMailbox(['m1'], 1)).ok).toBe(true);
      expect(mailboxCursor(store)).toBe(1);
      expect((await host.acknowledgeMailbox(['m1'], 1)).ok).toBe(true);
      expect(mailboxCursor(store)).toBe(1);

      const rewind = await host.acknowledgeMailbox(['m1'], 0);
      expect(rewind.ok).toBe(false);
      if (!rewind.ok) expect(rewind.error.code).toBe('E_REVISION_CONFLICT');
      expect(mailboxCursor(store)).toBe(1);

      expect((await host.acknowledgeMailbox(['m2'], 2)).ok).toBe(true);
      expect(mailboxCursor(store)).toBe(2);
    } finally {
      fixture.cleanup();
    }
  });

  test('bad claim-token or generation is E_REVISION_CONFLICT and writes nothing', async () => {
    const { fixture, store } = await claimedBoundStore();
    try {
      const before = store.read();
      if (!before.ok) throw new Error(before.error.message);
      const staleToken = new TeamWorkerRuntimeHost({
        store,
        teamId: 'alpha',
        taskId: 'task',
        claimToken: 'wrong-token',
        generation: 1,
        worktreePath: fixture.root,
        processMarker: PROCESS,
      });
      const staleGeneration = new TeamWorkerRuntimeHost({
        store,
        teamId: 'alpha',
        taskId: 'task',
        claimToken: 'claim-1',
        generation: 9,
        worktreePath: fixture.root,
        processMarker: PROCESS,
      });
      const tokenResult = await staleToken.heartbeat();
      const generationResult = await staleGeneration.listMailbox(0);
      expect(tokenResult.ok).toBe(false);
      expect(generationResult.ok).toBe(false);
      if (!tokenResult.ok) expect(tokenResult.error.code).toBe('E_REVISION_CONFLICT');
      if (!generationResult.ok) expect(generationResult.error.code).toBe('E_REVISION_CONFLICT');
      const after = store.read();
      if (!after.ok) throw new Error(after.error.message);
      expect(after.value.revision).toBe(before.value.revision);
      expect(after.value.value.heartbeats.task).toBeUndefined();
      expect(JSON.stringify(after.value.value)).toBe(JSON.stringify(before.value.value));
    } finally {
      fixture.cleanup();
    }
  });

  test('SIGTERM before CAS leaves the aggregate unchanged', async () => {
    const { fixture, store, host } = await claimedBoundStore();
    try {
      const before = store.read();
      if (!before.ok) throw new Error(before.error.message);
      host.interrupt();
      const heartbeat = await host.heartbeat();
      const moved = await host.transition('claimed', 'launched');
      expect(heartbeat.ok).toBe(false);
      expect(moved.ok).toBe(false);
      if (!heartbeat.ok) expect(heartbeat.error.code).toBe('E_TERMINAL_STATE');
      const after = store.read();
      if (!after.ok) throw new Error(after.error.message);
      expect(after.value.revision).toBe(before.value.revision);
      expect(after.value.value.workerBindings?.task.state).toBe('claimed');
    } finally {
      fixture.cleanup();
    }
  });

  test('oma team worker run fencing does not persist a CAS', async () => {
    const { fixture, store } = await claimedBoundStore();
    try {
      const before = store.read();
      if (!before.ok) throw new Error(before.error.message);
      let stderr = '';
      const code = await teamCommand([
        'worker', 'run', '--team', 'alpha', '--task', 'task', '--claim-token', 'stale', '--generation', '1',
      ], {
        context: {
          stateRoot: fixture.root,
          workspaceRoot: fixture.root,
          repoKey: 'repo',
          workspaceKey: 'workspace',
        },
        stdout: () => undefined,
        stderr: (value) => { stderr += value; },
      });
      expect(code).toBe(1);
      expect(stderr).toContain('E_REVISION_CONFLICT');
      const after = store.read();
      if (!after.ok) throw new Error(after.error.message);
      expect(after.value.revision).toBe(before.value.revision);
    } finally {
      fixture.cleanup();
    }
  });

  test('full protocol loop on a real store delivers only after verification evidence', async () => {
    const git = GitFixture.create();
    try {
      const task = writableTask({ id: 'task' });
      const store = new TeamStateStore(git.stateRoot, 'repo', 'workspace', 'alpha');
      const created = await store.create({
        ...manifestFor(task),
        repoRoot: git.repo,
      }, 'owner');
      if (!created.ok) throw new Error(created.error.message);
      const claimed = await store.claimTask('task', 'worker', created.value.revision, 100, 50_000, 'claim-1');
      if (!claimed.ok) throw new Error(claimed.error.message);
      const bound = await store.bindWorkerAuthority(claimed.value.revision, 'claim-1', binding());
      if (!bound.ok) throw new Error(bound.error.message);
      const worktrees = new GitWorktreeManager(git.repo, git.managedWorktreesRoot);
      const worktree = worktrees.create({
        teamId: 'alpha',
        workerId: 'task',
        generation: 1,
        branchName: `oma-team/alpha/task-g1-${Date.now()}`,
        baseSha: git.head(),
        ownerNonce: 'owner',
      });
      if (!worktree.ok) throw new Error(worktree.error.message);
      git.commitFile('src/result.txt', 'done\n', 'worker result', worktree.value.path);

      const sent = await executeTeamApiOperation('send-message', {
        from_worker: 'leader',
        to_worker: 'task',
        body: 'integrate',
        message_id: 'm1',
        generation: 1,
        claim_token: 'claim-1',
      }, { store, nowMs: 200 });
      expect(sent.ok).toBe(true);

      const host = new TeamWorkerRuntimeHost({
        store,
        teamId: 'alpha',
        taskId: 'task',
        claimToken: 'claim-1',
        generation: 1,
        worktreePath: worktree.value.path,
        leaderRepo: git.repo,
        managedWorktreesRoot: git.managedWorktreesRoot,
        processMarker: PROCESS,
        nowMs: () => 1_000,
        runVerification: async (argv) => ({
          ok: true,
          value: {
            argv,
            exitCode: 0,
            stdoutHash: sha256('stdout'),
            stderrHash: sha256('stderr'),
            artifactHash: sha256(argv.join(' ')),
          },
        }),
      });

      const result = await runWorkerProtocolLoop({
        store_kind: 'oma_worker_envelope',
        schema_version: 1,
        repository_id: 'OMA',
        run_id: 'alpha',
        team_id: 'alpha',
        task_id: 'task',
        task_text: 'Execute team task task',
        dependencies: [],
        write_scope: ['src'],
        verification_argv: [],
        artifact_contract: {
          proposal_root: 'artifacts/task',
          required_files: [],
          terminal_receipt_path: 'artifacts/task/terminal.json',
        },
        contributor_guidance_hashes: [],
        mailbox_cursor: 0,
        claim_id: sha256('claim-1'),
        generation: 1,
        state_endpoint: 'oma://team/alpha/task/task',
        cancellation_token_hash: sha256('claim-1'),
        provider: 'agy_headless',
        native_role: 'executor',
        capability_mode: 'read-write',
        deadline_ms: 30_000,
      }, host);
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error(result.error.message);
      expect(result.value).toMatchObject({
        outcome: 'completed',
        mailboxCursor: 1,
        commandCount: 0,
      });
      const finalState = store.read();
      if (!finalState.ok) throw new Error(finalState.error.message);
      expect(finalState.value.value.tasks.task.status).toBe('completed');
      expect(finalState.value.value.workerBindings?.task.state).toBe('terminal');
      expect(finalState.value.value.mailboxCursors?.task.cursor).toBe(1);
      expect(git.git(['status', '--porcelain=v1', '--untracked-files=all']).stdout).toBe('');
      expect(fs.readFileSync(path.join(git.repo, 'src/result.txt'), 'utf8')).toBe('done\n');
    } finally {
      git.cleanup();
    }
  });

  test('runTeamWorker fences before ensureBound so a bad token never binds', async () => {
    const { fixture, store } = await claimedBoundStore();
    try {
      const before = store.read();
      if (!before.ok) throw new Error(before.error.message);
      const result = await runTeamWorker({
        store,
        teamId: 'alpha',
        taskId: 'task',
        claimToken: 'nope',
        generation: 1,
        worktreePath: fixture.root,
        processMarker: PROCESS,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('E_REVISION_CONFLICT');
      const after = store.read();
      if (!after.ok) throw new Error(after.error.message);
      expect(after.value.revision).toBe(before.value.revision);
    } finally {
      fixture.cleanup();
    }
  });
});
