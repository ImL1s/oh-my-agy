import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { probeConfigObject, readContainedJson } from '../../../src/native/probes/config';
import { absentPluginIdentity } from '../../../src/native/probes/identity';

describe('contained config reader', () => {
  it('accepts contained regular JSON and rejects escape/symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-config-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-outside-'));
    try {
      fs.writeFileSync(path.join(root, 'ok.json'), '{"ok":true}');
      fs.writeFileSync(path.join(outside, 'secret.json'), '{"secret":true}');
      fs.symlinkSync(path.join(outside, 'secret.json'), path.join(root, 'link.json'));
      expect(readContainedJson(root, 'ok.json')).toMatchObject({ status: 'ok', value: { ok: true } });
      expect(readContainedJson(root, '../escape.json').status).toBe('rejected');
      expect(readContainedJson(root, 'link.json').status).toBe('rejected');
    } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); }
  });

  it('emits bounded config observations without treating absence as unsupported', () => {
    const result = probeConfigObject({ permission: { sandbox: true } }, {
      mode: 'passive', evaluationTimestamp: '2026-07-31T12:00:00.000Z', identityDigest: 'd'.repeat(64),
      hostIdentity: { realpath: '/agy', binarySha256: 'a'.repeat(64), version: null, versionOutputSha256: 'b'.repeat(64), helpOutputSha256: 'c'.repeat(64), platform: 'darwin', arch: 'arm64' },
      pluginIdentity: absentPluginIdentity(),
    });
    expect(result.observations.find(({ capability }) => capability === 'permission.sandbox')?.result).toBe('positive');
    expect(result.observations.find(({ capability }) => capability === 'hook.stop')?.result).toBe('indeterminate');
  });
});
