import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDefaultServices } from '../../src/cli/services';
import {
  HostCliAdapter,
  HostCliResult,
  grokMcpAddArgs,
  plannedClaudeSlashSpawns,
  plannedGrokSlashSpawns,
} from '../../src/setup/host-install';
import { computePackageIdentity } from '../../src/setup/installed-identity';
import { PluginCommandAdapter, PluginCommandResult } from '../../src/setup/plugin';
import {
  SETUP_DRY_RUN_SCHEMA,
  SetupDryRunPlanV1,
} from '../../src/setup/dry-run';
import { plannedAgyPluginSpawns } from '../../src/setup/transaction';

function surface(root: string, version: string, marker = version): void {
  fs.mkdirSync(path.join(root, 'dist', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'src', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: '@iml1s/oh-my-agy', version,
    bin: { oma: 'dist/bin/oma.js', omy: 'dist/bin/oma.js' },
    files: ['dist/bin', 'dist/src', 'plugin.json', 'hooks.json', 'skills', 'rules', 'package.json'],
  }));
  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({ name: 'oh-my-agy', version }));
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify({
    name: 'oh-my-agy', version,
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
  fs.writeFileSync(path.join(root, 'skills', 'runtime', 'SKILL.md'), marker);
  fs.writeFileSync(path.join(root, 'rules', 'runtime.md'), marker);
}

function snapshotTree(root: string): string {
  const rows: string[] = [];
  const walk = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })
      .sort((left, right) => Buffer.compare(Buffer.from(left.name, 'utf8'), Buffer.from(right.name, 'utf8')))) {
      const abs = path.join(dir, entry.name);
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (entry.isSymbolicLink()) {
        rows.push(`L ${rel} -> ${fs.readlinkSync(abs)}`);
        continue;
      }
      if (entry.isDirectory()) {
        rows.push(`D ${rel}`);
        walk(abs);
        continue;
      }
      const bytes = fs.readFileSync(abs);
      const mode = (fs.statSync(abs).mode & 0o777).toString(8);
      rows.push(`F ${rel} ${mode} ${crypto.createHash('sha256').update(bytes).digest('hex')}`);
    }
  };
  walk(root);
  return rows.join('\n');
}

class CountingPluginAdapter implements PluginCommandAdapter {
  readonly calls: string[][] = [];

  async run(argv: readonly string[]): Promise<PluginCommandResult> {
    this.calls.push([...argv]);
    throw new Error(`spawn not allowed in dry-run: ${argv.join(' ')}`);
  }
}

class CountingHostAdapter implements HostCliAdapter {
  readonly whichCalls: string[] = [];
  readonly runCalls: Array<{ cmd: string; args: readonly string[] }> = [];

  which(cmd: string): string | null {
    this.whichCalls.push(cmd);
    return `/injected/${cmd}`;
  }

  run(cmd: string, args: readonly string[]): HostCliResult {
    this.runCalls.push({ cmd, args });
    throw new Error(`spawn not allowed in dry-run: ${cmd} ${args.join(' ')}`);
  }
}

describe('oma setup --dry-run', () => {
  let scratch: string;
  let source: string;
  let stateRoot: string;
  let configRoot: string;
  let homeDir: string;
  let installedRoot: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-setup-dry-run-'));
    source = path.join(scratch, 'source');
    stateRoot = path.join(scratch, 'state');
    configRoot = path.join(scratch, 'gemini-config');
    homeDir = path.join(scratch, 'home');
    installedRoot = path.join(configRoot, 'plugins', 'oh-my-agy');
    fs.mkdirSync(homeDir, { recursive: true });
    surface(source, '1.0.0', 'candidate');
    surface(installedRoot, '0.9.0', 'previous');
  });

  afterEach(() => {
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  async function runSetup(argv: readonly string[]): Promise<{
    code: number;
    stdout: string;
    stderr: string;
    plugin: CountingPluginAdapter;
    host: CountingHostAdapter;
    before: string;
    after: string;
  }> {
    const plugin = new CountingPluginAdapter();
    const host = new CountingHostAdapter();
    let stdout = '';
    let stderr = '';
    const before = snapshotTree(scratch);
    const services = createDefaultServices({
      packageRoot: source,
      stateRoot,
      cwd: scratch,
      agyCommand: 'agy',
      pluginAdapter: plugin,
      hostCliAdapter: host,
      homeDir,
      antigravityConfigRoot: configRoot,
      environment: { HOME: homeDir, PATH: homeDir },
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    });
    const code = await services.setupCommand(argv);
    const after = snapshotTree(scratch);
    return { code, stdout, stderr, plugin, host, before, after };
  }

  test('prints canonical plan, full spawn argv, and never spawns or mutates', async () => {
    const result = await runSetup(['--dry-run']);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.plugin.calls).toEqual([]);
    expect(result.host.whichCalls).toEqual([]);
    expect(result.host.runCalls).toEqual([]);
    expect(result.after).toBe(result.before);
    expect(fs.existsSync(stateRoot)).toBe(false);

    const plan = JSON.parse(result.stdout) as SetupDryRunPlanV1;
    expect(plan.schema).toBe(SETUP_DRY_RUN_SCHEMA);
    expect(plan.dryRun).toBe(true);
    expect(plan.mutates).toBe(false);
    expect(plan.hosts).toEqual(['all']);
    expect(plan.scope).toBe('global');
    expect(plan.packageRoot).toBe(path.resolve(source));
    expect(plan.candidateIdentity?.version).toBe('1.0.0');
    expect(plan.installedIdentity?.version).toBe('0.9.0');
    expect(plan.installedIdentity?.digest).not.toBe(plan.candidateIdentity?.digest);

    const identity = computePackageIdentity(source);
    expect(identity.ok).toBe(true);
    if (!identity.ok) return;
    const stagePath = path.join(stateRoot, 'install', 'stages', identity.value.digest);
    expect(plan.targetPaths.stagePath).toBe(stagePath);
    expect(plan.targetPaths.pluginInstallPath).toBe(installedRoot);
    expect(plan.plannedSpawns.map((row) => row.args)).toEqual([
      ...plannedAgyPluginSpawns('agy', 'oh-my-agy', stagePath, true),
      ...plannedClaudeSlashSpawns(path.resolve(source)),
      ...plannedGrokSlashSpawns(path.resolve(source)),
    ]);
    expect(plan.plannedSpawns.some((row) => row.args.includes('plugin') && row.args.includes('marketplace'))).toBe(true);
    expect(JSON.stringify(plan)).not.toMatch(/Bearer |token=/i);
  });

  test.each([
    [['--dry-run'], 'global', ['all'], ['agy', 'claude', 'grok']],
    [['--dry-run', '--global'], 'global', ['all'], ['agy', 'claude', 'grok']],
    [['--dry-run', '--workspace'], 'workspace', ['all'], ['agy', 'claude', 'grok']],
    [['--dry-run', '--host', 'all'], 'global', ['all'], ['agy', 'claude', 'grok']],
    [['--dry-run', '--host', 'agy'], 'global', ['agy'], ['agy']],
    [['--dry-run', '--host', 'claude'], 'global', ['claude'], ['claude']],
    [['--dry-run', '--host', 'grok'], 'global', ['grok'], ['grok']],
    [['--dry-run', '--host', 'claude', '--workspace'], 'workspace', ['claude'], ['claude']],
    [['--host', 'grok', '--global', '--dry-run'], 'global', ['grok'], ['grok']],
  ] as const)('flag matrix %j', async (argv, scope, hosts, spawnHosts) => {
    const result = await runSetup(argv);
    expect(result.code).toBe(0);
    expect(result.plugin.calls).toEqual([]);
    expect(result.host.whichCalls).toEqual([]);
    expect(result.host.runCalls).toEqual([]);
    expect(result.after).toBe(result.before);
    const plan = JSON.parse(result.stdout) as SetupDryRunPlanV1;
    expect(plan.scope).toBe(scope);
    expect(plan.hosts).toEqual([...hosts]);
    expect([...new Set(plan.plannedSpawns.map((row) => row.host))].sort()).toEqual([...spawnHosts]);
    const expectedHosts = spawnHosts as readonly string[];
    if (expectedHosts.includes('claude')) {
      expect(plan.plannedSpawns).toEqual(expect.arrayContaining([
        expect.objectContaining({
          host: 'claude',
          args: ['claude', 'plugin', 'marketplace', 'add', path.resolve(source)],
        }),
        expect.objectContaining({
          host: 'claude',
          args: ['claude', 'plugin', 'install', 'oh-my-agy@oh-my-agy'],
        }),
      ]));
    }
    if (expectedHosts.includes('grok')) {
      expect(plan.plannedSpawns).toEqual(expect.arrayContaining([
        expect.objectContaining({
          host: 'grok',
          args: ['grok', 'plugin', 'install', path.resolve(source), '--trust'],
        }),
        expect.objectContaining({
          host: 'grok',
          args: ['grok', ...grokMcpAddArgs(path.resolve(source))],
        }),
      ]));
    }
    if (expectedHosts.includes('agy')) {
      expect(plan.plannedSpawns.some((row) => (
        row.host === 'agy' && row.args[0] === 'agy' && row.args[1] === 'plugin'
      ))).toBe(true);
    }
  });

  test('invalid --host still fails closed without spawn or mutation', async () => {
    const result = await runSetup(['--dry-run', '--host', 'nope']);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Invalid --host value');
    expect(result.plugin.calls).toEqual([]);
    expect(result.host.whichCalls).toEqual([]);
    expect(result.host.runCalls).toEqual([]);
    expect(result.after).toBe(result.before);
  });

  test('without --dry-run still dispatches injected host adapter', async () => {
    const host = new CountingHostAdapter();
    host.run = (cmd, args) => {
      host.runCalls.push({ cmd, args });
      return { status: 0, stdout: 'ok', stderr: '', timedOut: false };
    };
    const plugin = new CountingPluginAdapter();
    const services = createDefaultServices({
      packageRoot: source,
      stateRoot,
      cwd: scratch,
      pluginAdapter: plugin,
      hostCliAdapter: host,
      homeDir,
      antigravityConfigRoot: configRoot,
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(await services.setupCommand(['--host', 'claude'])).toBe(0);
    expect(host.runCalls.length).toBeGreaterThan(0);
    expect(host.runCalls[0]?.args[0]).toBe('plugin');
  });
});
