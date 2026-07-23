import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { computePackageIdentity, resolveInstalledPluginIdentity } from '../../src/setup/installed-identity';
import { PluginCommandAdapter, PluginCommandResult } from '../../src/setup/plugin';
import { createInstallReceipt, writeInstallReceipt } from '../../src/setup/receipt';
import { uninstallOwnedInstallation } from '../../src/setup/uninstall';

function writable(root: string): void {
  if (!fs.existsSync(root)) return;
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const absolute = path.join(root, entry.name);
    if (entry.isDirectory()) writable(absolute);
    else fs.chmodSync(absolute, 0o600);
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

class RemovingAdapter implements PluginCommandAdapter {
  readonly calls: string[][] = [];

  constructor(private readonly installedRoot: string) {}

  async run(argv: readonly string[]): Promise<PluginCommandResult> {
    this.calls.push([...argv]);
    if (argv.join(' ') === 'plugin list') {
      return {
        argv: [...argv], code: 0,
        stdout: fs.existsSync(path.join(this.installedRoot, 'plugin.json'))
          ? JSON.stringify({ imports: [{ name: 'oh-my-agy', source: 'antigravity' }] })
          : JSON.stringify({ imports: [] }),
        stderr: '',
      };
    }
    if (argv[0] === 'plugin' && argv[1] === 'uninstall') {
      if (fs.existsSync(this.installedRoot)) {
        writable(this.installedRoot);
        fs.rmSync(this.installedRoot, { recursive: true, force: true });
      }
    }
    return { argv: [...argv], code: 0, stdout: 'ok\n', stderr: '' };
  }
}

describe('ownership-aware uninstall', () => {
  let scratch: string;
  let source: string;
  let installed: string;
  let stage: string;
  let binDir: string;
  let receiptPath: string;
  let projectState: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-uninstall-'));
    source = path.join(scratch, 'source');
    installed = path.join(scratch, 'gemini-config', 'plugins', 'oh-my-agy');
    stage = path.join(scratch, 'state', 'install', 'stages', 'owned-stage');
    binDir = path.join(scratch, 'bin');
    receiptPath = path.join(scratch, 'state', 'install', 'receipts', 'install.json');
    projectState = path.join(scratch, 'repo', '.agy');
    surface(source, '1.0.0');
    surface(installed, '1.0.0');
    fs.cpSync(source, stage, { recursive: true });
    fs.mkdirSync(binDir);
    fs.symlinkSync(path.join(stage, 'dist', 'bin', 'oma.js'), path.join(binDir, 'oma'));
    fs.symlinkSync(path.join(stage, 'dist', 'bin', 'oma.js'), path.join(binDir, 'omy'));
    fs.mkdirSync(projectState, { recursive: true });
    fs.writeFileSync(path.join(projectState, 'keep.json'), '{}');
    fs.writeFileSync(path.join(scratch, 'gemini-config', 'foreign.json'), 'keep');

    const sourceIdentity = computePackageIdentity(source);
    const installedIdentity = resolveInstalledPluginIdentity({
      pluginName: 'oh-my-agy',
      antigravityConfigRoot: path.join(scratch, 'gemini-config'),
      registry: { present: true, enabled: true, source: 'antigravity', components: ['hooks'] },
    });
    if (!sourceIdentity.ok || !installedIdentity.ok) throw new Error('fixture identity failed');
    const receipt = createInstallReceipt({
      transactionId: 'install',
      status: 'installed',
      source: sourceIdentity.value,
      installed: installedIdentity.value,
      ownedInventory: [
        { path: stage, kind: 'stage', identity: sourceIdentity.value.digest },
        { path: installed, kind: 'host_plugin', identity: installedIdentity.value.digest },
        { path: path.join(binDir, 'oma'), kind: 'cli_symlink', identity: path.join(stage, 'dist', 'bin', 'oma.js') },
        { path: path.join(binDir, 'omy'), kind: 'cli_symlink', identity: path.join(stage, 'dist', 'bin', 'oma.js') },
        { path: receiptPath, kind: 'receipt', identity: 'install' },
      ],
      commands: [{
        argv: ['agy', 'plugin', 'install'], exitCode: 0,
        stdoutSha256: 'a'.repeat(64), stderrSha256: 'b'.repeat(64),
      }],
      sourceUri: null,
      sourceTag: null,
      peeledCommit: null,
    });
    const written = writeInstallReceipt(receiptPath, receipt);
    if (!written.ok) throw new Error(written.error.message);
  });

  afterEach(() => {
    writable(scratch);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  test('removes only exact owned plugin/stage/links and preserves foreign config plus .agy', async () => {
    const adapter = new RemovingAdapter(installed);
    const result = await uninstallOwnedInstallation({
      receiptPath,
      adapter,
      projectStatePath: projectState,
    });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({ status: 'uninstalled', collisions: [] }),
    }));
    expect(fs.existsSync(installed)).toBe(false);
    expect(fs.existsSync(stage)).toBe(false);
    expect(fs.existsSync(path.join(binDir, 'oma'))).toBe(false);
    expect(fs.existsSync(path.join(binDir, 'omy'))).toBe(false);
    expect(fs.readFileSync(path.join(scratch, 'gemini-config', 'foreign.json'), 'utf8')).toBe('keep');
    expect(fs.existsSync(path.join(projectState, 'keep.json'))).toBe(true);
    expect(fs.existsSync(receiptPath)).toBe(true);

    const second = await uninstallOwnedInstallation({ receiptPath, adapter, projectStatePath: projectState });
    expect(second).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({ status: 'already_absent' }),
    }));
  });

  test('modified owned paths are preserved as collisions rather than deleted', async () => {
    fs.rmSync(path.join(binDir, 'oma'));
    fs.symlinkSync(path.join(source, 'dist', 'bin', 'oma.js'), path.join(binDir, 'oma'));
    fs.writeFileSync(path.join(installed, 'dist', 'src', 'hooks', 'stop.js'), 'foreign change');
    const result = await uninstallOwnedInstallation({
      receiptPath,
      adapter: new RemovingAdapter(installed),
      projectStatePath: projectState,
    });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({ status: 'completed_with_collisions' }),
    }));
    if (!result.ok) return;
    expect(result.value.collisions).toEqual(expect.arrayContaining([installed, path.join(binDir, 'oma')]));
    expect(fs.existsSync(installed)).toBe(true);
    expect(fs.existsSync(path.join(binDir, 'oma'))).toBe(true);
  });

  test('explicit purge removes only the named .agy state path', async () => {
    const result = await uninstallOwnedInstallation({
      receiptPath,
      adapter: new RemovingAdapter(installed),
      projectStatePath: projectState,
      purge: true,
    });
    expect(result.ok).toBe(true);
    expect(fs.existsSync(projectState)).toBe(false);
    expect(fs.readFileSync(path.join(scratch, 'gemini-config', 'foreign.json'), 'utf8')).toBe('keep');
  });
});
