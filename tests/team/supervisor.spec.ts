import { assessWorker } from '../../src/team/supervisor';
import { TeamTaskRuntimeV1 } from '../../src/team/types';

function task(): TeamTaskRuntimeV1 {
  return {
    id: 'task-a', revision: 1, status: 'in_progress', commandEvidence: {},
    claim: { ownerId: 'worker', token: 'token', generation: 1, leasedUntilMs: 100 },
  };
}

describe('hung worker supervision', () => {
  test('TEAM-09A/B/C separates alive, unknown, and dead proof', () => {
    expect(assessWorker(task(), undefined, 200, 'alive', 'alive').status).toBe('awaiting_interaction');
    expect(assessWorker(task(), undefined, 200, 'dead', 'unknown').status).toBe('orphan_identity_unproven');
    expect(assessWorker(task(), undefined, 200, 'dead', 'dead').status).toBe('reclaimable');
  });
});

