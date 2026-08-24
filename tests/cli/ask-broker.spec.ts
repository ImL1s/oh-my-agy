import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ALLOWED_CAPTURE_TOOLS, ALLOWED_CAPTURE_TOOL_NAMES } from '../../src/ask/allowed-tools';
import {
  ASK_ADVISORY_BANNER,
  ASK_TRUNCATION_MARKER_PREFIX,
  AskSpawnSyncV1,
  buildAskArgv,
  runAskBroker,
  utcAskStamp,
} from '../../src/ask/broker';
import { CLI_HELP, runCli } from '../../src/cli/application';
import { ASK_RESULT_SCHEMA, ASK_USAGE, runAskCommand } from '../../src/cli/ask-command';
import { shouldHostLaunch } from '../../src/cli/host-launch';
import { parseCliArguments } from '../../src/cli/parser';
import { runtimeError } from '../../src/runtime/errors';
import { ProcessOutcome } from '../../src/runtime/process';
import { ok } from '../../src/runtime/types';

function captureIo() {
  let stdout = '';
  let stderr = '';
  return {
    stdout: (value: string) => { stdout += value; },
    stderr: (value: string) => { stderr += value; },
    output: () => ({ stdout, stderr }),
  };
}

function snapshotTree(target: string): string {
  if (!fs.existsSync(target)) return 'ABSENT';
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) return `LINK:${fs.readlinkSync(target)}`;
  if (!stat.isDirectory()) return fs.readFileSync(target, 'utf8');
  return fs.readdirSync(target, { withFileTypes: true })
    .map((entry) => entry.name)
    .sort()
    .map((name) => `${name}=${snapshotTree(path.join(target, name))}`)
    .join('\n');
}

function makeWorkspace(): { cwd: string; cleanup: () => void } {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-ask-'));
  return { cwd, cleanup: () => fs.rmSync(cwd, { recursive: true, force: true }) };
}

function unusedSpawn(): jest.MockedFunction<AskSpawnSyncV1> {
  return jest.fn<ReturnType<AskSpawnSyncV1>, Parameters<AskSpawnSyncV1>>(() => {
    throw new Error('spawn must not be called');
  });
}

const FIXED_NOW = () => new Date('2026-08-24T12:00:00.000Z');

describe('oma ask broker', () => {
  test('allowlist matches production capture tools and rejects unknown providers without spawn', () => {
    expect([...ALLOWED_CAPTURE_TOOL_NAMES]).toEqual([
      'codex', 'claude', 'grok', 'agy', 'cursor-agent',
    ]);
    expect([...ALLOWED_CAPTURE_TOOLS].sort()).toEqual([...ALLOWED_CAPTURE_TOOL_NAMES].sort());
    const workspace = makeWorkspace();
    const spawn = unusedSpawn();
    const io = captureIo();
    try {
      const code = runAskCommand(['gemini', 'second opinion'], {
        cwd: workspace.cwd,
        environment: { PATH: workspace.cwd, HOME: workspace.cwd },
        now: FIXED_NOW,
        spawnSync: spawn,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(2);
      expect(spawn).not.toHaveBeenCalled();
      expect(io.output().stderr).toContain('E_VALIDATOR_REJECTED');
      expect(io.output().stderr).toContain('gemini');
      expect(fs.existsSync(path.join(workspace.cwd, '.agy', 'artifacts'))).toBe(false);
    } finally {
      workspace.cleanup();
    }
  });

  test('rejects path-like executables without spawning', () => {
    const workspace = makeWorkspace();
    const spawn = unusedSpawn();
    const io = captureIo();
    try {
      expect(runAskCommand(['/bin/sh', 'echo hi'], {
        cwd: workspace.cwd,
        environment: { PATH: '/bin', HOME: workspace.cwd },
        spawnSync: spawn,
        stdout: io.stdout,
        stderr: io.stderr,
      })).toBe(2);
      expect(spawn).not.toHaveBeenCalled();
      expect(io.output().stderr).toMatch(/allowlisted|unknown ask tool/u);
    } finally {
      workspace.cleanup();
    }
  });

  test('--dry-run prints the full argv, writes an advisory artifact, and never spawns', () => {
    const workspace = makeWorkspace();
    const spawn = unusedSpawn();
    const io = captureIo();
    try {
      const code = runAskCommand(['codex', 'review the gate', '--dry-run'], {
        cwd: workspace.cwd,
        environment: { PATH: workspace.cwd, HOME: workspace.cwd },
        now: FIXED_NOW,
        spawnSync: spawn,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(0);
      expect(spawn).not.toHaveBeenCalled();
      const expectedArgv = buildAskArgv('codex', 'review the gate');
      expect(io.output().stdout).toContain('oma ask dry-run tool=codex');
      expect(io.output().stdout).toContain(`argv: ${JSON.stringify(expectedArgv)}`);
      expect(io.output().stdout).toContain(ASK_ADVISORY_BANNER);
      const artifact = path.join(
        workspace.cwd, '.agy', 'artifacts', `ask-${utcAskStamp(FIXED_NOW())}-codex.md`,
      );
      const body = fs.readFileSync(artifact, 'utf8');
      expect(body).toContain('ADVISORY ONLY');
      expect(body).toContain('inbound_reply_injection: forbidden');
      expect(body).toContain('tool: codex');
      expect(body).toContain('ts: 2026-08-24T12:00:00.000Z');
      expect(body).toContain('dry_run: true');
      expect(body).not.toContain('inbound reply loop implemented');
      expect(fs.existsSync(path.join(workspace.cwd, '.agy', 'autopilot'))).toBe(false);
      expect(fs.existsSync(path.join(workspace.cwd, '.agy', 'reviews'))).toBe(false);
    } finally {
      workspace.cleanup();
    }
  });

  test.each([...ALLOWED_CAPTURE_TOOL_NAMES])('fixed argv for %s has no elevation flags', (tool) => {
    const argv = buildAskArgv(tool, 'q');
    expect(argv[0]).toBe(tool);
    expect(argv.at(-1)).toBe('q');
    const joined = argv.join(' ');
    expect(joined).not.toMatch(/dangerously|yolo|always-approve|bypass/i);
    expect(argv.every((entry) => typeof entry === 'string')).toBe(true);
  });

  test('redacts secrets in the question before argv, artifact, and JSON output', () => {
    const workspace = makeWorkspace();
    const spawn = unusedSpawn();
    const io = captureIo();
    try {
      const question = 'please review token=supersecret-value';
      const code = runAskCommand(['claude', question, '--dry-run', '--json'], {
        cwd: workspace.cwd,
        environment: { PATH: workspace.cwd, HOME: workspace.cwd },
        now: FIXED_NOW,
        spawnSync: spawn,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(0);
      expect(spawn).not.toHaveBeenCalled();
      const payload = JSON.parse(io.output().stdout) as { argv: string[] };
      expect(JSON.stringify(payload)).not.toContain('supersecret-value');
      expect(payload.argv.join('\n')).toContain('token=<redacted>');
      const artifact = path.join(
        workspace.cwd, '.agy', 'artifacts', `ask-${utcAskStamp(FIXED_NOW())}-claude.md`,
      );
      const body = fs.readFileSync(artifact, 'utf8');
      expect(body).not.toContain('supersecret-value');
      expect(body).toContain('token=<redacted>');
    } finally {
      workspace.cleanup();
    }
  });

  test('--file contents are attached and redacted; missing binary does not spawn', () => {
    const workspace = makeWorkspace();
    const spawn = unusedSpawn();
    const io = captureIo();
    try {
      const notes = path.join(workspace.cwd, 'notes.md');
      fs.writeFileSync(notes, 'password=hunter2\n');
      const code = runAskCommand(['grok', 'summarize notes', '--file', notes, '--dry-run'], {
        cwd: workspace.cwd,
        environment: { PATH: workspace.cwd, HOME: workspace.cwd },
        now: FIXED_NOW,
        spawnSync: spawn,
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(0);
      expect(spawn).not.toHaveBeenCalled();
      expect(io.output().stdout).toContain('Attached file');
      expect(io.output().stdout).toContain('password=<redacted>');
      expect(io.output().stdout).not.toContain('hunter2');

      const missing = captureIo();
      expect(runAskCommand(['agy', 'hello'], {
        cwd: workspace.cwd,
        environment: { PATH: workspace.cwd, HOME: workspace.cwd },
        spawnSync: spawn,
        resolveExecutable: () => null,
        stdout: missing.stdout,
        stderr: missing.stderr,
      })).toBe(1);
      expect(spawn).not.toHaveBeenCalled();
      expect(missing.output().stderr).toContain('E_NOT_FOUND');
    } finally {
      workspace.cleanup();
    }
  });

  test('transcript over the cap is truncated with a marker', () => {
    const workspace = makeWorkspace();
    const spawn: jest.MockedFunction<AskSpawnSyncV1> = jest.fn((_command, argv, options) => {
      expect(Array.isArray(argv)).toBe(true);
      expect(options.shell).toBe(false);
      expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
      return {
        status: 0,
        signal: null,
        stdout: 'Z'.repeat(200),
        stderr: '',
      };
    });
    try {
      const result = runAskBroker({
        tool: 'cursor-agent',
        question: 'short',
        cwd: workspace.cwd,
        dryRun: false,
        environment: { PATH: workspace.cwd, HOME: workspace.cwd },
        now: FIXED_NOW,
        spawnSync: spawn,
        resolveExecutable: () => '/tmp/cursor-agent',
        transcriptMaxBytes: 64,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.spawned).toBe(true);
      expect(result.value.truncated).toBe(true);
      expect(spawn).toHaveBeenCalledTimes(1);
      const body = fs.readFileSync(result.value.artifactPath, 'utf8');
      expect(body).toContain(ASK_TRUNCATION_MARKER_PREFIX);
      expect(body).toContain('max_bytes=64');
      expect(body).toContain('ADVISORY ONLY');
    } finally {
      workspace.cleanup();
    }
  });

  test('successful spawn stays advisory and leaves autopilot/reviews byte-identical', () => {
    const workspace = makeWorkspace();
    const spawn: jest.MockedFunction<AskSpawnSyncV1> = jest.fn((command, argv, options) => {
      expect(command).toBe('/resolved/codex');
      expect(argv).toEqual(['exec', '-s', 'read-only', 'ship it']);
      expect(options.shell).toBe(false);
      expect(options.env.OMA_SESSION_ID).toBeUndefined();
      return { status: 0, signal: null, stdout: 'looks fine\n', stderr: '' };
    });
    try {
      const autopilot = path.join(workspace.cwd, '.agy', 'autopilot');
      const reviews = path.join(workspace.cwd, '.agy', 'reviews');
      fs.mkdirSync(autopilot, { recursive: true, mode: 0o700 });
      fs.mkdirSync(reviews, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(autopilot, 'state.json'), '{"phase":"implement"}\n');
      fs.writeFileSync(path.join(reviews, 'gate.md'), 'VERDICT: pending\n');
      const before = {
        autopilot: snapshotTree(autopilot),
        reviews: snapshotTree(reviews),
      };
      const io = captureIo();
      const code = runAskCommand(['codex', 'ship it'], {
        cwd: workspace.cwd,
        environment: {
          PATH: workspace.cwd,
          HOME: workspace.cwd,
          OMA_SESSION_ID: 'must-not-leak',
          OMA_LAUNCH_NONCE: 'nonce',
          OMA_INVOCATION_GENERATION: '1',
        },
        now: FIXED_NOW,
        spawnSync: spawn,
        resolveExecutable: () => '/resolved/codex',
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(0);
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(io.output().stdout).toContain('artifact=.agy/artifacts/ask-20260824T120000Z-codex.md');
      expect(io.output().stdout).toContain(ASK_ADVISORY_BANNER);
      const artifact = fs.readFileSync(path.join(
        workspace.cwd, '.agy', 'artifacts', 'ask-20260824T120000Z-codex.md',
      ), 'utf8');
      expect(artifact).toContain('looks fine');
      expect(artifact).toContain('ADVISORY ONLY');
      expect(snapshotTree(autopilot)).toBe(before.autopilot);
      expect(snapshotTree(reviews)).toBe(before.reviews);
    } finally {
      workspace.cleanup();
    }
  });

  test('source uses spawnSync argv arrays and never assembles a shell string', () => {
    const files = [
      path.resolve(__dirname, '../../src/ask/broker.ts'),
      path.resolve(__dirname, '../../src/cli/ask-command.ts'),
      path.resolve(__dirname, '../../src/ask/allowed-tools.ts'),
    ];
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8');
      expect(source).not.toMatch(/\bexec(?:Sync)?\s*\(/);
      expect(source).not.toMatch(/shell:\s*true/);
    }
    const broker = fs.readFileSync(files[0]!, 'utf8');
    expect(broker).toMatch(/spawnSync\(/);
    expect(broker).toMatch(/shell:\s*false/);
  });

  test('JSON success includes advisory schema and forbids inbound reply injection', () => {
    const workspace = makeWorkspace();
    const io = captureIo();
    try {
      const code = runAskCommand(['agy', 'ping', '--dry-run', '--json'], {
        cwd: workspace.cwd,
        environment: { PATH: workspace.cwd, HOME: workspace.cwd },
        now: FIXED_NOW,
        spawnSync: unusedSpawn(),
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(0);
      const payload = JSON.parse(io.output().stdout) as Record<string, unknown>;
      expect(payload).toMatchObject({
        advisory: true,
        dry_run: true,
        inbound_reply_injection: 'forbidden',
        ok: true,
        schema: ASK_RESULT_SCHEMA,
        spawned: false,
        tool: 'agy',
        truncated: false,
      });
      expect(payload.artifact).toBe('.agy/artifacts/ask-20260824T120000Z-agy.md');
    } finally {
      workspace.cleanup();
    }
  });
});

describe('oma ask CLI wiring', () => {
  test('parser, help, and host-launch treat ask as a structured command', async () => {
    expect(parseCliArguments(['ask', 'codex', 'q', '--dry-run'])).toEqual({
      kind: 'extended',
      command: 'ask',
      args: ['codex', 'q', '--dry-run'],
    });
    expect(CLI_HELP).toContain(ASK_USAGE.replace('Usage: ', ''));
    expect(shouldHostLaunch(['ask'])).toBe(false);
    expect(() => shouldHostLaunch(['ask', '--direct'])).toThrow(/E_LAUNCH_USAGE/);

    const outcome: ProcessOutcome = {
      code: 0, signal: null, timedOut: false, stdout: '', stderr: '', processIdentity: null,
    };
    const services = {
      launchMode: jest.fn(async () => ok(outcome)),
      passThrough: jest.fn(async () => ok(outcome)),
      autopilotCommand: jest.fn(async () => 0),
      teamCommand: jest.fn(async () => 0),
      setupCommand: jest.fn(async () => 0),
      doctorCommand: jest.fn(async () => 0),
      skillCommand: jest.fn(async () => 0),
      nativeCommand: jest.fn(async () => 0),
      extendedCommand: jest.fn(async () => 0),
    };
    expect(await runCli(['ask', 'codex', 'q'], services)).toBe(0);
    expect(services.extendedCommand).toHaveBeenCalledWith('ask', ['codex', 'q']);
    expect(services.passThrough).not.toHaveBeenCalled();
  });

  test('--help prints usage and does not spawn', () => {
    const workspace = makeWorkspace();
    const spawn = unusedSpawn();
    const io = captureIo();
    try {
      expect(runAskCommand(['--help'], {
        cwd: workspace.cwd,
        environment: { HOME: workspace.cwd },
        spawnSync: spawn,
        stdout: io.stdout,
        stderr: io.stderr,
      })).toBe(0);
      expect(spawn).not.toHaveBeenCalled();
      expect(io.output().stdout).toContain(ASK_USAGE);
    } finally {
      workspace.cleanup();
    }
  });

  test('usage errors do not spawn and --json failures stay canonical', () => {
    const workspace = makeWorkspace();
    const spawn = unusedSpawn();
    const io = captureIo();
    try {
      expect(runAskCommand(['--json'], {
        cwd: workspace.cwd,
        environment: { HOME: workspace.cwd },
        spawnSync: spawn,
        stdout: io.stdout,
        stderr: io.stderr,
      })).toBe(2);
      expect(spawn).not.toHaveBeenCalled();
      expect(JSON.parse(io.output().stdout)).toMatchObject({
        ok: false,
        code: 'E_VALIDATOR_REJECTED',
        schema: ASK_RESULT_SCHEMA,
        advisory: true,
        inbound_reply_injection: 'forbidden',
      });
    } finally {
      workspace.cleanup();
    }
  });
});

describe('production allowlist extraction', () => {
  test('unknown runtime errors still use E_VALIDATOR_REJECTED rather than launching', () => {
    expect(runtimeError('E_VALIDATOR_REJECTED', 'x').code).toBe('E_VALIDATOR_REJECTED');
    expect(ALLOWED_CAPTURE_TOOLS.has('codex')).toBe(true);
    expect(ALLOWED_CAPTURE_TOOLS.has('printf')).toBe(false);
    expect(ALLOWED_CAPTURE_TOOLS.has('/bin/sh')).toBe(false);
  });
});
