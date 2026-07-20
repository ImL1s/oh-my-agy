import * as fs from 'fs';
import * as path from 'path';
import { sha256 } from '../../src/runtime/atomic';
import { createDeliveryEvidence, DeliveryValidator } from '../../src/team/delivery';
import { IntegrationManager, readIntegrationTransaction } from '../../src/team/integration';
import { FastForwardPublisherV1 } from '../../src/team/publisher';
import { validateTeamManifest } from '../../src/team/manifest';
import { GitWorktreeManager } from '../../src/team/worktree';
import { CanonicalTeamTaskV1 } from '../../src/team/types';
import { GitFixture } from '../helpers/git-fixture';

function task(scope: string): CanonicalTeamTaskV1 {
  return {
    id: 'task-a', dependencies: [], write_scope: [{ kind: 'dir', path: scope }], mode: 'headless',
    verification: { version: 1, commands: [], requiredArtifacts: [] },
  };
}

describe('delivery and guarded temporary integration', () => {
  let fixture: GitFixture;

  beforeEach(() => { fixture = GitFixture.create(); });
  afterEach(() => fixture.cleanup());

  function worker() {
    const manager = new GitWorktreeManager(fixture.repo, fixture.managedWorktreesRoot);
    const created = manager.create({
      teamId: 'alpha', workerId: 'worker-a', generation: 1, branchName: `oma-team/alpha/worker-${Date.now()}`,
      baseSha: fixture.head(), ownerNonce: 'owner-a',
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  }

  function evidenceFor(worktree: ReturnType<typeof worker>, baseSha: string, commits: string[]) {
    const created = createDeliveryEvidence({
      taskId: 'task-a', taskRevision: 1, manifestRevision: 1, claimToken: 'claim-a', generation: 1,
      baseSha, orderedCommits: commits, headSha: commits[commits.length - 1], commandEvidenceIds: [],
      workerWorkspaceKey: worktree.identity.workspaceKey, workerWorktreeRealpath: worktree.path,
    });
    if (!created.ok) throw new Error(created.error.message);
    return created.value;
  }

  test('TEAM-13D validates linear commits and rejects an out-of-scope tree diff', () => {
    const managed = worker();
    const base = managed.baseSha;
    const first = fixture.commitFile('src/inside.txt', 'inside\n', 'inside', managed.path);
    const validEvidence = evidenceFor(managed, base, [first]);
    const valid = new DeliveryValidator().validate(validEvidence, {
      task: task('src'), currentTaskRevision: 1, manifestRevision: 1, claimToken: 'claim-a', generation: 1,
      completedDependencies: new Set(), commandEvidenceIds: new Set(),
    });
    expect(valid.ok).toBe(true);

    const second = fixture.commitFile('outside.txt', 'outside\n', 'outside', managed.path);
    const escaped = new DeliveryValidator().validate(evidenceFor(managed, base, [first, second]), {
      task: task('src'), currentTaskRevision: 1, manifestRevision: 1, claimToken: 'claim-a', generation: 1,
      completedDependencies: new Set(), commandEvidenceIds: new Set(),
    });
    expect(escaped.ok).toBe(false);
    if (!escaped.ok) expect(escaped.error.code).toBe('E_DELIVERY_SCOPE_VIOLATION');
  });

  test('TEAM-15 publishes only after full temporary verification and exact readback', async () => {
    const managed = worker();
    const commit = fixture.commitFile('src/feature.txt', 'feature\n', 'feature', managed.path);
    const validated = new DeliveryValidator().validate(evidenceFor(managed, managed.baseSha, [commit]), {
      task: task('src'), currentTaskRevision: 1, manifestRevision: 1, claimToken: 'claim-a', generation: 1,
      completedDependencies: new Set(), commandEvidenceIds: new Set(),
    });
    if (!validated.ok) throw new Error(validated.error.message);
    const leaderBefore = fixture.head();
    const prepared = new IntegrationManager(fixture.managedWorktreesRoot).prepare({
      leaderRepo: fixture.repo, stateRevision: 7, ownerNonce: 'owner-a', delivery: validated.value,
    });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(fixture.head()).toBe(leaderBefore);
    expect(prepared.value.publishPhase).toBe('temporary_verified');

    const published = await new FastForwardPublisherV1().publishCheckedOutRef(prepared.value);
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.value.publishPhase).toBe('readback_verified');
    expect(fixture.head()).toBe(published.value.integrationTip);
    expect(fs.readFileSync(path.join(fixture.repo, 'src/feature.txt'), 'utf8')).toBe('feature\n');
    expect(fixture.git(['status', '--porcelain=v1', '--untracked-files=all']).stdout).toBe('');
  });

  test('TEAM-16F rejects a same-OID symbolic branch switch without moving either ref', async () => {
    const managed = worker();
    const commit = fixture.commitFile('src/feature.txt', 'feature\n', 'feature', managed.path);
    const validated = new DeliveryValidator().validate(evidenceFor(managed, managed.baseSha, [commit]), {
      task: task('src'), currentTaskRevision: 1, manifestRevision: 1, claimToken: 'claim-a', generation: 1,
      completedDependencies: new Set(), commandEvidenceIds: new Set(),
    });
    if (!validated.ok) throw new Error(validated.error.message);
    const prepared = new IntegrationManager(fixture.managedWorktreesRoot).prepare({
      leaderRepo: fixture.repo, stateRevision: 7, ownerNonce: 'owner-a', delivery: validated.value,
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const oldOid = fixture.head();
    fixture.git(['branch', 'other', oldOid]);
    fixture.git(['switch', 'other']);
    const rejected = await new FastForwardPublisherV1().publishCheckedOutRef(prepared.value);
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.code).toBe('E_TARGET_REF_CHANGED');
    expect(fixture.head()).toBe(oldOid);
    expect(fixture.git(['rev-parse', 'refs/heads/main']).stdout.trim()).toBe(oldOid);
    expect(fixture.git(['rev-parse', 'refs/heads/other']).stdout.trim()).toBe(oldOid);
  });

  test('TEAM-16C refuses dirty leader and guarded old-OID races', async () => {
    const managed = worker();
    const commit = fixture.commitFile('src/feature.txt', 'feature\n', 'feature', managed.path);
    const validated = new DeliveryValidator().validate(evidenceFor(managed, managed.baseSha, [commit]), {
      task: task('src'), currentTaskRevision: 1, manifestRevision: 1, claimToken: 'claim-a', generation: 1,
      completedDependencies: new Set(), commandEvidenceIds: new Set(),
    });
    if (!validated.ok) throw new Error(validated.error.message);
    const prepared = new IntegrationManager(fixture.managedWorktreesRoot).prepare({
      leaderRepo: fixture.repo, stateRevision: 7, ownerNonce: 'owner-a', delivery: validated.value,
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    fs.writeFileSync(path.join(fixture.repo, 'dirty.txt'), 'user work\n');
    const dirty = await new FastForwardPublisherV1().publishCheckedOutRef(prepared.value);
    expect(dirty.ok).toBe(false);
    if (!dirty.ok) expect(dirty.error.code).toBe('E_LEADER_WORKTREE_CHANGED');
    expect(fs.readFileSync(path.join(fixture.repo, 'dirty.txt'), 'utf8')).toBe('user work\n');
  });

  test('TEAM-16E recovers a ref-published crash only from the same journaled transaction', async () => {
    const managed = worker();
    const commit = fixture.commitFile('src/feature.txt', 'feature\n', 'feature', managed.path);
    const validated = new DeliveryValidator().validate(evidenceFor(managed, managed.baseSha, [commit]), {
      task: task('src'), currentTaskRevision: 1, manifestRevision: 1, claimToken: 'claim-a', generation: 1,
      completedDependencies: new Set(), commandEvidenceIds: new Set(),
    });
    if (!validated.ok) throw new Error(validated.error.message);
    const prepared = new IntegrationManager(fixture.managedWorktreesRoot).prepare({
      leaderRepo: fixture.repo, stateRevision: 7, ownerNonce: 'owner-a', delivery: validated.value,
    });
    if (!prepared.ok) throw new Error(prepared.error.message);
    const crashed = await new FastForwardPublisherV1({ afterRefPublished: () => { throw new Error('simulated crash'); } })
      .publishCheckedOutRef(prepared.value);
    expect(crashed.ok).toBe(false);
    const journaled = readIntegrationTransaction(prepared.value.journalPath);
    expect(journaled.publishPhase).toBe('ref_published');
    const recovered = await new FastForwardPublisherV1().recover(journaled);
    expect(recovered.ok).toBe(true);
    if (recovered.ok) expect(recovered.value.publishPhase).toBe('readback_verified');
  });
});

