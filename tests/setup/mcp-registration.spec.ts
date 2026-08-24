import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { MCP_OPERATION_NAMES_V1 } from '../../src/mcp/operations';
import { runDoctor } from '../../src/setup/doctor';
import {
  HostCliAdapter,
  HostCliResult,
  grokMcpAddArgs,
  grokMcpServerBin,
  installSlashHosts,
  plannedGrokSlashSpawns,
} from '../../src/setup/host-install';
import { PluginCommandAdapter } from '../../src/setup/plugin';

const repoRoot = path.resolve(__dirname, '../..');

function fakeResult(partial: Partial<HostCliResult> = {}): HostCliResult {
  return {
    status: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...partial,
  };
}

function recordingAdapter(opts: {
  which?: Record<string, string | null>;
  run?: (cmd: string, args: readonly string[]) => HostCliResult;
}): HostCliAdapter & { calls: Array<{ cmd: string; args: readonly string[] }> } {
  const calls: Array<{ cmd: string; args: readonly string[] }> = [];
  return {
    which(cmd: string) {
      if (opts.which && cmd in opts.which) return opts.which[cmd] ?? null;
      return null;
    },
    run(cmd: string, args: readonly string[]) {
      calls.push({ cmd, args: [...args] });
      if (opts.run) return opts.run(cmd, args);
      return fakeResult({ status: 0, stdout: 'ok' });
    },
    calls,
  };
}

function doctorAdapter(): PluginCommandAdapter {
  return {
    async run(argv) {
      return { argv, code: 0, stdout: JSON.stringify({ imports: [] }), stderr: '' };
    },
  };
}

function writeDoctorSurface(root: string, version: string, opts?: {
  claudePlugin?: Record<string, unknown>;
  claudeMcp?: Record<string, unknown> | null;
}): void {
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
  fs.writeFileSync(path.join(root, '.claude-plugin', 'plugin.json'), JSON.stringify(
    opts?.claudePlugin ?? {
      name: 'oh-my-agy',
      version,
      skills: ['./skills/autopilot/'],
      mcpServers: './.claude-plugin/.mcp.json',
    },
  ));
  fs.writeFileSync(path.join(root, '.claude-plugin', 'marketplace.json'), JSON.stringify({
    name: 'oh-my-agy',
    version,
    owner: { name: 'ImL1s' },
    plugins: [{ name: 'oh-my-agy', source: './', version }],
  }));
  fs.writeFileSync(path.join(root, 'hooks.json'), JSON.stringify({
    'oh-my-agy-runtime': {
      PreInvocation: [{ command: 'node "${extensionPath}/dist/src/hooks/pre-invocation.js"' }],
      Stop: [{ command: 'node "${extensionPath}/dist/src/hooks/stop.js"' }],
    },
  }));
  fs.writeFileSync(path.join(root, 'dist', 'bin', 'oma.js'), '#!/usr/bin/env node\n');
  fs.chmodSync(path.join(root, 'dist', 'bin', 'oma.js'), 0o755);
  fs.writeFileSync(path.join(root, 'dist', 'src', 'hooks', 'pre-invocation.js'), version);
  fs.writeFileSync(path.join(root, 'dist', 'src', 'hooks', 'stop.js'), version);
  fs.writeFileSync(
    path.join(root, 'skills', 'autopilot', 'SKILL.md'),
    '# IN-SESSION PRIMARY\nYou are already in the agent session.\n',
  );
  fs.writeFileSync(path.join(root, 'rules', 'runtime.md'), version);
  if (opts?.claudeMcp === null) return;
  fs.writeFileSync(path.join(root, '.claude-plugin', '.mcp.json'), JSON.stringify(
    opts?.claudeMcp ?? {
      mcpServers: {
        'oh-my-agy': {
          command: 'node',
          args: ['${CLAUDE_PLUGIN_ROOT}/dist/bin/oma.js', 'mcp-server'],
          env: { OMA_PACKAGE_ROOT: '${CLAUDE_PLUGIN_ROOT}' },
        },
      },
    },
  ));
}

describe('Claude / Grok MCP registration (#49)', () => {
  test('Claude plugin manifest points at .claude-plugin/.mcp.json and uses CLAUDE_PLUGIN_ROOT', () => {
    const claudePlugin = JSON.parse(
      fs.readFileSync(path.join(repoRoot, '.claude-plugin', 'plugin.json'), 'utf8'),
    ) as { mcpServers?: unknown };
    const claudeMcpRaw = fs.readFileSync(
      path.join(repoRoot, '.claude-plugin', '.mcp.json'),
      'utf8',
    );
    const claudeMcp = JSON.parse(claudeMcpRaw) as {
      mcpServers?: {
        'oh-my-agy'?: {
          command?: string;
          args?: string[];
          env?: Record<string, string>;
        };
      };
    };
    const rootMcp = JSON.parse(
      fs.readFileSync(path.join(repoRoot, '.mcp.json'), 'utf8'),
    ) as {
      mcpServers?: {
        'oh-my-agy'?: { args?: string[]; env?: Record<string, string> };
      };
    };

    expect(claudePlugin.mcpServers).toBe('./.claude-plugin/.mcp.json');
    expect(fs.existsSync(path.join(repoRoot, '.claude-plugin', '.mcp.json'))).toBe(true);
    expect(claudeMcpRaw).not.toContain('${extensionPath}');
    expect(claudeMcpRaw).toContain('${CLAUDE_PLUGIN_ROOT}');
    expect(claudeMcp.mcpServers?.['oh-my-agy']?.command).toBe('node');
    expect(claudeMcp.mcpServers?.['oh-my-agy']?.args).toEqual([
      '${CLAUDE_PLUGIN_ROOT}/dist/bin/oma.js',
      'mcp-server',
    ]);
    expect(claudeMcp.mcpServers?.['oh-my-agy']?.env?.OMA_PACKAGE_ROOT).toBe('${CLAUDE_PLUGIN_ROOT}');

    // Antigravity 根目錄 .mcp.json 不得回歸；${extensionPath} 僅屬 agy。
    expect(rootMcp.mcpServers?.['oh-my-agy']?.args).toEqual([
      '${extensionPath}/dist/bin/oma.js',
      'mcp-server',
    ]);
    expect(rootMcp.mcpServers?.['oh-my-agy']?.env?.OMA_PACKAGE_ROOT).toBe('${extensionPath}');
  });

  test('package.json files already includes .claude-plugin so the new json is packed', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as {
      files?: string[];
    };
    expect(pkg.files).toEqual(expect.arrayContaining(['.claude-plugin']));
    expect(fs.existsSync(path.join(repoRoot, '.claude-plugin', '.mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, '.claude-plugin', 'plugin.json'))).toBe(true);
  });

  test('does not add MCP operations beyond the fixed six read/proposal ops', () => {
    expect(MCP_OPERATION_NAMES_V1).toEqual([
      'run_status.read',
      'recovery_manifest.read',
      'wiki.search',
      'team_status.read',
      'mailbox.list',
      'proposal.create',
    ]);
  });

  test('Grok planned argv is grok mcp add oh-my-agy <bin> -- mcp-server (injected adapter only)', () => {
    const root = '/tmp/oma-package';
    const bin = grokMcpServerBin(root);
    expect(bin).toBe(path.join(root, 'dist', 'bin', 'oma.js'));
    expect(grokMcpAddArgs(root)).toEqual([
      'mcp', 'add', 'oh-my-agy', bin, '--', 'mcp-server',
    ]);
    expect(plannedGrokSlashSpawns(root)).toEqual([
      ['grok', 'plugin', 'install', root, '--trust'],
      ['grok', 'mcp', 'add', 'oh-my-agy', bin, '--', 'mcp-server'],
    ]);
  });

  test('oma setup --host grok receipt includes MCP add argv and result via fake HostCliAdapter', () => {
    const adapter = recordingAdapter({
      which: { grok: '/bin/grok' },
      run: (_cmd, args) => {
        if (args[0] === 'mcp') {
          return fakeResult({ status: 0, stdout: "Added stdio MCP server 'oh-my-agy'" });
        }
        return fakeResult({ status: 0, stdout: 'plugin installed' });
      },
    });
    const result = installSlashHosts(repoRoot, ['grok'], adapter);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps).toHaveLength(1);
    const step = result.value.steps[0];
    expect(step.host).toBe('grok');
    expect(step.status).toBe('ok');
    const bin = grokMcpServerBin(repoRoot);
    expect(adapter.calls).toEqual([
      { cmd: '/bin/grok', args: ['plugin', 'install', repoRoot, '--trust'] },
      { cmd: '/bin/grok', args: ['mcp', 'add', 'oh-my-agy', bin, '--', 'mcp-server'] },
    ]);
    expect(step.commandReceipts).toHaveLength(2);
    expect(step.commandReceipts?.[0]?.argv).toEqual([
      '/bin/grok', 'plugin', 'install', repoRoot, '--trust',
    ]);
    expect(step.commandReceipts?.[0]?.exitCode).toBe(0);
    expect(step.commandReceipts?.[1]?.argv).toEqual([
      '/bin/grok', 'mcp', 'add', 'oh-my-agy', bin, '--', 'mcp-server',
    ]);
    expect(step.commandReceipts?.[1]?.exitCode).toBe(0);
    expect(step.commands).toEqual(expect.arrayContaining([
      expect.stringContaining('grok mcp add oh-my-agy'),
    ]));
  });

  test('Grok MCP add already-registered is idempotent success with receipt', () => {
    const adapter = recordingAdapter({
      which: { grok: '/bin/grok' },
      run: (_cmd, args) => {
        if (args[0] === 'plugin') {
          return fakeResult({ status: 0, stdout: 'installed' });
        }
        return fakeResult({
          status: 1,
          stderr: "Error: MCP server 'oh-my-agy' already exists\n",
        });
      },
    });
    const result = installSlashHosts(repoRoot, ['grok'], adapter);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.steps[0].status).toBe('ok');
    expect(result.value.steps[0].commandReceipts).toHaveLength(2);
    expect(result.value.steps[0].commandReceipts?.[1]?.exitCode).toBe(1);
  });

  test('Grok CLI missing still prints MCP add as manual command and never spawns', () => {
    const adapter = recordingAdapter({ which: { grok: null } });
    const result = installSlashHosts(repoRoot, ['grok'], adapter);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(adapter.calls).toEqual([]);
    expect(result.value.steps[0].status).toBe('needs_manual');
    expect(result.value.steps[0].commands).toEqual(expect.arrayContaining([
      expect.stringContaining('mcp add oh-my-agy'),
    ]));
    expect(result.value.steps[0].commandReceipts ?? []).toEqual([]);
  });
});

describe('oma doctor mcp_registration', () => {
  let scratch: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-mcp-reg-'));
  });

  afterEach(() => fs.rmSync(scratch, { recursive: true, force: true }));

  async function mcpCheck(root: string) {
    const report = await runDoctor({
      packageRoot: root,
      packageVersion: '0.2.3',
      adapter: doctorAdapter(),
      antigravityConfigRoot: path.join(scratch, 'gemini-config'),
      homeDir: path.join(scratch, 'home'),
      stateRoot: path.join(scratch, 'state'),
      mode: 'development',
      agyCommand: 'echo',
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return undefined;
    return {
      report: report.value,
      check: report.value.checks.find((item) => item.id === 'mcp_registration'),
    };
  }

  test('warns (never fails) when Claude MCP wiring is unregistered', async () => {
    const root = path.join(scratch, 'unregistered');
    writeDoctorSurface(root, '0.2.3', {
      claudePlugin: { name: 'oh-my-agy', version: '0.2.3', skills: ['./skills/autopilot/'] },
      claudeMcp: null,
    });
    const result = await mcpCheck(root);
    expect(result?.check).toEqual(expect.objectContaining({
      id: 'mcp_registration',
      status: 'warn',
    }));
    expect(result?.report.ok).toBe(true);
    expect(result?.report.checks.some((item) => (
      item.id === 'mcp_registration' && item.status === 'fail'
    ))).toBe(false);
  });

  test('warns when .claude-plugin/.mcp.json uses Antigravity ${extensionPath}', async () => {
    const root = path.join(scratch, 'wrong-var');
    writeDoctorSurface(root, '0.2.3', {
      claudeMcp: {
        mcpServers: {
          'oh-my-agy': {
            command: 'node',
            args: ['${extensionPath}/dist/bin/oma.js', 'mcp-server'],
          },
        },
      },
    });
    const result = await mcpCheck(root);
    expect(result?.check?.status).toBe('warn');
    expect(result?.check?.message).toMatch(/extensionPath|CLAUDE_PLUGIN_ROOT/);
  });

  test('passes when mcpServers points at CLAUDE_PLUGIN_ROOT config', async () => {
    const root = path.join(scratch, 'registered');
    writeDoctorSurface(root, '0.2.3');
    const result = await mcpCheck(root);
    expect(result?.check).toEqual(expect.objectContaining({
      id: 'mcp_registration',
      status: 'pass',
    }));
  });

  test('shipped packageRoot registers mcp_registration as pass', async () => {
    const report = await runDoctor({
      packageRoot: repoRoot,
      adapter: doctorAdapter(),
      homeDir: path.join(scratch, 'home'),
      stateRoot: path.join(scratch, 'state'),
      antigravityConfigRoot: path.join(scratch, 'gemini-config'),
      mode: 'development',
      agyCommand: 'echo',
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.checks.find((item) => item.id === 'mcp_registration')).toEqual(
      expect.objectContaining({ status: 'pass' }),
    );
  });
});
