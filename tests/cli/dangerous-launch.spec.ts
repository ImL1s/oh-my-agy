import { detectDangerousLaunchFlags, DANGEROUS_LAUNCH_FLAGS } from '../../src/cli/dangerous-launch';

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
