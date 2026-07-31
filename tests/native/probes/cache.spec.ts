import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalBytesV1 } from '../../../src/contracts/state-schemas';
import { assembleHostCapabilityProfile, HostIdentityV1 } from '../../../src/native/capability-profile';
import {
  HOST_CAPABILITY_CACHE_KEY_V1,
  HOST_CAPABILITY_CACHE_STORE_V1,
  HostCapabilityProfileCacheV1,
  isHostCapabilityProfileFresh,
} from '../../../src/native/probes/cache';
import { absentPluginIdentity } from '../../../src/native/probes/identity';
import { acquireOwnerLock, releaseOwnerLock } from '../../../src/runtime/lock';

const host: HostIdentityV1 = { realpath: '/agy', binarySha256: 'a'.repeat(64), version: '1.0.0', versionOutputSha256: 'b'.repeat(64), helpOutputSha256: 'c'.repeat(64), platform: 'darwin', arch: 'arm64' };
const FRESH_NOW = '2026-07-31T12:00:01.000Z';

function makeProfile(identity: HostIdentityV1, evaluationTimestamp = '2026-07-31T12:00:00.000Z') {
  const plugin = absentPluginIdentity();
  return assembleHostCapabilityProfile({ evaluationTimestamp, hostIdentityBefore: identity, hostIdentityAfter: identity, pluginIdentityBefore: plugin, pluginIdentityAfter: plugin, observations: [] });
}

function makeLiveProfile(identity: HostIdentityV1, evaluationTimestamp: string) {
  const base = makeProfile(identity, evaluationTimestamp);
  const plugin = absentPluginIdentity();
  return assembleHostCapabilityProfile({
    evaluationTimestamp,
    hostIdentityBefore: identity,
    hostIdentityAfter: identity,
    pluginIdentityBefore: plugin,
    pluginIdentityAfter: plugin,
    observations: [{
      capability: 'headless.print',
      source: 'live_probe',
      tier: 'verified',
      result: 'positive',
      observedAt: evaluationTimestamp,
      identityDigest: base.identityDigest,
      detailCode: 'LIVE_VERIFIED',
      diagnostic: null,
    }],
  });
}

function makeSlowLiveProfile(identity: HostIdentityV1) {
  const evaluationTimestamp = '2026-07-31T12:00:45.000Z';
  const base = makeProfile(identity, evaluationTimestamp);
  const plugin = absentPluginIdentity();
  return assembleHostCapabilityProfile({
    evaluationTimestamp,
    hostIdentityBefore: identity,
    hostIdentityAfter: identity,
    pluginIdentityBefore: plugin,
    pluginIdentityAfter: plugin,
    observations: [
      {
        capability: 'headless.print',
        source: 'help',
        tier: 'observed',
        result: 'positive',
        observedAt: '2026-07-31T12:00:00.000Z',
        identityDigest: base.identityDigest,
        detailCode: 'HELP_OBSERVED',
        diagnostic: null,
      },
      {
        capability: 'headless.print',
        source: 'live_probe',
        tier: 'verified',
        result: 'positive',
        observedAt: evaluationTimestamp,
        identityDigest: base.identityDigest,
        detailCode: 'LIVE_VERIFIED',
        diagnostic: null,
      },
    ],
  });
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

  it('re-reads corrupt state under the cache owner lock before deleting it', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-cap-cache-corrupt-race-'));
    const target = path.join(root, 'native', 'host-capability-profile-v1.json');
    const lock = await acquireOwnerLock(`${target}.lock`, { timeoutMs: 5_000 });
    expect(lock.ok).toBe(true);
    let released = false;
    try {
      if (!lock.ok) return;
      const cache = new HostCapabilityProfileCacheV1(root);
      const verified = makeLiveProfile(host, '2026-07-31T12:00:01.000Z');
      const passive = makeProfile(host, '2026-07-31T12:00:02.000Z');
      fs.writeFileSync(target, '{malformed', { mode: 0o600 });

      const pending = cache.commit(passive);
      await Promise.resolve();
      fs.writeFileSync(target, canonicalBytesV1({
        store_kind: HOST_CAPABILITY_CACHE_STORE_V1,
        schema_version: 1,
        revision: 7,
        value: verified,
      }), { mode: 0o600 });
      expect(releaseOwnerLock(lock.value).ok).toBe(true);
      released = true;

      expect(await pending).toBe('unchanged');
      expect(cache.read(verified.cacheKey, '2026-07-31T12:00:03.000Z')?.profileDigest)
        .toBe(verified.profileDigest);
    } finally {
      if (lock.ok && !released) releaseOwnerLock(lock.value);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not let a passive commit downgrade a fresh verified profile', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-cap-cache-authority-'));
    try {
      const cache = new HostCapabilityProfileCacheV1(root);
      const live = makeLiveProfile(host, '2026-07-31T12:00:01.000Z');
      const passiveFinishingLater = makeProfile(host, '2026-07-31T12:00:02.000Z');
      expect(await cache.commit(live)).toBe('created');

      expect(await cache.commit(passiveFinishingLater)).toBe('unchanged');
      expect(cache.read(live.cacheKey, '2026-07-31T12:00:03.000Z')?.profileDigest)
        .toBe(live.profileDigest);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('keeps fresh route authority after superseded help evidence expires', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-cap-cache-route-fresh-'));
    try {
      const cache = new HostCapabilityProfileCacheV1(root);
      const profile = makeSlowLiveProfile(host);
      expect(await cache.commit(profile)).toBe('created');

      expect(isHostCapabilityProfileFresh(profile, '2026-07-31T12:01:05.000Z')).toBe(true);
      expect(cache.read(profile.cacheKey, '2026-07-31T12:01:05.000Z')?.profileDigest)
        .toBe(profile.profileDigest);
      expect(await cache.commit(makeProfile(host, '2026-07-31T12:01:05.000Z')))
        .toBe('unchanged');
      expect(cache.read(profile.cacheKey, '2026-07-31T12:01:05.000Z')?.profileDigest)
        .toBe(profile.profileDigest);
      expect(isHostCapabilityProfileFresh(profile, '2026-07-31T12:01:45.001Z')).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('leaves a future-schema cache byte-identical and fails closed', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-cap-cache-future-'));
    try {
      const cache = new HostCapabilityProfileCacheV1(root);
      const incoming = makeProfile(host);
      const target = path.join(root, 'native', 'host-capability-profile-v1.json');
      const futureBytes = canonicalBytesV1({
        store_kind: HOST_CAPABILITY_CACHE_STORE_V1,
        schema_version: 2,
        revision: 7,
        value: incoming,
      });
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, futureBytes, { mode: 0o600 });

      expect(cache.readSnapshot(incoming.cacheKey)).toBeNull();
      expect(await cache.commit(incoming)).toBe('conflict');
      expect(fs.readFileSync(target)).toEqual(futureBytes);
      expect(fs.existsSync(path.join(root, `${HOST_CAPABILITY_CACHE_KEY_V1}.json`))).toBe(true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('invalidates only the expected identity-bound cache entry', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-profile-invalidate-'));
    try {
      const cache = new HostCapabilityProfileCacheV1(root);
      const current = makeProfile({ ...host, binarySha256: 'e'.repeat(64) });
      expect(await cache.commit(current)).toBe('created');
      const snapshot = cache.readSnapshot(current.cacheKey);
      expect(snapshot).not.toBeNull();
      expect(await cache.invalidate('f'.repeat(64), snapshot)).toBe('conflict');
      expect(cache.read(current.cacheKey, FRESH_NOW)).toEqual(current);
      expect(await cache.invalidate(current.cacheKey, snapshot)).toBe('removed');
      expect(cache.read(current.cacheKey, FRESH_NOW)).toBeNull();
      expect(await cache.invalidate(current.cacheKey, snapshot)).toBe('unchanged');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('does not let a stale failed probe invalidate a newer successful profile', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-profile-invalidate-race-'));
    try {
      const cache = new HostCapabilityProfileCacheV1(root);
      const first = makeProfile(host);
      const newer = makeProfile(host, '2026-07-31T12:00:01.000Z');
      expect(await cache.commit(first)).toBe('created');
      const staleFailureView = cache.readSnapshot(first.cacheKey);
      expect(staleFailureView).not.toBeNull();
      expect(await cache.commit(newer)).toBe('updated');

      expect(await cache.invalidate(first.cacheKey, staleFailureView)).toBe('conflict');
      expect(cache.read(newer.cacheKey, '2026-07-31T12:00:02.000Z')?.profileDigest)
        .toBe(newer.profileDigest);

      expect(await cache.invalidate(newer.cacheKey, null)).toBe('unchanged');
      expect(cache.read(newer.cacheKey, '2026-07-31T12:00:02.000Z')?.profileDigest)
        .toBe(newer.profileDigest);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
