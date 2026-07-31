import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assembleHostCapabilityProfile, HostIdentityV1 } from '../../../src/native/capability-profile';
import { HostCapabilityProfileCacheV1 } from '../../../src/native/probes/cache';
import { absentPluginIdentity } from '../../../src/native/probes/identity';

const host: HostIdentityV1 = { realpath: '/agy', binarySha256: 'a'.repeat(64), version: '1.0.0', versionOutputSha256: 'b'.repeat(64), helpOutputSha256: 'c'.repeat(64), platform: 'darwin', arch: 'arm64' };
const FRESH_NOW = '2026-07-31T12:00:01.000Z';

function makeProfile(identity: HostIdentityV1) {
  const plugin = absentPluginIdentity();
  return assembleHostCapabilityProfile({ evaluationTimestamp: '2026-07-31T12:00:00.000Z', hostIdentityBefore: identity, hostIdentityAfter: identity, pluginIdentityBefore: plugin, pluginIdentityAfter: plugin, observations: [] });
}

describe('host capability cache', () => {
  it('CAS-replaces an identity-bound entry when the cache key changes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-cap-cache-'));
    try {
      const cache = new HostCapabilityProfileCacheV1(root);
      const first = makeProfile(host);
      const updated = makeProfile({ ...host, binarySha256: 'd'.repeat(64) });
      expect(await cache.commit(first)).toBe('created');
      expect(cache.read(updated.cacheKey, '2026-07-31T12:00:01.000Z')).toBeNull();
      expect(await cache.commit(updated)).toBe('updated');
      expect(cache.read(updated.cacheKey, '2026-07-31T12:00:01.000Z')?.profileDigest).toBe(updated.profileDigest);
      expect(cache.read(first.cacheKey, '2026-07-31T12:00:01.000Z')).toBeNull();
      expect(cache.read(updated.cacheKey, '2026-07-31T12:05:00.001Z')).toBeNull();
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('rebuilds a corrupt named OMA cache without trusting it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-cap-cache-'));
    try {
      const cache = new HostCapabilityProfileCacheV1(root);
      const first = makeProfile(host);
      const target = path.join(root, 'native', 'host-capability-profile-v1.json');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, '{malformed');
      expect(cache.read(first.cacheKey, '2026-07-31T12:00:01.000Z')).toBeNull();
      expect(await cache.commit(first)).toBe('created');
      expect(cache.read(first.cacheKey, '2026-07-31T12:00:01.000Z')?.profileDigest).toBe(first.profileDigest);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('invalidates only the expected identity-bound cache entry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-profile-invalidate-'));
    try {
      const cache = new HostCapabilityProfileCacheV1(root);
      const current = makeProfile({ ...host, binarySha256: 'e'.repeat(64) });
      expect(await cache.commit(current)).toBe('created');
      expect(await cache.invalidate('f'.repeat(64))).toBe('conflict');
      expect(cache.read(current.cacheKey, FRESH_NOW)).toEqual(current);
      expect(await cache.invalidate(current.cacheKey)).toBe('removed');
      expect(cache.read(current.cacheKey, FRESH_NOW)).toBeNull();
      expect(await cache.invalidate(current.cacheKey)).toBe('unchanged');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
