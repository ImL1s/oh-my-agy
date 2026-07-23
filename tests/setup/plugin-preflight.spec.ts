import * as fs from 'fs';
import * as path from 'path';
import {
  PluginCommandAdapter,
  PluginCommandResult,
  verifyPluginActive,
} from '../../src/setup/plugin';
import { createStateFixture } from '../helpers/state-fixture';

class FakePluginAdapter implements PluginCommandAdapter {
  constructor(private readonly result: PluginCommandResult) {}

  async run(): Promise<PluginCommandResult> {
    return this.result;
  }
}

function createPackageSurface(root: string): void {
  fs.mkdirSync(path.join(root, 'dist', 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'src', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'oma-runtime'), { recursive: true });
  fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
    name: '@iml1s/oh-my-agy', version: '1.0.0',
    bin: { oma: 'dist/bin/oma.js', omy: 'dist/bin/oma.js' },
    files: ['dist/bin', 'dist/src', 'plugin.json', 'hooks.json', 'skills', 'rules', 'package.json'],
  }));
  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({ name: 'oh-my-agy', version: '1.0.0' }));
  fs.writeFileSync(path.join(root, 'hooks.json'), JSON.stringify({
    'oh-my-agy-runtime': {
      PreInvocation: [{ type: 'command', command: 'node "${extensionPath}/dist/src/hooks/pre-invocation.js"' }],
      Stop: [{ type: 'command', command: 'node "${extensionPath}/dist/src/hooks/stop.js"' }],
    },
  }));
  fs.writeFileSync(path.join(root, 'dist', 'bin', 'oma.js'), '#!/usr/bin/env node\n');
  fs.writeFileSync(path.join(root, 'dist', 'src', 'hooks', 'pre-invocation.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(root, 'dist', 'src', 'hooks', 'stop.js'), 'module.exports = {};\n');
  fs.writeFileSync(path.join(root, 'skills', 'oma-runtime', 'SKILL.md'), '# Runtime\n');
  fs.writeFileSync(path.join(root, 'rules', 'runtime.md'), '# Runtime\n');
}

describe('managed launch plugin preflight', () => {
  test('returns typed installed/enabled/list/entrypoint readback evidence', async () => {
    const fixture = createStateFixture('oma-plugin-preflight-');
    createPackageSurface(fixture.root);
    try {
      const result = await verifyPluginActive({
        packageRoot: fixture.root,
        antigravityConfigRoot: fixture.path('empty-config'),
        adapter: new FakePluginAdapter({
          argv: ['plugin', 'list'],
          code: 0,
          stdout: `oh-my-agy 1.0.0 enabled ${fixture.root}\n`,
          stderr: '',
        }),
      });
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          schemaVersion: 1,
          pluginName: 'oh-my-agy',
          installed: true,
          enabled: true,
          hookEntrypoints: expect.objectContaining({
            preInvocation: expect.stringContaining('pre-invocation.js'),
            stop: expect.stringContaining('stop.js'),
          }),
        }),
      }));
    } finally {
      fixture.cleanup();
    }
  });

  test('missing registry readback is E_PLUGIN_NOT_ACTIVE', async () => {
    const fixture = createStateFixture('oma-plugin-inactive-');
    createPackageSurface(fixture.root);
    try {
      const result = await verifyPluginActive({
        packageRoot: fixture.root,
        antigravityConfigRoot: fixture.path('empty-config'),
        adapter: new FakePluginAdapter({
          argv: ['plugin', 'list'], code: 0, stdout: 'No imported plugins.\n', stderr: '',
        }),
      });
      expect(result).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'E_PLUGIN_NOT_ACTIVE' }),
      }));
    } finally {
      fixture.cleanup();
    }
  });

  test('sparse real agy JSON is presence only and cannot synthesize installed identity', async () => {
    const fixture = createStateFixture('oma-plugin-json-list-');
    createPackageSurface(fixture.root);
    try {
      const result = await verifyPluginActive({
        packageRoot: fixture.root,
        antigravityConfigRoot: fixture.path('empty-config'),
        adapter: new FakePluginAdapter({
          argv: ['plugin', 'list'],
          code: 0,
          stdout: JSON.stringify({
            imports: [{
              name: 'oh-my-agy',
              source: 'antigravity',
              importedAt: '2026-07-20T11:01:23Z',
              components: ['skills', 'hooks'],
            }],
          }),
          stderr: '',
        }),
      });
      expect(result).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: 'E_PLUGIN_NOT_ACTIVE',
          message: expect.stringMatching(/unresolved/i),
        }),
      }));
    } finally {
      fixture.cleanup();
    }
  });

  test('sparse real agy JSON resolves exact bytes from the standard config root', async () => {
    const fixture = createStateFixture('oma-plugin-json-installed-');
    const source = fixture.path('source');
    const configRoot = fixture.path('gemini-config');
    const installed = path.join(configRoot, 'plugins', 'oh-my-agy');
    fs.mkdirSync(source, { recursive: true });
    fs.mkdirSync(installed, { recursive: true });
    createPackageSurface(source);
    createPackageSurface(installed);
    try {
      const result = await verifyPluginActive({
        packageRoot: source,
        antigravityConfigRoot: configRoot,
        adapter: new FakePluginAdapter({
          argv: ['plugin', 'list'],
          code: 0,
          stdout: JSON.stringify({
            imports: [{ name: 'oh-my-agy', source: 'antigravity', components: ['skills', 'hooks'] }],
          }),
          stderr: '',
        }),
      });
      expect(result).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          pluginName: 'oh-my-agy',
          version: '1.0.0',
          installPath: fs.realpathSync(installed),
          installedDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
          listStdoutSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        }),
      }));
    } finally {
      fixture.cleanup();
    }
  });
});
