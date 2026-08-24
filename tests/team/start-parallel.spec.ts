/**
 * #43：`oma team start --max-parallel` 與 manifest `max_parallel`。
 * 設計概念映射：OMC `team --count` / OMX `team N` / OMG `team --workers`。
 */
import * as fs from 'fs';
import * as path from 'path';
import { parseTeamCommand, teamCommand } from '../../src/team/commands';
import { parseTeamManifest } from '../../src/team/manifest';
import { TeamOrchestrator } from '../../src/team/orchestrator';
import { TeamStateStore } from '../../src/team/state';
import { RuntimeContext } from '../../src/team/types';
import { resolveGitWorktreeIdentity } from '../../src/team/worktree';
import { formatCliError } from '../../src/runtime/error-catalog';
import { runtimeError } from '../../src/runtime/errors';
import { err, ok } from '../../src/runtime/types';
import { GitFixture } from '../helpers/git-fixture';
import { headlessProviderRouteFactory } from '../helpers/team-provider-route';

const MAX_PARALLEL_FLAG_MESSAGE = 'max-parallel must be a positive integer';

function independentTask(id: string, file: string, dependencies: readonly string[] = []) {
  return {
    id,
    dependencies: [...dependencies],
    write_scope: [{ kind: 'file' as const, path: file }],
    mode: 'headless' as const,
    verification: { version: 1 as const, commands: [], requiredArtifacts: [] },
  };
}

function independentTasks(count: number) {
  return Array.from({ length: count }, (_, index) => independentTask(`t${index + 1}`, `t${index + 1}.txt`));
}

function writeManifest(fixture: GitFixture, body: Record<string, unknown>): string {
  const manifestPath = path.join(fixture.root, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(body));
  return manifestPath;
}

function fakeTmux() {
  let pane = 0;
  return {
    startWorker: (input: { sessionName: string; ownerNonce: string; workerNonce: string }) => ok({
      sessionName: input.sessionName,
      paneId: `%${++pane}`,
      ownerNonce: input.ownerNonce,
      workerNonce: input.workerNonce,
    }),
    killOwnedSession: () => ok(undefined),
    hasSession: () => false,
    inspectOwnedPane: () => err(runtimeError('E_NOT_FOUND', 'not live')),
  };
}

function makeOrchestrator(fixture: GitFixture, context: RuntimeContext): TeamOrchestrator {
  return new TeamOrchestrator({
    providerProfileFactory: headlessProviderRouteFactory(),
    stateRoot: context.stateRoot,
    workspaceRoot: context.workspaceRoot,
    repoKey: context.repoKey,
    workspaceKey: context.workspaceKey,
    managedWorktreesRoot: fixture.managedWorktreesRoot,
    sessionNamePrefix: 'par',
    tokenFactory: context.tokenFactory ?? (() => {
      let sequence = 0;
      return () => `par-tok-${++sequence}`;
    })(),
    tmux: fakeTmux() as any,
  });
}

function contextFor(fixture: GitFixture): RuntimeContext {
  const leader = resolveGitWorktreeIdentity(fixture.repo);
  let sequence = 0;
  return {
    stateRoot: fixture.stateRoot,
    workspaceRoot: fixture.repo,
    repoKey: leader.repoKey,
    workspaceKey: leader.workspaceKey,
    tokenFactory: () => `par-tok-${++sequence}`,
  };
}

async function runStart(
  fixture: GitFixture,
  argv: readonly string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const context = contextFor(fixture);
  let stdout = '';
  let stderr = '';
  const code = await teamCommand(argv, {
    context,
    stdout: (value) => { stdout += value; },
    stderr: (value) => { stderr += value; },
    orchestratorFactory: (ctx) => makeOrchestrator(fixture, ctx),
  });
  return { code, stdout, stderr };
}

describe('team start max-parallel (#43)', () => {
  describe('parseTeamManifest', () => {
    let fixture: GitFixture;
    beforeEach(() => { fixture = GitFixture.create(); });
    afterEach(() => fixture.cleanup());

    test('omitted max_parallel defaults to 1', () => {
      const parsed = parseTeamManifest({
        schema: 'oma.team-manifest/v1',
        teamId: 'alpha',
        revision: 1,
        tasks: independentTasks(1),
      }, fixture.repo);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.max_parallel).toBe(1);
    });

    test('positive max_parallel is preserved', () => {
      const parsed = parseTeamManifest({
        schema: 'oma.team-manifest/v1',
        teamId: 'alpha',
        revision: 1,
        max_parallel: 4,
        tasks: independentTasks(1),
      }, fixture.repo);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.max_parallel).toBe(4);
    });

    test.each([0, -1, 1.5, '4', null, true] as const)(
      'rejects non-positive or non-integer max_parallel %j with E_VALIDATOR_REJECTED',
      (maxParallel) => {
        const parsed = parseTeamManifest({
          schema: 'oma.team-manifest/v1',
          teamId: 'alpha',
          revision: 1,
          max_parallel: maxParallel,
          tasks: independentTasks(1),
        }, fixture.repo);
        expect(parsed.ok).toBe(false);
        if (parsed.ok) return;
        expect(parsed.error.code).toBe('E_VALIDATOR_REJECTED');
        expect(parsed.error.message).toBe('max_parallel must be a positive integer');
      },
    );
  });

  describe('parseTeamCommand start --max-parallel', () => {
    test('accepts a positive integer with the same contract as tick', () => {
      expect(parseTeamCommand([
        'start', '--manifest', 'team.json', '--max-parallel', '3',
      ])).toEqual({
        ok: true,
        value: {
          kind: 'start',
          manifestPath: 'team.json',
          workerMode: 'headless',
          maxParallel: 3,
        },
      });
    });

    test.each(['0', '-1', 'abc'] as const)(
      'rejects %j with the same E_VALIDATOR_REJECTED message as tick',
      (value) => {
        const start = parseTeamCommand([
          'start', '--manifest', 'team.json', '--max-parallel', value,
        ]);
        const tick = parseTeamCommand([
          'tick', '--team', 'alpha', '--max-parallel', value,
        ]);
        expect(start.ok).toBe(false);
        expect(tick.ok).toBe(false);
        if (start.ok || tick.ok) return;
        expect(start.error.code).toBe('E_VALIDATOR_REJECTED');
        expect(start.error.message).toBe(MAX_PARALLEL_FLAG_MESSAGE);
        expect(start.error).toEqual(tick.error);
      },
    );
  });

  describe('teamCommand start', () => {
    test('CLI --max-parallel 3 starts three ready non-overlapping tasks', async () => {
      const fixture = GitFixture.create();
      try {
        const manifestPath = writeManifest(fixture, {
          schema: 'oma.team-manifest/v1',
          teamId: 'alpha',
          revision: 1,
          tasks: independentTasks(3),
        });
        const result = await runStart(fixture, [
          'start', '--manifest', manifestPath, '--max-parallel', '3',
        ]);
        expect(result.stderr).toBe('');
        expect(result.code).toBe(0);
        const body = JSON.parse(result.stdout);
        expect(body.kind).toBe('team-started');
        expect(body.workers.map((worker: { taskId: string }) => worker.taskId)).toEqual(['t1', 't2', 't3']);
      } finally {
        fixture.cleanup();
      }
    }, 20_000);

    test('manifest max_parallel 4 with no flag starts four workers', async () => {
      const fixture = GitFixture.create();
      try {
        const manifestPath = writeManifest(fixture, {
          schema: 'oma.team-manifest/v1',
          teamId: 'alpha',
          revision: 1,
          max_parallel: 4,
          tasks: independentTasks(4),
        });
        const result = await runStart(fixture, ['start', '--manifest', manifestPath]);
        expect(result.stderr).toBe('');
        expect(result.code).toBe(0);
        const body = JSON.parse(result.stdout);
        expect(body.workers).toHaveLength(4);
        expect(body.workers.map((worker: { taskId: string }) => worker.taskId))
          .toEqual(['t1', 't2', 't3', 't4']);
      } finally {
        fixture.cleanup();
      }
    }, 20_000);

    test('CLI --max-parallel 2 overrides manifest max_parallel 4', async () => {
      const fixture = GitFixture.create();
      try {
        const manifestPath = writeManifest(fixture, {
          schema: 'oma.team-manifest/v1',
          teamId: 'alpha',
          revision: 1,
          max_parallel: 4,
          tasks: independentTasks(4),
        });
        const result = await runStart(fixture, [
          'start', '--manifest', manifestPath, '--max-parallel', '2',
        ]);
        expect(result.stderr).toBe('');
        expect(result.code).toBe(0);
        const body = JSON.parse(result.stdout);
        expect(body.workers.map((worker: { taskId: string }) => worker.taskId)).toEqual(['t1', 't2']);
      } finally {
        fixture.cleanup();
      }
    }, 20_000);

    test('default remains one worker when neither flag nor manifest field is set', async () => {
      const fixture = GitFixture.create();
      try {
        const manifestPath = writeManifest(fixture, {
          schema: 'oma.team-manifest/v1',
          teamId: 'alpha',
          revision: 1,
          tasks: independentTasks(3),
        });
        const result = await runStart(fixture, ['start', '--manifest', manifestPath]);
        expect(result.stderr).toBe('');
        expect(result.code).toBe(0);
        const body = JSON.parse(result.stdout);
        expect(body.workers.map((worker: { taskId: string }) => worker.taskId)).toEqual(['t1']);
      } finally {
        fixture.cleanup();
      }
    }, 20_000);

    test.each(['0', '-1', 'abc'] as const)(
      'teamCommand rejects --max-parallel %s with tick-identical message',
      async (value) => {
        let stderr = '';
        const code = await teamCommand([
          'start', '--manifest', 'missing.json', '--max-parallel', value,
        ], {
          context: {
            stateRoot: '/tmp',
            workspaceRoot: '/tmp',
            repoKey: null,
            workspaceKey: 'ws',
          },
          stdout: () => undefined,
          stderr: (chunk) => { stderr += chunk; },
        });
        expect(code).toBe(2);
        expect(stderr).toBe(formatCliError('E_VALIDATOR_REJECTED', MAX_PARALLEL_FLAG_MESSAGE));
      },
    );

    test('manifest max_parallel 0 is rejected by parseTeamManifest and team start', async () => {
      const fixture = GitFixture.create();
      try {
        const body = {
          schema: 'oma.team-manifest/v1',
          teamId: 'alpha',
          revision: 1,
          max_parallel: 0,
          tasks: independentTasks(2),
        };
        expect(parseTeamManifest(body, fixture.repo)).toEqual({
          ok: false,
          error: expect.objectContaining({
            code: 'E_VALIDATOR_REJECTED',
            message: 'max_parallel must be a positive integer',
          }),
        });
        const manifestPath = writeManifest(fixture, body);
        const result = await runStart(fixture, ['start', '--manifest', manifestPath]);
        expect(result.code).toBe(2);
        expect(result.stderr).toContain('E_VALIDATOR_REJECTED: max_parallel must be a positive integer');
      } finally {
        fixture.cleanup();
      }
    });

    test('overlapping write_scope still starts one worker even with --max-parallel 5', async () => {
      const fixture = GitFixture.create();
      try {
        const manifestPath = writeManifest(fixture, {
          schema: 'oma.team-manifest/v1',
          teamId: 'alpha',
          revision: 1,
          tasks: [
            independentTask('task-a', 'src/a.ts'),
            independentTask('task-b', 'src/a.ts', ['task-a']),
          ],
        });
        const result = await runStart(fixture, [
          'start', '--manifest', manifestPath, '--max-parallel', '5',
        ]);
        expect(result.stderr).toBe('');
        expect(result.code).toBe(0);
        const body = JSON.parse(result.stdout);
        expect(body.workers.map((worker: { taskId: string }) => worker.taskId)).toEqual(['task-a']);

        const leader = resolveGitWorktreeIdentity(fixture.repo);
        const store = new TeamStateStore(
          fixture.stateRoot, leader.repoKey, leader.workspaceKey, 'alpha',
        );
        const snapshot = store.read();
        expect(snapshot.ok).toBe(true);
        if (!snapshot.ok) return;
        expect(snapshot.value.value.tasks['task-a'].status).toBe('in_progress');
        expect(snapshot.value.value.tasks['task-b'].status).toBe('pending');
      } finally {
        fixture.cleanup();
      }
    }, 20_000);

    test('unordered overlapping write_scope is still rejected under --max-parallel 5', async () => {
      const fixture = GitFixture.create();
      try {
        const manifestPath = writeManifest(fixture, {
          schema: 'oma.team-manifest/v1',
          teamId: 'alpha',
          revision: 1,
          tasks: [
            independentTask('task-a', 'src/a.ts'),
            independentTask('task-b', 'src/a.ts'),
          ],
        });
        const result = await runStart(fixture, [
          'start', '--manifest', manifestPath, '--max-parallel', '5',
        ]);
        expect(result.code).toBe(1);
        expect(result.stderr).toContain('E_TASK_SCOPE_OVERLAP');
      } finally {
        fixture.cleanup();
      }
    });
  });
});
