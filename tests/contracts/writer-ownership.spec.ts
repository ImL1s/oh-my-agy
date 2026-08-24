import {
  FROZEN_OMA_BASE_V1,
  OMA_OWNERSHIP_RULES_V1,
  OWNERSHIP_ORACLE_ARGV_V1,
  ownershipForPath,
  parseRawDiffRecordsZ,
  parseRawDiffZ,
  validateChangedPathOwnership,
  validateFinalTreeEvidence,
} from '../../scripts/check-writer-ownership';

describe('OMA W0 exhaustive changed-path ownership oracle', () => {
  test('every required W0 path family maps exactly once to oma-contract-owner', () => {
    const representative = [
      'src/contracts/index.ts', 'src/contracts/run-manifest.ts',
      'src/contracts/repository-workflow.ts', 'docs/parity/oma-parity.json',
      'scripts/check-writer-ownership.ts', 'tests/fixtures/workflow/golden.json',
      'tests/fixtures/recovery/vector.jsonl', 'tests/contracts/run-manifest.spec.ts',
    ];
    expect(OMA_OWNERSHIP_RULES_V1).toHaveLength(7);
    for (const repositoryPath of representative) {
      expect(ownershipForPath(repositoryPath)).toEqual({ wave: 'OMA-W0', owner: 'oma-contract-owner' });
    }
    expect(validateChangedPathOwnership(representative, 'OMA-W0')['OMA-W0']).toHaveLength(representative.length);
  });

  test('unowned, overlapping-wave expectation, and every AGENTS path fail closed', () => {
    expect(() => ownershipForPath('src/contracts/extra.ts')).toThrow('0 ownership');
    expect(() => ownershipForPath('AGENTS.md')).toThrow('Immutable');
    expect(() => ownershipForPath('src/AGENTS.md')).toThrow('Immutable');
    expect(() => ownershipForPath('scripts/AGENTS.md')).toThrow('Immutable');
    expect(() => validateChangedPathOwnership(['src/setup/doctor.ts'], 'OMA-W0')).toThrow('OMA-W1');
  });

  test('#49 MCP registration files map to install and composition owners', () => {
    expect(ownershipForPath('tests/setup/mcp-registration.spec.ts')).toEqual({
      wave: 'OMA-W1', owner: 'oma-install-owner',
    });
    expect(ownershipForPath('.claude-plugin/.mcp.json')).toEqual({
      wave: 'OMA-W6', owner: 'oma-final-composition-owner',
    });
  });

  test('error catalog is W2 runtime-owned; explain command and docs are W6', () => {
    expect(ownershipForPath('src/runtime/error-catalog.ts')).toEqual({
      wave: 'OMA-W2', owner: 'oma-state-owner',
    });
    expect(ownershipForPath('tests/runtime/error-catalog.spec.ts')).toEqual({
      wave: 'OMA-W2', owner: 'oma-state-owner',
    });
    expect(ownershipForPath('src/cli/explain-command.ts')).toEqual({
      wave: 'OMA-W6', owner: 'oma-final-composition-owner',
    });
    expect(ownershipForPath('docs/error-codes.md')).toEqual({
      wave: 'OMA-W6', owner: 'oma-final-composition-owner',
    });
  });

  test('production probe implementation and evidence tests are W6 composition-owned', () => {
    expect(ownershipForPath('src/production/evidence.ts')).toEqual({
      wave: 'OMA-W6', owner: 'oma-final-composition-owner',
    });
    expect(ownershipForPath('tests/production/evidence.spec.ts')).toEqual({
      wave: 'OMA-W6', owner: 'oma-final-composition-owner',
    });
  });

  test('product workflow authority is W4 native-surface-owned', () => {
    expect(ownershipForPath('src/workflows/authority.ts')).toEqual({
      wave: 'OMA-W4', owner: 'oma-native-surface-owner',
    });
    expect(ownershipForPath('scripts/generate-skill-catalog.ts')).toEqual({
      wave: 'OMA-W4', owner: 'oma-native-surface-owner',
    });
    expect(ownershipForPath('src/modes/skill-catalog.ts')).toEqual({
      wave: 'OMA-W4', owner: 'oma-native-surface-owner',
    });
    expect(ownershipForPath('tests/package/skill-catalog.spec.ts')).toEqual({
      wave: 'OMA-W4', owner: 'oma-native-surface-owner',
    });
    // #36 授權的 skill catalog 索引；其他 AGENTS.md 仍不可變。
    expect(ownershipForPath('skills/AGENTS.md')).toEqual({
      wave: 'OMA-W4', owner: 'oma-native-surface-owner',
    });
  });

  test('raw NUL parser preserves staged modes/OIDs and both rename paths', () => {
    const header = `:100644 100755 ${'1'.repeat(40)} ${'2'.repeat(40)} R100`;
    const raw = Buffer.from(`${header}\0old-name.ts\0new-name.ts\0`, 'utf8');
    expect(parseRawDiffRecordsZ(raw)).toEqual([{
      old_mode: '100644', new_mode: '100755', old_oid: '1'.repeat(40), new_oid: '2'.repeat(40),
      status: 'R100', source_path: 'old-name.ts', destination_path: 'new-name.ts',
    }]);
    expect(parseRawDiffZ(raw)).toEqual(['old-name.ts', 'new-name.ts']);
    expect(() => parseRawDiffZ(Buffer.from(':bad\0'))).toThrow('Malformed');
    expect(() => parseRawDiffZ(Buffer.from(
      `${header}\0same.ts\0same.ts\0`, 'utf8',
    ))).toThrow('identical');
    expect(() => parseRawDiffZ(Buffer.from(
      `${header}\0old.ts\0new.ts\0${header}\0old.ts\0newer.ts\0`, 'utf8',
    ))).toThrow('Duplicate');
    expect(() => parseRawDiffZ(Buffer.from(`${header}\0old.ts\0new.ts`, 'utf8'))).toThrow('unterminated');
  });

  test('final-tree proof requires a clean one-parent candidate and exact remote old OID', () => {
    const base = '1'.repeat(40);
    const candidate = '2'.repeat(40);
    const oldRemote = '3'.repeat(40);
    const record = {
      old_mode: '000000', new_mode: '100644', old_oid: '0'.repeat(40), new_oid: '4'.repeat(40),
      status: 'A', source_path: 'src/contracts/index.ts', destination_path: null,
    };
    const input = {
      base, candidate, remote: 'origin', approvedBranch: 'main', approvedRemoteOldOid: oldRemote,
    };
    const evidence = {
      deltaRecords: [record],
      deltaPaths: ['src/contracts/index.ts'],
      residual: Buffer.alloc(0),
      parents: `${candidate} ${base}`,
      remote: `${oldRemote}\trefs/heads/main`,
    };
    expect(() => validateFinalTreeEvidence(input, evidence)).not.toThrow();
    expect(() => validateFinalTreeEvidence({ ...input, candidate: base }, evidence)).toThrow('differ');
    expect(() => validateFinalTreeEvidence({ ...input, approvedRemoteOldOid: undefined }, evidence))
      .toThrow('remote old OIDs');
    expect(() => validateFinalTreeEvidence(input, { ...evidence, residual: Buffer.from('dirty') }))
      .toThrow('not clean');
    expect(() => validateFinalTreeEvidence(input, { ...evidence, parents: `${candidate} ${base} ${oldRemote}` }))
      .toThrow('exactly one');
    expect(() => validateFinalTreeEvidence(input, { ...evidence, remote: `${candidate}\trefs/heads/main` }))
      .toThrow('drifted');
    expect(() => validateFinalTreeEvidence(input, { ...evidence, deltaPaths: [] }))
      .toThrow('do not match');
  });

  test('exact inclusive dirty/final-tree argv and frozen base are mechanically locked', () => {
    expect(FROZEN_OMA_BASE_V1).toBe('f8eeaae6f42ebbfc1c22be504277377332c0d8fe');
    expect(OWNERSHIP_ORACLE_ARGV_V1).toEqual({
      cached: ['diff', '--cached', '--raw', '-z', '--no-abbrev', '--find-renames=50%', '$BASE', '--'],
      worktree: ['diff', '--raw', '-z', '--no-abbrev', '--find-renames=50%', '--'],
      untracked: ['ls-files', '--others', '--exclude-standard', '-z'],
      cached_ignored: ['ls-files', '--cached', '--ignored', '--exclude-standard', '-z'],
      submodules: ['submodule', 'status', '--recursive'],
      submodule_status: ['-C', '$SUBMODULE', 'status', '--porcelain=v2', '-z', '--untracked-files=all'],
      final_tree: ['diff-tree', '-r', '--raw', '-z', '--no-abbrev', '--find-renames=50%', '$BASE^{tree}', '$CANDIDATE^{tree}', '--'],
      residual: ['status', '--porcelain=v2', '-z', '--untracked-files=all'],
      parents: ['rev-list', '--parents', '-n', '1', '$CANDIDATE'],
      remote: ['ls-remote', '--exit-code', '$REMOTE', 'refs/heads/$APPROVED_BRANCH'],
    });
  });
});
