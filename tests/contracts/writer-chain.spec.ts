import {
  HANDOFF_DOMAIN_V1,
  PARENT_HASH_ORACLE_V1,
  HandoffPayloadV1,
  W6RequestBindingV1,
  canonicalBytesV1,
  createPathProposal,
  createProposalIndex,
  handoffHash,
  merkleRootV1,
  safePathKey,
  signHandoff,
  sha256Hex,
  validateProposalIndex,
  validateParentHandoffHashes,
  verifyHandoff,
} from '../../src/contracts';

function payload(keyId: string): HandoffPayloadV1 {
  return {
    store_kind: 'dual_parity_handoff', schema_version: 1, repository_id: 'OMA', run_id: 'run-1',
    wave: 'OMA-W0', owner: 'oma-contract-owner', key_id: keyId,
    frozen_base_commit: '1'.repeat(40), frozen_base_tree: '2'.repeat(40), manifest_revision: 1,
    lease_generation: 2,
    manifest_hash: 'a'.repeat(64), proposal_index_hash: 'b'.repeat(64),
    proposal_merkle_root: 'c'.repeat(64), parent_waves: [], parent_handoff_hashes: [],
    completed_at: '2026-07-22T00:00:00.000Z',
  };
}

function proposalIndex(w6Requests: W6RequestBindingV1[]) {
  const proposal = createPathProposal({
    store_kind: 'dual_parity_path_proposal',
    schema_version: 1,
    repository_id: 'OMA',
    run_id: 'run-1',
    wave: 'OMA-W0',
    owner: 'oma-contract-owner',
    path: 'src/contracts/writer-chain.ts',
    initial_sha256: 'ABSENT',
    final_sha256: '9'.repeat(64),
    disposition: 'changed',
    reason: 'Test the authenticated proposal index.',
    targeted_tests: [{
      argv: ['npx', 'jest', '--runInBand', 'tests/contracts/writer-chain.spec.ts'],
      exit_code: 0,
      stdout_sha256: '7'.repeat(64),
      stderr_sha256: '8'.repeat(64),
    }],
  });
  return createProposalIndex({
    store_kind: 'dual_parity_proposal_index',
    schema_version: 1,
    repository_id: 'OMA',
    run_id: 'run-1',
    wave: 'OMA-W0',
    owner: 'oma-contract-owner',
    frozen_base_commit: '1'.repeat(40),
    frozen_base_tree: '2'.repeat(40),
    proposals: [proposal],
    w6_requests: w6Requests,
    created_at: '2026-07-22T00:00:00.000Z',
  });
}

describe('OMA W0 authenticated writer chain', () => {
  test('envelope is exactly signed_payload+signature with frozen HMAC domain and canonical hash', () => {
    const key = Buffer.alloc(32, 7);
    const keyId = 'd'.repeat(64);
    const envelope = signHandoff(payload(keyId), key, keyId);
    expect(Object.keys(envelope).sort()).toEqual(['signature', 'signed_payload']);
    expect(envelope.signature).toMatch(/^[0-9a-f]{64}$/);
    expect(handoffHash(envelope)).toMatch(/^[0-9a-f]{64}$/);
    expect(HANDOFF_DOMAIN_V1.toString('utf8')).toBe('OMG-OMA-HANDOFF-V1\0');
    expect(() => verifyHandoff(envelope, key, keyId)).not.toThrow();
    expect(() => verifyHandoff(envelope, Buffer.alloc(32, 8), keyId)).toThrow('signature');
    expect(() => verifyHandoff({
      ...envelope,
      signed_payload: { ...envelope.signed_payload, run_id: 'foreign' },
    }, key, keyId)).toThrow('signature');
  });

  test('canonical integer-only bytes make float, reordered bytes, and wrong key identity fail', () => {
    const key = Buffer.alloc(32, 3);
    const keyId = 'e'.repeat(64);
    expect(() => signHandoff({ ...payload(keyId), manifest_revision: 1.5 }, key, keyId)).toThrow('integers');
    expect(() => signHandoff(payload(keyId), key, 'f'.repeat(64))).toThrow('key identity');
    expect(canonicalBytesV1(payload(keyId)).at(-1)).not.toBe(0x0a);
  });

  test('exact dependency parent hashes use DAG order, never completion order or numeric predecessor', () => {
    expect(PARENT_HASH_ORACLE_V1).toEqual({
      'OMA-W0': [], 'OMA-W1': ['OMA-W0'], 'OMA-W2': ['OMA-W0'], 'OMA-W3': ['OMA-W2'],
      'OMA-W4': ['OMA-W1', 'OMA-W2'], 'OMA-W5': ['OMA-W3', 'OMA-W4'],
      'OMA-W6': ['OMA-W0', 'OMA-W1', 'OMA-W2', 'OMA-W3', 'OMA-W4', 'OMA-W5'],
      'OMA-W7': ['OMA-W6'],
    });
    const key = Buffer.alloc(32, 1);
    const keyId = 'd'.repeat(64);
    const rootParent = signHandoff({
      ...payload(keyId), wave: 'OMA-W0', owner: 'oma-contract-owner',
    }, key, keyId);
    const rootHash = handoffHash(rootParent);
    const parent1 = signHandoff({
      ...payload(keyId), wave: 'OMA-W1', owner: 'oma-install-owner',
      parent_waves: ['OMA-W0'], parent_handoff_hashes: [rootHash],
    }, key, keyId);
    const parent2 = signHandoff({
      ...payload(keyId), wave: 'OMA-W2', owner: 'oma-state-owner',
      parent_waves: ['OMA-W0'], parent_handoff_hashes: [rootHash],
    }, key, keyId);
    const hashes = [handoffHash(parent1), handoffHash(parent2)];
    const binding = {
      repository_id: 'OMA' as const,
      run_id: 'run-1',
      frozen_base_commit: '1'.repeat(40),
      frozen_base_tree: '2'.repeat(40),
      current_manifest_revision: 1,
      current_lease_generation: 2,
      current_manifest_hash: 'a'.repeat(64),
      previous_manifest_hash: null,
    };
    expect(() => validateParentHandoffHashes(
      'OMA-W4', ['OMA-W1', 'OMA-W2'], hashes, [parent1, parent2], binding,
    )).not.toThrow();
    expect(() => validateParentHandoffHashes(
      'OMA-W4', ['OMA-W2', 'OMA-W1'], [...hashes].reverse(), [parent2, parent1], binding,
    )).toThrow('order');
    expect(() => validateParentHandoffHashes(
      'OMA-W4', ['OMA-W1', 'OMA-W2'], [hashes[0], hashes[0]], [parent1, parent2], binding,
    )).toThrow();
    expect(() => validateParentHandoffHashes(
      'OMA-W4', ['OMA-W1', 'OMA-W2'], [handoffHash(parent1), handoffHash(parent2)],
      [parent1, { ...parent2, signed_payload: { ...parent2.signed_payload, run_id: 'foreign' } }],
      binding,
    )).toThrow('foreign');
  });

  test('path Merkle root is deterministic by UTF-8 path bytes and binds path plus proposal hash', () => {
    const left = merkleRootV1([
      { path: 'z.ts', hash: 'a'.repeat(64) }, { path: 'a.ts', hash: 'b'.repeat(64) },
    ]);
    const right = merkleRootV1([
      { path: 'a.ts', hash: 'b'.repeat(64) }, { path: 'z.ts', hash: 'a'.repeat(64) },
    ]);
    expect(left).toBe(right);
    expect(merkleRootV1([{ path: 'a.ts', hash: 'c'.repeat(64) }])).not.toBe(right);
  });

  test('W6 request bindings use exact portable keys, safe integers, unique sorted confined paths', () => {
    const root = `.agy/artifacts/dual-parity/${safePathKey('run-1')}/OMA-W0`;
    const a = { path: `${root}/a.json`, byte_length: 2, sha256: 'a'.repeat(64) };
    const z = { path: `${root}/z.json`, byte_length: 3, sha256: 'b'.repeat(64) };
    const index = proposalIndex([z, a]);
    expect(index.w6_requests).toEqual([a, z]);
    expect(() => validateProposalIndex({
      ...index,
      w6_requests: [z, a],
    })).toThrow('sorted');
    expect(() => validateProposalIndex({
      ...index,
      w6_requests: [a, a],
    })).toThrow('unique');
    expect(() => proposalIndex([{ ...a, byte_length: 1.5 }])).toThrow('safe integer');
    expect(() => proposalIndex([{ ...a, byte_length: '2' } as any])).toThrow('safe integer');
    expect(() => proposalIndex([null as any])).toThrow('object');
    expect(() => proposalIndex([{ ...a, sha256: 'A'.repeat(64) }])).toThrow('SHA-256');
    expect(() => proposalIndex([{ ...a, path: '../foreign.json' }])).toThrow('escapes');
    expect(() => proposalIndex([{
      ...a,
      path: `.agy/artifacts/dual-parity/${safePathKey('other-run')}/OMA-W0/a.json`,
    }])).toThrow('run/wave');
    expect(() => validateProposalIndex({
      ...index,
      w6_requests: [{ ...a, extra: true } as any],
    })).toThrow('keys');
  });

  test('proposal-index hash and handoff HMAC authenticate the exact W6 request set', () => {
    const key = Buffer.alloc(32, 6);
    const keyId = 'd'.repeat(64);
    const emptyIndex = proposalIndex([]);
    const root = `.agy/artifacts/dual-parity/${safePathKey('run-1')}/OMA-W0`;
    const requestIndex = proposalIndex([{
      path: `${root}/w6-packaging-request.json`,
      byte_length: 2,
      sha256: 'a'.repeat(64),
    }]);
    const empty = signHandoff({
      ...payload(keyId),
      proposal_index_hash: sha256Hex(canonicalBytesV1(emptyIndex)),
    }, key, keyId);
    const withRequest = signHandoff({
      ...payload(keyId),
      proposal_index_hash: sha256Hex(canonicalBytesV1(requestIndex)),
    }, key, keyId);
    expect(empty.signed_payload.proposal_index_hash)
      .not.toBe(withRequest.signed_payload.proposal_index_hash);
    expect(empty.signature).not.toBe(withRequest.signature);
    expect(handoffHash(empty)).not.toBe(handoffHash(withRequest));
  });
});
