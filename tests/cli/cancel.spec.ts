import * as fs from 'fs';
import * as path from 'path';
import { parseCliArguments } from '../../src/cli/parser';
import { CLI_HELP, runCli } from '../../src/cli/application';
import { createDefaultServices } from '../../src/cli/services';
import {
  CANCEL_DEFAULT_REASON,
  CANCEL_NO_TARGET_MESSAGE,
  CANCEL_USAGE,
  cancelManagedSession,
  cancelManagedTeam,
  parseCancelArgv,
  runCancelCommand,
} from '../../src/cli/cancel-command';
import {
  listManagedSessions,
  runSessionListCommand,
} from '../../src/cli/session-commands';
import {
  createInitialSessionAggregate,
  SessionAggregateStore,
  sessionAggregateRelativePath,
  SessionAggregateV1,
} from '../../src/continuation/session-aggregate';
import { canonicalJsonV1 } from '../../src/contracts/state-schemas';
import { sha256 } from '../../src/runtime/atomic';
import { TeamStateStore } from '../../src/team/state';
import { CanonicalTeamManifestV1, TeamAggregateV1 } from '../../src/team/types';
import { createStateFixture, StateFixture } from '../helpers/state-fixture';

const packageRoot = path.resolve(__dirname, '../..');
const FIXED_NOW = new Date('2026-08-24T00:00:00.000Z');

function fingerprintStateRoot(root: string): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        parts.push(`D:${relative}`);
        walk(full);
      } else if (entry.isFile()) {
        parts.push(`F:${relative}:${fs.readFileSync(full).toString('hex')}`);
      }
    }
  };
  if (fs.existsSync(root)) walk(root);
  return parts.join('\n');
}

async function seedSession(
  fixture: StateFixture,
  workspaceKey: string,
  sessionId: string,
  phase: 'deep-interview' | 'ralplan' | 'completed' | 'cancelled' = 'ralplan',
): Promise<SessionAggregateStore> {
  const sessionPath = fixture.path(sessionAggregateRelativePath(workspaceKey, sessionId));
  const store = new SessionAggregateStore(sessionPath);
  const initialized = await store.initialize(createInitialSessionAggregate({
    sessionId,
    repoKey: null,
    workspaceKey,
    launchNonceDigest: sha256(`nonce-${sessionId}`),
    phase: phase === 'completed' || phase === 'cancelled' ? 'deep-interview' : phase,
  }));
  if (!initialized.ok) throw new Error(initialized.error.message);
  if (phase === 'completed' || phase === 'cancelled') {
    const updated = await store.compareAndSwap(initialized.value.revision, (snapshot) => ({
      ...snapshot,
      revision: snapshot.revision + 1,
      autopilot: {
        ...snapshot.autopilot,
        phase,
        terminal: {
          phase,
          reason: phase === 'cancelled' ? 'already-cancelled' : 'done',
          actor: 'test',
          actorNonce: 'nonce',
          evidenceDigest: sha256('evidence'),
          at: '2026-08-17T00:00:00.000Z',
        },
      },
    }));
    if (!updated.ok) throw new Error(updated.error.message);
  }
  return store;
}

const TEAM_MANIFEST: CanonicalTeamManifestV1 = {
  schema: 'oma.team-manifest/v1',
  teamId: 'team-alpha',
  revision: 1,
  repoRoot: '/tmp',
  tasks: [{
    id: 'inspect',
    dependencies: [],
    mode: 'headless',
    write_scope: 'none',
    verification: { version: 1, commands: [], requiredArtifacts: [] },
  }],
};

async function seedTeam(
  fixture: StateFixture,
  teamId = 'team-alpha',
  repoKey: string | null = 'repo',
  workspaceKey = 'workspace-a',
): Promise<TeamStateStore> {
  const store = new TeamStateStore(fixture.root, repoKey, workspaceKey, teamId);
  const created = await store.create({ ...TEAM_MANIFEST, teamId }, 'owner-nonce');
  if (!created.ok) throw new Error(created.error.message);
  return store;
}

function captureIo() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: (value: string) => { stdout += value; },
    stderr: (value: string) => { stderr += value; },
    output: () => ({ stdout, stderr }),
  };
}

function cancelContext(fixture: StateFixture, io: ReturnType<typeof captureIo>) {
  return {
    cwd: fixture.root,
    stateRoot: fixture.root,
    environment: { HOME: fixture.root, OMA_STATE_ROOT: fixture.root },
    now: () => FIXED_NOW,
    stdout: io.stdout,
    stderr: io.stderr,
  };
}

describe('oma cancel parser', () => {
  test('parseCliArguments routes cancel as extended and leaves autopilot cancel on the autopilot verb', () => {
    expect(parseCliArguments(['cancel'])).toEqual({
      kind: 'extended',
      command: 'cancel',
      args: [],
    });
    expect(parseCliArguments([
      'cancel', '--session', 's1', '--workspace-key', 'ws', '--reason', 'stop',
    ])).toEqual({
      kind: 'extended',
      command: 'cancel',
      args: ['--session', 's1', '--workspace-key', 'ws', '--reason', 'stop'],
    });
    expect(parseCliArguments([
      'autopilot', 'cancel', '--session', 's1', '--expected-revision', '4', '--reason', 'operator',
    ])).toEqual({
      kind: 'autopilot',
      args: ['cancel', '--session', 's1', '--expected-revision', '4', '--reason', 'operator'],
    });
  });

  test('parseCancelArgv accepts the public flag surface and rejects malformed pairs', () => {
    expect(parseCancelArgv([])).toEqual({
      ok: true,
      value: {
        kind: 'run',
        options: {
          asJson: false,
          sessionId: undefined,
          workspaceKey: undefined,
          teamId: undefined,
          all: false,
          reason: CANCEL_DEFAULT_REASON,
        },
      },
    });
    expect(parseCancelArgv(['--help'])).toEqual({ ok: true, value: { kind: 'help' } });
    expect(parseCancelArgv(['-h'])).toEqual({ ok: true, value: { kind: 'help' } });
    const parsed = parseCancelArgv([
      '--session', 's1', '--workspace-key', 'ws', '--team', 't1',
      '--reason', 'stop now', '--json',
    ]);
    expect(parsed).toEqual({
      ok: true,
      value: {
        kind: 'run',
        options: {
          asJson: true,
          sessionId: 's1',
          workspaceKey: 'ws',
          teamId: 't1',
          all: false,
          reason: 'stop now',
        },
      },
    });
    const all = parseCancelArgv(['--all', '--reason', 'bulk']);
    expect(all).toEqual({
      ok: true,
      value: {
        kind: 'run',
        options: {
          asJson: false,
          sessionId: undefined,
          workspaceKey: undefined,
          teamId: undefined,
          all: true,
          reason: 'bulk',
        },
      },
    });

    for (const argv of [
      ['--session', 's1'],
      ['--workspace-key', 'ws'],
      ['--session', 's1', '--workspace-key'],
      ['--all', '--session', 's1', '--workspace-key', 'ws'],
      ['--all', '--team', 't1'],
      ['--reason', ''],
      ['--reason'],
      ['--json', '--json'],
      ['--unknown'],
      ['--session', 's1', '--workspace-key', 'ws\0x'],
    ]) {
      const rejected = parseCancelArgv(argv);
      expect(rejected.ok).toBe(false);
      if (rejected.ok) return;
      expect(rejected.error.code).toBe('E_VALIDATOR_REJECTED');
    }
  });
});

describe('oma cancel command', () => {
  test('no target and no active session prints a readable no-op and exits 0', async () => {
    const fixture = createStateFixture('oma-cancel-empty-');
    const io = captureIo();
    try {
      const before = fingerprintStateRoot(fixture.root);
      const code = await runCancelCommand([], cancelContext(fixture, io));
      expect(code).toBe(0);
      expect(io.output().stderr).toBe('');
      expect(io.output().stdout).toContain(CANCEL_NO_TARGET_MESSAGE);
      expect(fingerprintStateRoot(fixture.root)).toBe(before);
    } finally {
      fixture.cleanup();
    }
  });

  test('--json no-op is canonical and --help prints usage with exit 0', async () => {
    const fixture = createStateFixture('oma-cancel-help-');
    try {
      const jsonIo = captureIo();
      const jsonCode = await runCancelCommand(['--json'], cancelContext(fixture, jsonIo));
      expect(jsonCode).toBe(0);
      const body = JSON.parse(jsonIo.output().stdout) as {
        ok: boolean;
        noop: boolean;
        message: string;
      };
      expect(body).toEqual(expect.objectContaining({
        ok: true,
        kind: 'oma-cancelled',
        schema_version: 1,
        noop: true,
        message: CANCEL_NO_TARGET_MESSAGE,
      }));
      expect(canonicalJsonV1(body)).toBe(jsonIo.output().stdout.trim());

      const helpIo = captureIo();
      const helpCode = await runCancelCommand(['--help'], cancelContext(fixture, helpIo));
      expect(helpCode).toBe(0);
      expect(helpIo.output().stdout).toContain(CANCEL_USAGE);
      expect(helpIo.output().stderr).toBe('');
    } finally {
      fixture.cleanup();
    }
  });

  test('--all with no active target is the same no-op', async () => {
    const fixture = createStateFixture('oma-cancel-all-empty-');
    const io = captureIo();
    try {
      await seedSession(fixture, 'workspace-a', 'done-session', 'completed');
      const before = fingerprintStateRoot(fixture.root);
      const code = await runCancelCommand(['--all'], cancelContext(fixture, io));
      expect(code).toBe(0);
      expect(io.output().stdout).toContain(CANCEL_NO_TARGET_MESSAGE);
      expect(fingerprintStateRoot(fixture.root)).toBe(before);
    } finally {
      fixture.cleanup();
    }
  });

  test('--session --workspace-key CAS-deactivates the session and session list shows terminal cancelled', async () => {
    const fixture = createStateFixture('oma-cancel-session-');
    const io = captureIo();
    try {
      await seedSession(fixture, 'workspace-a', 'session-alpha', 'ralplan');
      const code = await runCancelCommand([
        '--session', 'session-alpha',
        '--workspace-key', 'workspace-a',
        '--reason', 'operator stop',
        '--json',
      ], cancelContext(fixture, io));
      expect(code).toBe(0);
      expect(io.output().stderr).toBe('');
      const body = JSON.parse(io.output().stdout) as {
        noop: boolean;
        sessions: Array<{ session_id: string; revision: number; phase: string }>;
      };
      expect(body.noop).toBe(false);
      expect(body.sessions).toEqual([expect.objectContaining({
        session_id: 'session-alpha',
        workspace_key: 'workspace-a',
        revision: 1,
        phase: 'cancelled',
      })]);

      const listed = listManagedSessions({
        stateRoot: fixture.root,
        workspaceKey: 'workspace-a',
      });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.sessions).toEqual([expect.objectContaining({
        session_id: 'session-alpha',
        phase: 'cancelled',
        revision: 1,
        terminal: true,
        last_event_utc: '2026-08-24T00:00:00.000Z',
      })]);

      const listIo = captureIo();
      expect(runSessionListCommand(['list', '--json', '--workspace-key', 'workspace-a'], {
        cwd: fixture.root,
        stateRoot: fixture.root,
        environment: { HOME: fixture.root, OMA_STATE_ROOT: fixture.root },
        stdout: listIo.stdout,
        stderr: listIo.stderr,
      })).toBe(0);
      const listBody = JSON.parse(listIo.output().stdout) as {
        sessions: Array<{ phase: string; terminal: boolean }>;
      };
      expect(listBody.sessions[0]).toEqual(expect.objectContaining({
        phase: 'cancelled',
        terminal: true,
      }));

      const aggregate = new SessionAggregateStore(
        fixture.path(sessionAggregateRelativePath('workspace-a', 'session-alpha')),
      ).read() as { ok: true; value: SessionAggregateV1 };
      expect(aggregate.value.autopilot.terminal).toEqual(expect.objectContaining({
        phase: 'cancelled',
        reason: 'operator stop',
        actor: 'operator',
        at: '2026-08-24T00:00:00.000Z',
      }));
    } finally {
      fixture.cleanup();
    }
  });

  test('stale expected revision returns E_REVISION_CONFLICT and does not blind-write', async () => {
    const fixture = createStateFixture('oma-cancel-cas-');
    try {
      const store = await seedSession(fixture, 'workspace-a', 'session-alpha', 'ralplan');
      const bumped = await store.compareAndSwap(0, (snapshot) => ({
        ...snapshot,
        revision: snapshot.revision + 1,
      }));
      if (!bumped.ok) throw new Error(bumped.error.message);
      const before = fingerprintStateRoot(fixture.root);
      const result = await cancelManagedSession({
        stateRoot: fixture.root,
        workspaceKey: 'workspace-a',
        sessionId: 'session-alpha',
        expectedRevision: 0,
        reason: 'stale',
        now: FIXED_NOW,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('E_REVISION_CONFLICT');
      expect(fingerprintStateRoot(fixture.root)).toBe(before);
      const current = store.read();
      expect(current.ok).toBe(true);
      if (!current.ok) return;
      expect(current.value.revision).toBe(1);
      expect(current.value.autopilot.phase).toBe('ralplan');
      expect(current.value.autopilot.terminal).toBeNull();
    } finally {
      fixture.cleanup();
    }
  });

  test('stale team revision is the same CAS reject', async () => {
    const fixture = createStateFixture('oma-cancel-team-cas-');
    try {
      const store = await seedTeam(fixture);
      const bumped = await store.sendMailbox(0, {
        schemaVersion: 1,
        id: 'm1',
        sender: 'leader',
        recipient: 'worker-a',
        bodyDigest: sha256('a'),
        createdAtMs: 1,
      });
      if (!bumped.ok) throw new Error(bumped.error.message);
      const before = fingerprintStateRoot(fixture.root);
      const result = await cancelManagedTeam({
        stateRoot: fixture.root,
        repoKey: 'repo',
        workspaceKey: 'workspace-a',
        teamId: 'team-alpha',
        expectedRevision: 0,
        reason: 'stale-team',
        now: FIXED_NOW,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('E_REVISION_CONFLICT');
      expect(fingerprintStateRoot(fixture.root)).toBe(before);
      const current = store.read();
      expect(current.ok).toBe(true);
      if (!current.ok) return;
      expect(current.value.revision).toBe(1);
      expect(current.value.value.tasks.inspect?.status).toBe('pending');
    } finally {
      fixture.cleanup();
    }
  });

  test('--team only stops the team; --session only stops the session', async () => {
    const fixture = createStateFixture('oma-cancel-isolation-');
    try {
      await seedSession(fixture, 'workspace-a', 'session-alpha', 'ralplan');
      const team = await seedTeam(fixture);
      const sessionOnly = captureIo();
      expect(await runCancelCommand([
        '--session', 'session-alpha', '--workspace-key', 'workspace-a',
      ], cancelContext(fixture, sessionOnly))).toBe(0);
      const afterSession = team.read();
      expect(afterSession.ok).toBe(true);
      if (!afterSession.ok) return;
      expect(afterSession.value.value.tasks.inspect?.status).toBe('pending');
      expect(afterSession.value.revision).toBe(0);
      const sessionStore = new SessionAggregateStore(
        fixture.path(sessionAggregateRelativePath('workspace-a', 'session-alpha')),
      );
      const cancelledSession = sessionStore.read();
      expect(cancelledSession.ok).toBe(true);
      if (!cancelledSession.ok) return;
      expect(cancelledSession.value.autopilot.phase).toBe('cancelled');

      const teamOnly = captureIo();
      expect(await runCancelCommand(['--team', 'team-alpha'], cancelContext(fixture, teamOnly))).toBe(0);
      const afterTeam = team.read();
      expect(afterTeam.ok).toBe(true);
      if (!afterTeam.ok) return;
      expect(afterTeam.value.value.tasks.inspect?.status).toBe('cancelled');
      expect(afterTeam.value.revision).toBe(1);
      const sessionUnchanged = sessionStore.read() as { ok: true; value: SessionAggregateV1 };
      expect(sessionUnchanged.value.revision).toBe(cancelledSession.value.revision);
      expect(sessionUnchanged.value.autopilot.phase).toBe('cancelled');
    } finally {
      fixture.cleanup();
    }
  });

  test('--all cancels active session and team together', async () => {
    const fixture = createStateFixture('oma-cancel-all-');
    const io = captureIo();
    try {
      await seedSession(fixture, 'workspace-a', 'session-alpha', 'deep-interview');
      await seedTeam(fixture);
      const code = await runCancelCommand(
        ['--all', '--reason', 'stop-all', '--json'],
        cancelContext(fixture, io),
      );
      expect(code).toBe(0);
      const body = JSON.parse(io.output().stdout) as {
        noop: boolean;
        sessions: unknown[];
        teams: unknown[];
      };
      expect(body.noop).toBe(false);
      expect(body.sessions).toHaveLength(1);
      expect(body.teams).toHaveLength(1);
      const listed = listManagedSessions({ stateRoot: fixture.root });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.sessions[0]).toEqual(expect.objectContaining({
        phase: 'cancelled',
        terminal: true,
      }));
    } finally {
      fixture.cleanup();
    }
  });

  test('CLI wiring through extendedCommand matches the dedicated runner', async () => {
    const fixture = createStateFixture('oma-cancel-cli-');
    try {
      await seedSession(fixture, 'workspace-a', 'session-alpha');
      let stdout = '';
      let stderr = '';
      const services = createDefaultServices({
        packageRoot,
        cwd: fixture.root,
        stateRoot: fixture.root,
        agyCommand: path.join(fixture.root, 'missing-agy'),
        pluginAdapter: {
          run: async (argv: readonly string[]) => ({ argv: [...argv], code: 1, stdout: '', stderr: '' }),
        },
        environment: { PATH: fixture.root, HOME: fixture.root, OMA_STATE_ROOT: fixture.root },
        stdout: (value) => { stdout += value; },
        stderr: (value) => { stderr += value; },
      });
      const code = await services.extendedCommand('cancel', [
        '--session', 'session-alpha', '--workspace-key', 'workspace-a', '--json',
      ]);
      expect(code).toBe(0);
      expect(stderr).toBe('');
      const body = JSON.parse(stdout) as { sessions: Array<{ phase: string }> };
      expect(body.sessions[0]?.phase).toBe('cancelled');
    } finally {
      fixture.cleanup();
    }
  });

  test('help documents top-level oma cancel and keeps autopilot cancel', async () => {
    expect(CLI_HELP).toContain(
      'oma cancel [--session <id> --workspace-key <key>] [--team <id>] [--all] [--reason <text>] [--json]',
    );
    expect(CLI_HELP).toContain(
      'oma autopilot cancel --session <id> --expected-revision <n> --reason <text>',
    );
    let stdout = '';
    const code = await runCli(['--help'], createDefaultServices({
      packageRoot,
      cwd: packageRoot,
      stdout: (value) => { stdout += value; },
      stderr: () => undefined,
    }), {
      stdout: (value) => { stdout += value; },
      stderr: () => undefined,
    });
    expect(code).toBe(0);
    expect(stdout).toContain('oma cancel [--session <id> --workspace-key <key>]');
  });

  test('cancel-command source never contains destructive git argv', () => {
    const source = fs.readFileSync(path.join(packageRoot, 'src/cli/cancel-command.ts'), 'utf8');
    expect(source).not.toContain('git reset --hard');
    expect(source).not.toContain('git clean -fd');
    expect(source).toMatch(/OMC|OMX|OMG/);
  });

  test('skills/cancel tells the agent to call oma cancel and never to hand-edit state.json', () => {
    const skill = fs.readFileSync(path.join(packageRoot, 'skills/cancel/SKILL.md'), 'utf8');
    expect(skill).toContain('oma cancel');
    expect(skill).not.toMatch(/active:\s*false/);
    expect(skill).not.toMatch(/hand-edit/i);
    expect(skill).not.toContain('.agy/autopilot/state.json');
  });

  test('team cancel record keeps reason and UTC timestamp without mutating a peer session', async () => {
    const fixture = createStateFixture('oma-cancel-team-record-');
    try {
      await seedSession(fixture, 'workspace-a', 'session-alpha', 'ralplan');
      await seedTeam(fixture);
      const beforeSession = fingerprintStateRoot(
        path.dirname(fixture.path(sessionAggregateRelativePath('workspace-a', 'session-alpha'))),
      );
      const result = await cancelManagedTeam({
        stateRoot: fixture.root,
        repoKey: 'repo',
        workspaceKey: 'workspace-a',
        teamId: 'team-alpha',
        expectedRevision: 0,
        reason: 'team-stop',
        now: FIXED_NOW,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual(expect.objectContaining({
        team_id: 'team-alpha',
        revision: 1,
        reason: 'team-stop',
        cancelled_at: '2026-08-24T00:00:00.000Z',
      }));
      const store = new TeamStateStore(fixture.root, 'repo', 'workspace-a', 'team-alpha');
      const snapshot = store.read() as { ok: true; value: { revision: number; value: TeamAggregateV1 } };
      expect(snapshot.value.value.tasks.inspect?.status).toBe('cancelled');
      expect(fingerprintStateRoot(
        path.dirname(fixture.path(sessionAggregateRelativePath('workspace-a', 'session-alpha'))),
      )).toBe(beforeSession);
    } finally {
      fixture.cleanup();
    }
  });
});
