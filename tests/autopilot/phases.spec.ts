import {
  gateMatchesPhase,
  nextOmxPhaseAfterGate,
  skillNameForPhase,
  toOmxPhaseName,
} from '../../src/autopilot/phases';

describe('OMX phase aliases', () => {
  test('maps legacy names to OMX', () => {
    expect(toOmxPhaseName('requirements')).toBe('deep-interview');
    expect(toOmxPhaseName('planning')).toBe('ralplan');
    expect(toOmxPhaseName('executing')).toBe('ultragoal');
    expect(toOmxPhaseName('review')).toBe('code-review');
    expect(toOmxPhaseName('qa')).toBe('ultraqa');
    expect(toOmxPhaseName('deep-interview')).toBe('deep-interview');
  });

  test('gateMatchesPhase accepts dual names', () => {
    expect(gateMatchesPhase('deep-interview', 'requirements')).toBe(true);
    expect(gateMatchesPhase('ralplan', 'planning')).toBe(true);
    expect(gateMatchesPhase('ultragoal', 'executing')).toBe(true);
  });

  test('nextOmxPhaseAfterGate advances the five-phase cycle', () => {
    expect(nextOmxPhaseAfterGate('deep-interview', 'deep-interview').phase).toBe('ralplan');
    expect(nextOmxPhaseAfterGate('ralplan', 'ralplan').phase).toBe('ultragoal');
    expect(nextOmxPhaseAfterGate('ultragoal', 'ultragoal').phase).toBe('code-review');
    expect(nextOmxPhaseAfterGate('code-review', 'code-review').phase).toBe('ultraqa');
    expect(nextOmxPhaseAfterGate('ultraqa', 'production').phase).toBe('completed');
  });

  test('skillNameForPhase returns workflow skill', () => {
    expect(skillNameForPhase('requirements')).toBe('deep-interview');
    expect(skillNameForPhase('code-review')).toBe('code-review');
  });
});
