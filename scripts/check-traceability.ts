import * as fs from 'fs';
import * as path from 'path';
import { canonicalJsonV1 } from '../src/contracts';

export const REQUIREMENT_ID_SET_V1 = [
  'DUAL-001',
  'DUAL-002',
  'DUAL-003',
  'LAUNCH-001',
  'LSP-001',
  'MCP-001',
  'OMA-AUTH-001',
  'OMA-G007-001',
  'OMA-HOOK-001',
  'OMA-IDENTITY-001',
  'OMA-INSTALL-001',
  'OMA-LSP-001',
  'OMA-MCP-001',
  'OMA-MEM-001',
  'OMA-NOTIFY-001',
  'OMA-SESSION-001',
  'OMA-TEAM-001',
  'OMG-EXT-001',
  'OMG-HOOK-001',
  'OMG-HOOK-002',
  'OMG-INSTALL-001',
  'OMG-LSP-001',
  'OMG-MCP-001',
  'OMG-MEM-001',
  'OMG-NOTIFY-001',
  'OMG-SESSION-001',
  'OMG-SPAWN-001',
  'OMG-TEAM-001',
  'OWN-001',
  'OWN-002',
  'OWN-003',
  'RELEASE-001',
  'RELEASE-002',
  'RESUME-001',
  'RESUME-002',
  'RESUME-003',
  'REVIEW-001',
  'TRACK-001',
  'TRUTH-001',
  'TRUTH-002',
  'WORKFLOW-001',
] as const;

export interface TraceabilityRowV1 {
  requirement_id: string;
  claim_status: string;
  implementation_paths: string[];
  test_paths: string[];
  live_evidence_required: boolean;
}

export interface TraceabilityV1 {
  store_kind: 'oma_traceability';
  schema_version: 1;
  repository_id: 'OMA';
  ownership_manifest: 'dual-parity-writers-v1';
  requirement_ids: string[];
  rows: TraceabilityRowV1[];
}

export function loadTraceability(
  traceabilityPath = path.resolve('docs/parity/oma-traceability.json'),
): TraceabilityV1 {
  return JSON.parse(fs.readFileSync(traceabilityPath, 'utf8')) as TraceabilityV1;
}

export function validateTraceability(traceability: TraceabilityV1, repositoryRoot = process.cwd()): void {
  if (traceability.store_kind !== 'oma_traceability' || traceability.schema_version !== 1
    || traceability.repository_id !== 'OMA' || traceability.ownership_manifest !== 'dual-parity-writers-v1') {
    throw new Error('OMA traceability identity is invalid');
  }
  if (JSON.stringify(traceability.requirement_ids) !== JSON.stringify(REQUIREMENT_ID_SET_V1)) {
    throw new Error('Requirement ID set/order drifted');
  }
  const rowIds = traceability.rows.map((row) => row.requirement_id);
  if (rowIds.length !== REQUIREMENT_ID_SET_V1.length || new Set(rowIds).size !== rowIds.length
    || JSON.stringify(rowIds) !== JSON.stringify(REQUIREMENT_ID_SET_V1)) {
    throw new Error('Traceability rows must cover each frozen requirement exactly once and in order');
  }
  for (const row of traceability.rows) {
    if (typeof row.live_evidence_required !== 'boolean') {
      throw new Error(`${row.requirement_id} does not record its live evidence boundary`);
    }
    if (['contract_implemented', 'partial_unverified'].includes(row.claim_status)
      && (row.implementation_paths.length === 0 || row.test_paths.length === 0)) {
      throw new Error(`${row.requirement_id} lacks owned implementation or test evidence`);
    }
    for (const relativePath of [...row.implementation_paths, ...row.test_paths]) {
      const resolved = path.resolve(repositoryRoot, relativePath);
      if (resolved !== repositoryRoot && !resolved.startsWith(`${path.resolve(repositoryRoot)}${path.sep}`)) {
        throw new Error(`${row.requirement_id} traceability path escapes the repository`);
      }
      if (['contract_implemented', 'partial_unverified'].includes(row.claim_status)
        && !fs.existsSync(resolved)) {
        throw new Error(`${row.requirement_id} references missing contract evidence: ${relativePath}`);
      }
    }
  }
}

if (require.main === module) {
  try {
    const traceability = loadTraceability();
    validateTraceability(traceability);
    process.stdout.write(`${canonicalJsonV1({
      ok: true,
      requirement_count: traceability.requirement_ids.length,
      row_count: traceability.rows.length,
    })}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
