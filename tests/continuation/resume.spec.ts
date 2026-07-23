import * as fs from 'fs';
import * as path from 'path';
import { ContractViolation } from '../../src/contracts/state-schemas';
import { buildResumeLaunchPlan, selectResumeTarget } from '../../src/continuation/resume';

describe('exact resume selection and launch', () => {
  const fixture = JSON.parse(fs.readFileSync(
    path.join(__dirname, '../fixtures/recovery/resume-selector-no-fallback-v1.json'),
    'utf8',
  ));

  test.each<any>(fixture.error_vectors)('$name preserves no-fallback error', (vector: any) => {
    try {
      selectResumeTarget(vector.candidates, { bestEffort: vector.best_effort });
      throw new Error('expected selection to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ContractViolation);
      expect((error as ContractViolation).code).toBe(vector.expected_error);
    }
  });

  test.each<any>(fixture.selection_vectors)('$name selects the exact first valid rank', (vector: any) => {
    const selected = selectResumeTarget(vector.candidates, { bestEffort: vector.best_effort });
    expect(selected.kind).toBe(vector.expected_kind);
  });

  test('verified resume uses exact --conversation and increments generation', () => {
    const plan = buildResumeLaunchPlan({
      kind: 'native_session', valid: true, binding_count: 1, repository_id: 'OMA',
      cwd_hash: 'cwd', generation: 7, lineage_hash: 'lineage', conversation_id: 'conv-1',
    });
    expect(plan.argv).toEqual(['agy', '--conversation', 'conv-1']);
    expect(plan.generation).toBe(8);
    expect(plan.verified).toBe(true);
  });

  test('best-effort continuation is explicit -c and never verified', () => {
    const plan = buildResumeLaunchPlan({
      kind: 'best_effort_repository_search', valid: true, binding_count: 1,
      repository_id: 'OMA', cwd_hash: 'cwd', generation: 2, lineage_hash: 'lineage',
      conversation_id: 'diagnostic', diagnostics_only: true,
    });
    expect(plan.argv).toEqual(['agy', '-c']);
    expect(plan.verified).toBe(false);
  });

  test('best-effort selector keeps OMA bridge fields when W0 marks diagnostics-only', () => {
    const selected = selectResumeTarget([{
      kind: 'best_effort_repository_search', valid: true, binding_count: 1,
      repository_id: 'OMA', cwd_hash: 'cwd', generation: 2, lineage_hash: 'lineage',
      conversation_id: 'diagnostic-only',
    }], { bestEffort: true });
    expect(selected).toEqual(expect.objectContaining({
      conversation_id: 'diagnostic-only', diagnostics_only: true,
    }));
  });
});
