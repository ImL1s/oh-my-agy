import {
  countPosixProbeSnapshot,
  createPosixProcessLineageTracker,
} from '../../src/runtime/process';

describe('POSIX probe process lineage', () => {
  it('does not adopt a reused PID with a different process start marker', () => {
    const lineage = createPosixProcessLineageTracker(new Map<number, string>());
    expect(countPosixProbeSnapshot(
      [
        '500 1 500 S Fri Jul 31 20:00:00 2026',
        '600 500 500 S Fri Jul 31 20:00:01 2026',
      ].join('\n'),
      500,
      2,
      lineage,
    )).toBe(2);

    expect(countPosixProbeSnapshot(
      [
        '600 1 600 S Fri Jul 31 20:00:02 2026',
        '601 600 600 S Fri Jul 31 20:00:03 2026',
      ].join('\n'),
      500,
      2,
      lineage,
    )).toBe(2);
  });
});
