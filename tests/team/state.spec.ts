import { sha256 } from '../../src/runtime/atomic';
import { TeamStateStore } from '../../src/team/state';
import { validateTeamManifest } from '../../src/team/manifest';
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

describe('Team state, claims, heartbeat, progress, and mailbox', () => {
  let fixture: GitFixture;
  let store: TeamStateStore;

  beforeEach(async () => {
    fixture = GitFixture.create();
    const manifest = validateTeamManifest(rawManifest(), fixture.repo);
    if (!manifest.ok) throw new Error(manifest.error.message);
    store = new TeamStateStore(fixture.stateRoot, 'repo-key', 'workspace-key', 'alpha');
    const created = await store.create(manifest.value, 'owner-nonce');
    if (!created.ok) throw new Error(created.error.message);
  });

  afterEach(() => fixture.cleanup());

  test('TEAM-13C blocks claims until dependencies are completed', async () => {
    const blocked = await store.claimTask('second', 'worker-2', 0, 1000, 5_000, 'claim-2');
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error.code).toBe('E_TASK_DEPENDENCY_BLOCKED');

    const first = await store.claimTask('first', 'worker-1', 0, 1000, 5_000, 'claim-1');
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const completed = await store.completeReadOnlyTask('first', first.value.revision, 'claim-1', 1, sha256('read-only-artifact'));
    expect(completed.ok).toBe(true);
    if (!completed.ok) return;
    expect((await store.claimTask('second', 'worker-2', completed.value.revision, 2000, 5_000, 'claim-2')).ok).toBe(true);
  });

  test('TEAM-05/06 heartbeat does not renew claims but valid progress does', async () => {
    const claimed = await store.claimTask('first', 'worker-1', 0, 1000, 1_000, 'claim-1');
    if (!claimed.ok) throw new Error(claimed.error.message);
    const heartbeat = await store.recordHeartbeat(claimed.value.revision, {
      schemaVersion: 1,
      workerId: 'worker-1', ownerNonce: 'owner-nonce', workerNonce: 'worker-nonce', paneId: '%1',
      process: { pid: 123, startMarker: 'start' }, recordedAtMs: 1500,
    });
    if (!heartbeat.ok) throw new Error(heartbeat.error.message);
    expect(heartbeat.value.value.tasks.first.claim?.leasedUntilMs).toBe(2000);

    const progress = await store.recordProgress(heartbeat.value.revision, {
      schemaVersion: 1, taskId: 'first', taskRevision: heartbeat.value.value.tasks.first.revision, claimToken: 'claim-1', generation: 1,
      kind: 'artifact', artifactDigest: sha256('artifact'), child: { pid: 123, startMarker: 'start' }, recordedAtMs: 1600,
    }, 5_000);
    if (!progress.ok) throw new Error(progress.error.message);
    expect(progress.value.value.tasks.first.claim?.leasedUntilMs).toBe(6600);
  });

  test('retireAfterCleanup is CAS-fenced, owner-bound, and idempotent', async () => {
    const retired = await store.retireAfterCleanup({
      expectedRevision: 0,
      ownerNonce: 'owner-nonce',
      dropMailboxIds: [],
      nowMs: 9,
    });
    expect(retired.ok).toBe(true);
    if (!retired.ok) return;
    expect(retired.value.value.retired).toBe(true);
    expect(retired.value.value.retiredAtMs).toBe(9);
    expect(retired.value.revision).toBe(1);

    const replay = await store.retireAfterCleanup({
      expectedRevision: retired.value.revision,
      ownerNonce: 'owner-nonce',
      dropMailboxIds: [],
      nowMs: 10,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.revision).toBe(retired.value.revision);
    expect(replay.value.value.retiredAtMs).toBe(9);

    const cas = await store.retireAfterCleanup({
      expectedRevision: 0,
      ownerNonce: 'owner-nonce',
      dropMailboxIds: [],
      nowMs: 11,
    });
    expect(cas.ok).toBe(false);
    if (cas.ok) return;
    expect(cas.error.code).toBe('E_REVISION_CONFLICT');

    const owner = await store.retireAfterCleanup({
      expectedRevision: retired.value.revision,
      ownerNonce: 'foreign',
      dropMailboxIds: [],
      nowMs: 12,
    });
    expect(owner.ok).toBe(false);
    if (owner.ok) return;
    expect(owner.error.code).toBe('E_LOCK_NOT_OWNER');
  });

  test('retireAfterCleanup drops mailbox index entries', async () => {
    const sent = await store.sendMailbox(0, {
      schemaVersion: 1,
      id: 'm-drop',
      sender: 'leader',
      recipient: 'first',
      bodyDigest: sha256('x'),
      createdAtMs: 1,
    });
    if (!sent.ok) throw new Error(sent.error.message);
    const retired = await store.retireAfterCleanup({
      expectedRevision: sent.value.revision,
      ownerNonce: 'owner-nonce',
      dropMailboxIds: ['m-drop'],
      nowMs: 5,
    });
    expect(retired.ok).toBe(true);
    if (!retired.ok) return;
    expect(retired.value.value.mailbox['m-drop']).toBeUndefined();
    expect(retired.value.value.retired).toBe(true);
  });

  test('TEAM-10 mailbox IDs are idempotent and recipient reads are isolated', async () => {
    const first = await store.sendMailbox(0, {
      schemaVersion: 1, id: 'm1', sender: 'leader', recipient: 'worker-a', bodyDigest: sha256('a'), createdAtMs: 1,
    });
    if (!first.ok) throw new Error(first.error.message);
    const replay = await store.sendMailbox(first.value.revision, {
      schemaVersion: 1, id: 'm1', sender: 'leader', recipient: 'worker-a', bodyDigest: sha256('a'), createdAtMs: 1,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.revision).toBe(first.value.revision);
    expect(store.mailboxFor('worker-a')).toHaveLength(1);
    expect(store.mailboxFor('worker-b')).toHaveLength(0);
  });
});
