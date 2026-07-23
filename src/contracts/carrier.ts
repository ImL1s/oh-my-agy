import * as path from 'path';
import { ContractViolation, assertNonEmptyString } from './state-schemas';

export const OMX_ROLE_INTENT_TOKEN_PATTERN = /^[0-9a-f]{32}$/;
export const OMX_ROLE_INTENT_TASK_PATTERN = /^omx_role_intent_([0-9a-f]{32})$/;
export const OMX_ROLE_INTENT_PATH_PATTERN = /^\/root\/omx_role_intent_([0-9a-f]{32})$/;

export interface ImportedCarrierV1 {
  agent_role?: string | null;
  agent_type?: string | null;
  task_name?: string | null;
  agent_path?: string | null;
}

export interface ImportedProvenanceReceiptV1 {
  store_kind: 'imported_provenance_receipt';
  schema_version: 1;
  token: string;
  role: string;
  parent_id: string;
  cwd_hash: string;
  run_id: string;
  session_id: string;
  child_id: string;
  expires_at_ms: number;
  consumed: boolean;
}

export interface ImportedCarrierContextV1 {
  purpose: 'imported_evidence';
  now_ms: number;
  expected_parent_id: string;
  expected_cwd_hash: string;
  expected_run_id: string;
  expected_session_id: string;
  expected_child_id: string;
  replay_tokens: ReadonlySet<string>;
}

export interface ParsedImportedCarrierV1 {
  source: 'typed' | 'task_name' | 'agent_path';
  role: string;
  token: string;
  native_authority: false;
  imported_only: true;
}

function tokenFromTaskName(value: string): string {
  const match = OMX_ROLE_INTENT_TASK_PATTERN.exec(value);
  if (match === null) {
    throw new ContractViolation('E_CARRIER_INVALID', 'task_name is not an exact adapted role-intent carrier');
  }
  return match[1];
}

function tokenFromAgentPath(value: string): string {
  if (path.posix.normalize(value) !== value) {
    throw new ContractViolation('E_CARRIER_INVALID', 'agent_path is not normalized');
  }
  const match = OMX_ROLE_INTENT_PATH_PATTERN.exec(value);
  if (match === null) {
    throw new ContractViolation('E_CARRIER_INVALID', 'agent_path is not the exact Codex 0.144.6 carrier');
  }
  return match[1];
}

export function parseImportedCarrier(
  carrier: Readonly<ImportedCarrierV1>,
  receipt: Readonly<ImportedProvenanceReceiptV1>,
  context: Readonly<ImportedCarrierContextV1>,
): ParsedImportedCarrierV1 {
  if (context.purpose !== 'imported_evidence') {
    throw new ContractViolation('E_CARRIER_AUTHORITY', 'Imported carriers cannot authorize native workers');
  }
  if (receipt.store_kind !== 'imported_provenance_receipt' || receipt.schema_version !== 1
    || !OMX_ROLE_INTENT_TOKEN_PATTERN.test(receipt.token)) {
    throw new ContractViolation('E_CARRIER_INVALID', 'Imported provenance receipt is invalid');
  }
  assertNonEmptyString(receipt.role, 'receipt.role');
  if (receipt.consumed || context.replay_tokens.has(receipt.token)) {
    throw new ContractViolation('E_CARRIER_REPLAY', 'Imported carrier token was already consumed');
  }
  if (receipt.expires_at_ms < context.now_ms) {
    throw new ContractViolation('E_CARRIER_EXPIRED', 'Imported carrier receipt expired');
  }
  const bindings: Array<[string, string, string]> = [
    ['parent_id', receipt.parent_id, context.expected_parent_id],
    ['cwd_hash', receipt.cwd_hash, context.expected_cwd_hash],
    ['run_id', receipt.run_id, context.expected_run_id],
    ['session_id', receipt.session_id, context.expected_session_id],
    ['child_id', receipt.child_id, context.expected_child_id],
  ];
  for (const [label, actual, expected] of bindings) {
    if (actual !== expected) {
      throw new ContractViolation('E_CARRIER_BINDING', `Imported carrier ${label} does not match`);
    }
  }

  const typed = [carrier.agent_role, carrier.agent_type]
    .filter((value): value is string => typeof value === 'string' && value !== '');
  if (typed.length === 2 && typed[0] !== typed[1]) {
    throw new ContractViolation('E_CARRIER_DISAGREEMENT', 'agent_role and agent_type disagree');
  }
  if (typed.length > 0 && typed[0] !== receipt.role) {
    throw new ContractViolation('E_CARRIER_DISAGREEMENT', 'Typed role disagrees with the receipt');
  }
  const taskToken = typeof carrier.task_name === 'string'
    ? tokenFromTaskName(carrier.task_name)
    : null;
  const pathToken = typeof carrier.agent_path === 'string'
    ? tokenFromAgentPath(carrier.agent_path)
    : null;
  for (const candidate of [taskToken, pathToken]) {
    if (candidate !== null && candidate !== receipt.token) {
      throw new ContractViolation('E_CARRIER_DISAGREEMENT', 'Carrier token disagrees with the receipt');
    }
  }
  if (taskToken !== null && pathToken !== null && taskToken !== pathToken) {
    throw new ContractViolation('E_CARRIER_DISAGREEMENT', 'task_name and agent_path disagree');
  }
  if (typed.length === 0 && taskToken === null && pathToken === null) {
    throw new ContractViolation('E_CARRIER_INVALID', 'No recognized imported carrier is present');
  }
  return {
    source: typed.length > 0 ? 'typed' : taskToken !== null ? 'task_name' : 'agent_path',
    role: receipt.role,
    token: receipt.token,
    native_authority: false,
    imported_only: true,
  };
}

export interface AntigravityNativeReceiptV1 {
  store_kind: 'antigravity_native_receipt';
  schema_version: 1;
  provider: 'antigravity_native' | 'agy_headless' | 'tmux_agy';
  run_id: string;
  parent_conversation_id: string;
  child_conversation_id: string;
  task_id: string;
  generation: number;
  receipt_hash: string;
}

export function validateAntigravityNativeReceipt(value: AntigravityNativeReceiptV1): void {
  if (value.store_kind !== 'antigravity_native_receipt' || value.schema_version !== 1
    || !['antigravity_native', 'agy_headless', 'tmux_agy'].includes(value.provider)
    || !Number.isInteger(value.generation) || value.generation <= 0) {
    throw new ContractViolation('E_NATIVE_RECEIPT', 'Antigravity native receipt is invalid');
  }
  for (const [label, candidate] of [
    ['run_id', value.run_id],
    ['parent_conversation_id', value.parent_conversation_id],
    ['child_conversation_id', value.child_conversation_id],
    ['task_id', value.task_id],
  ] as const) assertNonEmptyString(candidate, label);
  if (!/^[0-9a-f]{64}$/.test(value.receipt_hash)) {
    throw new ContractViolation('E_NATIVE_RECEIPT', 'Native receipt hash is invalid');
  }
}
