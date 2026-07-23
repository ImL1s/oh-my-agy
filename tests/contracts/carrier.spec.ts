import * as fs from 'fs';
import * as path from 'path';
import {
  ImportedProvenanceReceiptV1,
  parseImportedCarrier,
  validateAntigravityNativeReceipt,
} from '../../src/contracts/carrier';

const fixture = (name: string): any => JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'fixtures', 'carrier', name), 'utf8',
));

function context(receipt: ImportedProvenanceReceiptV1) {
  return {
    purpose: 'imported_evidence' as const,
    now_ms: 1000,
    expected_parent_id: receipt.parent_id,
    expected_cwd_hash: receipt.cwd_hash,
    expected_run_id: receipt.run_id,
    expected_session_id: receipt.session_id,
    expected_child_id: receipt.child_id,
    replay_tokens: new Set<string>(),
  };
}

describe('OMA W0 imported-carrier and Antigravity receipt boundary', () => {
  test('typed/task/path agreement uses typed precedence and remains imported-only', () => {
    const data = fixture('valid-all-carriers.json');
    expect(parseImportedCarrier(data.carrier, data.receipt, context(data.receipt))).toEqual({
      source: 'typed', role: 'architect', token: data.receipt.token,
      native_authority: false, imported_only: true,
    });
  });

  test('Codex 0.144.6 exact agent_path is accepted only as declared imported evidence', () => {
    const data = fixture('codex-0.144.6-agent-path-only.json');
    expect(parseImportedCarrier(data.carrier, data.receipt, context(data.receipt))).toEqual(
      expect.objectContaining({ source: 'agent_path', role: 'critic', native_authority: false }),
    );
    expect(() => parseImportedCarrier(
      data.carrier, data.receipt, { ...context(data.receipt), purpose: 'native_launch' } as any,
    )).toThrow('cannot authorize');
  });

  test('disagreement, uppercase/suffix/traversal/foreign root, expiry, replay and binding drift fail closed', () => {
    const valid = fixture('valid-all-carriers.json');
    const disagreement = fixture('invalid-disagreement.json');
    expect(() => parseImportedCarrier(disagreement.carrier, valid.receipt, context(valid.receipt)))
      .toThrow('disagree');
    for (const agentPath of fixture('invalid-agent-paths.json').values) {
      expect(() => parseImportedCarrier(
        { agent_path: agentPath }, valid.receipt, context(valid.receipt),
      )).toThrow();
    }
    expect(() => parseImportedCarrier(
      valid.carrier, { ...valid.receipt, expires_at_ms: 999 }, context(valid.receipt),
    )).toThrow('expired');
    expect(() => parseImportedCarrier(
      valid.carrier, valid.receipt, { ...context(valid.receipt), replay_tokens: new Set([valid.receipt.token]) },
    )).toThrow('consumed');
    expect(() => parseImportedCarrier(
      valid.carrier, valid.receipt, { ...context(valid.receipt), expected_parent_id: 'foreign' },
    )).toThrow('parent_id');
  });

  test('Antigravity typed receipt is separate native identity truth', () => {
    const receipt = {
      store_kind: 'antigravity_native_receipt', schema_version: 1, provider: 'antigravity_native',
      run_id: 'run', parent_conversation_id: 'parent', child_conversation_id: 'child', task_id: 'task',
      generation: 2, receipt_hash: 'a'.repeat(64),
    } as const;
    expect(() => validateAntigravityNativeReceipt(receipt)).not.toThrow();
    expect(() => validateAntigravityNativeReceipt({ ...receipt, provider: 'codex' } as any)).toThrow();
  });
});
