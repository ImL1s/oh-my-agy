import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PluginCommandAdapter, PluginCommandResult } from '../../src/setup/plugin';
import { PluginSetupTransaction } from '../../src/setup/transaction';

function writable(root: string): void {
  if (!fs.existsSync(root)) return;
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) writable(path.join(root, entry.name));
    else fs.chmodSync(path.join(root, entry.name), 0o600);
  }
}

function surface(root: string, version: string, marker = version): void {
  fs.mkdirSync(path.join(root, 'dist', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'src', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: '@iml1s/oh-my-agy', version,
    bin: { oma: 'dist/bin/oma.js', omy: 'dist/bin/oma.js' },
    files: ['dist/bin', 'dist/src', 'plugin.json', 'hooks.json', 'skills', 'rules', 'package.json'],
  }));
  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({ name: 'oh-my-agy', version }));
  fs.writeFileSync(path.join(root, 'hooks.json'), JSON.stringify({
    'oh-my-agy-runtime': {
      PreInvocation: [{ command: 'node "${extensionPath}/dist/src/hooks/pre-invocation.js"' }],
      Stop: [{ command: 'node "${extensionPath}/dist/src/hooks/stop.js"' }],
    },
  }));
  fs.writeFileSync(path.join(root, 'dist', 'bin', 'oma.js'), marker);
  fs.writeFileSync(path.join(root, 'dist', 'src', 'hooks', 'pre-invocation.js'), marker);
  fs.writeFileSync(path.join(root, 'dist', 'src', 'hooks', 'stop.js'), marker);
  fs.writeFileSync(path.join(root, 'skills', 'runtime', 'SKILL.md'), marker);
  fs.writeFileSync(path.join(root, 'rules', 'runtime.md'), marker);
}

class InstallingAdapter implements PluginCommandAdapter {
  readonly calls: string[][] = [];
  failCommand?: string;
  uncertainInstall = false;

  constructor(private readonly installedRoot: string) {}

  async run(argv: readonly string[]): Promise<PluginCommandResult> {
    this.calls.push([...argv]);
    const command = argv.join(' ');
    if (command === 'plugin list') {
      return {
        argv: [...argv], code: 0,
        stdout: fs.existsSync(path.join(this.installedRoot, 'plugin.json'))
          ? JSON.stringify({ imports: [{ name: 'oh-my-agy', source: 'antigravity', components: ['hooks', 'skills'] }] })
          : JSON.stringify({ imports: [] }),
        stderr: '',
      };
    }
    if (argv[0] === 'plugin' && argv[1] === 'install' && argv[2]) {
      if (fs.existsSync(this.installedRoot)) {
        writable(this.installedRoot);
        fs.rmSync(this.installedRoot, { recursive: true, force: true });
      }
      fs.cpSync(argv[2], this.installedRoot, { recursive: true, dereference: true });
      if (this.uncertainInstall) {
        return { argv: [...argv], code: 9, stdout: '', stderr: 'timeout: result unknown' };
      }
    }
    if (command.startsWith('plugin uninstall')) {
      if (fs.existsSync(this.installedRoot)) {
        writable(this.installedRoot);
        fs.rmSync(this.installedRoot, { recursive: true, force: true });
      }
    }
    if (this.failCommand !== undefined && command.startsWith(this.failCommand)) {
      this.failCommand = undefined;
      return { argv: [...argv], code: 9, stdout: '', stderr: 'fixture failure' };
    }
    return { argv: [...argv], code: 0, stdout: 'ok\n', stderr: '' };
  }
}

describe('transactional immutable plugin setup', () => {
  let scratch: string;
  let source: string;
  let stateRoot: string;
  let configRoot: string;
  let installedRoot: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-setup-'));
    source = path.join(scratch, 'source');
    stateRoot = path.join(scratch, 'state');
    configRoot = path.join(scratch, 'gemini-config');
    installedRoot = path.join(configRoot, 'plugins', 'oh-my-agy');
    surface(source, '1.0.0');
  });

  afterEach(() => {
    writable(scratch);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  test('stages immutable bytes, installs, exact-readbacks, and is digest-idempotent', async () => {
    const adapter = new InstallingAdapter(installedRoot);
    const transaction = new PluginSetupTransaction({
      packageRoot: source,
      stateRoot,
      antigravityConfigRoot: configRoot,
      adapter,
      idFactory: () => 'transaction-1',
    });
    const first = await transaction.run();
    expect(first).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({
        status: 'success', idempotent: false,
        stagePath: expect.stringContaining('/install/stages/'),
        installedIdentity: expect.objectContaining({ version: '1.0.0' }),
      }),
    }));
    expect(adapter.calls.map((argv) => argv.slice(0, 2).join(' '))).toEqual([
      'plugin list', 'plugin validate', 'plugin install', 'plugin enable', 'plugin list',
    ]);

    adapter.calls.length = 0;
    const second = await transaction.run();
    expect(second).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({ status: 'success', idempotent: true }),
    }));
    expect(adapter.calls.map((argv) => argv.join(' '))).toEqual(['plugin list']);
  });

  test('failure after host switch rolls back the exact previous installed version', async () => {
    surface(installedRoot, '0.9.0', 'previous');
    const adapter = new InstallingAdapter(installedRoot);
    adapter.failCommand = 'plugin enable';
    const transaction = new PluginSetupTransaction({
      packageRoot: source,
      stateRoot,
      antigravityConfigRoot: configRoot,
      adapter,
      idFactory: () => 'transaction-failed',
    });
    const result = await transaction.run();
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'E_PLUGIN_NOT_ACTIVE' }),
    }));
    expect(JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8')).version)
      .toBe('0.9.0');
    const record = JSON.parse(fs.readFileSync(
      path.join(stateRoot, 'setup-transactions', 'transaction-failed.json'), 'utf8',
    ));
    expect(record).toEqual(expect.objectContaining({
      status: 'rolled_back',
      recovery: expect.stringContaining('restored previous'),
    }));
  });

  test('an uncertain install result is adopted only after exact installed readback', async () => {
    const adapter = new InstallingAdapter(installedRoot);
    adapter.uncertainInstall = true;
    const transaction = new PluginSetupTransaction({
      packageRoot: source,
      stateRoot,
      antigravityConfigRoot: configRoot,
      adapter,
      idFactory: () => 'transaction-uncertain',
    });
    const result = await transaction.run();
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({ status: 'success' }),
    }));
    const record = JSON.parse(fs.readFileSync(
      path.join(stateRoot, 'setup-transactions', 'transaction-uncertain.json'), 'utf8',
    ));
    expect(record.steps).toContain('plugin install reconciled by exact readback');
  });

  test('injected fault immediately after switch also restores the previous install', async () => {
    surface(installedRoot, '0.9.0', 'previous');
    const adapter = new InstallingAdapter(installedRoot);
    const transaction = new PluginSetupTransaction({
      packageRoot: source,
      stateRoot,
      antigravityConfigRoot: configRoot,
      adapter,
      idFactory: () => 'transaction-fault',
      faultInjector(point) {
        if (point === 'after_plugin_switch') throw new Error('injected after switch');
      },
    });
    const result = await transaction.run();
    expect(result.ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8')).version)
      .toBe('0.9.0');
  });
});
