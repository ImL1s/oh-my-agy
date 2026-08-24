import * as fs from 'fs';
import * as path from 'path';
import { resolveLegacyStdio } from '../../src/cli/legacy-stdio';

const packageRoot = path.resolve(__dirname, '../..');

describe('resolveLegacyStdio', () => {
  test('unset on TTY inherits (interactive host)', () => {
    expect(resolveLegacyStdio({}, true)).toBe('inherit');
  });

  test('unset on non-TTY ignores (e2e / CI silence)', () => {
    expect(resolveLegacyStdio({}, false)).toBe('ignore');
  });

  test('explicit inherit overrides non-TTY', () => {
    expect(resolveLegacyStdio({ OMA_LEGACY_STDIO: 'inherit' }, false)).toBe('inherit');
  });

  test('explicit ignore overrides TTY', () => {
    expect(resolveLegacyStdio({ OMA_LEGACY_STDIO: 'ignore' }, true)).toBe('ignore');
  });

  test('unknown value falls back to TTY without crashing', () => {
    expect(resolveLegacyStdio({ OMA_LEGACY_STDIO: 'verbose' }, true)).toBe('inherit');
    expect(resolveLegacyStdio({ OMA_LEGACY_STDIO: 'verbose' }, false)).toBe('ignore');
  });

  // 接線守門：純函式綠不能代表 bin/oma.ts 仍呼叫它。若改回三元運算式，這條必須紅。
  test('bin/oma.ts wires resolveLegacyStdio before spawning the magic child', () => {
    const source = fs.readFileSync(path.join(packageRoot, 'bin', 'oma.ts'), 'utf8');
    expect(source).toMatch(/import \{ resolveLegacyStdio \} from '\.\.\/src\/cli\/legacy-stdio'/);
    expect(source).toMatch(/resolveLegacyStdio\(process\.env,\s*Boolean\(process\.stdout\.isTTY\)\)/);
    expect(source).not.toMatch(/OMA_LEGACY_STDIO === 'inherit' \? 'inherit' : 'ignore'/);
    const spawnIndex = source.indexOf("spawn('agy', magicArgv");
    const resolveIndex = source.indexOf('resolveLegacyStdio(process.env');
    const guardIndex = source.indexOf('guardDangerousArgv');
    expect(resolveIndex).toBeGreaterThan(0);
    expect(guardIndex).toBeGreaterThan(resolveIndex);
    expect(spawnIndex).toBeGreaterThan(guardIndex);
  });
});
