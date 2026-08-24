import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CLI_HELP } from '../../src/cli/application';
import { createDefaultServices, parseDoctorCliOptions } from '../../src/cli/services';
import { HostCliAdapter, HostCliResult } from '../../src/setup/host-install';
import {
  DOCTOR_CHECK_JSON_KEYS,
  DoctorCheckV1,
  doctorCheck,
  doctorCheckToJsonValue,
  doctorReportToJsonValue,
  doctorReportToLines,
  runDoctor,
} from '../../src/setup/doctor';
import {
  applyOwnedDoctorFix,
  assertNoGitSpawn,
  buildDoctorFixPlan,
  DOCTOR_FIX_SCHEMA,
  isGitSpawnArgv,
  spawnSyncAgyArgv,
} from '../../src/setup/doctor-fix';
import { PluginCommandAdapter } from '../../src/setup/plugin';
import { ok } from '../../src/runtime/types';

function chmodTree(root: string): void {
  if (!fs.existsSync(root)) return;
  try { fs.chmodSync(root, 0o700); } catch { /* ignore */ }
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) chmodTree(full);
    else if (!entry.isSymbolicLink()) {
      try { fs.chmodSync(full, 0o600); } catch { /* ignore */ }
    }
  }
}

function forceRm(root: string): void {
  chmodTree(root);
  fs.rmSync(root, { recursive: true, force: true });
}

/** 窮舉已知 check id；新增 builder 若漏列入此表或漏填 nextAction 即紅。 */
const CORE_DOCTOR_CHECK_IDS = [
  'node',
  'package_root',
  'version_sync',
  'claude_plugin_manifest',
  'mcp_registration',
  'slash_skills',
  'skill_manifest_drift',
  'hooks',
  'hooks_kill_switch',
  'agy_path',
  'state_root',
  'hooks_observed',
  'slash_collision',
  'plugin_registry',
] as const;

const OPTIONAL_DOCTOR_CHECK_IDS = ['native_capabilities'] as const;

function surface(root: string, version: string, marker = 'same'): void {
  fs.mkdirSync(path.join(root, 'dist', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'src', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'autopilot'), { recursive: true });
  fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: '@iml1s/oh-my-agy', version,
    bin: { oma: 'dist/bin/oma.js', omy: 'dist/bin/oma.js' },
    files: [
      'dist/bin', 'dist/src', 'plugin.json', 'hooks.json', '.claude-plugin',
      'skills', 'rules', 'package.json',
    ],
  }));
  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({ name: 'oh-my-agy', version }));
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'oh-my-agy', version, skills: ['./skills/autopilot/'],
    mcpServers: './.claude-plugin/.mcp.json',
  }));
  fs.writeFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'oh-my-agy',
    version,
    owner: { name: 'ImL1s' },
    plugins: [{ name: 'oh-my-agy', source: './', version }],
  }));
  fs.writeFileSync(path.join(root, '.claude-plugin', '.mcp.json'), JSON.stringify({
    mcpServers: {
      'oh-my-agy': {
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/dist/bin/oma.js', 'mcp-server'],
      },
    },
  }));
  fs.writeFileSync(path.join(root, 'hooks.json'), JSON.stringify({
    'oh-my-agy-runtime': {
      PreInvocation: [{ command: 'node "${extensionPath}/dist/src/hooks/pre-invocation.js"' }],
      Stop: [{ command: 'node "${extensionPath}/dist/src/hooks/stop.js"' }],
    },
  }));
  fs.writeFileSync(path.join(root, 'dist', 'bin', 'oma.js'), `#!/usr/bin/env node\n${marker}\n`);
  fs.chmodSync(path.join(root, 'dist', 'bin', 'oma.js'), 0o755);
  fs.writeFileSync(path.join(root, 'dist', 'src', 'hooks', 'pre-invocation.js'), marker);
  fs.writeFileSync(path.join(root, 'dist', 'src', 'hooks', 'stop.js'), marker);
  fs.writeFileSync(
    path.join(root, 'skills', 'autopilot', 'SKILL.md'),
    '# IN-SESSION PRIMARY\nYou are already in the agent session.\n',
  );
  fs.writeFileSync(path.join(root, 'rules', 'runtime.md'), marker);
}

function adapter(stdout = '{"imports":[]}', code = 0): PluginCommandAdapter {
  return {
    async run(argv) {
      if (argv[0] === 'git' || argv.includes('git')) {
        throw new Error(`git spawn intercepted: ${argv.join(' ')}`);
      }
      return { argv, code, stdout, stderr: '' };
    },
  };
}

function assertCheckFieldOrder(check: DoctorCheckV1): void {
  const keys = Object.keys(check);
  expect(keys.slice(0, DOCTOR_CHECK_JSON_KEYS.length)).toEqual([...DOCTOR_CHECK_JSON_KEYS]);
  if (check.detail !== undefined) {
    expect(keys[keys.length - 1]).toBe('detail');
  }
  expect(check.nextAction.trim().length).toBeGreaterThan(0);
  expect(check.nextAction).not.toMatch(/\n/);
}

describe('doctor nextAction contract (#50)', () => {
  let scratch: string;
  let source: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-doctor-next-'));
    source = path.join(scratch, 'source');
    surface(source, '0.2.3');
  });

  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

  async function doctor(overrides: Partial<Parameters<typeof runDoctor>[0]> = {}) {
    return runDoctor({
      packageRoot: source,
      packageVersion: '0.2.3',
      adapter: adapter(),
      antigravityConfigRoot: path.join(scratch, 'gemini-config'),
      homeDir: path.join(scratch, 'home'),
      stateRoot: path.join(scratch, 'state'),
      mode: 'development',
      agyCommand: 'echo',
      environment: {},
      ...overrides,
    });
  }

  test('every check builder emits a non-empty nextAction and no unknown ids', async () => {
    const report = await doctor();
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const ids = report.value.checks.map((check) => check.id);
    expect(ids.filter((id) => !(CORE_DOCTOR_CHECK_IDS as readonly string[]).includes(id))).toEqual([]);
    expect(ids).toEqual(expect.arrayContaining([...CORE_DOCTOR_CHECK_IDS]));
    expect(ids).not.toContain('native_capabilities');
    for (const check of report.value.checks) {
      assertCheckFieldOrder(check);
    }
  });

  test('native_capabilities is included when requested and still has nextAction', async () => {
    const report = await doctor({
      includeNativeCapabilities: true,
      nativeCapabilitiesProbe: async () => ok({
        kind: 'host_absent',
        diagnostics: [{ code: 'E_NOT_FOUND', message: 'agy unavailable' }],
      }),
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const ids = report.value.checks.map((check) => check.id);
    expect(ids).toEqual(expect.arrayContaining([
      ...CORE_DOCTOR_CHECK_IDS,
      ...OPTIONAL_DOCTOR_CHECK_IDS,
    ]));
    const extra = ids.filter((id) => (
      !(CORE_DOCTOR_CHECK_IDS as readonly string[]).includes(id)
      && !(OPTIONAL_DOCTOR_CHECK_IDS as readonly string[]).includes(id)
    ));
    expect(extra).toEqual([]);
    const native = report.value.checks.find((check) => check.id === 'native_capabilities');
    expect(native).toBeDefined();
    if (native === undefined) return;
    assertCheckFieldOrder(native);
    expect(native.status).toBe('warn');
  });

  test('human mode prints next action only on warn/fail, never on pass', () => {
    const report = {
      schemaVersion: 1 as const,
      ok: false,
      exitCode: 1 as const,
      packageRoot: '/tmp',
      packageVersion: '0.0.0',
      mode: 'strict' as const,
      checks: [
        doctorCheck('node', 'pass', 'Node ok', 'SECRET_PASS_ACTION'),
        doctorCheck('hooks', 'warn', 'hooks warn', 'VISIBLE_WARN_ACTION'),
        doctorCheck('package_root', 'fail', 'pkg fail', 'VISIBLE_FAIL_ACTION', { bin: 'x' }),
      ],
    };
    const text = doctorReportToLines(report).join('\n');
    expect(text).toContain('✓ [node] Node ok');
    expect(text).not.toContain('SECRET_PASS_ACTION');
    expect(text).toMatch(/^! \[hooks\] hooks warn$/m);
    expect(text).toMatch(/^ {2}next: VISIBLE_WARN_ACTION$/m);
    expect(text).toMatch(/^✗ \[package_root\] pkg fail$/m);
    expect(text).toMatch(/^ {2}next: VISIBLE_FAIL_ACTION$/m);
  });

  test('--json includes nextAction with stable field order', async () => {
    const report = await doctor();
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    const jsonValue = doctorReportToJsonValue(report.value);
    expect(Object.keys(jsonValue)).toEqual([
      'schemaVersion', 'ok', 'exitCode', 'packageRoot', 'packageVersion', 'mode', 'checks',
    ]);
    const parsed = JSON.parse(JSON.stringify(jsonValue, null, 2)) as typeof jsonValue;
    expect(Object.keys(parsed)).toEqual(Object.keys(jsonValue));
    for (const check of parsed.checks) {
      assertCheckFieldOrder(check);
      expect(Object.keys(doctorCheckToJsonValue(check)).slice(0, 4))
        .toEqual([...DOCTOR_CHECK_JSON_KEYS]);
    }
  });

  test('doctorCheck rejects an empty nextAction so new builders cannot skip it', () => {
    expect(() => doctorCheck('node', 'fail', 'bad', '   ')).toThrow(/nextAction/);
  });
});

describe('hooks_kill_switch informational check (#50)', () => {
  let scratch: string;
  let source: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-doctor-kill-'));
    source = path.join(scratch, 'source');
    surface(source, '0.2.3');
  });

  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

  async function killSwitch(environment: NodeJS.ProcessEnv): Promise<DoctorCheckV1 | undefined> {
    const report = await runDoctor({
      packageRoot: source,
      packageVersion: '0.2.3',
      adapter: adapter(),
      antigravityConfigRoot: path.join(scratch, 'gemini-config'),
      homeDir: path.join(scratch, 'home'),
      stateRoot: path.join(scratch, 'state'),
      mode: 'development',
      agyCommand: 'echo',
      environment,
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return undefined;
    return report.value.checks.find((check) => check.id === 'hooks_kill_switch');
  }

  test.each([
    [{}],
    [{ PATH: '/usr/bin' }],
  ])('unset kill switches are pass/info: %j', async (environment) => {
    const check = await killSwitch(environment);
    expect(check).toEqual(expect.objectContaining({
      id: 'hooks_kill_switch',
      status: 'pass',
      message: expect.stringMatching(/unset/),
    }));
    expect(check?.nextAction.trim().length).toBeGreaterThan(0);
  });

  test.each([
    [{ DISABLE_OMA: '1' }, /DISABLE_OMA/],
    [{ DISABLE_OMA: 'true' }, /DISABLE_OMA/],
    [{ DISABLE_OMA: 'TRUE' }, /DISABLE_OMA/],
    [{ OMA_SKIP_HOOKS: 'stop' }, /OMA_SKIP_HOOKS/],
    [{ DISABLE_OMA: '1', OMA_SKIP_HOOKS: 'pre-invocation' }, /hooks are currently off/],
  ])('set kill switches warn that hooks are off: %j', async (environment, message) => {
    const check = await killSwitch(environment);
    expect(check?.status).toBe('warn');
    expect(check?.message).toMatch(message);
    expect(check?.message).toMatch(/hooks are currently off/);
    expect(check?.nextAction).toMatch(/Unset DISABLE_OMA/);
  });
});

describe('oma doctor --fix (#50)', () => {
  const repoRoot = path.resolve(__dirname, '../..');

  test('parseDoctorCliOptions allows --fix and still rejects unknown/duplicate flags', () => {
    expect(parseDoctorCliOptions(['--fix'])).toEqual({
      asJson: false,
      native: false,
      strictPlugin: true,
      fix: true,
      strict: false,
      conflicts: false,
      pluginDir: undefined,
    });
    expect(parseDoctorCliOptions(['--json', '--native', '--no-strict-plugin', '--fix'])).toEqual({
      asJson: true,
      native: true,
      strictPlugin: false,
      fix: true,
      strict: false,
      conflicts: false,
      pluginDir: undefined,
    });
    expect(() => parseDoctorCliOptions(['--fix', '--fix'])).toThrow(/duplicate option --fix/);
    expect(() => parseDoctorCliOptions(['--unknown'])).toThrow(/unexpected argument/);
  });

  test('CLI_HELP documents --fix', () => {
    expect(CLI_HELP).toContain('oma doctor [--json] [--no-strict-plugin] [--native] [--fix]');
  });

  test('source never spawn/exec git (string assertion)', () => {
    const files = [
      'src/setup/doctor-fix.ts',
      'src/setup/doctor.ts',
      'src/cli/services.ts',
    ];
    for (const relative of files) {
      const src = fs.readFileSync(path.join(repoRoot, relative), 'utf8');
      expect(src).not.toMatch(/\bspawn(?:Sync)?\(\s*['"]git['"]/);
      expect(src).not.toMatch(/\bexec(?:File)?(?:Sync)?\(\s*['"]git['"]/);
    }
    const fixSrc = fs.readFileSync(path.join(repoRoot, 'src/setup/doctor-fix.ts'), 'utf8');
    expect(fixSrc).toMatch(/spawnSync/);
    expect(fixSrc).not.toMatch(/\bwhile\s*\(/);
  });

  test('isGitSpawnArgv and spawnSyncAgyArgv refuse git', () => {
    expect(isGitSpawnArgv(['git', 'status'])).toBe(true);
    expect(isGitSpawnArgv(['/usr/bin/git', 'status'])).toBe(true);
    expect(isGitSpawnArgv(['agy', 'plugin', 'list'])).toBe(false);
    expect(() => assertNoGitSpawn(['git', 'rev-parse'])).toThrow(/refuses git/);
    expect(() => spawnSyncAgyArgv('git', ['status'])).toThrow(/refuses git/);
  });

  test('applyOwnedDoctorFix runs setup once, never git, and skips readback when agy is missing', async () => {
    let setups = 0;
    const readbacks: string[][] = [];
    const missingPlan = buildDoctorFixPlan({ agyCommand: '/missing/agy', agyMissing: true });
    expect(missingPlan.message).toMatch(/will not retry/);
    expect(missingPlan.plannedSpawns).toEqual([]);
    const missing = await applyOwnedDoctorFix({
      plan: missingPlan,
      runSetup: async () => {
        setups += 1;
        return 0;
      },
      pluginReadback: async () => {
        throw new Error('plugin readback must not run when agy is missing');
      },
    });
    expect(setups).toBe(1);
    expect(missing.retried).toBe(false);
    expect(missing.readback).toBeNull();

    const presentPlan = buildDoctorFixPlan({ agyCommand: 'agy', agyMissing: false });
    for (const spawned of presentPlan.plannedSpawns) {
      expect(isGitSpawnArgv(spawned.args)).toBe(false);
    }
    const present = await applyOwnedDoctorFix({
      plan: presentPlan,
      runSetup: async () => {
        setups += 1;
        return 0;
      },
      pluginReadback: async () => {
        const argv = ['agy', 'plugin', 'list'];
        assertNoGitSpawn(argv);
        readbacks.push(argv);
        return { argv, code: 0, stdout: '{"imports":[]}', stderr: '' };
      },
    });
    expect(setups).toBe(2);
    expect(present.readback?.argv).toEqual(['agy', 'plugin', 'list']);
    expect(readbacks).toEqual([['agy', 'plugin', 'list']]);
  });

  test('doctor --fix prints the plan first, intercepts git, and reports before/after', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-doctor-fix-cli-'));
    const source = path.join(scratch, 'source');
    const homeDir = path.join(scratch, 'home');
    const stateRoot = path.join(scratch, 'state');
    const configRoot = path.join(scratch, 'gemini-config');
    surface(source, '0.2.3');
    fs.mkdirSync(homeDir, { recursive: true });
    const pluginArgv: string[][] = [];
    const plugin: PluginCommandAdapter = {
      async run(argv) {
        expect(argv[0]).not.toBe('git');
        expect(argv).not.toContain('git');
        pluginArgv.push([...argv]);
        return { argv, code: 0, stdout: JSON.stringify({ imports: [] }), stderr: '' };
      },
    };
    const hostRuns: Array<{ cmd: string; args: readonly string[] }> = [];
    const host: HostCliAdapter = {
      which() { return null; },
      run(cmd: string, args: readonly string[]): HostCliResult {
        expect(cmd).not.toBe('git');
        hostRuns.push({ cmd, args });
        return { status: 0, stdout: '', stderr: '', timedOut: false };
      },
    };
    let stdout = '';
    let stderr = '';
    let setups = 0;
    try {
      const services = createDefaultServices({
        packageRoot: source,
        cwd: scratch,
        stateRoot,
        homeDir,
        antigravityConfigRoot: configRoot,
        agyCommand: 'echo',
        pluginAdapter: plugin,
        hostCliAdapter: host,
        environment: { HOME: homeDir, PATH: homeDir },
        stdout: (value) => { stdout += value; },
        stderr: (value) => { stderr += value; },
      });
      const originalSetup = services.setupCommand.bind(services);
      services.setupCommand = async (argv) => {
        setups += 1;
        expect(argv).not.toContain('git');
        return originalSetup(argv);
      };
      const code = await services.doctorCommand(['--fix']);
      expect([0, 1, 2]).toContain(code);
      expect(setups).toBe(1);
      const planAt = stdout.indexOf('oma doctor --fix planned actions (never git):');
      const beforeAt = stdout.indexOf('=== before ===');
      const afterAt = stdout.indexOf('=== after ===');
      expect(planAt).toBeGreaterThanOrEqual(0);
      expect(beforeAt).toBeGreaterThan(planAt);
      expect(afterAt).toBeGreaterThan(beforeAt);
      expect(stdout).toContain('Changed:');
      expect(pluginArgv.some((argv) => argv[0] === 'git' || argv.includes('git'))).toBe(false);
      expect(hostRuns.some((item) => item.cmd === 'git')).toBe(false);
      expect(stderr).not.toMatch(/infinite/i);
    } finally {
      forceRm(scratch);
    }
  });

  test('doctor --fix --json keeps stable field order and nextAction on both reports', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-doctor-fix-json-'));
    const source = path.join(scratch, 'source');
    const homeDir = path.join(scratch, 'home');
    surface(source, '0.2.3');
    fs.mkdirSync(homeDir, { recursive: true });
    let stdout = '';
    try {
      const services = createDefaultServices({
        packageRoot: source,
        cwd: scratch,
        stateRoot: path.join(scratch, 'state'),
        homeDir,
        antigravityConfigRoot: path.join(scratch, 'gemini-config'),
        agyCommand: 'echo',
        pluginAdapter: adapter(),
        hostCliAdapter: {
          which() { return null; },
          run(cmd) {
            expect(cmd).not.toBe('git');
            return { status: 0, stdout: '', stderr: '', timedOut: false };
          },
        },
        environment: { HOME: homeDir, PATH: homeDir },
        stdout: (value) => { stdout += value; },
        stderr: () => undefined,
      });
      const code = await services.doctorCommand(['--fix', '--json']);
      expect([0, 1, 2]).toContain(code);
      const payload = JSON.parse(stdout) as {
        schema: string;
        mutatesGit: boolean;
        retried: boolean;
        before: { checks: DoctorCheckV1[] };
        after: { checks: DoctorCheckV1[] };
      };
      expect(Object.keys(payload).slice(0, 6)).toEqual([
        'schema', 'schemaVersion', 'mutatesGit', 'plannedActions', 'plannedSpawns', 'agyMissing',
      ]);
      expect(payload.schema).toBe(DOCTOR_FIX_SCHEMA);
      expect(payload.mutatesGit).toBe(false);
      expect(payload.retried).toBe(false);
      for (const check of [...payload.before.checks, ...payload.after.checks]) {
        assertCheckFieldOrder(check);
      }
    } finally {
      forceRm(scratch);
    }
  });

  test('agy missing prints a readable skip and does not retry', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-doctor-fix-noagy-'));
    const source = path.join(scratch, 'source');
    const homeDir = path.join(scratch, 'home');
    surface(source, '0.2.3');
    fs.mkdirSync(homeDir, { recursive: true });
    let stdout = '';
    let setups = 0;
    try {
      const services = createDefaultServices({
        packageRoot: source,
        cwd: scratch,
        stateRoot: path.join(scratch, 'state'),
        homeDir,
        antigravityConfigRoot: path.join(scratch, 'gemini-config'),
        agyCommand: path.join(scratch, 'missing-agy'),
        pluginAdapter: adapter(),
        hostCliAdapter: {
          which() { return null; },
          run(cmd) {
            expect(cmd).not.toBe('git');
            return { status: 0, stdout: '', stderr: '', timedOut: false };
          },
        },
        environment: { HOME: homeDir, PATH: homeDir },
        stdout: (value) => { stdout += value; },
        stderr: () => undefined,
      });
      const originalSetup = services.setupCommand.bind(services);
      services.setupCommand = async (argv) => {
        setups += 1;
        return originalSetup(argv);
      };
      const code = await services.doctorCommand(['--fix']);
      expect([0, 1, 2]).toContain(code);
      expect(setups).toBe(1);
      expect(stdout).toMatch(/agy is not runnable/);
      expect(stdout).toMatch(/will not retry/);
    } finally {
      forceRm(scratch);
    }
  });
});
