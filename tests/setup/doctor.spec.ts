import * as path from 'path';
import { runDoctor } from '../../src/setup/doctor';
import { PluginCommandAdapter } from '../../src/setup/plugin';

describe('oma doctor', () => {
  const packageRoot = path.resolve(__dirname, '../..');
  // 必須與 package.json / plugin.json 同步，避免 release bump 後硬編碼版本炸 CI
  const packageVersion = require('../../package.json').version as string;

  test('passes hooks/version when plugin registry is active', async () => {
    const adapter: PluginCommandAdapter = {
      async run(argv) {
        if (argv[0] === 'plugin' && argv[1] === 'list') {
          return {
            argv,
            code: 0,
            stdout: JSON.stringify({
              imports: [{ name: 'oh-my-agy', enabled: true, version: packageVersion, source: 'test' }],
            }),
            stderr: '',
          };
        }
        return { argv, code: 0, stdout: '', stderr: '' };
      },
    };
    const report = await runDoctor({
      packageRoot,
      packageVersion,
      adapter,
      strictPlugin: true,
      // CI 可能沒有 agy；echo 可 spawn 即通過 path 檢查
      agyCommand: 'echo',
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.checks.find((c) => c.id === 'hooks')?.status).toBe('pass');
    expect(report.value.checks.find((c) => c.id === 'version_sync')?.status).toBe('pass');
    expect(report.value.checks.find((c) => c.id === 'plugin_registry')?.status).toBe('pass');
    expect(report.value.checks.find((c) => c.id === 'claude_plugin_manifest')?.status).toBe('pass');
    expect(report.value.checks.find((c) => c.id === 'slash_skills')?.status).toBe('pass');
    // OMC 可能已安裝 → pass 或 warn 皆可接受
    const collision = report.value.checks.find((c) => c.id === 'slash_collision');
    expect(collision).toBeDefined();
    expect(['pass', 'warn']).toContain(collision!.status);
  });

  test('fails closed on inactive plugin when strict', async () => {
    const adapter: PluginCommandAdapter = {
      async run(argv) {
        if (argv[0] === 'plugin' && argv[1] === 'list') {
          return {
            argv,
            code: 0,
            stdout: JSON.stringify({ imports: [] }),
            stderr: '',
          };
        }
        return { argv, code: 0, stdout: '', stderr: '' };
      },
    };
    const report = await runDoctor({
      packageRoot,
      packageVersion,
      adapter,
      strictPlugin: true,
      agyCommand: 'echo',
    });
    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.ok).toBe(false);
    expect(report.value.exitCode).toBe(1);
    expect(report.value.checks.find((c) => c.id === 'plugin_registry')?.status).toBe('fail');
  });
});
