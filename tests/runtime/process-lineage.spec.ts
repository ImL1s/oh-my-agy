import {
  countPosixProbeSnapshot,
  createPosixProcessLineageTracker,
} from '../../src/runtime/process';

describe('POSIX probe process lineage', () => {
  it('retains first-snapshot detached descendants without adopting unrelated children', () => {
    const lineage = createPosixProcessLineageTracker(new Map([
      [100, 'Fri Jul 31 19:59:00 2026'],
    ]));

    expect(countPosixProbeSnapshot(
      [
        '500 100 500 S Fri Jul 31 20:00:00 2026',
        '600 1 600 S Fri Jul 31 20:00:01 2026',
        '601 600 600 S Fri Jul 31 20:00:02 2026',
        '700 100 700 S Fri Jul 31 20:00:03 2026',
      ].join('\n'),
      500,
      8,
      lineage,
    )).toBe(3);
    expect([...lineage.observedProcesses.keys()].sort((left, right) => left - right))
      .toEqual([500, 600, 601]);

    expect(countPosixProbeSnapshot(
      [
        '500 100 500 S Fri Jul 31 20:00:00 2026',
        '600 1 600 S Fri Jul 31 20:00:01 2026',
        '601 600 600 S Fri Jul 31 20:00:02 2026',
        '701 100 701 S Fri Jul 31 20:00:04 2026',
      ].join('\n'),
      500,
      8,
      lineage,
    )).toBe(3);
  });

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
