import {
  assertCompactionPackCurrent,
  createCompactionPack,
  validateCompactionPack,
} from '../../src/runtime/compaction';

describe('compaction checkpoint', () => {
  test('preserves guidance bytes, receipts, counters, warning order, and unknown hashes', () => {
    const pack = createCompactionPack({
      runId: 'run-1', aggregateId: 'a'.repeat(64), aggregateRevision: 4,
      aggregateSha256: 'b'.repeat(64), generation: 2,
      guidance: Buffer.from('exact guidance\n'),
      receiptHashes: ['c'.repeat(64)],
      warnings: ['W_UNKNOWN_RECORD_TYPE', 'W_BROKEN_CHAIN', 'W_PARTIAL_RECOVERY'],
      counters: { complete_turns_retained: 124 },
      unknownRecordHashes: ['d'.repeat(64)],
      createdAt: '2026-07-22T00:00:00.000Z',
    });
    expect(pack.warnings).toEqual(['W_BROKEN_CHAIN', 'W_PARTIAL_RECOVERY', 'W_UNKNOWN_RECORD_TYPE']);
    expect(Buffer.from(pack.guidance_base64, 'base64').toString()).toBe('exact guidance\n');
    expect(() => validateCompactionPack(pack)).not.toThrow();
    expect(() => assertCompactionPackCurrent(pack, {
      aggregateId: 'a'.repeat(64), aggregateRevision: 4,
      aggregateSha256: 'b'.repeat(64), generation: 3,
    })).toThrow(/stale aggregate generation/);
  });
});
