import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CLI_HELP } from '../../src/cli/application';
import { createDefaultServices, parseDoctorCliOptions } from '../../src/cli/services';
import {
  DOCTOR_CHECK_JSON_KEYS,
  DoctorCheckV1,
  applyDoctorStrictExit,
  checkOmcAutopilotCollision,
  doctorCheckToJsonValue,
  doctorReportToJsonValue,
} from '../../src/setup/doctor';
import {
  DOCTOR_CONFLICT_CHECK_IDS,
  runDoctorConflicts,
} from '../../src/setup/doctor-conflicts';

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

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSkill(pluginRoot: string, name: string): void {
  const dir = path.join(pluginRoot, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${name}\n`);
}

function writeAgyHook(
  pluginRoot: string,
  relative: 'hooks.json' | '.agents/hooks.json' | 'hooks/hooks.json',
  key: string,
  events: readonly string[],
): void {
  const registration: Record<string, unknown> = {};
  for (const event of events) {
    registration[event] = [{ type: 'command', command: `node ${event}.js` }];
  }
  writeJson(path.join(pluginRoot, relative), { [key]: registration });
}

function writeMcp(pluginRoot: string, relative: string, servers: Record<string, unknown>): void {
  writeJson(path.join(pluginRoot, relative), { mcpServers: servers });
}

function writePluginMeta(pluginRoot: string, name: string): void {
  writeJson(path.join(pluginRoot, 'plugin.json'), { name, version: '0.0.0-test' });
}

function treeFingerprint(root: string): string[] {
  const lines: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (entry.isDirectory()) {
        lines.push(`d ${rel}`);
        walk(full);
        continue;
      }
      if (entry.isSymbolicLink()) {
        lines.push(`l ${rel} -> ${fs.readlinkSync(full)}`);
        continue;
      }
      const body = fs.readFileSync(full);
      lines.push(`f ${rel} ${body.length} ${body.toString('hex')}`);
    }
  };
  walk(root);
  return lines;
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

function checkById(checks: readonly DoctorCheckV1[], id: string): DoctorCheckV1 {
  const found = checks.find((item) => item.id === id);
  expect(found).toBeDefined();
  if (found === undefined) throw new Error(`missing check ${id}`);
  return found;
}

describe('oma doctor conflicts (#65)', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  let scratch: string;
  let homeDir: string;
  let packageRoot: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-doctor-conflicts-'));
    homeDir = path.join(scratch, 'home');
    packageRoot = path.join(scratch, 'pkg');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(packageRoot, { recursive: true });
    writeJson(path.join(packageRoot, 'package.json'), {
      name: '@iml1s/oh-my-agy',
      version: '0.0.0-test',
    });
  });

  afterEach(() => forceRm(scratch));

  function report(overrides: Partial<Parameters<typeof runDoctorConflicts>[0]> = {}) {
    return runDoctorConflicts({
      packageRoot,
      packageVersion: '0.0.0-test',
      homeDir,
      cwd: scratch,
      ...overrides,
    });
  }

  test('emits exactly the four conflict check ids in stable order', () => {
    const result = report();
    expect(result.checks.map((item) => item.id)).toEqual([...DOCTOR_CONFLICT_CHECK_IDS]);
    for (const check of result.checks) assertCheckFieldOrder(check);
  });

  test('duplicate_hook_registration warns when two manifests register the same event', () => {
    const pluginDir = path.join(scratch, 'dual-hooks');
    writePluginMeta(pluginDir, 'oh-my-agy');
    writeAgyHook(pluginDir, 'hooks.json', 'oh-my-agy-runtime', ['PreInvocation', 'Stop']);
    writeAgyHook(pluginDir, '.agents/hooks.json', 'oh-my-agy-workspace', ['PreInvocation', 'Stop']);
    const before = treeFingerprint(pluginDir);
    const result = report({ pluginDir });
    const hook = checkById(result.checks, 'duplicate_hook_registration');
    expect(hook.status).toBe('warn');
    expect(hook.message).toMatch(/PreInvocation/);
    expect(hook.message).toMatch(/Stop/);
    expect(hook.message).toMatch(/if both take effect they would fire twice/i);
    expect(hook.message).toMatch(/not a confirmed host defect/i);
    expect(hook.message).not.toMatch(/must be a defect/i);
    expect(result.exitCode).toBe(0);
    expect(treeFingerprint(pluginDir)).toEqual(before);
  });

  test('duplicate_hook_registration passes when only one hook manifest is present', () => {
    const pluginDir = path.join(scratch, 'single-hook');
    writePluginMeta(pluginDir, 'oh-my-agy');
    writeAgyHook(pluginDir, 'hooks.json', 'oh-my-agy-runtime', ['PreInvocation', 'Stop']);
    const result = report({ pluginDir });
    expect(checkById(result.checks, 'duplicate_hook_registration').status).toBe('pass');
    expect(result.exitCode).toBe(0);
  });

  test('duplicate_hook_registration warns across two sibling plugins sharing an event', () => {
    const pluginDir = path.join(scratch, 'plugins');
    writePluginMeta(path.join(pluginDir, 'alpha'), 'alpha');
    writeAgyHook(path.join(pluginDir, 'alpha'), 'hooks.json', 'alpha', ['PreInvocation']);
    writePluginMeta(path.join(pluginDir, 'beta'), 'beta');
    writeAgyHook(path.join(pluginDir, 'beta'), 'hooks.json', 'beta', ['PreInvocation']);
    const hook = checkById(report({ pluginDir }).checks, 'duplicate_hook_registration');
    expect(hook.status).toBe('warn');
    expect(hook.message).toMatch(/PreInvocation/);
  });

  test('missing --plugin-dir path returns a readable warn and does not crash or create the path', () => {
    const missing = path.join(scratch, 'no-such-plugin-dir');
    expect(fs.existsSync(missing)).toBe(false);
    const before = treeFingerprint(scratch);
    const result = report({ pluginDir: missing });
    expect(result.checks.map((item) => item.id)).toEqual([...DOCTOR_CONFLICT_CHECK_IDS]);
    const hook = checkById(result.checks, 'duplicate_hook_registration');
    expect(hook.status).toBe('warn');
    expect(hook.message).toMatch(/not found/i);
    expect(hook.message).toContain(missing);
    expect(checkById(result.checks, 'mcp_server_name_collision').status).toBe('warn');
    expect(checkById(result.checks, 'duplicate_skill_name').status).toBe('warn');
    expect(result.exitCode).toBe(0);
    expect(fs.existsSync(missing)).toBe(false);
    expect(treeFingerprint(scratch)).toEqual(before);
  });

  test('--plugin-dir pointing at a file is readable and does not crash', () => {
    const filePath = path.join(scratch, 'not-a-dir.json');
    fs.writeFileSync(filePath, '{}\n');
    const result = report({ pluginDir: filePath });
    const hook = checkById(result.checks, 'duplicate_hook_registration');
    expect(hook.status).toBe('warn');
    expect(hook.message).toMatch(/not a directory/i);
    expect(result.exitCode).toBe(0);
  });

  test('mcp_server_name_collision warns when two plugins declare the same MCP server', () => {
    const pluginDir = path.join(scratch, 'mcp-dup');
    writePluginMeta(path.join(pluginDir, 'one'), 'one');
    writeMcp(path.join(pluginDir, 'one'), '.mcp.json', {
      shared: { command: 'node', args: ['one.js'] },
    });
    writePluginMeta(path.join(pluginDir, 'two'), 'two');
    writeMcp(path.join(pluginDir, 'two'), '.claude-plugin/.mcp.json', {
      shared: { command: 'node', args: ['two.js'] },
    });
    const mcp = checkById(report({ pluginDir }).checks, 'mcp_server_name_collision');
    expect(mcp.status).toBe('warn');
    expect(mcp.message).toMatch(/shared/);
  });

  test('mcp_server_name_collision passes for unique names and same-plugin dual host files', () => {
    const pluginDir = path.join(scratch, 'mcp-ok');
    const oma = path.join(pluginDir, 'oh-my-agy');
    writePluginMeta(oma, 'oh-my-agy');
    writeMcp(oma, '.mcp.json', {
      'oh-my-agy': { command: 'node', args: ['agy.js'] },
    });
    writeMcp(oma, '.claude-plugin/.mcp.json', {
      'oh-my-agy': { command: 'node', args: ['claude.js'] },
    });
    writePluginMeta(path.join(pluginDir, 'other'), 'other');
    writeMcp(path.join(pluginDir, 'other'), '.mcp.json', {
      other: { command: 'node', args: ['other.js'] },
    });
    expect(checkById(report({ pluginDir }).checks, 'mcp_server_name_collision').status).toBe('pass');
  });

  test('duplicate_skill_name warns when two plugins provide the same slash skill', () => {
    const pluginDir = path.join(scratch, 'skills-dup');
    writePluginMeta(path.join(pluginDir, 'oma'), 'oh-my-agy');
    writeSkill(path.join(pluginDir, 'oma'), 'autopilot');
    writePluginMeta(path.join(pluginDir, 'omc'), 'oh-my-claudecode');
    writeSkill(path.join(pluginDir, 'omc'), 'autopilot');
    const skill = checkById(report({ pluginDir }).checks, 'duplicate_skill_name');
    expect(skill.status).toBe('warn');
    expect(skill.message).toMatch(/autopilot/);
  });

  test('duplicate_skill_name passes when skill names are unique', () => {
    const pluginDir = path.join(scratch, 'skills-ok');
    writePluginMeta(path.join(pluginDir, 'oma'), 'oh-my-agy');
    writeSkill(path.join(pluginDir, 'oma'), 'autopilot');
    writePluginMeta(path.join(pluginDir, 'other'), 'other');
    writeSkill(path.join(pluginDir, 'other'), 'other-skill');
    expect(checkById(report({ pluginDir }).checks, 'duplicate_skill_name').status).toBe('pass');
  });

  test('competing_plugin_autopilot reuses slash_collision without reimplementing it', () => {
    const omcSkill = path.join(homeDir, '.claude', 'skills', 'autopilot', 'SKILL.md');
    fs.mkdirSync(path.dirname(omcSkill), { recursive: true });
    fs.writeFileSync(omcSkill, 'omc autopilot\n');
    const slash = checkOmcAutopilotCollision(homeDir);
    const competing = checkById(report().checks, 'competing_plugin_autopilot');
    expect(slash.id).toBe('slash_collision');
    expect(slash.status).toBe('warn');
    expect(competing.status).toBe(slash.status);
    expect(competing.message).toBe(slash.message);
    expect(competing.nextAction).toBe(slash.nextAction);
    expect(competing.detail).toEqual(slash.detail);
    expect(competing.id).toBe('competing_plugin_autopilot');
  });

  test('competing_plugin_autopilot passes when OMC autopilot paths are absent', () => {
    const slash = checkOmcAutopilotCollision(homeDir);
    const competing = checkById(report().checks, 'competing_plugin_autopilot');
    expect(slash.status).toBe('pass');
    expect(competing.status).toBe('pass');
    expect(competing.message).toBe(slash.message);
  });

  test('default exit code is 0 even when checks warn; --strict upgrades to 1', () => {
    const pluginDir = path.join(scratch, 'warn-exit');
    writePluginMeta(pluginDir, 'oh-my-agy');
    writeAgyHook(pluginDir, 'hooks.json', 'oh-my-agy-runtime', ['Stop']);
    writeAgyHook(pluginDir, '.agents/hooks.json', 'oh-my-agy-workspace', ['Stop']);
    const soft = report({ pluginDir, strict: false });
    expect(soft.exitCode).toBe(0);
    expect(soft.ok).toBe(true);
    expect(soft.mode).toBe('development');
    const hard = report({ pluginDir, strict: true });
    expect(hard.exitCode).toBe(1);
    expect(hard.mode).toBe('strict');
    expect(checkById(hard.checks, 'duplicate_hook_registration').status).toBe('warn');
  });

  test('--strict is a no-op when every conflict check passes', () => {
    const pluginDir = path.join(scratch, 'clean');
    writePluginMeta(pluginDir, 'oh-my-agy');
    writeAgyHook(pluginDir, 'hooks.json', 'oh-my-agy-runtime', ['Stop']);
    const result = report({ pluginDir, strict: true });
    expect(result.checks.every((item) => item.status === 'pass')).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  test('--json DoctorCheckV1 shape matches canonical field order', () => {
    const pluginDir = path.join(scratch, 'json-shape');
    writePluginMeta(pluginDir, 'oh-my-agy');
    writeAgyHook(pluginDir, 'hooks.json', 'oh-my-agy-runtime', ['Stop']);
    writeAgyHook(pluginDir, '.agents/hooks.json', 'oh-my-agy-workspace', ['Stop']);
    const result = report({ pluginDir });
    const jsonValue = doctorReportToJsonValue(result);
    expect(Object.keys(jsonValue)).toEqual([
      'schemaVersion', 'ok', 'exitCode', 'packageRoot', 'packageVersion', 'mode', 'checks',
    ]);
    for (const check of jsonValue.checks) {
      assertCheckFieldOrder(check);
      expect(Object.keys(doctorCheckToJsonValue(check)).slice(0, 4))
        .toEqual([...DOCTOR_CHECK_JSON_KEYS]);
    }
    expect(JSON.parse(JSON.stringify(jsonValue)).checks[0].id).toBe('duplicate_hook_registration');
  });

  test('execution is read-only against a mixed fixture tree', () => {
    const pluginDir = path.join(scratch, 'readonly');
    writePluginMeta(path.join(pluginDir, 'left'), 'left');
    writeAgyHook(path.join(pluginDir, 'left'), 'hooks.json', 'left', ['PreInvocation']);
    writeMcp(path.join(pluginDir, 'left'), '.mcp.json', { shared: { command: 'node' } });
    writeSkill(path.join(pluginDir, 'left'), 'autopilot');
    writePluginMeta(path.join(pluginDir, 'right'), 'right');
    writeAgyHook(path.join(pluginDir, 'right'), 'hooks.json', 'right', ['PreInvocation']);
    writeMcp(path.join(pluginDir, 'right'), '.mcp.json', { shared: { command: 'node' } });
    writeSkill(path.join(pluginDir, 'right'), 'autopilot');
    const before = treeFingerprint(scratch);
    report({ pluginDir, strict: true });
    expect(treeFingerprint(scratch)).toEqual(before);
  });

  test('source stays read-only (no fs mutation APIs)', () => {
    const src = fs.readFileSync(path.join(repoRoot, 'src/setup/doctor-conflicts.ts'), 'utf8');
    expect(src).not.toMatch(/\bfs\.(writeFile|mkdir|rm|unlink|appendFile|chmod|rename|copyFile)/);
    expect(src).not.toMatch(/\b(?:spawn|exec)(?:Sync)?\s*\(/);
  });

  test('real package dual hook manifests warn and are not modified', () => {
    const tracked = ['hooks.json', '.agents/hooks.json'].map((relative) => {
      const filePath = path.join(repoRoot, relative);
      const stat = fs.statSync(filePath);
      return {
        relative,
        mtimeMs: stat.mtimeMs,
        bytes: fs.readFileSync(filePath),
      };
    });
    const result = runDoctorConflicts({
      packageRoot: repoRoot,
      homeDir,
      cwd: repoRoot,
    });
    const hook = checkById(result.checks, 'duplicate_hook_registration');
    expect(hook.status).toBe('warn');
    expect(hook.message).toMatch(/if both take effect they would fire twice/i);
    expect(result.exitCode).toBe(0);
    for (const entry of tracked) {
      const filePath = path.join(repoRoot, entry.relative);
      expect(fs.statSync(filePath).mtimeMs).toBe(entry.mtimeMs);
      expect(fs.readFileSync(filePath).equals(entry.bytes)).toBe(true);
    }
  });
});

describe('parseDoctorCliOptions conflicts / --strict (#65)', () => {
  test('keeps --fix parsing and adds conflicts/--strict/--plugin-dir defaults', () => {
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
    expect(parseDoctorCliOptions(['conflicts', '--json', '--plugin-dir', '/tmp/x', '--strict'])).toEqual({
      asJson: true,
      native: false,
      strictPlugin: true,
      fix: false,
      strict: true,
      conflicts: true,
      pluginDir: '/tmp/x',
    });
    expect(parseDoctorCliOptions(['--strict'])).toEqual({
      asJson: false,
      native: false,
      strictPlugin: true,
      fix: false,
      strict: true,
      conflicts: false,
      pluginDir: undefined,
    });
  });

  test('rejects unknown, duplicate, and illegal combinations', () => {
    expect(() => parseDoctorCliOptions(['--fix', '--fix'])).toThrow(/duplicate option --fix/);
    expect(() => parseDoctorCliOptions(['--unknown'])).toThrow(/unexpected argument/);
    expect(() => parseDoctorCliOptions(['positional'])).toThrow(/unexpected argument/);
    expect(() => parseDoctorCliOptions(['conflicts', 'conflicts'])).toThrow(/duplicate option conflicts/);
    expect(() => parseDoctorCliOptions(['conflicts', '--plugin-dir'])).toThrow(/--plugin-dir requires a path/);
    expect(() => parseDoctorCliOptions(['--plugin-dir', '/tmp/x'])).toThrow(/only valid with conflicts/);
    expect(() => parseDoctorCliOptions(['conflicts', '--fix'])).toThrow(/read-only/);
    expect(() => parseDoctorCliOptions(['conflicts', '--native'])).toThrow(/--native/);
    expect(() => parseDoctorCliOptions(['conflicts', '--no-strict-plugin'])).toThrow(/--no-strict-plugin/);
    expect(() => parseDoctorCliOptions(['--strict', '--strict'])).toThrow(/duplicate option --strict/);
  });

  test('CLI_HELP documents the conflicts subcommand without dropping --fix', () => {
    expect(CLI_HELP).toContain('oma doctor [--json] [--no-strict-plugin] [--native] [--fix]');
    expect(CLI_HELP).toContain('oma doctor conflicts [--json] [--plugin-dir <path>] [--strict]');
  });

  test('applyDoctorStrictExit upgrades warn-only doctor exit 2 to 1', () => {
    const report = {
      schemaVersion: 1 as const,
      ok: true,
      exitCode: 2 as const,
      packageRoot: '/tmp',
      packageVersion: '0.0.0',
      mode: 'development' as const,
      checks: [],
    };
    expect(applyDoctorStrictExit(report, false).exitCode).toBe(2);
    expect(applyDoctorStrictExit(report, true).exitCode).toBe(1);
    expect(applyDoctorStrictExit({ ...report, exitCode: 0 }, true).exitCode).toBe(0);
    expect(applyDoctorStrictExit({ ...report, exitCode: 1, ok: false }, true).exitCode).toBe(1);
  });
});

describe('oma doctor conflicts CLI wiring (#65)', () => {
  test('doctorCommand conflicts --json is read-only, exit 0 on warn, 1 with --strict', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-doctor-conflicts-cli-'));
    const homeDir = path.join(scratch, 'home');
    const pluginDir = path.join(scratch, 'plugins');
    const packageRoot = path.join(scratch, 'pkg');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(packageRoot, { recursive: true });
    writeJson(path.join(packageRoot, 'package.json'), { name: '@iml1s/oh-my-agy', version: '0.0.0-test' });
    writePluginMeta(pluginDir, 'oh-my-agy');
    writeAgyHook(pluginDir, 'hooks.json', 'oh-my-agy-runtime', ['Stop']);
    writeAgyHook(pluginDir, '.agents/hooks.json', 'oh-my-agy-workspace', ['Stop']);
    const before = treeFingerprint(scratch);
    let stdout = '';
    try {
      const services = createDefaultServices({
        packageRoot,
        cwd: scratch,
        homeDir,
        stateRoot: path.join(scratch, 'state'),
        antigravityConfigRoot: path.join(scratch, 'gemini-config'),
        agyCommand: path.join(scratch, 'missing-agy'),
        environment: { HOME: homeDir, PATH: homeDir },
        stdout: (value) => { stdout += value; },
        stderr: () => undefined,
      });
      const code = await services.doctorCommand(['conflicts', '--json', '--plugin-dir', pluginDir]);
      expect(code).toBe(0);
      const payload = JSON.parse(stdout) as {
        exitCode: number;
        checks: DoctorCheckV1[];
      };
      expect(payload.exitCode).toBe(0);
      expect(payload.checks.map((item) => item.id)).toEqual([...DOCTOR_CONFLICT_CHECK_IDS]);
      expect(checkById(payload.checks, 'duplicate_hook_registration').status).toBe('warn');
      for (const check of payload.checks) assertCheckFieldOrder(check);

      stdout = '';
      const strictCode = await services.doctorCommand([
        'conflicts', '--json', '--plugin-dir', pluginDir, '--strict',
      ]);
      expect(strictCode).toBe(1);
      expect(JSON.parse(stdout).exitCode).toBe(1);
      expect(treeFingerprint(scratch)).toEqual(before);
    } finally {
      forceRm(scratch);
    }
  });

  test('doctorCommand conflicts with a missing --plugin-dir path does not crash', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-doctor-conflicts-missing-'));
    const homeDir = path.join(scratch, 'home');
    const packageRoot = path.join(scratch, 'pkg');
    const missing = path.join(scratch, 'absent-plugins');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(packageRoot, { recursive: true });
    writeJson(path.join(packageRoot, 'package.json'), { name: '@iml1s/oh-my-agy', version: '0.0.0-test' });
    let stdout = '';
    let stderr = '';
    try {
      const services = createDefaultServices({
        packageRoot,
        cwd: scratch,
        homeDir,
        stateRoot: path.join(scratch, 'state'),
        antigravityConfigRoot: path.join(scratch, 'gemini-config'),
        agyCommand: path.join(scratch, 'missing-agy'),
        environment: { HOME: homeDir, PATH: homeDir },
        stdout: (value) => { stdout += value; },
        stderr: (value) => { stderr += value; },
      });
      const code = await services.doctorCommand(['conflicts', '--plugin-dir', missing, '--json']);
      expect(code).toBe(0);
      expect(stderr).toBe('');
      expect(fs.existsSync(missing)).toBe(false);
      const payload = JSON.parse(stdout) as { checks: DoctorCheckV1[] };
      expect(checkById(payload.checks, 'duplicate_hook_registration').message).toMatch(/not found/i);
    } finally {
      forceRm(scratch);
    }
  });

  test('doctor --strict upgrades warn-only main doctor exit 2 to 1 without breaking --fix parse', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-doctor-strict-exit-'));
    const homeDir = path.join(scratch, 'home');
    const source = path.join(scratch, 'source');
    fs.mkdirSync(homeDir, { recursive: true });
    fs.mkdirSync(path.join(source, 'dist', 'bin'), { recursive: true });
    fs.mkdirSync(path.join(source, 'dist', 'src', 'hooks'), { recursive: true });
    fs.mkdirSync(path.join(source, '.claude-plugin'), { recursive: true });
    fs.mkdirSync(path.join(source, 'skills', 'autopilot'), { recursive: true });
    writeJson(path.join(source, 'package.json'), {
      name: '@iml1s/oh-my-agy',
      version: '0.2.3',
      bin: { oma: 'dist/bin/oma.js' },
    });
    writeJson(path.join(source, 'plugin.json'), { name: 'oh-my-agy', version: '0.2.3' });
    writeJson(path.join(source, '.claude-plugin', 'plugin.json'), {
      name: 'oh-my-agy', version: '0.2.3', skills: ['./skills/autopilot/'],
    });
    writeJson(path.join(source, '.claude-plugin', 'marketplace.json'), {
      name: 'oh-my-agy', version: '0.2.3', plugins: [{ name: 'oh-my-agy', version: '0.2.3' }],
    });
    fs.writeFileSync(path.join(source, 'dist', 'bin', 'oma.js'), '#!/usr/bin/env node\n');
    fs.writeFileSync(path.join(source, 'dist', 'src', 'hooks', 'pre-invocation.js'), 'hook\n');
    fs.writeFileSync(path.join(source, 'dist', 'src', 'hooks', 'stop.js'), 'hook\n');
    fs.writeFileSync(
      path.join(source, 'skills', 'autopilot', 'SKILL.md'),
      '# IN-SESSION PRIMARY\nYou are already in the agent session.\n',
    );
    writeJson(path.join(source, 'hooks.json'), {
      'oh-my-agy-runtime': {
        PreInvocation: [{ command: 'node "${extensionPath}/dist/src/hooks/pre-invocation.js"' }],
        Stop: [{ command: 'node "${extensionPath}/dist/src/hooks/stop.js"' }],
      },
    });
    let stdout = '';
    try {
      const services = createDefaultServices({
        packageRoot: source,
        cwd: scratch,
        homeDir,
        stateRoot: path.join(scratch, 'state'),
        antigravityConfigRoot: path.join(scratch, 'gemini-config'),
        agyCommand: path.join(scratch, 'missing-agy'),
        pluginAdapter: {
          async run(argv) {
            return { argv, code: 0, stdout: JSON.stringify({ imports: [] }), stderr: '' };
          },
        },
        environment: { HOME: homeDir, PATH: homeDir },
        stdout: (value) => { stdout += value; },
        stderr: () => undefined,
      });
      const warnCode = await services.doctorCommand(['--no-strict-plugin', '--json']);
      expect(warnCode).toBe(2);
      stdout = '';
      const strictCode = await services.doctorCommand(['--no-strict-plugin', '--strict', '--json']);
      expect(strictCode).toBe(1);
      expect(JSON.parse(stdout).exitCode).toBe(1);
    } finally {
      forceRm(scratch);
    }
  });
});
