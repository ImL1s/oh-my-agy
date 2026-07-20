import * as fs from 'fs';
import * as path from 'path';
import { PluginCommandAdapter, PluginCommandResult } from '../../src/setup/plugin';
import { PluginSetupTransaction } from '../../src/setup/transaction';
import { createStateFixture } from '../helpers/state-fixture';

class RecordingAdapter implements PluginCommandAdapter {
  readonly calls: string[][] = [];
  failCommand?: string;

  async run(argv: readonly string[]): Promise<PluginCommandResult> {
    this.calls.push([...argv]);
    const command = argv.join(' ');
    if (this.failCommand !== undefined && command.startsWith(this.failCommand)) {
      return { argv: [...argv], code: 9, stdout: '', stderr: 'fixture failure' };
    }
    if (command === 'plugin list') {
      return {
        argv: [...argv], code: 0, stdout: 'oh-my-agy 1.0.0 enabled /fixture/oh-my-agy\n', stderr: '',
      };
    }
    return { argv: [...argv], code: 0, stdout: 'ok\n', stderr: '' };
  }
}

function createPackageSurface(root: string): void {
  fs.mkdirSync(path.join(root, 'dist', 'src', 'hooks'), { recursive: true });
  fs.mkdirSync(path.join(root, 'skills', 'runtime'), { recursive: true });
  fs.mkdirSync(path.join(root, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'oh-my-agy', version: '1.0.0' }));
  fs.writeFileSync(path.join(root, 'plugin.json'), JSON.stringify({ name: 'oh-my-agy' }));
  fs.writeFileSync(path.join(root, 'hooks.json'), '{}');
  fs.writeFileSync(path.join(root, 'dist', 'src', 'hooks', 'pre-invocation.js'), '');
  fs.writeFileSync(path.join(root, 'dist', 'src', 'hooks', 'stop.js'), '');
  fs.writeFileSync(path.join(root, 'skills', 'runtime', 'SKILL.md'), '# runtime\n');
  fs.writeFileSync(path.join(root, 'rules', 'runtime.md'), '# runtime\n');
}

describe('transactional plugin setup', () => {
  test('runs snapshot -> validate -> install -> enable -> readback and is digest-idempotent', async () => {
    const fixture = createStateFixture('oma-setup-');
    const packageRoot = fixture.path('package');
    const stateRoot = fixture.path('state');
    fs.mkdirSync(packageRoot);
    createPackageSurface(packageRoot);
    const adapter = new RecordingAdapter();
    const transaction = new PluginSetupTransaction({
      packageRoot,
      stateRoot,
      adapter,
      idFactory: () => 'transaction-1',
    });
    try {
      const first = await transaction.run();
      expect(first).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ status: 'success', idempotent: false }),
      }));
      expect(adapter.calls.map((argv) => argv.join(' '))).toEqual([
        'plugin list',
        `plugin validate ${packageRoot}`,
        `plugin install ${packageRoot}`,
        'plugin enable oh-my-agy',
        'plugin list',
      ]);

      adapter.calls.length = 0;
      const second = await transaction.run();
      expect(second).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({ status: 'success', idempotent: true }),
      }));
      expect(adapter.calls.map((argv) => argv.join(' '))).toEqual(['plugin list']);
    } finally {
      fixture.cleanup();
    }
  });

  test('partial failure records recovery evidence and never uninstalls an existing plugin', async () => {
    const fixture = createStateFixture('oma-setup-failure-');
    const packageRoot = fixture.path('package');
    const stateRoot = fixture.path('state');
    fs.mkdirSync(packageRoot);
    createPackageSurface(packageRoot);
    const adapter = new RecordingAdapter();
    adapter.failCommand = 'plugin enable';
    const transaction = new PluginSetupTransaction({
      packageRoot,
      stateRoot,
      adapter,
      idFactory: () => 'transaction-failed',
    });
    try {
      const result = await transaction.run();
      expect(result).toEqual(expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: 'E_PLUGIN_NOT_ACTIVE' }),
      }));
      expect(adapter.calls.some((argv) => argv.includes('uninstall'))).toBe(false);
      const record = JSON.parse(fs.readFileSync(
        path.join(stateRoot, 'setup-transactions', 'transaction-failed.json'),
        'utf8',
      ));
      expect(record).toEqual(expect.objectContaining({
        status: 'failed',
        recovery: expect.stringContaining('preserved'),
      }));
    } finally {
      fixture.cleanup();
    }
  });
});

