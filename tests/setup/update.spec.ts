import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PluginCommandAdapter, PluginCommandResult } from '../../src/setup/plugin';
import {
  DoctorProbeV1,
  ImmutableInstallUpdater,
  classifyDoctorProbe,
  preflightImmutableInstallCandidate,
} from '../../src/setup/update';
import { computePackageIdentity } from '../../src/setup/installed-identity';
import { readInstallReceipt } from '../../src/setup/receipt';

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
  fs.writeFileSync(path.join(root, 'dist', 'bin', 'oma.js'), `#!/usr/bin/env node\n${marker}\n`);
  fs.chmodSync(path.join(root, 'dist', 'bin', 'oma.js'), 0o755);
  fs.writeFileSync(path.join(root, 'dist', 'src', 'hooks', 'pre-invocation.js'), marker);
  fs.writeFileSync(path.join(root, 'dist', 'src', 'hooks', 'stop.js'), marker);
  fs.writeFileSync(path.join(root, 'skills', 'runtime', 'SKILL.md'), marker);
  fs.writeFileSync(path.join(root, 'rules', 'runtime.md'), marker);
}

class InstallingAdapter implements PluginCommandAdapter {
  readonly calls: string[][] = [];

  constructor(private readonly installedRoot: string) {}

  async run(argv: readonly string[]): Promise<PluginCommandResult> {
    this.calls.push([...argv]);
    if (argv.join(' ') === 'plugin list') {
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

function probe(exitCode: number | null, valid = true): DoctorProbeV1 {
  return {
    argv: ['node', 'dist/bin/oma.js', 'doctor', '--json'],
    exitCode,
    stdout: valid ? JSON.stringify({ schemaVersion: 1, exitCode }) : 'not-json',
    stderr: '',
    valid,
  };
}

describe('immutable update and doctor gate', () => {
  let scratch: string;
  let source: string;
  let prior: string;
  let stateRoot: string;
  let configRoot: string;
  let installedRoot: string;
  let binDir: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-update-'));
    source = path.join(scratch, 'source');
    prior = path.join(scratch, 'prior-cli');
    stateRoot = path.join(scratch, 'state');
    configRoot = path.join(scratch, 'gemini-config');
    installedRoot = path.join(configRoot, 'plugins', 'oh-my-agy');
    binDir = path.join(scratch, 'bin');
    surface(source, '1.0.0', 'candidate');
    surface(prior, '0.9.0', 'previous');
    surface(installedRoot, '0.9.0', 'previous');
    fs.mkdirSync(binDir);
    fs.symlinkSync(path.join(prior, 'dist', 'bin', 'oma.js'), path.join(binDir, 'oma'));
    fs.symlinkSync(path.join(prior, 'dist', 'bin', 'oma.js'), path.join(binDir, 'omy'));
  });

  afterEach(() => {
    writable(scratch);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  test('doctor classifier accepts only 0, or 2 in development', () => {
    expect(classifyDoctorProbe('development', probe(0))).toEqual({ ok: true, value: 'installed' });
    expect(classifyDoctorProbe('development', probe(2))).toEqual({
      ok: true, value: 'completed_with_warning',
    });
    for (const candidate of [probe(1), probe(null), probe(0, false), probe(2)]) {
      const mode = candidate.exitCode === 2 ? 'release' : 'development';
      expect(classifyDoctorProbe(mode, candidate).ok).toBe(false);
    }
  });

  test('release preflight binds candidate, asset, and runnable identity without host mutation', () => {
    const identity = computePackageIdentity(source);
    expect(identity.ok).toBe(true);
    if (!identity.ok) return;
    const priorTarget = fs.realpathSync(path.join(binDir, 'oma'));
    const result = preflightImmutableInstallCandidate({
      packageRoot: source,
      mode: 'release',
      expectedPackageDigest: identity.value.digest,
      assetSha256: 'A'.repeat(64),
    });
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({
        mode: 'release',
        packageDigest: identity.value.digest,
        assetSha256: 'a'.repeat(64),
        version: '1.0.0',
        runnableEntrypoints: true,
      }),
    }));
    expect(fs.existsSync(stateRoot)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8')).version)
      .toBe('0.9.0');
    expect(fs.realpathSync(path.join(binDir, 'oma'))).toBe(priorTarget);
  });

  test('preflight rejects digest drift, malformed asset SHA, and missing runnable bytes', () => {
    expect(preflightImmutableInstallCandidate({
      packageRoot: source,
      mode: 'development',
      expectedPackageDigest: '0'.repeat(64),
    }).ok).toBe(false);
    expect(preflightImmutableInstallCandidate({
      packageRoot: source,
      mode: 'development',
      assetSha256: 'not-a-sha',
    }).ok).toBe(false);
    fs.rmSync(path.join(source, 'dist', 'src', 'hooks', 'stop.js'));
    expect(preflightImmutableInstallCandidate({
      packageRoot: source,
      mode: 'development',
    }).ok).toBe(false);
    expect(fs.existsSync(stateRoot)).toBe(false);
  });

  test('preflight rejects a non-executable CLI before any install mutation', () => {
    fs.chmodSync(path.join(source, 'dist', 'bin', 'oma.js'), 0o644);
    const result = preflightImmutableInstallCandidate({
      packageRoot: source,
      mode: 'development',
    });
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'E_VALIDATOR_REJECTED',
        message: 'CLI entrypoint is not executable',
      }),
    }));
    expect(fs.existsSync(stateRoot)).toBe(false);
    expect(fs.existsSync(installedRoot)).toBe(true);
  });

  test('updater rejects a non-executable CLI before adapter or state mutation', async () => {
    fs.chmodSync(path.join(source, 'dist', 'bin', 'oma.js'), 0o644);
    const adapter = new InstallingAdapter(installedRoot);
    const updater = new ImmutableInstallUpdater({
      packageRoot: source,
      stateRoot,
      antigravityConfigRoot: configRoot,
      binDir,
      adapter,
      mode: 'development',
      doctorProbe: async () => probe(0),
    });
    const result = await updater.run();
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'E_VALIDATOR_REJECTED',
        message: 'CLI entrypoint is not executable',
      }),
    }));
    expect(adapter.calls).toEqual([]);
    expect(fs.existsSync(stateRoot)).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8')).version)
      .toBe('0.9.0');
  });

  test('switches CLI to immutable stage, writes a 0400 receipt, and binds exact installed bytes', async () => {
    const updater = new ImmutableInstallUpdater({
      packageRoot: source,
      stateRoot,
      antigravityConfigRoot: configRoot,
      binDir,
      adapter: new InstallingAdapter(installedRoot),
      mode: 'development',
      idFactory: () => 'update-success',
      doctorProbe: async () => probe(0),
      sourceUri: 'https://github.com/ImL1s/oh-my-agy',
      sourceTag: 'v1.0.0',
      peeledCommit: 'a'.repeat(40),
      hostVersion: 'agy-test',
    });
    const result = await updater.run();
    expect(result).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({
        status: 'installed',
        receiptPath: expect.stringContaining('/install/receipts/update-success.json'),
      }),
    }));
    if (!result.ok) return;
    const omaTarget = fs.realpathSync(path.join(binDir, 'oma'));
    expect(omaTarget).toBe(fs.realpathSync(path.join(result.value.stagePath, 'dist', 'bin', 'oma.js')));
    expect(JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8')).version)
      .toBe('1.0.0');
    expect(fs.statSync(result.value.receiptPath).mode & 0o777).toBe(0o400);
    const receipt = readInstallReceipt(result.value.receiptPath);
    expect(receipt).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({
        source: expect.objectContaining({ tag: 'v1.0.0', peeledCommit: 'a'.repeat(40) }),
        installed: expect.objectContaining({ version: '1.0.0' }),
        host: { name: 'antigravity', version: 'agy-test' },
      }),
    }));
  });

  test.each([
    ['hard failure', probe(1), 'development'],
    ['malformed', probe(0, false), 'development'],
    ['release warning', probe(2), 'release'],
  ] as const)('%s rolls plugin and both CLI pointers back', async (_label, doctor, mode) => {
    const updater = new ImmutableInstallUpdater({
      packageRoot: source,
      stateRoot,
      antigravityConfigRoot: configRoot,
      binDir,
      adapter: new InstallingAdapter(installedRoot),
      mode,
      idFactory: () => `update-${_label.replace(/\s/g, '-')}`,
      doctorProbe: async () => doctor,
    });
    const result = await updater.run();
    expect(result.ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8')).version)
      .toBe('0.9.0');
    expect(fs.realpathSync(path.join(binDir, 'oma'))).toBe(fs.realpathSync(path.join(prior, 'dist', 'bin', 'oma.js')));
    expect(fs.realpathSync(path.join(binDir, 'omy'))).toBe(fs.realpathSync(path.join(prior, 'dist', 'bin', 'oma.js')));
  });

  test('idempotent doctor failure preserves the current plugin, CLI pointers, and receipt', async () => {
    const adapter = new InstallingAdapter(installedRoot);
    const first = new ImmutableInstallUpdater({
      packageRoot: source,
      stateRoot,
      antigravityConfigRoot: configRoot,
      binDir,
      adapter,
      mode: 'development',
      idFactory: () => 'update-v1-success',
      doctorProbe: async () => probe(0),
    });
    const installed = await first.run();
    expect(installed.ok).toBe(true);
    if (!installed.ok) return;
    const receiptBefore = fs.readFileSync(installed.value.receiptPath);
    const pluginDigestBefore = computePackageIdentity(installedRoot);
    expect(pluginDigestBefore.ok).toBe(true);
    const omaTargetBefore = fs.realpathSync(path.join(binDir, 'oma'));
    const omyTargetBefore = fs.realpathSync(path.join(binDir, 'omy'));
    adapter.calls.length = 0;

    const second = new ImmutableInstallUpdater({
      packageRoot: source,
      stateRoot,
      antigravityConfigRoot: configRoot,
      binDir,
      adapter,
      mode: 'development',
      idFactory: () => 'update-v1-idempotent-failure',
      doctorProbe: async () => probe(1),
    });
    const failed = await second.run();

    expect(failed.ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8')).version)
      .toBe('1.0.0');
    expect(fs.realpathSync(path.join(binDir, 'oma'))).toBe(omaTargetBefore);
    expect(fs.realpathSync(path.join(binDir, 'omy'))).toBe(omyTargetBefore);
    expect(fs.readFileSync(installed.value.receiptPath)).toEqual(receiptBefore);
    expect(adapter.calls.map((argv) => argv.join(' '))).toEqual(['plugin list']);
    const pluginDigestAfter = computePackageIdentity(installedRoot);
    expect(pluginDigestAfter).toEqual(pluginDigestBefore);
    expect(fs.existsSync(path.join(
      stateRoot, 'install', 'receipts', 'update-v1-idempotent-failure.json',
    ))).toBe(false);
  });

  test('foreign CLI files are preserved and block before host mutation', async () => {
    fs.rmSync(path.join(binDir, 'oma'));
    fs.writeFileSync(path.join(binDir, 'oma'), 'foreign');
    const updater = new ImmutableInstallUpdater({
      packageRoot: source,
      stateRoot,
      antigravityConfigRoot: configRoot,
      binDir,
      adapter: new InstallingAdapter(installedRoot),
      mode: 'development',
      doctorProbe: async () => probe(0),
    });
    const result = await updater.run();
    expect(result.ok).toBe(false);
    expect(fs.readFileSync(path.join(binDir, 'oma'), 'utf8')).toBe('foreign');
    expect(JSON.parse(fs.readFileSync(path.join(installedRoot, 'package.json'), 'utf8')).version)
      .toBe('0.9.0');
  });
});
