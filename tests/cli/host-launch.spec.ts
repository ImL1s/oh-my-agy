import { AGY_OPEN_FLAG } from '../../src/cli/dangerous-launch';
import {
  HostLaunchUsageError,
  normalizeAgyHostArgv,
  resolveLaunchPolicy,
  runHostLaunch,
  shouldHostLaunch,
  splitAtEndOfOptions,
} from '../../src/cli/host-launch';

describe('OMA host-launch contract', () => {
  test('GRAM-04 keeps suffix opaque', () => {
    expect(splitAtEndOfOptions(['--madmax', '--', '--sandbox'])).toEqual({
      head: ['--madmax'],
      suffix: ['--', '--sandbox'],
    });
    expect(normalizeAgyHostArgv(['--madmax', '--', '--sandbox'], { madmax: true })).toEqual([
      AGY_OPEN_FLAG,
      '--',
      '--sandbox',
    ]);
  });

  test('policy last-flag wins over env', () => {
    expect(resolveLaunchPolicy(['--tmux', '--direct'], { OMA_LAUNCH_POLICY: 'tmux' }).policy).toBe('direct');
    expect(resolveLaunchPolicy([], { OMA_LAUNCH_POLICY: 'detached-tmux' }).policy).toBe('tmux');
  });

  test('shouldHostLaunch skips structured commands and legacy magic', () => {
    expect(shouldHostLaunch([])).toBe(true);
    expect(shouldHostLaunch(['--madmax'])).toBe(true);
    expect(shouldHostLaunch(['--yolo'])).toBe(true);
    expect(shouldHostLaunch(['--direct'])).toBe(true);
    expect(shouldHostLaunch(['--tmux'])).toBe(true);
    expect(shouldHostLaunch(['doctor'])).toBe(false);
    expect(shouldHostLaunch(['cancel'])).toBe(false);
    expect(() => shouldHostLaunch(['cancel', '--direct'])).toThrow(/E_LAUNCH_USAGE/);
    expect(shouldHostLaunch(['hooks'])).toBe(false);
    expect(shouldHostLaunch(['hooks', 'status'])).toBe(false);
    expect(shouldHostLaunch(['explain'])).toBe(false);
    expect(shouldHostLaunch(['ask'])).toBe(false);
    expect(() => shouldHostLaunch(['ask', '--direct'])).toThrow(/E_LAUNCH_USAGE/);
    expect(shouldHostLaunch(['native', 'capabilities'])).toBe(false);
    expect(shouldHostLaunch(['native', 'probe', '--live'])).toBe(false);
    expect(shouldHostLaunch(['native'])).toBe(false);
    expect(shouldHostLaunch(['native', 'future'])).toBe(false);
    expect(shouldHostLaunch(['help'])).toBe(false);
    expect(shouldHostLaunch(['ralph'])).toBe(false);
    expect(shouldHostLaunch(['ralph', '--', 'ship'])).toBe(false);
    expect(shouldHostLaunch(['please', 'ultrawork', 'this'])).toBe(false);
    // Ordinary argv stays on enforcer passthrough (e2e / Sisyphus).
    expect(shouldHostLaunch(['fix', 'the', 'bug'])).toBe(false);
    expect(shouldHostLaunch(['run'])).toBe(false);
    // GRAM-04: suffix magic must not change routing; still not host-launch.
    expect(shouldHostLaunch(['fix', 'bug', '--', 'ultrawork'])).toBe(false);
    expect(() => shouldHostLaunch(['ralph', '--madmax'])).toThrow(HostLaunchUsageError);
    expect(() => shouldHostLaunch(['doctor', '--direct'])).toThrow(/E_LAUNCH_USAGE/);
    expect(() => shouldHostLaunch(['native', 'capabilities', '--direct'])).toThrow(/E_LAUNCH_USAGE/);
    expect(() => shouldHostLaunch(['native', 'future', '--direct'])).not.toThrow();
  });

  test('madmax injects open flag and rejects plan/sandbox in head', () => {
    expect(normalizeAgyHostArgv(['--madmax', 'hi'], { madmax: true })).toEqual([AGY_OPEN_FLAG, 'hi']);
    expect(() => normalizeAgyHostArgv(['--madmax', '--mode', 'plan'], { madmax: true }))
      .toThrow(/refusing --mode plan/);
    expect(() => normalizeAgyHostArgv(['--madmax', '--sandbox'], { madmax: true }))
      .toThrow(/refusing --sandbox/);
  });

  test('Windows rejects cmd/bat shim paths early', async () => {
    const prev = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const notes: string[] = [];
    try {
      // Absolute path so resolution does not take the "not on PATH" branch first.
      const code = await runHostLaunch(['--direct'], {
        agyCommand: '/tmp/agy.cmd',
        env: { ...process.env, PATH: '' },
        stderr: (text) => { notes.push(text); },
      });
      expect(code).toBe(127);
      expect(notes.join('')).toMatch(/\.cmd\/\.bat shims are not argv-safe/);
    } finally {
      Object.defineProperty(process, 'platform', { value: prev });
    }
  });
});
