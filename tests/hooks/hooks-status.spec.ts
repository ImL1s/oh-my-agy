/**
 * `oma hooks status|tail|test` 觀測面。設計概念映射：OMX `omx hooks status|test`，
 * 以及 OMG doctor 對 hook 形狀的誠實檢查 — 從未觸發不得全綠。
 */
import * as fs from 'fs';
import * as path from 'path';
import { createDefaultServices } from '../../src/cli/services';
import {
  HOOKS_NEVER_OBSERVED,
  HOOKS_TAIL_LIMIT_DEFAULT,
  HOOKS_TAIL_LIMIT_MAX,
  HOOKS_TAIL_LIMIT_MIN,
  HOOKS_TEST_NOT_HOST_PROOF,
  HooksSpawnSyncV1,
  parseHooksArgv,
  projectHooksObservation,
  renderHooksStatus,
  runHooksCommand,
} from '../../src/cli/hooks-commands';
import { CLI_HELP } from '../../src/cli/application';
import { parseCliArguments } from '../../src/cli/parser';
import { appendHookLifecycleEvent } from '../../src/hooks/common';
import { canonicalBytesV1 } from '../../src/contracts/state-schemas';
import { runDoctor } from '../../src/setup/doctor';
import { createStateFixture, StateFixture } from '../helpers/state-fixture';

const packageRoot = path.resolve(__dirname, '../..');
const PLAIN_NONCE = 'oma-hooks-status-plain-nonce-secret';

function captureIo() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: (value: string) => { stdout += value; },
    stderr: (value: string) => { stderr += value; },
    output: () => ({ stdout, stderr }),
  };
}

function fingerprintTree(root: string): Buffer {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
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
  walk(root);
  return Buffer.from(parts.join('\n'));
}

function chmodStateRoot(root: string): void {
  fs.chmodSync(root, 0o700);
}

function seedManagedLifecycle(fixture: StateFixture, observedAt = '2026-08-20T10:00:00.000Z'): void {
  chmodStateRoot(fixture.root);
  appendHookLifecycleEvent(fixture.path('lifecycle', 'hooks.jsonl'), {
    eventType: 'session_started',
    runId: 'session-hooks-1',
    generation: 1,
    parentId: null,
    nativeIdentity: 'conversation-1',
    payload: { binding_route: 'exact_env' },
    observedAt,
  });
}

function writeDebugLog(fixture: StateFixture, records: readonly Record<string, unknown>[]): void {
  const target = fixture.path('logs', 'hook-debug.jsonl');
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    target,
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`,
    { mode: 0o600 },
  );
}

function hooksContext(
  fixture: StateFixture,
  io: ReturnType<typeof captureIo>,
  extra: { spawnSync?: HooksSpawnSyncV1; environment?: NodeJS.ProcessEnv } = {},
) {
  return {
    cwd: fixture.root,
    packageRoot,
    stateRoot: fixture.root,
    environment: extra.environment ?? { HOME: fixture.root, PATH: process.env.PATH },
    stdout: io.stdout,
    stderr: io.stderr,
    spawnSync: extra.spawnSync,
  };
}

describe('oma hooks argv', () => {
  test('parses status/tail/test and rejects --limit outside 1..500', () => {
    expect(parseHooksArgv([])).toEqual({ ok: true, value: { kind: 'status', asJson: false } });
    expect(parseHooksArgv(['status', '--json'])).toEqual({
      ok: true, value: { kind: 'status', asJson: true },
    });
    expect(parseHooksArgv(['tail'])).toEqual({
      ok: true, value: { kind: 'tail', limit: HOOKS_TAIL_LIMIT_DEFAULT },
    });
    expect(parseHooksArgv(['tail', '--limit', '1'])).toEqual({
      ok: true, value: { kind: 'tail', limit: HOOKS_TAIL_LIMIT_MIN },
    });
    expect(parseHooksArgv(['tail', '--limit', '500'])).toEqual({
      ok: true, value: { kind: 'tail', limit: HOOKS_TAIL_LIMIT_MAX },
    });
    expect(parseHooksArgv(['test'])).toEqual({
      ok: true, value: { kind: 'test', event: 'pre-invocation' },
    });
    expect(parseHooksArgv(['test', '--event', 'stop'])).toEqual({
      ok: true, value: { kind: 'test', event: 'stop' },
    });

    for (const argv of [
      ['tail', '--limit', '0'],
      ['tail', '--limit', '501'],
      ['tail', '--limit', '1.5'],
      ['tail', '--limit', 'abc'],
      ['tail', '--limit', '01'],
      ['tail', '--limit'],
    ]) {
      const parsed = parseHooksArgv(argv);
      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error.code).toBe('E_VALIDATOR_REJECTED');
      expect(parsed.error.message).toContain('1..500');
    }
  });

  test('routes hooks through the structured CLI parser', () => {
    expect(parseCliArguments(['hooks', 'status', '--json'])).toEqual({
      kind: 'extended',
      command: 'hooks',
      args: ['status', '--json'],
    });
    expect(CLI_HELP).toContain('oma hooks status [--json]');
    expect(CLI_HELP).toContain('oma hooks tail [--limit <1..500>]');
    expect(CLI_HELP).toContain('oma hooks test [--event pre-invocation|stop]');
  });
});

describe('oma hooks status projection', () => {
  test('empty or missing lifecycle is never-observed, not all-green', () => {
    const fixture = createStateFixture('oma-hooks-empty-');
    try {
      chmodStateRoot(fixture.root);
      const missing = projectHooksObservation(fixture.path('no-such-state'));
      expect(missing.observed).toBe(false);
      expect(missing.observation).toBe('never_observed');
      expect(missing.last_seen_at).toBeNull();
      expect(missing.binding_route).toBeNull();
      expect(missing.message).toContain(HOOKS_NEVER_OBSERVED);

      const empty = projectHooksObservation(fixture.root);
      expect(empty.observed).toBe(false);
      expect(empty.managed_count).toBe(0);
      expect(empty.fail_open_count).toBe(0);
      const text = renderHooksStatus(empty, 'text');
      expect(text).toContain(HOOKS_NEVER_OBSERVED);
      expect(text.toLowerCase()).not.toMatch(/\ball[- ]green\b/);
      expect(text).not.toMatch(/\bOK\b/);
    } finally {
      fixture.cleanup();
    }
  });

  test('fixture lifecycle + debug log report last_seen_at, binding_route, and counts', () => {
    const fixture = createStateFixture('oma-hooks-fixture-');
    try {
      seedManagedLifecycle(fixture, '2026-08-20T10:00:00.000Z');
      appendHookLifecycleEvent(fixture.path('lifecycle', 'hooks.jsonl'), {
        eventType: 'turn_started',
        runId: 'session-hooks-1',
        generation: 1,
        parentId: null,
        nativeIdentity: 'conversation-1',
        payload: { invocation_num: 1 },
        observedAt: '2026-08-20T10:00:05.000Z',
      });
      writeDebugLog(fixture, [
        {
          store_kind: 'hook_debug_event',
          schema_version: 1,
          ts: '2026-08-20T09:59:00.000Z',
          event: 'preinvocation.fail_open_unmanaged',
          payload: { ok: false, decision: 'allow' },
        },
        {
          store_kind: 'hook_debug_event',
          schema_version: 1,
          ts: '2026-08-20T10:00:06.000Z',
          event: 'preinvocation.bound',
          payload: { bindingRoute: 'exact_env', decision: 'allow', injectSteps: 1 },
        },
      ]);
      const projection = projectHooksObservation(fixture.root);
      expect(projection.observed).toBe(true);
      expect(projection.last_seen_at).toBe('2026-08-20T10:00:06.000Z');
      expect(projection.binding_route).toBe('exact_env');
      expect(projection.managed_count).toBe(2);
      expect(projection.fail_open_count).toBe(1);
      expect(projection.lifecycle_event_count).toBe(2);
      expect(projection.debug_event_count).toBe(2);

      const json = renderHooksStatus(projection, 'json');
      const parsed = JSON.parse(json) as Record<string, unknown>;
      expect(Object.keys(parsed)).toEqual([...Object.keys(parsed)].sort());
      expect(json).toBe(canonicalBytesV1(parsed).toString('utf8'));
    } finally {
      fixture.cleanup();
    }
  });

  test('corrupt lifecycle or debug lines stay readable and do not crash', () => {
    const fixture = createStateFixture('oma-hooks-corrupt-');
    try {
      chmodStateRoot(fixture.root);
      fs.mkdirSync(fixture.path('lifecycle'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        fixture.path('lifecycle', 'hooks.jsonl'),
        '{not-json\n{"store_kind":"nope"}\n',
        { mode: 0o600 },
      );
      fs.mkdirSync(fixture.path('logs'), { recursive: true, mode: 0o700 });
      fs.writeFileSync(fixture.path('logs', 'hook-debug.jsonl'), '<<<corrupt>>>\n', { mode: 0o600 });
      expect(() => projectHooksObservation(fixture.root)).not.toThrow();
      const projection = projectHooksObservation(fixture.root);
      expect(projection.observed).toBe(false);
      expect(projection.corrupt_lifecycle_lines).toBeGreaterThan(0);
      expect(projection.corrupt_debug_lines).toBeGreaterThan(0);
      expect(projection.message).toContain(HOOKS_NEVER_OBSERVED);

      const io = captureIo();
      const code = runHooksCommand(['status', '--json'], hooksContext(fixture, io));
      expect(code).toBe(0);
      expect(io.output().stdout).toContain(HOOKS_NEVER_OBSERVED);
      expect(io.output().stderr).not.toMatch(/throw|TypeError|SyntaxError/i);
    } finally {
      fixture.cleanup();
    }
  });

  test('redacts plaintext OMA_LAUNCH_NONCE from status and tail', () => {
    const fixture = createStateFixture('oma-hooks-redact-');
    try {
      seedManagedLifecycle(fixture);
      writeDebugLog(fixture, [{
        store_kind: 'hook_debug_event',
        schema_version: 1,
        ts: '2026-08-20T11:00:00.000Z',
        event: 'preinvocation.bound',
        env: {
          OMA_LAUNCH_NONCE: PLAIN_NONCE,
          OMA_LAUNCH_NONCE_FP: 'sha256:deadbeefdeadbeef',
        },
        payload: {
          bindingRoute: 'first_preinvocation',
          decision: 'allow',
          message: `nonce=${PLAIN_NONCE}`,
        },
      }]);
      const io = captureIo();
      const context = hooksContext(fixture, io, {
        environment: {
          HOME: fixture.root,
          PATH: process.env.PATH,
          OMA_LAUNCH_NONCE: PLAIN_NONCE,
        },
      });
      expect(runHooksCommand(['status', '--json'], context)).toBe(0);
      expect(runHooksCommand(['tail', '--limit', '10'], context)).toBe(0);
      const combined = `${io.output().stdout}\n${io.output().stderr}`;
      expect(combined).not.toContain(PLAIN_NONCE);
      expect(combined).toContain('first_preinvocation');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('oma hooks tail', () => {
  test('prints the most recent events and honors --limit', () => {
    const fixture = createStateFixture('oma-hooks-tail-');
    try {
      seedManagedLifecycle(fixture, '2026-08-20T10:00:00.000Z');
      appendHookLifecycleEvent(fixture.path('lifecycle', 'hooks.jsonl'), {
        eventType: 'turn_completed',
        runId: 'session-hooks-1',
        generation: 1,
        parentId: null,
        nativeIdentity: 'conversation-1',
        payload: { decision: 'allow' },
        observedAt: '2026-08-20T10:00:09.000Z',
      });
      const io = captureIo();
      expect(runHooksCommand(['tail', '--limit', '1'], hooksContext(fixture, io))).toBe(0);
      const { stdout } = io.output();
      expect(stdout).toContain('turn_completed');
      expect(stdout).not.toContain('session_started');
    } finally {
      fixture.cleanup();
    }
  });

  test('out-of-range --limit returns E_VALIDATOR_REJECTED without reading state', () => {
    const fixture = createStateFixture('oma-hooks-limit-');
    try {
      const io = captureIo();
      const code = runHooksCommand(['tail', '--limit', '501'], hooksContext(fixture, io));
      expect(code).toBe(2);
      expect(io.output().stderr).toContain('E_VALIDATOR_REJECTED');
      expect(io.output().stderr).toContain('1..500');
    } finally {
      fixture.cleanup();
    }
  });
});

describe('oma hooks test', () => {
  test('spawnSync uses argv (no shell string), prints decision, and writes zero lifecycle bytes', () => {
    const fixture = createStateFixture('oma-hooks-test-');
    try {
      seedManagedLifecycle(fixture);
      const before = fingerprintTree(fixture.root);
      const spawn: jest.MockedFunction<HooksSpawnSyncV1> = jest.fn((command, argv, options) => {
        expect(command).toBe(process.execPath);
        expect(Array.isArray(argv)).toBe(true);
        expect(argv).toHaveLength(1);
        expect(argv[0]).toMatch(/pre-invocation\.js$/);
        expect(options.shell).toBe(false);
        expect(typeof options.input).toBe('string');
        expect(options.env.OMA_LAUNCH_NONCE).toBeUndefined();
        expect(options.env.OMA_STATE_ROOT).toBeUndefined();
        expect(options.input).not.toContain(PLAIN_NONCE);
        return {
          status: 0,
          signal: null,
          stdout: JSON.stringify({ decision: 'allow', injectSteps: [] }),
          stderr: '',
        };
      });
      const io = captureIo();
      const code = runHooksCommand(['test', '--event', 'pre-invocation'], hooksContext(fixture, io, {
        spawnSync: spawn,
        environment: {
          HOME: fixture.root,
          PATH: process.env.PATH ?? '/usr/bin',
          OMA_LAUNCH_NONCE: PLAIN_NONCE,
          OMA_STATE_ROOT: fixture.root,
          OMA_SESSION_ID: 'must-not-leak',
        },
      }));
      expect(code).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      const { stdout } = io.output();
      expect(stdout).toContain('decision: allow');
      expect(stdout).toMatch(/injectSteps:\s*0/);
      expect(stdout).toContain(HOOKS_TEST_NOT_HOST_PROOF);
      expect(stdout).not.toContain(PLAIN_NONCE);
      expect(fingerprintTree(fixture.root).equals(before)).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });

  test('real compiled entrypoint (when present) fail-opens without lifecycle writes and is not host proof', () => {
    const fixture = createStateFixture('oma-hooks-test-real-');
    try {
      seedManagedLifecycle(fixture);
      const before = fingerprintTree(fixture.root);
      const io = captureIo();
      const code = runHooksCommand(['test', '--event', 'pre-invocation'], hooksContext(fixture, io, {
        environment: {
          HOME: fixture.root,
          PATH: process.env.PATH,
          OMA_LAUNCH_NONCE: PLAIN_NONCE,
          OMA_STATE_ROOT: fixture.root,
        },
      }));
      const { stdout, stderr } = io.output();
      const combined = `${stdout}\n${stderr}`;
      expect(combined).toContain(HOOKS_TEST_NOT_HOST_PROOF);
      expect(combined).not.toContain(PLAIN_NONCE);
      expect(fingerprintTree(fixture.root).equals(before)).toBe(true);
      const dist = path.join(packageRoot, 'dist', 'src', 'hooks', 'pre-invocation.js');
      if (fs.existsSync(dist)) {
        expect(code).toBe(0);
        expect(stdout).toContain('decision: allow');
        expect(stdout).toMatch(/injectSteps:\s*0/);
      }
    } finally {
      fixture.cleanup();
    }
  });

  test('extendedCommand wiring reaches hooks status', async () => {
    const fixture = createStateFixture('oma-hooks-extended-');
    try {
      const io = captureIo();
      const services = createDefaultServices({
        packageRoot,
        cwd: fixture.root,
        stateRoot: fixture.root,
        environment: { HOME: fixture.root, PATH: '/usr/bin' },
        stdout: io.stdout,
        stderr: io.stderr,
      });
      // parser → extendedCommand('hooks') 不得落到 agy passthrough。
      expect(parseCliArguments(['hooks', 'test']).kind).toBe('extended');
      expect(await services.extendedCommand('hooks', ['status'])).toBe(0);
      expect(io.output().stdout).toContain(HOOKS_NEVER_OBSERVED);
    } finally {
      fixture.cleanup();
    }
  });
});

describe('oma doctor hooks_observed', () => {
  test('warns when never observed and does not fail; passes after lifecycle evidence', async () => {
    const fixture = createStateFixture('oma-hooks-doctor-');
    try {
      chmodStateRoot(fixture.root);
      fs.mkdirSync(fixture.path('home'), { recursive: true, mode: 0o700 });
      const adapter = {
        async run(argv: readonly string[]) {
          return { argv, code: 0, stdout: JSON.stringify({ imports: [] }), stderr: '' };
        },
      };
      const never = await runDoctor({
        packageRoot,
        adapter,
        homeDir: fixture.path('home'),
        stateRoot: fixture.root,
        mode: 'development',
        agyCommand: 'echo',
      });
      expect(never.ok).toBe(true);
      if (!never.ok) return;
      const warned = never.value.checks.find((check) => check.id === 'hooks_observed');
      expect(warned).toEqual(expect.objectContaining({
        status: 'warn',
        message: expect.stringContaining(HOOKS_NEVER_OBSERVED),
      }));
      expect(warned?.status).not.toBe('fail');

      seedManagedLifecycle(fixture);
      const seen = await runDoctor({
        packageRoot,
        adapter,
        homeDir: fixture.path('home'),
        stateRoot: fixture.root,
        mode: 'development',
        agyCommand: 'echo',
      });
      expect(seen.ok).toBe(true);
      if (!seen.ok) return;
      expect(seen.value.checks.find((check) => check.id === 'hooks_observed')).toEqual(
        expect.objectContaining({ status: 'pass' }),
      );
    } finally {
      fixture.cleanup();
    }
  });
});
