import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { inspectExecutableIdentity } from '../../../src/native/probes/identity';

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
});
