import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { CLI_HELP } from '../../src/cli/application';
import { parseTeamCommand, teamCommand } from '../../src/team/commands';
import {
  DEFAULT_CAPTURE_LINES,
  MAX_CAPTURE_LINES,
  TmuxSpawnFn,
  capturePane,
  listOwnedPanes,
  parseCaptureLineCount,
  printAttachArgv,
} from '../../src/team/pane-observe';
import { TeamStateStore } from '../../src/team/state';
import { validateTeamManifest } from '../../src/team/manifest';
import { RuntimeContext, SupervisorHeartbeatV1 } from '../../src/team/types';
import { GitFixture } from '../helpers/git-fixture';

const OWNER = 'owner-nonce';
const PANE = '%9';
const SESSION = 'oma-alpha-task-a-g1';
const SECRET = 'super-secret-token';

interface FakeTmuxOptions {
  ownerNonce?: string;
  capture?: string;
  missing?: boolean;
  livePanes?: string;
}

function createFakeTmux(options: FakeTmuxOptions = {}): {
  calls: string[][];
  spawn: TmuxSpawnFn;
} {
  const calls: string[][] = [];
  return {
    calls,
    spawn: (argv) => {
      calls.push([...argv]);
      if (options.missing) {
        return {
          status: null,
          stdout: '',
          stderr: '',
          error: { code: 'ENOENT', message: 'spawnSync tmux ENOENT' },
        };
      }
      const command = argv[0];
      if (command === 'show-options') {
        return { status: 0, stdout: `${options.ownerNonce ?? OWNER}\n`, stderr: '' };
      }
      if (command === 'capture-pane') {
        return { status: 0, stdout: options.capture ?? 'hello pane\n', stderr: '' };
      }
      if (command === 'list-panes') {
        return { status: 0, stdout: `${options.livePanes ?? PANE}\n`, stderr: '' };
      }
      return { status: 1, stdout: '', stderr: `unexpected tmux ${command}` };
    },
  };
}

function fingerprintTree(root: string): string {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(root);
  files.sort();
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(root, file));
    hash.update('\0');
    hash.update(fs.readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function heartbeat(): SupervisorHeartbeatV1 {
  return {
    schemaVersion: 1,
    workerId: 'task-a',
    ownerNonce: OWNER,
    workerNonce: 'worker-nonce',
    process: { pid: 123, startMarker: `tmux:${SESSION}` },
    paneId: PANE,
    recordedAtMs: 1500,
  };
}

async function seedTeam(fixture: GitFixture): Promise<{
  store: TeamStateStore;
  context: RuntimeContext;
}> {
  fs.writeFileSync(path.join(fixture.repo, 'worker.txt'), 'untouched\n');
  const manifest = validateTeamManifest({
    schema: 'oma.team-manifest/v1',
    teamId: 'alpha',
    revision: 1,
    tasks: [{
      id: 'task-a',
      dependencies: [],
      write_scope: 'none',
      mode: 'read_only',
      verification: { version: 1, commands: [], requiredArtifacts: [] },
    }],
  }, fixture.repo);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const store = new TeamStateStore(fixture.stateRoot, 'repo-key', 'workspace-key', 'alpha');
  const created = await store.create(manifest.value, OWNER);
  if (!created.ok) throw new Error(created.error.message);
  const claimed = await store.claimTask('task-a', 'worker-a', created.value.revision, 1000, 5_000, 'claim-1');
  if (!claimed.ok) throw new Error(claimed.error.message);
  const recorded = await store.recordHeartbeat(claimed.value.revision, heartbeat());
  if (!recorded.ok) throw new Error(recorded.error.message);
  return {
    store,
    context: {
      stateRoot: fixture.stateRoot,
      workspaceRoot: fixture.repo,
      repoKey: 'repo-key',
      workspaceKey: 'workspace-key',
    },
  };
}

describe('parseCaptureLineCount / team capture --lines', () => {
  test('CLI_HELP documents read-only pane observe verbs', () => {
    expect(CLI_HELP).toContain('oma team panes --team <id>');
    expect(CLI_HELP).toContain('oma team capture --team <id> --task <id> [--lines 1..2000]');
    expect(CLI_HELP).toContain('oma team view --team <id> [--task <id>] --print-argv');
  });

  test('defaults to 200 and accepts 1..2000 inclusive', () => {
    expect(DEFAULT_CAPTURE_LINES).toBe(200);
    expect(MAX_CAPTURE_LINES).toBe(2000);
    expect(parseCaptureLineCount('1')).toEqual({ ok: true, value: 1 });
    expect(parseCaptureLineCount('200')).toEqual({ ok: true, value: 200 });
    expect(parseCaptureLineCount('2000')).toEqual({ ok: true, value: 2000 });
    expect(parseTeamCommand(['capture', '--team', 'alpha', '--task', 'task-a'])).toEqual({
      ok: true,
      value: {
        kind: 'capture',
        teamId: 'alpha',
        taskId: 'task-a',
        lines: 200,
      },
    });
    expect(parseTeamCommand(['panes', '--team', 'alpha'])).toEqual({
      ok: true,
      value: { kind: 'panes', teamId: 'alpha' },
    });
    expect(parseTeamCommand(['view', '--team', 'alpha', '--print-argv'])).toEqual({
      ok: true,
      value: { kind: 'view', teamId: 'alpha', printArgv: true },
    });
  });

  test.each(['0', '2001', 'abc', '1.5', '-1', '+200', '2e3'])(
    'rejects --lines %s with E_VALIDATOR_REJECTED',
    (raw) => {
      const lines = parseCaptureLineCount(raw);
      expect(lines.ok).toBe(false);
      if (lines.ok) return;
      expect(lines.error.code).toBe('E_VALIDATOR_REJECTED');
      const parsed = parseTeamCommand([
        'capture', '--team', 'alpha', '--task', 'task-a', '--lines', raw,
      ]);
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.error.code).toBe('E_VALIDATOR_REJECTED');
    },
  );

  test('rejects --raw and unknown observe flags', () => {
    const raw = parseTeamCommand([
      'capture', '--team', 'alpha', '--task', 'task-a', '--raw', 'true',
    ]);
    expect(raw.ok).toBe(false);
    if (!raw.ok) expect(raw.error.code).toBe('E_VALIDATOR_REJECTED');
    const view = parseTeamCommand(['view', '--team', 'alpha']);
    expect(view.ok).toBe(false);
    if (!view.ok) expect(view.error.code).toBe('E_VALIDATOR_REJECTED');
  });
});

describe('capturePane adapter', () => {
  test('strips ANSI then redacts secrets; default -S -200', () => {
    const fake = createFakeTmux({
      capture: `\u001b[31mred\u001b[0m token=${SECRET} Authorization: Bearer ${SECRET}\n`,
    });
    const result = capturePane({
      pane: PANE,
      sessionName: SESSION,
      expectedOwnerNonce: OWNER,
      spawn: fake.spawn,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.lines).toBe(200);
    expect(result.value.text).not.toContain('\u001b[');
    expect(result.value.text).not.toContain(SECRET);
    expect(result.value.text).toContain('<redacted>');
    expect(fake.calls[0]).toEqual(['show-options', '-v', '-t', SESSION, '@oma_owner_nonce']);
    expect(fake.calls[1]).toEqual(['capture-pane', '-p', '-t', PANE, '-S', '-200']);
    expect(fake.calls.some((argv) => argv[0] === 'send-keys')).toBe(false);
    expect(fake.calls.every((argv) => argv.every((token) => !token.includes(' ')))).toBe(true);
  });

  test('nonce mismatch returns E_TMUX_OWNER_MISMATCH and never capture-pane', () => {
    const fake = createFakeTmux({
      ownerNonce: 'foreign-owner',
      capture: SECRET,
    });
    const result = capturePane({
      pane: PANE,
      sessionName: SESSION,
      expectedOwnerNonce: OWNER,
      spawn: fake.spawn,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_TMUX_OWNER_MISMATCH');
    expect(JSON.stringify(result.error)).not.toContain(SECRET);
    expect(fake.calls.some((argv) => argv[0] === 'capture-pane')).toBe(false);
    expect(fake.calls[0]?.[0]).toBe('show-options');
  });

  test('line bounds reject 0 and 2001 before any spawn', () => {
    const spawn = jest.fn();
    expect(capturePane({
      pane: PANE, sessionName: SESSION, expectedOwnerNonce: OWNER, lines: 0, spawn,
    }).ok).toBe(false);
    expect(capturePane({
      pane: PANE, sessionName: SESSION, expectedOwnerNonce: OWNER, lines: 2001, spawn,
    }).ok).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('tmux missing is a readable error and does not throw', () => {
    const fake = createFakeTmux({ missing: true });
    expect(() => capturePane({
      pane: PANE,
      sessionName: SESSION,
      expectedOwnerNonce: OWNER,
      spawn: fake.spawn,
    })).not.toThrow();
    const result = capturePane({
      pane: PANE,
      sessionName: SESSION,
      expectedOwnerNonce: OWNER,
      spawn: fake.spawn,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('E_RETRYABLE_BLOCKER');
    expect(result.error.message).toMatch(/tmux is not installed/i);
  });
});

describe('printAttachArgv / listOwnedPanes', () => {
  test('printAttachArgv returns argv and never spawns', () => {
    const spawn = jest.fn();
    const argv = printAttachArgv({ sessionName: SESSION, paneId: PANE });
    expect(argv).toEqual({
      ok: true,
      value: ['tmux', 'attach-session', '-t', SESSION, ';', 'select-pane', '-t', PANE],
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  test('listOwnedPanes proves owner nonce then inventories live panes', () => {
    const fake = createFakeTmux();
    const listed = listOwnedPanes({
      teamId: 'alpha',
      aggregate: {
        schemaVersion: 1,
        teamId: 'alpha',
        repoKey: 'repo-key',
        leaderWorkspaceKey: 'workspace-key',
        ownerNonce: OWNER,
        manifest: {
          schema: 'oma.team-manifest/v1',
          teamId: 'alpha',
          revision: 1,
          repoRoot: '/tmp',
          tasks: [],
        },
        tasks: {},
        heartbeats: { 'task-a': heartbeat() },
        mailbox: {},
      },
      spawn: fake.spawn,
    });
    expect(listed).toEqual({
      ok: true,
      value: [{ taskId: 'task-a', sessionName: SESSION, paneId: PANE }],
    });
    expect(fake.calls[0]).toEqual(['show-options', '-v', '-t', SESSION, '@oma_owner_nonce']);
    expect(fake.calls[1]).toEqual(['list-panes', '-t', SESSION, '-F', '#{pane_id}']);
    expect(fake.calls.some((argv) => argv[0] === 'capture-pane')).toBe(false);
  });

  test('listOwnedPanes nonce mismatch emits no pane rows', () => {
    const fake = createFakeTmux({ ownerNonce: 'other' });
    const listed = listOwnedPanes({
      teamId: 'alpha',
      aggregate: {
        schemaVersion: 1,
        teamId: 'alpha',
        repoKey: 'repo-key',
        leaderWorkspaceKey: 'workspace-key',
        ownerNonce: OWNER,
        manifest: {
          schema: 'oma.team-manifest/v1',
          teamId: 'alpha',
          revision: 1,
          repoRoot: '/tmp',
          tasks: [],
        },
        tasks: {},
        heartbeats: { 'task-a': heartbeat() },
        mailbox: {},
      },
      spawn: fake.spawn,
    });
    expect(listed.ok).toBe(false);
    if (listed.ok) return;
    expect(listed.error.code).toBe('E_TMUX_OWNER_MISMATCH');
    expect(fake.calls.some((argv) => argv[0] === 'list-panes')).toBe(false);
  });
});

describe('oma team panes|capture|view CLI', () => {
  let fixture: GitFixture;

  beforeEach(() => {
    fixture = GitFixture.create();
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test('panes lists nonce-proved owned panes as JSON', async () => {
    const { context } = await seedTeam(fixture);
    const fake = createFakeTmux();
    let stdout = '';
    const code = await teamCommand(['panes', '--team', 'alpha'], {
      context,
      stdout: (value) => { stdout += value; },
      stderr: () => undefined,
      tmuxSpawn: fake.spawn,
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      kind: 'team-panes',
      teamId: 'alpha',
      panes: [{ taskId: 'task-a', sessionName: SESSION, paneId: PANE }],
    });
    expect(fake.calls[0]?.[0]).toBe('show-options');
  });

  test('view --print-argv prints argv with zero spawn', async () => {
    const { context } = await seedTeam(fixture);
    const spawn = jest.fn();
    let stdout = '';
    let stderr = '';
    const code = await teamCommand(
      ['view', '--team', 'alpha', '--task', 'task-a', '--print-argv'],
      {
        context,
        stdout: (value) => { stdout += value; },
        stderr: (value) => { stderr += value; },
        tmuxSpawn: spawn,
      },
    );
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(spawn).not.toHaveBeenCalled();
    expect(JSON.parse(stdout)).toEqual({
      ok: true,
      kind: 'team-view-argv',
      teamId: 'alpha',
      taskId: 'task-a',
      argv: ['tmux', 'attach-session', '-t', SESSION, ';', 'select-pane', '-t', PANE],
    });
  });

  test('missing team view --print-argv is E_NOT_FOUND with zero spawn', async () => {
    const spawn = jest.fn();
    let stdout = '';
    let stderr = '';
    const code = await teamCommand(
      ['view', '--team', 'missing', '--print-argv'],
      {
        context: {
          stateRoot: fixture.stateRoot,
          workspaceRoot: fixture.repo,
          repoKey: 'repo-key',
          workspaceKey: 'workspace-key',
        },
        stdout: (value) => { stdout += value; },
        stderr: (value) => { stderr += value; },
        tmuxSpawn: spawn,
      },
    );
    expect(code).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/^E_NOT_FOUND:/);
    expect(spawn).not.toHaveBeenCalled();
  });

  test('panes, capture, and view leave team state and worktree byte-identical', async () => {
    const { context } = await seedTeam(fixture);
    const before = fingerprintTree(fixture.root);
    const fake = createFakeTmux({
      capture: `\u001b[32mok\u001b[0m token=${SECRET}\n`,
    });
    const io = { stdout: () => undefined, stderr: () => undefined };

    expect(await teamCommand(['panes', '--team', 'alpha'], {
      context, ...io, tmuxSpawn: fake.spawn,
    })).toBe(0);
    expect(await teamCommand(['capture', '--team', 'alpha', '--task', 'task-a'], {
      context, ...io, tmuxSpawn: fake.spawn,
    })).toBe(0);
    expect(await teamCommand(['view', '--team', 'alpha', '--print-argv'], {
      context, ...io, tmuxSpawn: fake.spawn,
    })).toBe(0);

    expect(fingerprintTree(fixture.root)).toBe(before);
    expect(fs.readFileSync(path.join(fixture.repo, 'worker.txt'), 'utf8')).toBe('untouched\n');
    expect(fake.calls.some((argv) => argv[0] === 'send-keys')).toBe(false);
  });

  test('CLI capture redacts pane text and nonce mismatch prints no content', async () => {
    const { context } = await seedTeam(fixture);
    const okFake = createFakeTmux({
      capture: `Authorization: Bearer ${SECRET}\n`,
    });
    let stdout = '';
    let stderr = '';
    const okCode = await teamCommand(
      ['capture', '--team', 'alpha', '--task', 'task-a', '--lines', '20'],
      {
        context,
        stdout: (value) => { stdout += value; },
        stderr: (value) => { stderr += value; },
        tmuxSpawn: okFake.spawn,
      },
    );
    expect(okCode).toBe(0);
    expect(stderr).toBe('');
    const body = JSON.parse(stdout);
    expect(body.kind).toBe('team-capture');
    expect(body.lines).toBe(20);
    expect(body.text).not.toContain(SECRET);
    expect(body.text).toContain('<redacted>');
    expect(okFake.calls.find((argv) => argv[0] === 'capture-pane')).toEqual(
      ['capture-pane', '-p', '-t', PANE, '-S', '-20'],
    );

    const bad = createFakeTmux({ ownerNonce: 'nope', capture: SECRET });
    stdout = '';
    stderr = '';
    const badCode = await teamCommand(
      ['capture', '--team', 'alpha', '--task', 'task-a'],
      {
        context,
        stdout: (value) => { stdout += value; },
        stderr: (value) => { stderr += value; },
        tmuxSpawn: bad.spawn,
      },
    );
    expect(badCode).toBe(1);
    expect(stdout).toBe('');
    expect(stderr).toMatch(/^E_TMUX_OWNER_MISMATCH:/);
    expect(stderr).not.toContain(SECRET);
    expect(bad.calls.some((argv) => argv[0] === 'capture-pane')).toBe(false);
  });

  test('CLI tmux-missing capture is readable and non-throwing', async () => {
    const { context } = await seedTeam(fixture);
    const fake = createFakeTmux({ missing: true });
    let stderr = '';
    const code = await teamCommand(
      ['capture', '--team', 'alpha', '--task', 'task-a'],
      {
        context,
        stdout: () => undefined,
        stderr: (value) => { stderr += value; },
        tmuxSpawn: fake.spawn,
      },
    );
    expect(code).toBe(1);
    expect(stderr).toMatch(/^E_RETRYABLE_BLOCKER: tmux is not installed/);
  });
});
