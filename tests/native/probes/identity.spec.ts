import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  inspectExecutableIdentity,
  resolveExecutablePath,
} from '../../../src/native/probes/identity';

describe('executable identity', () => {
  it('hashes trusted executables, accepts stable canonical symlinks, and rejects non-executable paths', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-identity-'));
    try {
      const executable = path.join(root, 'agy');
      fs.writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      expect(inspectExecutableIdentity({ executable, version: '1.0.0', versionOutput: '1.0.0', helpOutput: 'help' }).realpath).toBe(fs.realpathSync(executable));
      fs.chmodSync(executable, 0o644);
      expect(() => inspectExecutableIdentity({ executable, version: null, versionOutput: '', helpOutput: '' })).toThrow(/permissions/);
      fs.chmodSync(executable, 0o755);
      const link = path.join(root, 'agy-link');
      fs.symlinkSync(executable, link);
      expect(inspectExecutableIdentity({ executable: link, version: null, versionOutput: '', helpOutput: '' }).realpath).toBe(fs.realpathSync(executable));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('resolves the native Windows .exe suffix from a semicolon-delimited PATH', () => {
    const existing = new Set(['D:\\Antigravity\\bin\\agy.exe']);
    expect(resolveExecutablePath(
      'agy',
      'relative;C:\\missing;D:\\Antigravity\\bin',
      'win32',
      (candidate) => existing.has(candidate),
    )).toBe('D:\\Antigravity\\bin\\agy.exe');
  });

  it('does not require POSIX execute bits for a regular Windows executable', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-identity-win32-'));
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    try {
      const executable = path.join(root, 'agy.exe');
      fs.writeFileSync(executable, 'windows fixture\n', { mode: 0o600 });
      expect(() => inspectExecutableIdentity({
        executable,
        version: null,
        versionOutput: '',
        helpOutput: '',
      })).toThrow(/permissions/);
      Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
      expect(inspectExecutableIdentity({
        executable,
        version: '1.1.9',
        versionOutput: '1.1.9',
        helpOutput: 'help',
      })).toMatchObject({ platform: 'win32', realpath: fs.realpathSync(executable) });
    } finally {
      if (platform !== undefined) Object.defineProperty(process, 'platform', platform);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
