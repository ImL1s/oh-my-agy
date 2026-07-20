import {
  confirmDangerousLaunch,
  DANGEROUS_LAUNCH_FLAGS,
  DANGEROUS_OVERRIDE_FLAG,
  detectDangerousLaunchFlags,
  guardDangerousArgv,
  stripDangerousOverride,
} from '../../src/cli/dangerous-launch';

describe('detectDangerousLaunchFlags', () => {
  test('detects madmax and yolo as exact tokens', () => {
    expect(detectDangerousLaunchFlags(['--madmax', 'x'])).toEqual(['--madmax']);
    expect(detectDangerousLaunchFlags(['a', '--yolo'])).toEqual(['--yolo']);
    expect(detectDangerousLaunchFlags(['--madmax', '--yolo'])).toEqual(['--madmax', '--yolo']);
  });

  test('ignores substring and prompt text', () => {
    expect(detectDangerousLaunchFlags(['--not-madmax'])).toEqual([]);
    expect(detectDangerousLaunchFlags(['-p', 'please use --madmax carefully'])).toEqual([]);
  });

  test('DANGEROUS_LAUNCH_FLAGS is frozen list', () => {
    expect([...DANGEROUS_LAUNCH_FLAGS].sort()).toEqual(['--madmax', '--yolo']);
  });
});

describe('confirmDangerousLaunch', () => {
  test('non-TTY without override rejects', async () => {
    const result = await confirmDangerousLaunch(['--madmax'], {
      isTTY: false,
      argv: ['--madmax', 'run'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('E_VALIDATOR_REJECTED');
  });

  test('non-TTY with override allows', async () => {
    const result = await confirmDangerousLaunch(['--yolo'], {
      isTTY: false,
      argv: ['--yolo', DANGEROUS_OVERRIDE_FLAG],
    });
    expect(result.ok).toBe(true);
  });

  test('TTY yes confirms', async () => {
    const result = await confirmDangerousLaunch(['--madmax'], {
      isTTY: true,
      argv: ['--madmax'],
      ask: async () => 'yes',
    });
    expect(result.ok).toBe(true);
  });

  test('TTY no rejects', async () => {
    const result = await confirmDangerousLaunch(['--madmax'], {
      isTTY: true,
      argv: ['--madmax'],
      ask: async () => 'no',
    });
    expect(result.ok).toBe(false);
  });

  test('empty flags allow without prompt', async () => {
    const result = await confirmDangerousLaunch([], {
      isTTY: false,
      argv: ['safe'],
    });
    expect(result.ok).toBe(true);
  });
});

describe('guardDangerousArgv', () => {
  test('strips override and keeps madmax after confirm', async () => {
    const result = await guardDangerousArgv(
      ['--madmax', 'run', DANGEROUS_OVERRIDE_FLAG],
      { isTTY: false },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual(['--madmax', 'run']);
    }
  });

  test('rejects non-TTY dangerous without override', async () => {
    const result = await guardDangerousArgv(['--yolo', 'x'], { isTTY: false });
    expect(result.ok).toBe(false);
  });
});

describe('stripDangerousOverride', () => {
  test('removes only override token', () => {
    expect(stripDangerousOverride(['a', DANGEROUS_OVERRIDE_FLAG, '--madmax'])).toEqual([
      'a',
      '--madmax',
    ]);
  });
});
