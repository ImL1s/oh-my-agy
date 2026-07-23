import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  comparePackageIdentity,
  computePackageIdentity,
  resolveInstalledPluginIdentity,
  stageImmutablePackage,
} from '../../src/setup/installed-identity';

function surface(root: string, version: string, marker = 'same'): void {
  fs.mkdirSync(path.join(root, 'dist', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'src', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'autopilot'), { recursive: true });
  fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: '@iml1s/oh-my-agy',
    version,
    bin: { oma: 'dist/bin/oma.js', omy: 'dist/bin/oma.js' },
    files: ['dist/bin', 'dist/src', 'plugin.json', 'hooks.json', 'skills', 'rules', 'package.json'],
  }));
  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({
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
  fs.writeFileSync(path.join(root, 'skills', 'autopilot', 'SKILL.md'), marker);
  fs.writeFileSync(path.join(root, 'rules', 'runtime.md'), marker);
}

describe('installed Antigravity identity', () => {
  let scratch: string;
  let source: string;
  let configRoot: string;
  let installed: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-identity-'));
    source = path.join(scratch, 'source');
    configRoot = path.join(scratch, 'gemini-config');
    installed = path.join(configRoot, 'plugins', 'oh-my-agy');
    surface(source, '0.2.3');
    surface(installed, '0.2.3');
  });

  afterEach(() => {
    const writable = (root: string): void => {
      if (!fs.existsSync(root)) return;
      fs.chmodSync(root, 0o700);
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory()) writable(path.join(root, entry.name));
      }
    };
    writable(scratch);
    fs.rmSync(scratch, { recursive: true, force: true });
  });

  test('resolves a sparse registry entry through the exact standard installed path', () => {
    const result = resolveInstalledPluginIdentity({
      pluginName: 'oh-my-agy',
      antigravityConfigRoot: configRoot,
      registry: { present: true, enabled: true, source: 'antigravity', components: ['skills', 'hooks'] },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.installPath).toBe(fs.realpathSync(installed));
    expect(result.value.version).toBe('0.2.3');
    expect(result.value.registry.components).toEqual(['hooks', 'skills']);
    expect(result.value.entrypoints).toEqual(expect.objectContaining({
      cli: 'dist/bin/oma.js',
      preInvocation: 'dist/src/hooks/pre-invocation.js',
      stop: 'dist/src/hooks/stop.js',
    }));
  });

  test('inventory is byte-sorted, ignores foreign files, and detects stale bytes/version', () => {
    fs.writeFileSync(path.join(installed, 'FOREIGN.txt'), 'not shipping');
    const sourceIdentity = computePackageIdentity(source);
    const installedIdentity = computePackageIdentity(installed);
    expect(sourceIdentity.ok && installedIdentity.ok).toBe(true);
    if (!sourceIdentity.ok || !installedIdentity.ok) return;
    expect(installedIdentity.value.inventory.some((entry) => entry.path === 'FOREIGN.txt')).toBe(false);
    expect(installedIdentity.value.digest).toBe(sourceIdentity.value.digest);
    expect(comparePackageIdentity(sourceIdentity.value, installedIdentity.value).ok).toBe(true);

    surface(installed, '0.2.2', 'stale');
    const stale = computePackageIdentity(installed);
    expect(stale.ok).toBe(true);
    if (!stale.ok) return;
    const compared = comparePackageIdentity(sourceIdentity.value, stale.value);
    expect(compared).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'E_PLUGIN_NOT_ACTIVE',
        details: expect.objectContaining({ expectedVersion: '0.2.3', actualVersion: '0.2.2' }),
      }),
    }));
  });

  test('explicit registry path plus a different standard path is ambiguous', () => {
    const other = path.join(scratch, 'other-install');
    surface(other, '0.2.3');
    const result = resolveInstalledPluginIdentity({
      pluginName: 'oh-my-agy',
      antigravityConfigRoot: configRoot,
      registry: {
        present: true,
        enabled: true,
        installPath: other,
        source: 'file',
        components: ['hooks'],
      },
    });
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'E_PLUGIN_NOT_ACTIVE',
        message: expect.stringMatching(/ambiguous/i),
      }),
    }));
  });

  test('stages only shipping bytes into an immutable content-addressed directory', () => {
    fs.writeFileSync(path.join(source, 'LOCAL.txt'), 'dirty local file');
    const staged = stageImmutablePackage({
      packageRoot: source,
      stagesRoot: path.join(scratch, 'stages'),
    });
    expect(staged.ok).toBe(true);
    if (!staged.ok) return;
    expect(path.basename(staged.value.stagePath)).toBe(staged.value.identity.digest);
    expect(fs.existsSync(path.join(staged.value.stagePath, 'LOCAL.txt'))).toBe(false);
    expect(fs.statSync(path.join(staged.value.stagePath, 'package.json')).mode & 0o777).toBe(0o400);
    expect(fs.statSync(path.join(staged.value.stagePath, 'dist', 'bin', 'oma.js')).mode & 0o777)
      .toBe(0o500);
    const second = stageImmutablePackage({
      packageRoot: source,
      stagesRoot: path.join(scratch, 'stages'),
    });
    expect(second.ok && second.value.stagePath).toBe(staged.value.stagePath);
  });
});
