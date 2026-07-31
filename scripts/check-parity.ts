import * as fs from 'fs';
import * as path from 'path';
import {
  CAPABILITY_TIERS,
  WORKFLOW_CAPABILITY_TIERS_V1,
  WORKFLOW_TERMINALS_V1,
  canonicalJsonV1,
} from '../src/contracts';

export const PARITY_CLASSIFICATIONS_V1 = [
  'faithful',
  'native_substitute',
  'host_owned',
  'host_impossible',
  'optional_unclaimed',
] as const;

export const OMA_MCP_OPERATIONS_V1 = [
  'run_status.read',
  'recovery_manifest.read',
  'wiki.search',
  'team_status.read',
  'mailbox.list',
  'proposal.create',
] as const;

export interface ParityInventoryV1 {
  store_kind: 'oma_parity_inventory';
  schema_version: 1;
  repository_id: 'OMA';
  ownership_manifest: 'dual-parity-writers-v1';
  classifications: string[];
  capability_tiers: string[];
  mcp_operations: string[];
  semantic_lsp_operation_count: number;
  operations: Array<{
    canonical_name: string;
    classification: string;
    claim_status: string;
    maximum_tier: string;
  }>;
  native_capability_contract: {
    schema: string;
    outcomes: string[];
    routing_authority: string;
    passive_commands: string[];
    live_command: string;
    live_evidence_required: boolean;
  };
  workflow_contract: {
    contract: string;
    terminals: string[];
    tiers: Record<string, string>;
    antigravity_saved_prompt_ceiling: string;
    antigravity_native_team: string;
  };
}

function exactArray(actual: readonly unknown[], expected: readonly unknown[], label: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} drifted from the frozen oracle`);
  }
}

export function loadParityInventory(
  inventoryPath = path.resolve('docs/parity/oma-parity.json'),
): ParityInventoryV1 {
  return JSON.parse(fs.readFileSync(inventoryPath, 'utf8')) as ParityInventoryV1;
}

export function validateParityInventory(inventory: ParityInventoryV1): void {
  if (inventory.store_kind !== 'oma_parity_inventory' || inventory.schema_version !== 1
    || inventory.repository_id !== 'OMA' || inventory.ownership_manifest !== 'dual-parity-writers-v1') {
    throw new Error('OMA parity inventory identity is invalid');
  }
  exactArray(inventory.classifications, PARITY_CLASSIFICATIONS_V1, 'classifications');
  exactArray(inventory.capability_tiers, CAPABILITY_TIERS, 'capability tiers');
  exactArray(inventory.mcp_operations, OMA_MCP_OPERATIONS_V1, 'OMA MCP operations');
  if (new Set(inventory.mcp_operations).size !== 6 || inventory.semantic_lsp_operation_count !== 0) {
    throw new Error('OMA MCP/LSP count contract is invalid');
  }
  for (const operation of inventory.operations) {
    if (!PARITY_CLASSIFICATIONS_V1.includes(operation.classification as typeof PARITY_CLASSIFICATIONS_V1[number])) {
      throw new Error(`Unknown parity classification: ${operation.classification}`);
    }
    if (operation.claim_status === 'optional_unclaimed' && operation.maximum_tier === 'verified') {
      throw new Error(`Optional-unclaimed operation cannot claim verified: ${operation.canonical_name}`);
    }
  }
  const nativeContract = inventory.native_capability_contract;
  if (nativeContract.schema !== 'oma.host-capability-profile/v1'
    || nativeContract.routing_authority !== 'profile_and_router_only'
    || nativeContract.live_command !== 'oma native probe --live'
    || nativeContract.live_evidence_required !== true) {
    throw new Error('Native capability contract identity drifted');
  }
  exactArray(nativeContract.outcomes, ['supported', 'unsupported', 'unknown'], 'native capability outcomes');
  exactArray(nativeContract.passive_commands, [
    'oma native capabilities',
    'oma doctor --native',
  ], 'native passive commands');
  if (inventory.workflow_contract.contract !== 'repository-workflow/v1') {
    throw new Error('Repository workflow contract identity drifted');
  }
  exactArray(inventory.workflow_contract.terminals, WORKFLOW_TERMINALS_V1, 'workflow terminals');
  if (JSON.stringify(inventory.workflow_contract.tiers) !== JSON.stringify(WORKFLOW_CAPABILITY_TIERS_V1)
    || inventory.workflow_contract.antigravity_saved_prompt_ceiling !== 'T1'
    || inventory.workflow_contract.antigravity_native_team !== 'optional_unclaimed') {
    throw new Error('Workflow tier/native claim oracle drifted');
  }
}

if (require.main === module) {
  try {
    const inventory = loadParityInventory();
    validateParityInventory(inventory);
    process.stdout.write(`${canonicalJsonV1({
      ok: true,
      mcp_operation_count: inventory.mcp_operations.length,
      semantic_lsp_operation_count: inventory.semantic_lsp_operation_count,
      operation_count: inventory.operations.length,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
