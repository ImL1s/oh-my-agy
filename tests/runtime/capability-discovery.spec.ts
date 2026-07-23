import { discoverCapabilities } from '../../src/runtime/capability-discovery';

describe('capability discovery truth tiers', () => {
  test('records seven tiers independently, resolves shadows deterministically, and requires fresh proof', async () => {
    const observedAt = '2026-07-22T00:00:00.000Z';
    const records = await discoverCapabilities([
      {
        canonicalName: 'host-hook', aliases: ['hook'], origin: '/z', priority: 20,
        configured: true, installed: true, enabled: true, loadable: true,
        observed: true, healthy: false, verified: false,
        version: '1.0.0', digest: 'a'.repeat(64), diagnostic: 'token=abc',
        observedAt,
      },
      {
        canonicalName: 'host-hook', aliases: [], origin: '/a', priority: 10,
        configured: true, installed: true, enabled: false, loadable: false,
        observed: false, healthy: false, verified: false,
        version: null, digest: null, diagnostic: '', observedAt,
      },
    ], { now: new Date('2026-07-22T00:00:01.000Z'), maxObservationAgeMs: 10_000 });
    expect(records.map((record) => record.origin)).toEqual(['/a', '/z']);
    expect(records[0].shadowed_by).toBeNull();
    expect(records[1].shadowed_by).toBe('/a');
    expect(records[1].healthy).toBe(false);
    expect(records[1].verified).toBe(false);
    expect(records[1].probe_timestamp).toBe(observedAt);
    expect(records[1].redacted_diagnostic).not.toContain('abc');
  });

  test('marks stale observation as restart-required without upgrading verified', async () => {
    const [record] = await discoverCapabilities([{
      canonicalName: 'session-start', aliases: [], origin: 'manifest', priority: 0,
      configured: true, installed: true, enabled: true, loadable: true,
      observed: true, healthy: true, verified: true,
      version: null, digest: null, diagnostic: '', observedAt: '2026-07-21T00:00:00.000Z',
    }], { now: new Date('2026-07-22T00:00:00.000Z'), maxObservationAgeMs: 1000 });
    expect(record.observed).toBe(false);
    expect(record.healthy).toBe(false);
    expect(record.verified).toBe(false);
    expect(record.bounded_result).toContain('restart-required');
  });
});
