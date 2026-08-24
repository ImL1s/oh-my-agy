import {
  countPosixProbeSnapshot,
  createPosixProcessLineageTracker,
} from '../../src/runtime/process';

describe('POSIX probe process lineage', () => {
  it('does not adopt first-snapshot PID-1 baseline-delta processes outside the probe group', () => {
    const lineage = createPosixProcessLineageTracker(new Map([
      [100, 'Fri Jul 31 19:59:00 2026'],
    ]));

    expect(countPosixProbeSnapshot(
      [
        '500 100 500 S Fri Jul 31 20:00:00 2026',
        '600 1 600 S Fri Jul 31 20:00:01 2026',
        '601 600 600 S Fri Jul 31 20:00:02 2026',
        '700 100 700 S Fri Jul 31 20:00:03 2026',
        '800 1 800 S Fri Jul 31 20:00:03 2026',
      ].join('\n'),
      500,
      1,
      lineage,
    )).toBe(1);
    expect([...lineage.observedProcesses.keys()]).toEqual([500]);

    expect(countPosixProbeSnapshot(
      [
        '500 100 500 S Fri Jul 31 20:00:00 2026',
        '600 1 600 S Fri Jul 31 20:00:01 2026',
        '601 600 600 S Fri Jul 31 20:00:02 2026',
        '701 100 701 S Fri Jul 31 20:00:04 2026',
        '800 1 800 S Fri Jul 31 20:00:03 2026',
      ].join('\n'),
      500,
      1,
      lineage,
    )).toBe(1);
  });

  it('counts PID-1 reparented process-group members without adopting unrelated PID-1 processes', () => {
    const lineage = createPosixProcessLineageTracker(new Map([
      [900, 'Fri Jul 31 19:59:00 2026'],
    ]));

    expect(countPosixProbeSnapshot(
      [
        '500 100 500 S Fri Jul 31 20:00:00 2026',
        '600 1 500 S Fri Jul 31 20:00:01 2026',
        '601 600 500 S Fri Jul 31 20:00:02 2026',
        '800 1 800 S Fri Jul 31 20:00:01 2026',
        '900 1 500 S Fri Jul 31 19:59:00 2026',
      ].join('\n'),
      500,
      8,
      lineage,
    )).toBe(3);
    expect([...lineage.observedProcesses.keys()].sort((left, right) => left - right))
      .toEqual([500, 600, 601]);
  });

  it('retains observed detached descendants after the root exits without adopting new PID-1 processes', () => {
    const lineage = createPosixProcessLineageTracker(new Map<number, string>());
    expect(countPosixProbeSnapshot(
      [
        '500 100 500 S Fri Jul 31 20:00:00 2026',
        '600 500 600 S Fri Jul 31 20:00:01 2026',
      ].join('\n'),
      500,
      8,
      lineage,
    )).toBe(2);

    expect(countPosixProbeSnapshot(
      [
        '600 1 600 S Fri Jul 31 20:00:01 2026',
        '800 1 800 S Fri Jul 31 20:00:05 2026',
      ].join('\n'),
      500,
      8,
      lineage,
    )).toBe(2);
    expect([...lineage.observedProcesses.keys()].sort((left, right) => left - right))
      .toEqual([500, 600]);
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
