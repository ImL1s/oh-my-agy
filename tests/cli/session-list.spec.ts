import * as fs from 'fs';
import * as path from 'path';
import { createDefaultServices } from '../../src/cli/services';
import {
  listManagedSessions,
  parseSessionListArgv,
  renderSessionList,
  runSessionListCommand,
  SessionListProjectionV1,
} from '../../src/cli/session-commands';
import {
  createInitialSessionAggregate,
  SessionAggregateStore,
  sessionAggregateRelativePath,
} from '../../src/continuation/session-aggregate';
import { canonicalJsonV1 } from '../../src/contracts/state-schemas';
import { sha256 } from '../../src/runtime/atomic';
import { createStateFixture, StateFixture } from '../helpers/state-fixture';

const packageRoot = path.resolve(__dirname, '../..');

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
  phase?: 'deep-interview' | 'ralplan' | 'completed',
): Promise<string> {
  const sessionPath = fixture.path(sessionAggregateRelativePath(workspaceKey, sessionId));
  const store = new SessionAggregateStore(sessionPath);
  const initialized = await store.initialize(createInitialSessionAggregate({
    sessionId,
    repoKey: null,
    workspaceKey,
    launchNonceDigest: sha256(`nonce-${sessionId}`),
    phase: phase === 'completed' ? 'deep-interview' : phase,
  }));
  if (!initialized.ok) throw new Error(initialized.error.message);
  if (phase === 'completed') {
    const updated = await store.compareAndSwap(initialized.value.revision, (snapshot) => ({
      ...snapshot,
      revision: snapshot.revision + 1,
      autopilot: {
        ...snapshot.autopilot,
        phase: 'completed',
        terminal: {
          phase: 'completed',
          reason: 'done',
          actor: 'test',
          actorNonce: 'nonce',
          evidenceDigest: sha256('evidence'),
          at: '2026-08-17T00:00:00.000Z',
        },
      },
    }));
    if (!updated.ok) throw new Error(updated.error.message);
  }
  return sessionPath;
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

describe('oma session list', () => {
  test('parseSessionListArgv rejects out-of-range and non-integer --limit', () => {
    for (const argv of [
      ['list', '--limit', '0'],
      ['list', '--limit', '201'],
      ['list', '--limit', '1.5'],
      ['list', '--limit', 'abc'],
      ['list', '--limit', '01'],
      ['--list', '--limit', '0'],
    ]) {
      const parsed = parseSessionListArgv(argv);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error.code).toBe('E_VALIDATOR_REJECTED');
      expect(parsed.error.message).toContain('1..200');
    }
  });

  test('exported list function returns session_id and phase without mutating state', async () => {
    const fixture = createStateFixture('oma-session-list-');
    try {
      await seedSession(fixture, 'workspace-a', 'session-alpha', 'deep-interview');
      await seedSession(fixture, 'workspace-b', 'session-beta', 'ralplan');
      const before = fingerprintStateRoot(fixture.root);
      const listed = listManagedSessions({ stateRoot: fixture.root });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.sessions.length).toBeGreaterThanOrEqual(1);
      expect(listed.value.sessions.map((row) => row.session_id).sort()).toEqual([
        'session-alpha', 'session-beta',
      ]);
      const alpha = listed.value.sessions.find((row) => row.session_id === 'session-alpha');
      expect(alpha).toEqual(expect.objectContaining({
        available: true,
        workspace_key: 'workspace-a',
        phase: 'deep-interview',
        revision: 0,
        generation: 1,
        terminal: false,
      }));
      const text = renderSessionList(listed.value, 'text');
      expect(text.startsWith('session_id\tworkspace_key\tphase\t')).toBe(true);
      expect(text).toContain('session-alpha\tworkspace-a\tdeep-interview');
      expect(fingerprintStateRoot(fixture.root)).toBe(before);
    } finally {
      fixture.cleanup();
    }
  });

  test('--json is canonical and --workspace-key filters; unknown key is empty', async () => {
    const fixture = createStateFixture('oma-session-list-json-');
    try {
      await seedSession(fixture, 'workspace-a', 'session-alpha');
      await seedSession(fixture, 'workspace-b', 'session-beta');
      const filtered = listManagedSessions({
        stateRoot: fixture.root,
        workspaceKey: 'workspace-a',
        limit: 200,
      });
      expect(filtered.ok).toBe(true);
      if (!filtered.ok) return;
      expect(filtered.value.workspace_key).toBe('workspace-a');
      expect(filtered.value.sessions).toHaveLength(1);
      expect(filtered.value.sessions[0]?.session_id).toBe('session-alpha');
      const json = renderSessionList(filtered.value, 'json');
      expect(canonicalJsonV1(JSON.parse(json))).toBe(json);

      const missing = listManagedSessions({
        stateRoot: fixture.root,
        workspaceKey: 'unknown-workspace',
      });
      expect(missing.ok).toBe(true);
      if (!missing.ok) return;
      expect(missing.value.sessions).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  test('--limit truncates after stable sort', async () => {
    const fixture = createStateFixture('oma-session-list-limit-');
    try {
      await seedSession(fixture, 'workspace-a', 'session-c');
      await seedSession(fixture, 'workspace-a', 'session-a');
      await seedSession(fixture, 'workspace-a', 'session-b');
      const listed = listManagedSessions({
        stateRoot: fixture.root,
        workspaceKey: 'workspace-a',
        limit: 1,
      });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.sessions).toHaveLength(1);
      expect(listed.value.sessions[0]?.session_id).toBe('session-a');
    } finally {
      fixture.cleanup();
    }
  });

  test('corrupt aggregate.json marks that row unavailable and does not abort', async () => {
    const fixture = createStateFixture('oma-session-list-corrupt-');
    try {
      await seedSession(fixture, 'workspace-a', 'good-session', 'ralplan');
      const corruptPath = fixture.path(sessionAggregateRelativePath('workspace-a', 'bad-session'));
      fs.mkdirSync(path.dirname(corruptPath), { recursive: true, mode: 0o700 });
      fs.writeFileSync(corruptPath, '{not-json', { mode: 0o600 });
      const listed = listManagedSessions({
        stateRoot: fixture.root,
        workspaceKey: 'workspace-a',
      });
      expect(listed.ok).toBe(true);
      if (!listed.ok) return;
      expect(listed.value.sessions).toHaveLength(2);
      const good = listed.value.sessions.find((row) => row.session_id === 'good-session');
      const bad = listed.value.sessions.find((row) => row.available === false);
      expect(good?.phase).toBe('ralplan');
      expect(bad).toEqual(expect.objectContaining({
        available: false,
        phase: null,
        unavailable_code: 'E_CORRUPT_STATE',
      }));
    } finally {
      fixture.cleanup();
    }
  });

  test('empty inventory exits 0 and leaves state root bytes unchanged', async () => {
    const fixture = createStateFixture('oma-session-list-empty-');
    const io = captureIo();
    try {
      const before = fingerprintStateRoot(fixture.root);
      const code = runSessionListCommand(['list', '--json'], {
        cwd: fixture.root,
        stateRoot: fixture.root,
        environment: { HOME: fixture.root, OMA_STATE_ROOT: fixture.root },
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(0);
      expect(io.output().stderr).toBe('');
      const body = JSON.parse(io.output().stdout) as SessionListProjectionV1;
      expect(body.sessions).toEqual([]);
      expect(canonicalJsonV1(body)).toBe(io.output().stdout.trim());
      expect(fingerprintStateRoot(fixture.root)).toBe(before);
    } finally {
      fixture.cleanup();
    }
  });

  test('CLI path and resume --list alias share the same canonical projection', async () => {
    const fixture = createStateFixture('oma-session-list-cli-');
    try {
      await seedSession(fixture, 'workspace-a', 'session-alpha', 'completed');
      const before = fingerprintStateRoot(fixture.root);
      const pluginAdapter = {
        run: async (argv: readonly string[]) => ({ argv: [...argv], code: 1, stdout: '', stderr: '' }),
      };
      const run = async (command: 'session' | 'resume', argv: readonly string[]) => {
        let stdout = '';
        let stderr = '';
        const services = createDefaultServices({
          packageRoot,
          cwd: fixture.root,
          stateRoot: fixture.root,
          agyCommand: path.join(fixture.root, 'missing-agy'),
          pluginAdapter,
          environment: { PATH: fixture.root, HOME: fixture.root, OMA_STATE_ROOT: fixture.root },
          stdout: (value) => { stdout += value; },
          stderr: (value) => { stderr += value; },
        });
        const code = await services.extendedCommand(command, argv);
        return { code, stdout, stderr };
      };
      const listed = await run('session', ['list', '--json']);
      const alias = await run('resume', ['--list', '--json']);
      expect(listed.code).toBe(0);
      expect(alias.code).toBe(0);
      expect(listed.stderr).toBe('');
      expect(alias.stdout).toBe(listed.stdout);
      const body = JSON.parse(listed.stdout) as SessionListProjectionV1;
      expect(body.sessions).toEqual([expect.objectContaining({
        session_id: 'session-alpha',
        phase: 'completed',
        terminal: true,
        last_event_utc: '2026-08-17T00:00:00.000Z',
      })]);
      expect(canonicalJsonV1(body)).toBe(listed.stdout.trim());

      for (const argv of [['list', '--limit', '0'], ['list', '--limit', '201'], ['list', '--limit', 'nope']]) {
        const rejected = await run('session', argv);
        expect(rejected.code).toBe(2);
        expect(rejected.stderr).toContain('E_VALIDATOR_REJECTED');
      }
      expect(fingerprintStateRoot(fixture.root)).toBe(before);
    } finally {
      fixture.cleanup();
    }
  });
});
