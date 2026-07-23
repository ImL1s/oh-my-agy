import { ProgressOracleV1 } from '../../src/continuation/progress-oracle';

describe('progress fingerprint authority', () => {
  test('heartbeat, lease and wall-clock metadata cannot manufacture progress', () => {
    const oracle = new ProgressOracleV1();
    const accepted = {
      acceptedGateRevisions: [{ id: 'gate', revision: 1 }],
      acceptedTaskProgressRevisions: [],
      acceptedEvidenceRevisionsAndDigests: [],
      verifiedArtifactDigests: [],
    };
    const baseline = oracle.fingerprint(accepted);
    const noisy = oracle.fingerprint({
      ...accepted,
      supervisorHeartbeat: '2026-07-22T00:00:00.000Z',
      leaseExpiresAt: '2026-07-22T00:01:00.000Z',
      wallClock: 123,
    } as typeof accepted);
    expect(noisy).toBe(baseline);
  });
});
