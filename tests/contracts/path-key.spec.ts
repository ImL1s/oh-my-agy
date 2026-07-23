import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  safePathKey,
  assertSafePathKey,
  resolveConfinedPath,
  validateExternalIdentifier,
} from '../../src/contracts/path-key';

describe('OMA W0 SHA-256 path-key and confinement contract', () => {
  test('raw external IDs become deterministic lowercase SHA-256 path components', () => {
    const raw = '../../conversation/含 空格';
    const key = safePathKey(raw);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toContain(raw);
    expect(safePathKey(raw)).toBe(key);
    expect(() => assertSafePathKey(key)).not.toThrow();
    expect(() => assertSafePathKey('ABC')).toThrow();
  });

  test('NUL, control, unpaired surrogate, empty, traversal and absolute paths reject', () => {
    expect(() => validateExternalIdentifier('')).toThrow();
    expect(() => validateExternalIdentifier('bad\0id')).toThrow();
    expect(() => validateExternalIdentifier('bad\nid')).toThrow();
    expect(() => validateExternalIdentifier('\ud800')).toThrow();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-path-key-'));
    try {
      expect(() => resolveConfinedPath(root, '../escape')).toThrow('escapes');
      expect(() => resolveConfinedPath(root, path.resolve(root, 'absolute'))).toThrow('relative');
      expect(resolveConfinedPath(root, 'safe/child')).toBe(
        path.join(fs.realpathSync(root), 'safe', 'child'),
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('a symlink in any existing parent fails before mutation', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-path-symlink-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-path-outside-'));
    try {
      fs.symlinkSync(outside, path.join(root, 'link'));
      expect(() => resolveConfinedPath(root, 'link/secret.json')).toThrow('symbolic-link');
      expect(fs.existsSync(path.join(outside, 'secret.json'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
