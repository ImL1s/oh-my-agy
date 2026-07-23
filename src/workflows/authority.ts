import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { canonicalBytesV1 } from '../contracts/state-schemas';
import { sha256Hex } from '../contracts/writer-chain';
import { resolveCanonicalAgyIdentity } from '../native/antigravity-status';
import {
  WorkflowDispatchInputV1,
  WorkflowProductAuthorityV1,
  WorkflowTaskReceiptV1,
} from './schema';

interface ProductWorkflowVerdictV1 {
  decision: WorkflowProductAuthorityV1['verdict']['decision'];
  findings: WorkflowProductAuthorityV1['verdict']['findings'];
}

export function workflowAuthorityDigest(
  authority: Omit<WorkflowProductAuthorityV1, 'authority_digest' | 'authority_mac'>,
): string {
  return sha256Hex(canonicalBytesV1(authority));
}

export function assertRepositoryExternalAuthorityRoot(
  stateRootInput: string,
  repositoryRootInput: string,
): void {
  const stateRoot = fs.realpathSync(path.resolve(stateRootInput));
  const repositoryRoot = fs.realpathSync(path.resolve(repositoryRootInput));
  const relative = path.relative(repositoryRoot, stateRoot);
  if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..')) {
    throw new Error('workflow authority state root must be repository-external');
  }
}

function workflowAuthorityKey(stateRootInput: string, create: boolean): Buffer {
  const stateRoot = path.resolve(stateRootInput);
  const target = path.join(stateRoot, 'trust', 'workflow-v1.key');
  const trustDirectory = path.dirname(target);
  assertOwnerOnlyDirectory(stateRoot);
  if (!fs.existsSync(trustDirectory)) {
    if (!create) throw new Error('workflow authority trust root is missing');
    fs.mkdirSync(trustDirectory, { mode: 0o700 });
  }
  assertOwnerOnlyDirectory(trustDirectory);
  if (!fs.existsSync(target)) {
    if (!create) throw new Error('workflow authority key is missing');
    const descriptor = fs.openSync(target, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, crypto.randomBytes(32)); fs.fsyncSync(descriptor); }
    finally { fs.closeSync(descriptor); }
  }
  const key = readOwnerOnlyRegular(target, 32);
  if (key.length !== 32) throw new Error('workflow authority trust root is unsafe');
  return key;
}

export function validateWorkflowProductAuthority(input: {
  authority: WorkflowProductAuthorityV1 | undefined;
  candidate_oid?: string;
  definition_digest: string;
  plan_digest: string;
  envelope_digest: string;
  task_id: string;
  stage_id: string;
  stage_kind: WorkflowDispatchInputV1['stage']['kind'];
  attempt: number;
  generation: number;
  receipt?: WorkflowTaskReceiptV1;
  authority_state_root?: string;
  repository_root?: string;
}): boolean {
  const value = input.authority;
  if (value === undefined || value.authority_kind !== 'oma_product_executor_v1'
    || !path.isAbsolute(value.agy_executable_realpath)
    || !/^[a-f0-9]{64}$/u.test(value.agy_executable_sha256)
    || !Number.isSafeInteger(value.agy_executable_byte_length)
    || value.agy_executable_byte_length <= 0
    || !/^[a-f0-9]{40,64}$/u.test(value.candidate_oid)
    || (input.candidate_oid !== undefined && value.candidate_oid !== input.candidate_oid)
    || value.definition_digest !== input.definition_digest
    || value.plan_digest !== input.plan_digest || value.envelope_digest !== input.envelope_digest
    || value.task_id !== input.task_id || value.stage_id !== input.stage_id
    || value.attempt !== input.attempt || value.generation !== input.generation
    || !['passed', 'failed'].includes(value.decision_status)
    || !validVerdict(value.verdict)
    || (value.result_hash !== null && !/^[a-f0-9]{64}$/u.test(value.result_hash))
    || (value.approval !== null && typeof value.approval !== 'boolean')
    || (value.ship_proof_digest !== null && !/^[a-f0-9]{64}$/u.test(value.ship_proof_digest))
    || !validProcess(value.launch) || !Array.isArray(value.verifications)
    || value.verifications.some((entry) => !validProcess(entry)
      || !Number.isSafeInteger(entry.exit_code)
      || !/^[a-f0-9]{64}$/u.test(entry.stdout_sha256)
      || !/^[a-f0-9]{64}$/u.test(entry.stderr_sha256)
      || typeof entry.stdout_path !== 'string' || typeof entry.stderr_path !== 'string')
    || !Array.isArray(value.artifacts)
    || value.artifacts.some((entry) => typeof entry !== 'object' || entry === null
      || typeof entry.path !== 'string' || entry.path === '' || entry.path.startsWith('/')
      || entry.path.includes('..') || !Number.isSafeInteger(entry.byte_length) || entry.byte_length < 0
      || !/^[a-f0-9]{64}$/u.test(entry.sha256))) return false;
  const identities = [value.launch, ...value.verifications].map((entry) => `${entry.pid}:${entry.start_marker}`);
  if (new Set(identities).size !== identities.length) return false;
  if (input.authority_state_root === undefined || input.repository_root === undefined) return false;
  const expectedPositive = positiveVerdict(input.stage_kind, value.verdict);
  const expectedStatus = decisionStatus(input.stage_kind, value.verdict);
  const expectedResultHash = expectedStatus === 'passed'
    ? sha256Hex(canonicalBytesV1({ artifacts: value.artifacts, verdict: value.verdict })) : null;
  const expectedApproval = input.stage_kind === 'skeptic' || input.stage_kind === 'verifier'
    ? expectedPositive : null;
  const expectedShipProof = input.stage_kind === 'ship_gate' && expectedPositive
    && expectedResultHash !== null
    ? sha256Hex(canonicalBytesV1([
      'oma-product-ship', value.candidate_oid, value.plan_digest, expectedResultHash,
    ])) : null;
  if (value.decision_status !== expectedStatus || value.result_hash !== expectedResultHash
    || value.approval !== expectedApproval || value.ship_proof_digest !== expectedShipProof) return false;
  if (input.receipt !== undefined && (input.receipt.status !== value.decision_status
    || input.receipt.result_hash !== value.result_hash || input.receipt.approval !== value.approval
    || input.receipt.ship_proof_digest !== value.ship_proof_digest)) return false;
  try {
    assertRepositoryExternalAuthorityRoot(input.authority_state_root, input.repository_root);
    const agy = resolveCanonicalAgyIdentity();
    if (value.agy_executable_realpath !== agy.realpath
      || value.agy_executable_sha256 !== agy.sha256
      || value.agy_executable_byte_length !== agy.byte_length
      || value.launch.argv[0] !== agy.realpath) return false;
    for (const artifact of value.artifacts) {
      const bytes = readOwnerOnlyRegular(confinedPath(input.repository_root, artifact.path), 524_288);
      if (bytes.length !== artifact.byte_length || sha256Hex(bytes) !== artifact.sha256) return false;
    }
    for (const verification of value.verifications) {
      const stdout = readOwnerOnlyRegular(confinedPath(input.repository_root, verification.stdout_path), 1_048_576);
      const stderr = readOwnerOnlyRegular(confinedPath(input.repository_root, verification.stderr_path), 1_048_576);
      if (sha256Hex(stdout) !== verification.stdout_sha256
        || sha256Hex(stderr) !== verification.stderr_sha256) return false;
    }
  } catch { return false; }
  const { authority_digest: ignored, authority_mac: ignoredMac, ...material } = value;
  void ignored;
  void ignoredMac;
  const digest = workflowAuthorityDigest(material);
  let authorityKey: Buffer;
  try { authorityKey = workflowAuthorityKey(input.authority_state_root, false); }
  catch { return false; }
  const expectedMac = crypto.createHmac('sha256', authorityKey)
    .update(canonicalBytesV1({ ...material, authority_digest: digest })).digest('hex');
  return value.authority_digest === digest
    && /^[a-f0-9]{64}$/u.test(value.authority_mac)
    && crypto.timingSafeEqual(Buffer.from(value.authority_mac, 'hex'), Buffer.from(expectedMac, 'hex'));
}

function assertOwnerOnlyDirectory(target: string): void {
  if (!fs.existsSync(target)) throw new Error('workflow authority parent state root is missing');
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('workflow authority directory chain is unsafe');
  }
}
function confinedPath(root: string, relative: string): string { const absoluteRoot = path.resolve(root); const target = path.resolve(absoluteRoot, relative);
  if (target === absoluteRoot || !target.startsWith(`${absoluteRoot}${path.sep}`)) throw new Error('path escape'); return target; }
function readOwnerOnlyRegular(target: string, max: number): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > max) {
      throw new Error('unsafe artifact');
    }
    const bytes = fs.readFileSync(descriptor);
    const finalStat = fs.fstatSync(descriptor);
    if (finalStat.dev !== stat.dev || finalStat.ino !== stat.ino || finalStat.size !== bytes.length) {
      throw new Error('artifact changed during read');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
function plainObject(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null); }
function validProcess(value: { pid:number; start_marker:string; operation_id:string; argv:string[]; argv_sha256:string }): boolean {
  return Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.start_marker === 'string' && value.start_marker.length > 0
    && typeof value.operation_id === 'string' && value.operation_id.length > 0 && Array.isArray(value.argv) && value.argv.length > 0
    && value.argv.every((entry) => typeof entry === 'string' && entry.length > 0 && !entry.includes('\0'))
    && value.argv_sha256 === sha256Hex(canonicalBytesV1(value.argv)); }

function validVerdict(value: unknown): value is ProductWorkflowVerdictV1 {
  return plainObject(value) && exactKeys(value, ['decision', 'findings'])
    && ['pass', 'approve', 'ship', 'reject', 'no_ship', 'failed'].includes(String(value.decision))
    && Array.isArray(value.findings) && value.findings.length <= 128
    && value.findings.every((finding) => plainObject(finding)
      && exactKeys(finding, ['code', 'severity', 'message'])
      && typeof finding.code === 'string' && /^[A-Z][A-Z0-9_.-]{0,63}$/u.test(finding.code)
      && ['info', 'warning', 'error'].includes(String(finding.severity))
      && typeof finding.message === 'string' && finding.message.length > 0
      && Buffer.byteLength(finding.message, 'utf8') <= 4096);
}

function positiveVerdict(
  kind: WorkflowDispatchInputV1['stage']['kind'],
  verdict: ProductWorkflowVerdictV1,
): boolean {
  if (verdict.findings.some((finding) => finding.severity === 'error')) return false;
  const decision = verdict.decision;
  return (kind === 'author' || kind === 'check') ? decision === 'pass'
    : kind === 'skeptic' ? decision === 'approve'
      : kind === 'verifier' ? decision === 'pass'
        : kind === 'ship_gate' && decision === 'ship';
}

function decisionStatus(
  kind: WorkflowDispatchInputV1['stage']['kind'],
  verdict: ProductWorkflowVerdictV1,
): 'passed' | 'failed' {
  const decision = verdict.decision;
  if (positiveVerdict(kind, verdict)) return 'passed';
  if ((kind === 'skeptic' || kind === 'verifier' || kind === 'ship_gate')
    && (decision === 'reject' || decision === 'no_ship')) return 'passed';
  return 'failed';
}

export function workflowVerdictOutputSchema(
  kind: WorkflowDispatchInputV1['stage']['kind'],
): Readonly<Record<string, unknown>> {
  const positive = kind === 'skeptic' ? 'approve'
    : kind === 'ship_gate' ? 'ship' : 'pass';
  return {
    type: 'object',
    additionalProperties: false,
    required: ['verdict'],
    properties: {
      verdict: {
        type: 'object',
        additionalProperties: false,
        required: ['decision', 'findings'],
        properties: {
          decision: {
            type: 'string',
            enum: [positive, 'reject', 'no_ship', 'failed'],
          },
          findings: {
            type: 'array',
            maxItems: 128,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['code', 'severity', 'message'],
              properties: {
                code: { type: 'string', pattern: '^[A-Z][A-Z0-9_.-]{0,63}$' },
                severity: { type: 'string', enum: ['info', 'warning', 'error'] },
                message: { type: 'string', minLength: 1, maxLength: 4096 },
              },
            },
          },
        },
      },
    },
  };
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((entry, index) => entry === wanted[index]);
}
