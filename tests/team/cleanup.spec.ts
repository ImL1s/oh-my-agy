import * as fs from 'fs';
import * as path from 'path';
import { CLI_HELP } from '../../src/cli/application';
import { sha256 } from '../../src/runtime/atomic';
import { isTeamCleanupTerminalStatus } from '../../src/team/cleanup';
import { parseTeamCommand, teamCommand } from '../../src/team/commands';
import { isTeamWaitTerminalStatus, TeamOrchestrator } from '../../src/team/orchestrator';
import { TeamStateStore } from '../../src/team/state';
import { CanonicalTeamManifestV1, RuntimeContext, TeamTaskStatus } from '../../src/team/types';
import { GitWorktreeManager, ManagedWorktreeV1 } from '../../src/team/worktree';
import { GitFixture } from '../helpers/git-fixture';

const OWNER_NONCE = 'owner-secret';
const TEAM_ID = 'alpha';

function cleanupManifest(taskIds: readonly string[]): CanonicalTeamManifestV1 {
  return {
    schema: 'oma.team-manifest/v1',
    teamId: TEAM_ID,
    revision: 1,
    repoRoot: '/tmp',
    tasks: taskIds.map((id) => ({
      id,
      dependencies: [],
      mode: 'read_only' as const,
      write_scope: 'none' as const,
      verification: { version: 1, commands: [], requiredArtifacts: [] },
    })),
  };
}

function gitSnapshot(fixture: GitFixture): string {
  return JSON.stringify({
    worktrees: fixture.git(['worktree', 'list', '--porcelain']).stdout,
    branches: fixture.git(['branch']).stdout,
  });
}

function mailboxSnapshot(store: TeamStateStore): string {
  const dir = path.join(store.teamDirectory(), 'mailbox-bodies');
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir).sort().map((name) => {
    const target = path.join(dir, name);
    const stat = fs.lstatSync(target);
    if (!stat.isFile()) return `${name}:dir`;
    return `${name}:${fs.readFileSync(target, 'utf8')}`;
  }).join('\n');
}

async function seedWorld(taskIds: readonly string[]) {
  const fixture = GitFixture.create();
  const store = new TeamStateStore(fixture.stateRoot, 'repo', 'workspace', TEAM_ID);
  const created = await store.create(cleanupManifest(taskIds), OWNER_NONCE);
  if (!created.ok) throw new Error(created.error.message);
  const manager = new GitWorktreeManager(fixture.repo, fixture.managedWorktreesRoot);
  const orch = new TeamOrchestrator({
    stateRoot: fixture.stateRoot,
    workspaceRoot: fixture.repo,
    repoKey: 'repo',
    workspaceKey: 'workspace',
    managedWorktreesRoot: fixture.managedWorktreesRoot,
    nowMs: () => 1_700_000_000_000,
  });
  const context: RuntimeContext = {
    stateRoot: fixture.stateRoot,
    workspaceRoot: fixture.repo,
    repoKey: 'repo',
    workspaceKey: 'workspace',
  };
  const aggregatePath = path.join(fixture.stateRoot, 'repositories', 'repo', 'teams', TEAM_ID, 'aggregate.json');
  return { fixture, store, manager, orch, context, aggregatePath };
}

function addWorktree(
  manager: GitWorktreeManager,
  fixture: GitFixture,
  taskId: string,
  generation = 1,
): ManagedWorktreeV1 {
  const created = manager.create({
    teamId: TEAM_ID,
    workerId: taskId,
    generation,
    branchName: `oma-team/${TEAM_ID}/${taskId}-g${generation}`,
    baseSha: fixture.head(),
    ownerNonce: OWNER_NONCE,
  });
  if (!created.ok) throw new Error(created.error.message);
  return created.value;
}

function writeMailboxBody(store: TeamStateStore, messageId: string, body: string): string {
  const dir = path.join(store.teamDirectory(), 'mailbox-bodies');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const target = path.join(dir, `${messageId}.txt`);
  fs.writeFileSync(target, body, { encoding: 'utf8', mode: 0o600 });
  return target;
}

async function completeTask(store: TeamStateStore, taskId: string, token: string): Promise<number> {
  const current = store.read();
  if (!current.ok) throw new Error(current.error.message);
  const claimed = await store.claimTask(taskId, taskId, current.value.revision, 1_000, 5_000, token);
  if (!claimed.ok) throw new Error(claimed.error.message);
  const completed = await store.completeReadOnlyTask(
    taskId,
    claimed.value.revision,
    token,
    1,
    sha256(`artifact:${taskId}`),
  );
  if (!completed.ok) throw new Error(completed.error.message);
  return completed.value.revision;
}

async function cancelTask(store: TeamStateStore, taskId: string, token: string): Promise<number> {
  const current = store.read();
  if (!current.ok) throw new Error(current.error.message);
  const claimed = await store.claimTask(taskId, taskId, current.value.revision, 1_000, 5_000, token);
  if (!claimed.ok) throw new Error(claimed.error.message);
  const cancelled = await store.transitionTaskStatus({
    taskId,
    expectedRevision: claimed.value.revision,
    from: 'in_progress',
    to: 'cancelled',
    claimToken: token,
    generation: 1,
  });
  if (!cancelled.ok) throw new Error(cancelled.error.message);
  return cancelled.value.revision;
}

function currentRevision(store: TeamStateStore): number {
  const snapshot = store.read();
  if (!snapshot.ok) throw new Error(snapshot.error.message);
  return snapshot.value.revision;
}

describe('oma team cleanup / GitWorktreeManager.cleanupTerminal', () => {
  test('CLI_HELP documents the cleanup verb', () => {
    expect(CLI_HELP).toContain(
      'oma team cleanup --team <id> --expected-revision <n> [--dry-run] [--json]',
    );
  });

  test('cleanup terminal statuses match wait / HUD / cancel', () => {
    const statuses: TeamTaskStatus[] = [
      'pending',
      'in_progress',
      'awaiting_interaction',
      'orphan_identity_unproven',
      'recovery_fork_unresolved',
      'delivered_unintegrated',
      'integration_blocked',
      'completed',
      'blocked_permission',
      'failed',
      'cancelled',
      'fenced_superseded',
    ];
    for (const status of statuses) {
      expect(isTeamCleanupTerminalStatus(status)).toBe(isTeamWaitTerminalStatus(status));
    }
  });

  test('parseTeamCommand accepts cleanup flags including boolean --dry-run and --json', () => {
    expect(parseTeamCommand([
      'cleanup', '--team', 'alpha', '--expected-revision', '3',
    ])).toEqual({
      ok: true,
      value: {
        kind: 'cleanup',
        teamId: 'alpha',
        expectedRevision: 3,
        dryRun: false,
        json: false,
      },
    });
    expect(parseTeamCommand([
      'cleanup', '--json', '--dry-run', '--team', 'alpha', '--expected-revision', '0',
    ])).toEqual({
      ok: true,
      value: {
        kind: 'cleanup',
        teamId: 'alpha',
        expectedRevision: 0,
        dryRun: true,
        json: true,
      },
    });
  });

  test('cleanup argv without --team / --expected-revision is E_VALIDATOR_REJECTED', async () => {
    const missing = parseTeamCommand(['cleanup', '--team', 'alpha']);
    expect(missing).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'E_VALIDATOR_REJECTED' }),
    }));
    const unknown = parseTeamCommand([
      'cleanup', '--team', 'alpha', '--expected-revision', '1', '--force',
    ]);
    expect(unknown.ok).toBe(false);
    const negative = parseTeamCommand([
      'cleanup', '--team', 'alpha', '--expected-revision', '-1',
    ]);
    expect(negative.ok).toBe(false);

    let stderr = '';
    const code = await teamCommand(['cleanup', '--dry-run'], {
      context: {
        stateRoot: '/tmp',
        workspaceRoot: '/tmp',
        repoKey: 'repo',
        workspaceKey: 'workspace',
      },
      stdout: () => undefined,
      stderr: (value) => { stderr += value; },
    });
    expect(code).toBe(2);
    expect(stderr).toContain('E_VALIDATOR_REJECTED');
  });

  test('dry-run lists planned worktree / branch / mailbox body with zero mutation', async () => {
    const { fixture, store, manager, orch, context, aggregatePath } = await seedWorld(['done-task']);
    try {
      const worktree = addWorktree(manager, fixture, 'done-task');
      await completeTask(store, 'done-task', 'claim-done');
      const bodyPath = writeMailboxBody(store, 'm-term', 'recycle me\n');
      const revision = currentRevision(store);
      const beforeGit = gitSnapshot(fixture);
      const beforeMailbox = mailboxSnapshot(store);
      const beforeAggregate = fs.readFileSync(aggregatePath);

      const spy = jest.spyOn(GitWorktreeManager.prototype, 'cleanupTerminal');
      const branchSpy = jest.spyOn(GitWorktreeManager.prototype, 'deleteManagedBranch');
      try {
        const result = await orch.cleanup(TEAM_ID, revision, { dryRun: true });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.dryRun).toBe(true);
        expect(result.value.removed).toEqual([]);
        expect(result.value.planned).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: 'worktree', path: worktree.path, taskId: 'done-task' }),
          expect.objectContaining({ kind: 'branch', branchName: worktree.branchName }),
          expect.objectContaining({ kind: 'mailbox-body', path: bodyPath }),
        ]));
        expect(spy).not.toHaveBeenCalled();
        expect(branchSpy).not.toHaveBeenCalled();
        expect(fs.existsSync(worktree.path)).toBe(true);
        expect(fs.existsSync(bodyPath)).toBe(true);
        expect(gitSnapshot(fixture)).toBe(beforeGit);
        expect(mailboxSnapshot(store)).toBe(beforeMailbox);
        expect(fs.readFileSync(aggregatePath)).toEqual(beforeAggregate);

        let stdout = '';
        const code = await teamCommand([
          'cleanup', '--team', TEAM_ID, '--expected-revision', String(revision), '--dry-run', '--json',
        ], {
          context,
          orchestratorFactory: () => orch,
          stdout: (value) => { stdout += value; },
          stderr: () => undefined,
        });
        expect(code).toBe(0);
        const body = JSON.parse(stdout) as { kind: string; dryRun: boolean; removed: unknown[] };
        expect(body.kind).toBe('team-cleanup');
        expect(body.dryRun).toBe(true);
        expect(body.removed).toEqual([]);
        expect(fs.readFileSync(aggregatePath)).toEqual(beforeAggregate);
        expect(gitSnapshot(fixture)).toBe(beforeGit);
      } finally {
        spy.mockRestore();
        branchSpy.mockRestore();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('completeReadOnlyTask worktree with extra commits is preserved', async () => {
    const { fixture, store, manager, orch } = await seedWorld(['done-task']);
    try {
      const worktree = addWorktree(manager, fixture, 'done-task');
      fixture.commitFile('src/result.ts', 'done\n', 'worker result', worktree.path);
      await completeTask(store, 'done-task', 'claim-done');
      const result = await orch.cleanup(TEAM_ID, currentRevision(store));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(fs.existsSync(worktree.path)).toBe(true);
      expect(fixture.git(['branch', '--list', worktree.branchName]).stdout).toContain(worktree.branchName);
      expect(result.value.preserved).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'worktree',
          taskId: 'done-task',
          code: 'E_DELIVERY_UNINTEGRATED',
        }),
      ]));
    } finally {
      fixture.cleanup();
    }
  });

  test('missing worktree with unmerged branch is preserved and not force-deleted', async () => {
    const { fixture, store, manager, orch } = await seedWorld(['cancelled-task']);
    try {
      const worktree = addWorktree(manager, fixture, 'cancelled-task');
      fixture.commitFile('result.ts', 'only on branch\n', 'keep branch tip', worktree.path);
      await cancelTask(store, 'cancelled-task', 'claim-cancel');
      fixture.git(['worktree', 'remove', worktree.path]);
      expect(fs.existsSync(worktree.path)).toBe(false);
      expect(fs.existsSync(worktree.markerPath)).toBe(true);
      const beforeBranch = fixture.git(['rev-parse', worktree.branchName]).stdout.trim();
      const result = await orch.cleanup(TEAM_ID, currentRevision(store));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(fixture.git(['rev-parse', worktree.branchName]).stdout.trim()).toBe(beforeBranch);
      expect(result.value.preserved).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'branch',
          taskId: 'cancelled-task',
          branchName: worktree.branchName,
          code: 'E_DELIVERY_UNINTEGRATED',
        }),
      ]));
      expect(result.value.removed.filter((item) => item.kind === 'branch')).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test('safely removes integrated terminal worktree, branch, mailbox body, and retires aggregate', async () => {
    const { fixture, store, manager, orch, context } = await seedWorld(['done-task']);
    try {
      const worktree = addWorktree(manager, fixture, 'done-task');
      fixture.commitFile('src/result.ts', 'done\n', 'worker result', worktree.path);
      fixture.git(['merge', '--ff-only', worktree.branchName]);
      await completeTask(store, 'done-task', 'claim-done');
      const bodyPath = writeMailboxBody(store, 'm-term', 'recycle me\n');
      const sent = await store.sendMailbox(currentRevision(store), {
        schemaVersion: 1,
        id: 'm-term',
        sender: 'leader',
        recipient: 'done-task',
        bodyDigest: sha256('recycle me\n'),
        createdAtMs: 1,
      });
      if (!sent.ok) throw new Error(sent.error.message);
      const revision = currentRevision(store);

      const spy = jest.spyOn(GitWorktreeManager.prototype, 'cleanupTerminal');
      try {
        const result = await orch.cleanup(TEAM_ID, revision);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.dryRun).toBe(false);
        expect(result.value.retired).toBe(true);
        expect(result.value.preserved).toEqual([]);
        expect(result.value.removed).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: 'worktree', path: worktree.path }),
          expect.objectContaining({ kind: 'branch', branchName: worktree.branchName }),
          expect.objectContaining({ kind: 'mailbox-body', path: bodyPath }),
        ]));
        expect(spy).toHaveBeenCalled();
        expect(spy.mock.calls.some((call) => (
          call[0].workerId === 'done-task'
          && call[1].outcome === 'integrated'
          && call[1].ownerNonce === OWNER_NONCE
        ))).toBe(true);
        expect(fs.existsSync(worktree.path)).toBe(false);
        expect(fs.existsSync(bodyPath)).toBe(false);
        expect(fixture.git(['branch', '--list', worktree.branchName]).stdout.trim()).toBe('');

        const status = await orch.status(TEAM_ID);
        expect(status.ok).toBe(true);
        if (!status.ok) return;
        expect(status.value.retired).toBe(true);
        expect(status.value.tasks['done-task']?.status).toBe('completed');

        let stdout = '';
        const code = await teamCommand(['status', '--team', TEAM_ID], {
          context,
          orchestratorFactory: () => orch,
          stdout: (value) => { stdout += value; },
          stderr: () => undefined,
        });
        expect(code).toBe(0);
        const body = JSON.parse(stdout) as { kind: string; retired: boolean };
        expect(body.kind).toBe('team-status');
        expect(body.retired).toBe(true);
      } finally {
        spy.mockRestore();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('worktree with unintegrated commits is preserved and the reason is explicit', async () => {
    const { fixture, store, manager, orch } = await seedWorld(['cancelled-task']);
    try {
      const worktree = addWorktree(manager, fixture, 'cancelled-task');
      fixture.commitFile('result.ts', 'unintegrated\n', 'keep me', worktree.path);
      await cancelTask(store, 'cancelled-task', 'claim-cancel');
      const revision = currentRevision(store);
      const result = await orch.cleanup(TEAM_ID, revision);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(fs.existsSync(worktree.path)).toBe(true);
      expect(result.value.removed.filter((item) => item.kind === 'worktree')).toEqual([]);
      expect(result.value.preserved).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'worktree',
          taskId: 'cancelled-task',
          path: worktree.path,
          code: 'E_DELIVERY_UNINTEGRATED',
        }),
      ]));
      expect(result.value.preserved[0]?.reason.length).toBeGreaterThan(0);
      expect(fixture.git(['branch', '--list', worktree.branchName]).stdout).toContain(worktree.branchName);
    } finally {
      fixture.cleanup();
    }
  });

  test('dry-run of unintegrated worktree lists the reason and mutates nothing', async () => {
    const { fixture, store, manager, orch, aggregatePath } = await seedWorld(['cancelled-task']);
    try {
      const worktree = addWorktree(manager, fixture, 'cancelled-task');
      fixture.commitFile('result.ts', 'unintegrated\n', 'keep me', worktree.path);
      await cancelTask(store, 'cancelled-task', 'claim-cancel');
      const revision = currentRevision(store);
      const beforeGit = gitSnapshot(fixture);
      const beforeAggregate = fs.readFileSync(aggregatePath);
      const spy = jest.spyOn(GitWorktreeManager.prototype, 'cleanupTerminal');
      try {
        const result = await orch.cleanup(TEAM_ID, revision, { dryRun: true });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.removed).toEqual([]);
        expect(result.value.planned.filter((item) => item.kind === 'worktree')).toEqual([]);
        expect(result.value.preserved).toEqual(expect.arrayContaining([
          expect.objectContaining({
            kind: 'worktree',
            taskId: 'cancelled-task',
            code: 'E_DELIVERY_UNINTEGRATED',
          }),
        ]));
        expect(result.value.preserved[0]?.reason.length).toBeGreaterThan(0);
        expect(spy).not.toHaveBeenCalled();
        expect(fs.existsSync(worktree.path)).toBe(true);
        expect(gitSnapshot(fixture)).toBe(beforeGit);
        expect(fs.readFileSync(aggregatePath)).toEqual(beforeAggregate);
      } finally {
        spy.mockRestore();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('cancelled terminal worktree at base SHA is removed', async () => {
    const { fixture, store, manager, orch } = await seedWorld(['cancelled-task']);
    try {
      const worktree = addWorktree(manager, fixture, 'cancelled-task');
      await cancelTask(store, 'cancelled-task', 'claim-cancel');
      const revision = currentRevision(store);
      const spy = jest.spyOn(GitWorktreeManager.prototype, 'cleanupTerminal');
      try {
        const result = await orch.cleanup(TEAM_ID, revision);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.retired).toBe(true);
        expect(result.value.preserved).toEqual([]);
        expect(result.value.removed).toEqual(expect.arrayContaining([
          expect.objectContaining({ kind: 'worktree', path: worktree.path }),
          expect.objectContaining({ kind: 'branch', branchName: worktree.branchName }),
        ]));
        expect(spy.mock.calls.some((call) => (
          call[0].workerId === 'cancelled-task'
          && call[1].ownerNonce === OWNER_NONCE
        ))).toBe(true);
        expect(fs.existsSync(worktree.path)).toBe(false);
        expect(fixture.git(['branch', '--list', worktree.branchName]).stdout.trim()).toBe('');
      } finally {
        spy.mockRestore();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('unknown team is E_NOT_FOUND', async () => {
    const { fixture, orch } = await seedWorld(['done-task']);
    try {
      const result = await orch.cleanup('no-such-team', 0);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('E_NOT_FOUND');
    } finally {
      fixture.cleanup();
    }
  });

  test('non-terminal task worktree, branch, and mailbox body are not touched', async () => {
    const { fixture, store, manager, orch } = await seedWorld(['done-task', 'live-task']);
    try {
      const done = addWorktree(manager, fixture, 'done-task');
      const live = addWorktree(manager, fixture, 'live-task');
      await completeTask(store, 'done-task', 'claim-done');
      const liveBody = writeMailboxBody(store, 'm-live', 'keep for live worker\n');
      const revision = currentRevision(store);
      const spy = jest.spyOn(GitWorktreeManager.prototype, 'cleanupTerminal');
      try {
        const result = await orch.cleanup(TEAM_ID, revision);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.value.retired).toBe(false);
        expect(result.value.skipped).toEqual(expect.arrayContaining([
          expect.objectContaining({ taskId: 'live-task', reason: 'non-terminal', status: 'pending' }),
        ]));
        expect(fs.existsSync(done.path)).toBe(false);
        expect(fs.existsSync(live.path)).toBe(true);
        expect(fs.existsSync(liveBody)).toBe(true);
        expect(fixture.git(['branch', '--list', live.branchName]).stdout).toContain(live.branchName);
        expect(spy.mock.calls.map((call) => call[0].workerId)).toEqual(['done-task']);
      } finally {
        spy.mockRestore();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('--expected-revision mismatch is a CAS rejection', async () => {
    const { fixture, store, manager, orch, context, aggregatePath } = await seedWorld(['done-task']);
    try {
      const worktree = addWorktree(manager, fixture, 'done-task');
      await completeTask(store, 'done-task', 'claim-done');
      const bodyPath = writeMailboxBody(store, 'm-cas', 'keep on cas miss\n');
      const actual = currentRevision(store);
      const beforeGit = gitSnapshot(fixture);
      const beforeMailbox = mailboxSnapshot(store);
      const beforeAggregate = fs.readFileSync(aggregatePath);
      const spy = jest.spyOn(GitWorktreeManager.prototype, 'cleanupTerminal');
      try {
        const result = await orch.cleanup(TEAM_ID, actual + 9);
        expect(result.ok).toBe(false);
        if (result.ok) return;
        expect(result.error.code).toBe('E_REVISION_CONFLICT');
        expect(spy).not.toHaveBeenCalled();
        expect(fs.existsSync(worktree.path)).toBe(true);
        expect(fs.existsSync(bodyPath)).toBe(true);
        expect(gitSnapshot(fixture)).toBe(beforeGit);
        expect(mailboxSnapshot(store)).toBe(beforeMailbox);
        expect(fs.readFileSync(aggregatePath)).toEqual(beforeAggregate);

        const dry = await orch.cleanup(TEAM_ID, actual + 9, { dryRun: true });
        expect(dry.ok).toBe(false);
        if (dry.ok) return;
        expect(dry.error.code).toBe('E_REVISION_CONFLICT');
        expect(fs.readFileSync(aggregatePath)).toEqual(beforeAggregate);

        let stderr = '';
        const code = await teamCommand([
          'cleanup', '--team', TEAM_ID, '--expected-revision', '0',
        ], {
          context,
          orchestratorFactory: () => orch,
          stdout: () => undefined,
          stderr: (value) => { stderr += value; },
        });
        expect(code).toBe(1);
        expect(code).not.toBe(0);
        expect(stderr).toContain('E_REVISION_CONFLICT');
        expect(store.read().ok).toBe(true);
        expect(currentRevision(store)).toBe(actual);
        expect(fs.existsSync(worktree.path)).toBe(true);
        expect(gitSnapshot(fixture)).toBe(beforeGit);
      } finally {
        spy.mockRestore();
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('repeated cleanup is idempotent', async () => {
    const { fixture, store, manager, orch } = await seedWorld(['done-task']);
    try {
      const worktree = addWorktree(manager, fixture, 'done-task');
      await completeTask(store, 'done-task', 'claim-done');
      writeMailboxBody(store, 'm-term', 'recycle me\n');
      const first = await orch.cleanup(TEAM_ID, currentRevision(store));
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(fs.existsSync(worktree.path)).toBe(false);
      const second = await orch.cleanup(TEAM_ID, first.value.revision);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.value.retired).toBe(true);
      expect(fs.existsSync(worktree.path)).toBe(false);
      const status = await orch.status(TEAM_ID);
      expect(status.ok).toBe(true);
      if (!status.ok) return;
      expect(status.value.retired).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test('cleanup sources never contain destructive git reset or clean argv', () => {
    // node_modules 在此 worktree 可能是 symlink；只讀明確原始碼路徑，禁止 walk node_modules。
    const sources = [
      'src/team/cleanup.ts',
      'src/team/worktree.ts',
      'src/team/orchestrator.ts',
      'src/team/commands.ts',
      'src/team/state.ts',
    ].map((relative) => fs.readFileSync(path.join(__dirname, '../..', relative), 'utf8'));
    const joined = sources.join('\n');
    expect(joined).not.toContain('git reset --hard');
    expect(joined).not.toContain('git clean -fd');
    expect(joined).toContain('cleanupTerminal');
    expect(joined).toContain("['branch', '-d', branchName]");
    expect(joined).not.toContain("['branch', '-D', branchName]");
  });
});
