import { createDefaultServices } from '../../src/cli/services';
import { AGY_OPEN_FLAG } from '../../src/cli/dangerous-launch';
import type { ProcessRunner } from '../../src/runtime/process';
import { ok } from '../../src/runtime/types';

function fakeRunner(onSpawn: (command: string, argv: readonly string[]) => void): ProcessRunner {
  return {
    foregroundInteractive: async (command: string, argv: readonly string[]) => {
      onSpawn(command, argv);
      return ok({
        code: 0,
        signal: null,
        timedOut: false,
        stdout: '',
        stderr: '',
        processIdentity: {
          pid: 1,
          startMarker: 'test',
          executablePath: command,
          executableDigest: '0'.repeat(64),
        },
      });
    },
    readIdentity: async () => ok({
      pid: 1,
      startMarker: 'test',
      executablePath: 'agy',
      executableDigest: '0'.repeat(64),
    }),
    proveIdentity: async () => ok(undefined),
    boundedHeadless: async () => ok({
      code: 0,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      processIdentity: {
        pid: 1,
        startMarker: 'test',
        executablePath: 'agy',
        executableDigest: '0'.repeat(64),
      },
    }),
  } as unknown as ProcessRunner;
}

describe('dangerous launch wiring', () => {
  test('top-level madmax consents without TTY and forwards only the agy open flag', async () => {
    const seen: { command: string; argv: string[] }[] = [];
    const services = createDefaultServices({
      dangerousLaunch: { isTTY: false },
      processRunner: fakeRunner((command, argv) => {
        seen.push({ command, argv: [...argv] });
      }),
      agyCommand: 'agy-fake',
    });
    const result = await services.passThrough(['--madmax', 'run']);
    expect(result.ok).toBe(true);
    expect(seen).toEqual([{ command: 'agy-fake', argv: [AGY_OPEN_FLAG, 'run'] }]);
  });

  test('yolo without TTY/override still fails closed before spawn', async () => {
    let spawnCount = 0;
    const services = createDefaultServices({
      dangerousLaunch: { isTTY: false },
      processRunner: fakeRunner(() => { spawnCount += 1; }),
    });
    const result = await services.passThrough(['--yolo', 'x']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('E_VALIDATOR_REJECTED');
    expect(spawnCount).toBe(0);
  });
});
