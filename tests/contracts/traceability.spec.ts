import {
  REQUIREMENT_ID_SET_V1,
  loadTraceability,
  validateTraceability,
} from '../../scripts/check-traceability';

describe('OMA W0 requirement traceability', () => {
  test('all 41 frozen IDs occur exactly once with honest claim/evidence boundaries', () => {
    const traceability = loadTraceability();
    expect(REQUIREMENT_ID_SET_V1).toHaveLength(41);
    expect(() => validateTraceability(traceability)).not.toThrow();
    expect(traceability.rows.filter((row) => row.requirement_id.startsWith('OMG-'))
      .every((row) => row.claim_status === 'reference_only')).toBe(true);
    expect(traceability.rows.find((row) => row.requirement_id === 'OMA-G007-001'))
      .toEqual(expect.objectContaining({ claim_status: 'blocked_live', live_evidence_required: true }));
  });

  test('missing, extra, duplicate, reordered, and claim-without-test mutations fail', () => {
    const traceability = loadTraceability();
    expect(() => validateTraceability({
      ...traceability,
      requirement_ids: traceability.requirement_ids.slice(1),
    })).toThrow('Requirement');
    expect(() => validateTraceability({
      ...traceability,
      rows: [...traceability.rows.slice(0, -1), traceability.rows[0]],
    })).toThrow('cover');
    const rows = traceability.rows.map((row) => row.requirement_id === 'WORKFLOW-001'
      ? { ...row, test_paths: [] }
      : row);
    expect(() => validateTraceability({ ...traceability, rows })).toThrow('lacks');
  });
});
