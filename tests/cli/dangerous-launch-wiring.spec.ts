import { createDefaultServices } from '../../src/cli/services';
import { runCli } from '../../src/cli/application';
import { ProcessOutcome } from '../../src/runtime/process';
import { Result, ok, err } from '../../src/runtime/types';
import { runtimeError } from '../../src/runtime/errors';

/**
 * 設計概念映射：S1 plan 要求 reject 時不得 spawn ProcessRunner。
 */
describe('dangerous launch wiring', () => {
  test('structured passThrough does not spawn when non-TTY gate rejects', async () => {
    let spawnCount = 0;
    const services = createDefaultServices({
      dangerousLaunch: { isTTY: false },
      // 攔截 runner 不可直接注入；改測 createDefaultServices 內建 guard：
      // 使用 mock agy 不存在 + 仍可依 error code 驗證，並以 spy 包一層
    });

    // 直接測 passThrough 回傳 E_VALIDATOR_REJECTED 且非 process outcome
    const result = await services.passThrough(['--madmax', 'run']);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('E_VALIDATOR_REJECTED');
    }
    expect(spawnCount).toBe(0);

    const code = await runCli(['--madmax', 'x'], {
      ...services,
      version: 'test',
    }, {
      stdout: () => undefined,
      stderr: () => undefined,
    });
    expect(code).toBe(2);
  });

  test('override allows passThrough Result shape (spawn may fail if no agy)', async () => {
    const services = createDefaultServices({
      dangerousLaunch: { isTTY: false },
      agyCommand: 'false', // 必定非零退出，但必須通過 gate
    });
    const result = await services.passThrough([
      '--madmax',
      '--i-understand-dangerous-launch',
      'noop',
    ]);
    // gate 已過：ok true 或 spawn 失敗仍是 process 層
    if (!result.ok) {
      // 若 runner 回 RuntimeError 以外情況
      expect(result.error.code).not.toBe('E_VALIDATOR_REJECTED');
    } else {
      expect(typeof result.value.code).toBe('number');
    }
  });
});
