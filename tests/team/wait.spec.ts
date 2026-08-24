import * as fs from 'fs';
import * as path from 'path';
import { CLI_HELP } from '../../src/cli/application';
import { sha256 } from '../../src/runtime/atomic';
import {
  HUD_WATCH_INTERVAL_MS_MAX,
  HUD_WATCH_INTERVAL_MS_MIN,
  HUD_WATCH_MAX_ITERATIONS,
  boundedSleep,
} from '../../src/hud/watch';
import { parseTeamCommand, teamCommand } from '../../src/team/commands';
import {
  TeamOrchestrator,
  isTeamWaitTerminalStatus,
} from '../../src/team/orchestrator';
import { TeamStateStore } from '../../src/team/state';
import { CanonicalTeamManifestV1, RuntimeContext } from '../../src/team/types';
import { createStateFixture } from '../helpers/state-fixture';

function waitManifest(teamId: string, taskIds: readonly string[] = ['inspect']): CanonicalTeamManifestV1 {
  return {
    schema: 'oma.team-manifest/v1',
    teamId,
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

async function completeInspect(store: TeamStateStore, expectedRevision = 0): Promise<number> {
  const claimed = await store.claimTask('inspect', 'worker-1', expectedRevision, 1_000, 5_000, 'claim-1');
  if (!claimed.ok) throw new Error(claimed.error.message);
  const completed = await store.completeReadOnlyTask(
    'inspect',
    claimed.value.revision,
    'claim-1',
    1,
    sha256('wait-artifact'),
  );
  if (!completed.ok) throw new Error(completed.error.message);
  return completed.value.revision;
}

async function seededWaitTeam(teamId = 'wait-team', taskIds: readonly string[] = ['inspect']) {
  const fixture = createStateFixture('oma-wait-');
  const store = new TeamStateStore(fixture.root, 'repo', 'workspace', teamId);
  const created = await store.create(waitManifest(teamId, taskIds), 'owner-secret');
  if (!created.ok) throw new Error(created.error.message);
  const orch = new TeamOrchestrator({
    stateRoot: fixture.root,
    workspaceRoot: fixture.root,
    repoKey: 'repo',
    workspaceKey: 'workspace',
    managedWorktreesRoot: path.join(fixture.root, 'managed-worktrees'),
  });
  const context: RuntimeContext = {
    stateRoot: fixture.root,
    workspaceRoot: fixture.root,
    repoKey: 'repo',
    workspaceKey: 'workspace',
  };
  const aggregatePath = fixture.path('repositories', 'repo', 'teams', teamId, 'aggregate.json');
  return { fixture, store, orch, teamId, context, aggregatePath };
}

describe('oma team wait / TeamOrchestrator.waitForConvergence', () => {
  test('CLI_HELP documents the wait verb', () => {
    expect(CLI_HELP).toContain(
      'oma team wait --team <id> [--timeout-ms <n>] [--poll-interval-ms <n>] [--json]',
    );
  });

  test('terminal statuses match HUD/cancel final set', () => {
    expect(isTeamWaitTerminalStatus('completed')).toBe(true);
    expect(isTeamWaitTerminalStatus('blocked_permission')).toBe(true);
    expect(isTeamWaitTerminalStatus('failed')).toBe(true);
    expect(isTeamWaitTerminalStatus('cancelled')).toBe(true);
    expect(isTeamWaitTerminalStatus('fenced_superseded')).toBe(true);
    expect(isTeamWaitTerminalStatus('pending')).toBe(false);
    expect(isTeamWaitTerminalStatus('in_progress')).toBe(false);
    expect(isTeamWaitTerminalStatus('awaiting_interaction')).toBe(false);
    expect(isTeamWaitTerminalStatus('delivered_unintegrated')).toBe(false);
    expect(isTeamWaitTerminalStatus('integration_blocked')).toBe(false);
  });

  test('parseTeamCommand accepts wait flags including boolean --json', () => {
    expect(parseTeamCommand(['wait', '--team', 'alpha'])).toEqual({
      ok: true,
      value: { kind: 'wait', teamId: 'alpha', json: false },
    });
    expect(parseTeamCommand([
      'wait', '--json', '--team', 'alpha', '--timeout-ms', '1500', '--poll-interval-ms', '50',
    ])).toEqual({
      ok: true,
      value: {
        kind: 'wait',
        teamId: 'alpha',
        json: true,
        timeoutMs: 1500,
        pollIntervalMs: 50,
      },
    });
    expect(parseTeamCommand([
      'wait', '--poll-interval-ms', String(HUD_WATCH_INTERVAL_MS_MAX), '--team', 'alpha',
    ]).ok).toBe(true);
  });

  test('poll-interval-ms outside 50–60000 is E_VALIDATOR_REJECTED', async () => {
    const low = parseTeamCommand(['wait', '--team', 'alpha', '--poll-interval-ms', '49']);
    expect(low).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'E_VALIDATOR_REJECTED' }),
    }));
    const high = parseTeamCommand([
      'wait', '--team', 'alpha', '--poll-interval-ms', String(HUD_WATCH_INTERVAL_MS_MAX + 1),
    ]);
    expect(high.ok).toBe(false);
    if (high.ok) return;
    expect(high.error.code).toBe('E_VALIDATOR_REJECTED');
    expect(high.error.message).toContain('50');
    expect(high.error.message).toContain('60000');
    const minOk = parseTeamCommand([
      'wait', '--team', 'alpha', '--poll-interval-ms', String(HUD_WATCH_INTERVAL_MS_MIN),
    ]);
    expect(minOk.ok).toBe(true);

    let stderr = '';
    const code = await teamCommand(['wait', '--team', 'alpha', '--poll-interval-ms', '49'], {
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

  test('timeout-ms must be a positive integer; wait requires --team', () => {
    expect(parseTeamCommand(['wait', '--team', 'alpha', '--timeout-ms', '0']).ok).toBe(false);
    expect(parseTeamCommand(['wait', '--team', 'alpha', '--timeout-ms', '-1']).ok).toBe(false);
    expect(parseTeamCommand(['wait', '--team', 'alpha', '--timeout-ms', '1.5']).ok).toBe(false);
    const missingTeam = parseTeamCommand(['wait', '--json']);
    expect(missingTeam).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'E_VALIDATOR_REJECTED' }),
    }));
  });

  test('unknown team id is the existing E_NOT_FOUND', async () => {
    const { fixture, orch, context } = await seededWaitTeam();
    try {
      const missing = await orch.waitForConvergence('no-such-team', {
        pollIntervalMs: 50,
        sleep: async () => undefined,
      });
      expect(missing.ok).toBe(false);
      if (missing.ok) return;
      expect(missing.error.code).toBe('E_NOT_FOUND');

      let stderr = '';
      const code = await teamCommand(['wait', '--team', 'no-such-team', '--json'], {
        context,
        orchestratorFactory: () => orch,
        stdout: () => undefined,
        stderr: (value) => { stderr += value; },
        waitRuntime: { sleep: async () => undefined },
      });
      expect(code).toBe(1);
      expect(stderr).toContain('E_NOT_FOUND');
    } finally {
      fixture.cleanup();
    }
  });

  test('all terminal tasks stop with converged and exit 0', async () => {
    const { fixture, store, orch, teamId, context } = await seededWaitTeam();
    try {
      await completeInspect(store);
      const result = await orch.waitForConvergence(teamId, {
        pollIntervalMs: 50,
        sleep: async () => {
          throw new Error('converged wait must not sleep');
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.stopped_by).toBe('converged');
      expect(result.value.iterations).toBe(1);
      expect(result.value.tasks.inspect.status).toBe('completed');

      let stdout = '';
      const code = await teamCommand(['wait', '--team', teamId, '--json'], {
        context,
        orchestratorFactory: () => orch,
        stdout: (value) => { stdout += value; },
        stderr: () => undefined,
        waitRuntime: { sleep: async () => undefined },
      });
      expect(code).toBe(0);
      const body = JSON.parse(stdout) as {
        ok: boolean;
        kind: string;
        stopped_by: string;
        tasks: { inspect: { status: string } };
      };
      expect(body).toEqual(expect.objectContaining({
        ok: true,
        kind: 'team-wait',
        stopped_by: 'converged',
      }));
      expect(body.tasks.inspect.status).toBe('completed');
    } finally {
      fixture.cleanup();
    }
  });

  test('timeout is non-zero, does not tick/stop, and leaves state untouched', async () => {
    const { fixture, store, orch, teamId, context, aggregatePath } = await seededWaitTeam();
    try {
      const before = fs.readFileSync(aggregatePath);
      const tick = jest.spyOn(orch, 'tick');
      const stop = jest.spyOn(orch, 'stop');
      const supervise = jest.spyOn(orch, 'superviseOnce');
      const reclaim = jest.spyOn(orch, 'reclaimTask');
      let now = 1_000;
      const result = await orch.waitForConvergence(teamId, {
        timeoutMs: 200,
        pollIntervalMs: 50,
        nowMs: () => now,
        sleep: async (milliseconds) => { now += milliseconds; },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.stopped_by).toBe('timeout');
      expect(result.value.tasks.inspect.status).toBe('pending');
      expect(tick).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(supervise).not.toHaveBeenCalled();
      expect(reclaim).not.toHaveBeenCalled();
      expect(fs.readFileSync(aggregatePath)).toEqual(before);
      expect(store.read().ok).toBe(true);

      let stdout = '';
      now = 1_000;
      const code = await teamCommand([
        'wait', '--team', teamId, '--timeout-ms', '200', '--poll-interval-ms', '50', '--json',
      ], {
        context,
        orchestratorFactory: () => orch,
        stdout: (value) => { stdout += value; },
        stderr: () => undefined,
        waitRuntime: {
          nowMs: () => now,
          sleep: async (milliseconds) => { now += milliseconds; },
        },
      });
      expect(code).toBe(1);
      expect(code).not.toBe(0);
      const body = JSON.parse(stdout) as { ok: boolean; stopped_by: string };
      expect(body.stopped_by).toBe('timeout');
      expect(body.ok).toBe(false);
      expect(fs.readFileSync(aggregatePath)).toEqual(before);
    } finally {
      fixture.cleanup();
    }
  });

  test('hard iteration cap applies even when timeout is huge', async () => {
    const { fixture, orch, teamId } = await seededWaitTeam();
    try {
      let sleeps = 0;
      const result = await orch.waitForConvergence(teamId, {
        timeoutMs: Number.MAX_SAFE_INTEGER,
        pollIntervalMs: 50,
        maxIterations: 3,
        sleep: async () => { sleeps += 1; },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.stopped_by).toBe('timeout');
      expect(result.value.iterations).toBe(3);
      expect(result.value.iterations).toBeLessThanOrEqual(HUD_WATCH_MAX_ITERATIONS);
      expect(sleeps).toBe(2);
    } finally {
      fixture.cleanup();
    }
  });

  test('orchestrator rejects poll interval outside HUD bounds', async () => {
    const { fixture, orch, teamId } = await seededWaitTeam();
    try {
      const rejected = await orch.waitForConvergence(teamId, {
        pollIntervalMs: 49,
        sleep: async () => undefined,
      });
      expect(rejected.ok).toBe(false);
      if (rejected.ok) return;
      expect(rejected.error.code).toBe('E_VALIDATOR_REJECTED');
    } finally {
      fixture.cleanup();
    }
  });

  test('wait is read-only: external completion is observed without mutating between polls', async () => {
    const { fixture, store, orch, teamId, aggregatePath } = await seededWaitTeam();
    try {
      let polls = 0;
      const result = await orch.waitForConvergence(teamId, {
        pollIntervalMs: 50,
        timeoutMs: 5_000,
        sleep: async () => {
          polls += 1;
          if (polls === 1) await completeInspect(store);
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.stopped_by).toBe('converged');
      expect(result.value.iterations).toBeGreaterThanOrEqual(2);
      expect(result.value.tasks.inspect.status).toBe('completed');
      const after = JSON.parse(fs.readFileSync(aggregatePath, 'utf8')) as {
        value: { tasks: { inspect: { status: string } } };
      };
      expect(after.value.tasks.inspect.status).toBe('completed');
    } finally {
      fixture.cleanup();
    }
  });

  test('abort during sleep returns aborted and clears the timer', async () => {
    const { fixture, orch, teamId, aggregatePath } = await seededWaitTeam();
    try {
      const before = fs.readFileSync(aggregatePath);
      const controller = new AbortController();
      const activeTimers = new Set<NodeJS.Timeout>();
      let enteredSleep!: () => void;
      const slept = new Promise<void>((resolve) => { enteredSleep = resolve; });
      const pending = orch.waitForConvergence(teamId, {
        pollIntervalMs: 50,
        timeoutMs: 60_000,
        signal: controller.signal,
        sleep: (milliseconds, signal) => {
          enteredSleep();
          return new Promise((resolve, reject) => {
            const finish = () => {
              if (signal !== undefined) signal.removeEventListener('abort', abort);
              activeTimers.delete(timer);
              resolve();
            };
            const timer = setTimeout(finish, milliseconds);
            activeTimers.add(timer);
            const abort = () => {
              clearTimeout(timer);
              activeTimers.delete(timer);
              signal?.removeEventListener('abort', abort);
              reject(new Error('aborted'));
            };
            if (signal === undefined) return;
            if (signal.aborted) abort();
            else signal.addEventListener('abort', abort, { once: true });
          });
        },
      });
      await slept;
      controller.abort();
      const result = await pending;
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.stopped_by).toBe('aborted');
      expect(activeTimers.size).toBe(0);
      expect(fs.readFileSync(aggregatePath)).toEqual(before);
    } finally {
      fixture.cleanup();
    }
  });

  test('SIGINT attachAbort stops with aborted, exit 130, and detaches the handler', async () => {
    const { fixture, orch, teamId, context } = await seededWaitTeam();
    try {
      const listeners: Array<() => void> = [];
      let enteredSleep!: () => void;
      const slept = new Promise<void>((resolve) => { enteredSleep = resolve; });
      let stdout = '';
      const pending = teamCommand([
        'wait', '--team', teamId, '--timeout-ms', '5000', '--poll-interval-ms', '50', '--json',
      ], {
        context,
        orchestratorFactory: () => orch,
        stdout: (value) => { stdout += value; },
        stderr: () => undefined,
        waitRuntime: {
          attachAbort: (abort) => {
            listeners.push(abort);
            return () => { listeners.length = 0; };
          },
          sleep: (milliseconds, signal) => {
            enteredSleep();
            return boundedSleep(milliseconds, signal);
          },
        },
      });
      await slept;
      expect(listeners).toHaveLength(1);
      listeners[0]!();
      const code = await pending;
      expect(code).toBe(130);
      expect(listeners).toHaveLength(0);
      const body = JSON.parse(stdout) as { stopped_by: string; ok: boolean };
      expect(body.stopped_by).toBe('aborted');
      expect(body.ok).toBe(false);
    } finally {
      fixture.cleanup();
    }
  });

  test('production SIGINT listener is removed after an already-converged wait', async () => {
    const { fixture, store, orch, teamId, context } = await seededWaitTeam();
    try {
      await completeInspect(store);
      const before = process.listenerCount('SIGINT');
      const code = await teamCommand(['wait', '--team', teamId, '--json'], {
        context,
        orchestratorFactory: () => orch,
        stdout: () => undefined,
        stderr: () => undefined,
      });
      expect(code).toBe(0);
      expect(process.listenerCount('SIGINT')).toBe(before);
    } finally {
      fixture.cleanup();
    }
  });
});
