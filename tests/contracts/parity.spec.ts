import * as fs from 'fs';
import * as path from 'path';
import { validateCapabilityRecord } from '../../src/contracts';
import {
  OMA_MCP_OPERATIONS_V1,
  PARITY_CLASSIFICATIONS_V1,
  loadParityInventory,
  validateParityInventory,
} from '../../scripts/check-parity';

describe('OMA W0 parity inventory', () => {
  test('exact classifications, six MCP operations, zero semantic LSP, and workflow tiers pass', () => {
    const inventory = loadParityInventory();
    expect(() => validateParityInventory(inventory)).not.toThrow();
    expect(PARITY_CLASSIFICATIONS_V1).toHaveLength(5);
    expect(OMA_MCP_OPERATIONS_V1).toEqual([
      'run_status.read', 'recovery_manifest.read', 'wiki.search',
      'team_status.read', 'mailbox.list', 'proposal.create',
    ]);
    expect(inventory.semantic_lsp_operation_count).toBe(0);
    expect(inventory.operations.find((row) => row.canonical_name === 'antigravity-native-subagent'))
      .toEqual(expect.objectContaining({ classification: 'optional_unclaimed' }));
  });

  test('count, classification, and native workflow false-claim mutations fail', () => {
    const inventory = loadParityInventory();
    expect(() => validateParityInventory({ ...inventory, mcp_operations: inventory.mcp_operations.slice(1) }))
      .toThrow('MCP');
    expect(() => validateParityInventory({
      ...inventory,
      operations: [{ ...inventory.operations[0], classification: 'configured_means_verified' }],
    })).toThrow('classification');
    expect(() => validateParityInventory({
      ...inventory,
      workflow_contract: { ...inventory.workflow_contract, antigravity_saved_prompt_ceiling: 'T5' },
    })).toThrow('Workflow');
  });

  test('capability fixture records every truth tier and redacted diagnostics', () => {
    const record = JSON.parse(fs.readFileSync(path.join(
      __dirname, '..', 'fixtures', 'capabilities', 'independent-tiers.json',
    ), 'utf8'));
    expect(validateCapabilityRecord(record)).toEqual(expect.objectContaining({
      configured: true, installed: false, observed: false, healthy: false, verified: false,
    }));
  });
});
