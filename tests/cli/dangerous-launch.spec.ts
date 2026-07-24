import {
  AGY_OPEN_FLAG,
  confirmDangerousLaunch,
  DANGEROUS_LAUNCH_FLAGS,
  DANGEROUS_OVERRIDE_FLAG,
  detectDangerousLaunchFlags,
  guardDangerousArgv,
  normalizeAgyOpenArgv,
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
  test('top-level --madmax is consent without TTY prompt', async () => {
    const result = await confirmDangerousLaunch(['--madmax'], {
      isTTY: false,
      argv: ['--madmax', 'run'],
    });
    expect(result.ok).toBe(true);
  });

  test('non-TTY --yolo without override rejects', async () => {
    const result = await confirmDangerousLaunch(['--yolo'], {
      isTTY: false,
      argv: ['--yolo', 'run'],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('E_VALIDATOR_REJECTED');
  });

  test('non-TTY with override allows yolo', async () => {
    const result = await confirmDangerousLaunch(['--yolo'], {
      isTTY: false,
      argv: ['--yolo', DANGEROUS_OVERRIDE_FLAG],
    });
    expect(result.ok).toBe(true);
  });

  test('TTY yes confirms yolo', async () => {
    const result = await confirmDangerousLaunch(['--yolo'], {
      isTTY: true,
      argv: ['--yolo'],
      ask: async () => 'yes',
    });
    expect(result.ok).toBe(true);
  });

  test('TTY no rejects yolo', async () => {
    const result = await confirmDangerousLaunch(['--yolo'], {
      isTTY: true,
      argv: ['--yolo'],
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

describe('normalizeAgyOpenArgv', () => {
  test('strips wrapper tokens and injects Antigravity open flag', () => {
    expect(normalizeAgyOpenArgv(['--madmax', 'run'])).toEqual([AGY_OPEN_FLAG, 'run']);
    expect(normalizeAgyOpenArgv(['--yolo', DANGEROUS_OVERRIDE_FLAG, 'x'])).toEqual([AGY_OPEN_FLAG, 'x']);
    expect(normalizeAgyOpenArgv([AGY_OPEN_FLAG, '--madmax'])).toEqual([AGY_OPEN_FLAG]);
  });
});

describe('guardDangerousArgv', () => {
  test('madmax consents without TTY and never forwards wrapper tokens', async () => {
    const result = await guardDangerousArgv(['--madmax', 'run'], { isTTY: false });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([AGY_OPEN_FLAG, 'run']);
    }
  });

  test('rejects non-TTY yolo without override', async () => {
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
