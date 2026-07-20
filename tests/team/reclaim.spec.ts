import { inspectReclaimFence } from '../../src/team/reclaim';

describe('Team reclaim fence', () => {
  test.each([
    ['alive', 'dead', 'Alive'],
    ['dead', 'alive', 'Alive'],
    ['dead', 'unknown', 'Unknown'],
    ['unknown', 'dead', 'Unknown'],
    ['dead', 'dead', 'DeadProof'],
  ] as const)('TEAM-09 liveness pane=%s process=%s -> %s', (pane, process, expected) => {
    expect(inspectReclaimFence(pane, process).kind).toBe(expected);
  });
});

