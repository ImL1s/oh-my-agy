import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalBytesV1 } from '../contracts/state-schemas';
import { RepositoryWorkflowV1, validateRepositoryWorkflow } from '../contracts/repository-workflow';
import { sha256Hex } from '../contracts/writer-chain';
import { MCP_OPERATION_NAMES_V1 } from '../mcp/operations';
import { OMA_MCP_PROTOCOL_VERSION_V1 } from '../mcp/server';
import {
  DISCOVERY_PROOF_ARGV_V1,
  DISCOVERY_PROOF_TOKEN_V1,
  FreshProcessRunnerV1,
  inspectAntigravityPublicStatus,
  inspectFreshPluginDiscovery,
} from '../native/antigravity-status';
import { inspectHostLspStatus } from '../native/lsp-status';
import { resolveStateRoot } from '../runtime/state-root';
import { PluginCommandAdapter, verifyPluginActive } from '../setup/plugin';
import { runDoctor } from '../setup/doctor';
import { readWorkflowJournal, replayWorkflowEvents } from '../workflows/replay';
import { evaluateWorkflowReview } from '../workflows/review';
import { WorkflowPlanV1, WorkflowRunSnapshotV1 } from '../workflows/schema';
import { workflowPlanDigest } from '../workflows/schema';
import { planRepositoryWorkflow } from '../workflows/planner';
import {
  assertRepositoryExternalAuthorityRoot,
} from '../workflows/authority';
import { validateAgy115Help } from '../team/agy-argv';
import { resolveCanonicalAgyIdentity } from '../native/antigravity-status';

export type ProductionEvidenceSeam =
  | 'plugin-discovery'
  | 'managed-lifecycle'
  | 'exact-resume'
  | 'worker-runtime'
  | 'mcp-lsp'
  | 'workflow'
  | 'independent-code-review'
  | 'ultraqa';

export type CoreProductionProbeSeam = 'plugin-discovery' | 'mcp-lsp';
export type ProductionCaptureKind = 'review' | 'ultraqa';

export interface ProductionProbeContext {
  readonly packageRoot: string;
  readonly repositoryRoot: string;
  readonly stateRoot?: string;
  readonly runId: string;
  readonly oid: string;
  readonly agyCommand: string;
  readonly packageVersion: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly pluginAdapter: PluginCommandAdapter;
  readonly freshPluginDiscoveryRunner?: FreshProcessRunnerV1;
}

export interface ProductionProbeResult {
  readonly seam: ProductionEvidenceSeam;
  readonly receiptPath: string;
  readonly artifactPath: string;
  readonly artifactSha256: string;
}

export interface ProductionEvidenceReceiptV1 {
  store_kind: 'oma_production_evidence_receipt';
  schema_version: 1;
  repository_id: 'OMA';
  run_id: string;
  oid: string;
  seam: ProductionEvidenceSeam;
  producer_identity: string;
  tool_identity: string;
  argv: string[];
  exit_code: 0;
  stdout_sha256: string;
  stderr_sha256: string;
  stdout_relative_path: string;
  stderr_relative_path: string;
  artifact_relative_path: string;
  artifact_byte_length: number;
  artifact_sha256: string;
  observed_at: string;
  receipt_hash: string;
}

export interface WriteProductionEvidenceInput {
  readonly context: ProductionProbeContext;
  readonly seam: ProductionEvidenceSeam;
  readonly artifact: Readonly<Record<string, unknown>>;
  readonly producerIdentity: string;
  readonly toolIdentity: string;
  readonly argv: readonly string[];
  readonly stdout: Buffer | string;
  readonly stderr: Buffer | string;
  readonly observedAt?: string;
}

export interface VerifiedProductionEvidence {
  readonly receipt: ProductionEvidenceReceiptV1;
  readonly artifact: Readonly<Record<string, unknown>>;
}

const RECEIPT_KEYS = [
  'store_kind', 'schema_version', 'repository_id', 'run_id', 'oid', 'seam',
  'producer_identity', 'tool_identity', 'argv', 'exit_code', 'stdout_sha256',
  'stderr_sha256', 'stdout_relative_path', 'stderr_relative_path',
  'artifact_relative_path', 'artifact_byte_length', 'artifact_sha256',
  'observed_at', 'receipt_hash',
] as const;

const CANONICAL_ARGV: Readonly<Record<ProductionEvidenceSeam, readonly string[] | null>> = {
  'plugin-discovery': ['oma', 'production', 'probe', 'plugin-discovery'],
  'managed-lifecycle': ['oma', 'production', 'probe', 'managed-lifecycle'],
  'exact-resume': ['oma', 'production', 'probe', 'exact-resume'],
  'worker-runtime': ['oma', 'production', 'probe', 'worker-runtime'],
  'mcp-lsp': ['oma', 'production', 'probe', 'mcp-lsp'],
  workflow: ['oma', 'production', 'probe', 'workflow'],
  'independent-code-review': null,
  ultraqa: null,
};

const MAX_EVIDENCE_BYTES = 1_048_576;
const MAX_CAPTURE_BYTES = 4_194_304;
const SAFE_ID = /^[A-Za-z0-9._:@+-]{1,256}$/u;
const SAFE_RUN_ID = /^[A-Za-z0-9._:-]{1,160}$/u;
const OID = /^[a-f0-9]{40,64}$/u;
const ALLOWED_CAPTURE_TOOLS = new Set(['codex', 'claude', 'grok', 'agy', 'cursor-agent']);
const PLUGIN_DISCOVERY_AUTHORITY = Symbol('product-owned-fresh-plugin-discovery');
const WORKFLOW_PROBE_AUTHORITY = Symbol('product-owned-workflow-probe');

export function productionCandidateOid(repositoryRoot: string): string {
  const result = spawnSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD^{commit}'], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 8_192,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const oid = (result.stdout ?? '').trim();
  if (result.status !== 0 || !OID.test(oid)) {
    throw new Error('production verification requires an exact git commit OID');
  }
  return oid;
}

export function resolveProductionRunId(
  environment: NodeJS.ProcessEnv,
  explicitRunId: string | undefined,
  oid: string,
): string {
  const environmentRunId = environment.OMA_PRODUCTION_RUN_ID?.trim();
  const value = explicitRunId ?? (
    environmentRunId === undefined || environmentRunId === '' ? oid : environmentRunId
  );
  if (!SAFE_RUN_ID.test(value)) throw new Error('invalid production run ID');
  return value;
}

export function resolveProductionStateRoot(input: {
  readonly stateRoot?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly create: boolean;
  readonly homeDirectory?: string;
}): string {
  if (input.stateRoot !== undefined) {
    const target = path.resolve(input.stateRoot);
    if (input.create && !fs.existsSync(target)) fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(target)) return target;
    assertSafeDirectory(target, 0o077);
    return fs.realpathSync(target);
  }
  const resolved = resolveStateRoot({
    env: input.environment,
    homeDirectory: input.homeDirectory ?? os.homedir(),
    create: input.create,
  });
  if (!resolved.ok) throw new Error(`${resolved.error.code}: ${resolved.error.message}`);
  return resolved.value.path;
}

export function productionEvidenceRunRoot(
  stateRoot: string,
  runId: string,
  create = false,
): string {
  if (!SAFE_RUN_ID.test(runId)) throw new Error('invalid production run ID');
  const root = path.resolve(stateRoot);
  if (!fs.existsSync(root)) {
    if (!create) return path.join(root, 'production-evidence', runId);
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  assertSafeDirectory(root, 0o077);
  const realRoot = fs.realpathSync(root);
  let cursor = realRoot;
  for (const segment of ['production-evidence', runId]) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) {
      if (!create) return path.join(realRoot, 'production-evidence', runId);
      fs.mkdirSync(cursor, { mode: 0o700 });
    }
    assertSafeDirectory(cursor, 0o077);
  }
  return fs.realpathSync(cursor);
}

export function writeProductionEvidence(
  input: Readonly<WriteProductionEvidenceInput>,
): ProductionProbeResult {
  return writeProductionEvidenceInternal(input);
}

function writeProductionEvidenceInternal(
  input: Readonly<WriteProductionEvidenceInput>,
  authority?: typeof PLUGIN_DISCOVERY_AUTHORITY | typeof WORKFLOW_PROBE_AUTHORITY,
): ProductionProbeResult {
  const { context, seam } = input;
  if (!SAFE_ID.test(input.producerIdentity) || !SAFE_ID.test(input.toolIdentity)) {
    throw new Error('production producer/tool identity is invalid');
  }
  if (!OID.test(context.oid) || !SAFE_RUN_ID.test(context.runId)) {
    throw new Error('production evidence identity is invalid');
  }
  const observedAt = input.observedAt ?? new Date().toISOString();
  if (!freshTimestamp(observedAt)) throw new Error('production evidence timestamp is not fresh');
  const artifact = {
    ...input.artifact,
    schema_version: 1,
    repository_id: 'OMA',
    run_id: context.runId,
    oid: context.oid,
    observed_at: observedAt,
    seam,
  };
  if (seam === 'plugin-discovery'
    && (artifact as Readonly<Record<string, unknown>>).fresh_session_discovery === 'observed'
    && authority !== PLUGIN_DISCOVERY_AUTHORITY) {
    throw new Error('observed plugin discovery requires product-owned fresh-process authority');
  }
  if (seam === 'workflow' && authority !== WORKFLOW_PROBE_AUTHORITY) {
    throw new Error('workflow evidence requires product-owned probe authority');
  }
  if (!artifactValidator(seam)(artifact)) {
    throw new Error(`production ${seam} artifact is not product-valid`);
  }
  const artifactBytes = canonicalBytesV1(artifact);
  if (artifactBytes.length > MAX_EVIDENCE_BYTES) throw new Error('production artifact exceeds byte bound');
  const stdout = Buffer.isBuffer(input.stdout) ? input.stdout : Buffer.from(input.stdout, 'utf8');
  const stderr = Buffer.isBuffer(input.stderr) ? input.stderr : Buffer.from(input.stderr, 'utf8');
  if (stdout.length > MAX_CAPTURE_BYTES || stderr.length > MAX_CAPTURE_BYTES) {
    throw new Error('production transcript exceeds byte bound');
  }
  const root = productionEvidenceRunRoot(context.stateRoot
    ?? resolveProductionStateRoot({ environment: context.environment, create: true }), context.runId, true);
  const artifactRelativePath = `artifacts/${seam}.json`;
  const stdoutRelativePath = `transcripts/${seam}.stdout.txt`;
  const stderrRelativePath = `transcripts/${seam}.stderr.txt`;
  const artifactPath = path.join(root, ...artifactRelativePath.split('/'));
  const stdoutPath = path.join(root, ...stdoutRelativePath.split('/'));
  const stderrPath = path.join(root, ...stderrRelativePath.split('/'));
  writeImmutableFile(artifactPath, artifactBytes);
  writeImmutableFile(stdoutPath, stdout);
  writeImmutableFile(stderrPath, stderr);
  const material = {
    store_kind: 'oma_production_evidence_receipt',
    schema_version: 1,
    repository_id: 'OMA',
    run_id: context.runId,
    oid: context.oid,
    seam,
    producer_identity: input.producerIdentity,
    tool_identity: input.toolIdentity,
    argv: [...input.argv],
    exit_code: 0,
    stdout_sha256: sha256Hex(stdout),
    stderr_sha256: sha256Hex(stderr),
    stdout_relative_path: stdoutRelativePath,
    stderr_relative_path: stderrRelativePath,
    artifact_relative_path: artifactRelativePath,
    artifact_byte_length: artifactBytes.length,
    artifact_sha256: sha256Hex(artifactBytes),
    observed_at: observedAt,
  } as const;
  assertExpectedArgv(seam, material.argv);
  const receipt: ProductionEvidenceReceiptV1 = {
    ...material,
    argv: [...material.argv],
    receipt_hash: sha256Hex(canonicalBytesV1(material)),
  };
  const receiptPath = path.join(root, 'receipts', `${seam}.json`);
  writeImmutableFile(receiptPath, canonicalBytesV1(receipt));
  return { seam, receiptPath, artifactPath, artifactSha256: material.artifact_sha256 };
}

export function verifyProductionEvidence(input: {
  readonly stateRoot: string;
  readonly runId: string;
  readonly oid: string;
  readonly seam: ProductionEvidenceSeam;
  readonly now?: number;
}): VerifiedProductionEvidence | null {
  try {
    const root = productionEvidenceRunRoot(input.stateRoot, input.runId, false);
    const receiptPath = path.join(root, 'receipts', `${input.seam}.json`);
    const receiptBytes = readBoundedRegularFile(receiptPath, MAX_EVIDENCE_BYTES, 0o077);
    const value = JSON.parse(receiptBytes.toString('utf8')) as unknown;
    if (!plainObject(value) || !exactKeys(value, RECEIPT_KEYS)
      || !canonicalBytesV1(value).equals(receiptBytes)) return null;
    const receipt = value as unknown as ProductionEvidenceReceiptV1;
    if (receipt.store_kind !== 'oma_production_evidence_receipt'
      || receipt.schema_version !== 1 || receipt.repository_id !== 'OMA'
      || receipt.run_id !== input.runId || receipt.oid !== input.oid || receipt.seam !== input.seam
      || !SAFE_ID.test(receipt.producer_identity) || !SAFE_ID.test(receipt.tool_identity)
      || receipt.exit_code !== 0 || !freshTimestamp(receipt.observed_at, input.now)) return null;
    assertExpectedArgv(input.seam, receipt.argv);
    const expectedReceiptPath = path.join(root, 'receipts', `${input.seam}.json`);
    if (path.resolve(receiptPath) !== expectedReceiptPath || fs.realpathSync(receiptPath) !== expectedReceiptPath) {
      return null;
    }
    const material = { ...receipt } as Record<string, unknown>;
    delete material.receipt_hash;
    if (receipt.receipt_hash !== sha256Hex(canonicalBytesV1(material))) return null;
    const artifactPath = confinedEvidencePath(root, receipt.artifact_relative_path, `artifacts/${input.seam}.json`);
    const stdoutPath = confinedEvidencePath(root, receipt.stdout_relative_path, `transcripts/${input.seam}.stdout.txt`);
    const stderrPath = confinedEvidencePath(root, receipt.stderr_relative_path, `transcripts/${input.seam}.stderr.txt`);
    const artifactBytes = readBoundedRegularFile(artifactPath, MAX_EVIDENCE_BYTES, 0o077);
    const stdoutBytes = readBoundedRegularFile(stdoutPath, MAX_CAPTURE_BYTES, 0o077);
    const stderrBytes = readBoundedRegularFile(stderrPath, MAX_CAPTURE_BYTES, 0o077);
    if (artifactBytes.length !== receipt.artifact_byte_length
      || sha256Hex(artifactBytes) !== receipt.artifact_sha256
      || sha256Hex(stdoutBytes) !== receipt.stdout_sha256
      || sha256Hex(stderrBytes) !== receipt.stderr_sha256) return null;
    const artifact = JSON.parse(artifactBytes.toString('utf8')) as unknown;
    if (!plainObject(artifact) || !canonicalBytesV1(artifact).equals(artifactBytes)
      || artifact.schema_version !== 1 || artifact.repository_id !== 'OMA'
      || artifact.run_id !== input.runId || artifact.oid !== input.oid
      || artifact.observed_at !== receipt.observed_at || artifact.seam !== input.seam
      || !artifactValidator(input.seam)(artifact)) return null;
    if (input.seam === 'plugin-discovery'
      && (artifact.canary_output_sha256 !== receipt.stdout_sha256
        || artifact.canary_stderr_sha256 !== receipt.stderr_sha256)) return null;
    if ((input.seam === 'independent-code-review' || input.seam === 'ultraqa')
      && artifact.reviewer_identity !== receipt.producer_identity
      || artifact.tool_identity !== undefined && artifact.tool_identity !== receipt.tool_identity) return null;
    return { receipt, artifact };
  } catch {
    return null;
  }
}

export async function runCoreProductionProbe(
  seam: CoreProductionProbeSeam,
  context: Readonly<ProductionProbeContext>,
): Promise<ProductionProbeResult> {
  assertCandidateContext(context);
  if (seam === 'plugin-discovery') return runPluginProbe(context);
  return runMcpLspProbe(context);
}

export interface PreparedWorkflowProductionProbeV1 {
  readonly runId: string;
  readonly oid: string;
  readonly execution: Readonly<{
    definition: RepositoryWorkflowV1;
    plan: WorkflowPlanV1;
    journal_path: string;
    workflow_input: Readonly<Record<string, unknown>>;
    mode: 'production';
  }>;
}

interface PreparedWorkflowProductionProbeInternalV1 {
  readonly context: ProductionProbeContext;
  readonly definitionBytes: Buffer;
  readonly inputBytes: Buffer;
}

const PREPARED_WORKFLOW_PROBES = new WeakMap<
PreparedWorkflowProductionProbeV1,
PreparedWorkflowProductionProbeInternalV1
>();

export async function prepareWorkflowProductionProbeFromCli(
  explicitRunId?: string,
): Promise<PreparedWorkflowProductionProbeV1> {
  for (const name of [
    'OMA_STATE_ROOT',
    'OMA_ANTIGRAVITY_CONFIG_ROOT',
    'ANTIGRAVITY_CONFIG_ROOT',
    'OMA_PRODUCTION_RUN_ID',
  ] as const) {
    if (process.env[name]?.trim()) {
      throw new Error(`workflow production probe rejects custom ${name}`);
    }
  }
  const repositoryRoot = fs.realpathSync(process.cwd());
  const packageRoot = locateInstalledPackageRoot(__dirname);
  const packageJson = JSON.parse(readBoundedRegularFile(
    path.join(packageRoot, 'package.json'), MAX_EVIDENCE_BYTES,
  ).toString('utf8')) as unknown;
  if (!plainObject(packageJson) || packageJson.name !== '@iml1s/oh-my-agy'
    || typeof packageJson.version !== 'string') {
    throw new Error('workflow production probe package identity is invalid');
  }
  const agyIdentity = resolveCanonicalAgyIdentity();
  const agyRealpath = agyIdentity.realpath;
  const versionProbe = spawnSync(agyRealpath, ['--version'], captureOptions(
    process.env, repositoryRoot, 15_000, 262_144,
  ));
  const helpProbe = spawnSync(agyRealpath, ['--help'], captureOptions(
    process.env, repositoryRoot, 15_000, 262_144,
  ));
  const host = validateAgy115Help(
    `${versionProbe.stdout ?? ''}`.trim(),
    `${helpProbe.stdout ?? ''}\n${helpProbe.stderr ?? ''}`,
  );
  if (!host.ok) throw new Error(`${host.error.code}: ${host.error.message}`);
  const pluginAdapter = realAgyPluginAdapter(agyRealpath, process.env, repositoryRoot);
  const active = await verifyPluginActive({
    packageRoot,
    adapter: pluginAdapter,
    homeDir: os.homedir(),
    antigravityConfigRoot: path.join(os.homedir(), '.gemini', 'config'),
  });
  if (!active.ok || active.value.sourceDigest !== active.value.installedDigest
    || active.value.version !== packageJson.version) {
    throw new Error('workflow production probe requires exact installed plugin identity');
  }
  const oid = productionCandidateOid(repositoryRoot);
  const runId = resolveProductionRunId({}, explicitRunId, oid);
  const stateRoot = resolveProductionStateRoot({
    environment: { ...process.env, OMA_STATE_ROOT: undefined },
    create: true,
  });
  const context: ProductionProbeContext = {
    packageRoot,
    repositoryRoot,
    stateRoot,
    runId,
    oid,
    agyCommand: agyRealpath,
    packageVersion: packageJson.version,
    environment: process.env,
    pluginAdapter,
  };
  const definitionPath = path.join(
    packageRoot, 'tests', 'fixtures', 'workflow', 'production-safety-review-v1.json',
  );
  const definitionBytes = readBoundedRegularFile(definitionPath, MAX_EVIDENCE_BYTES, 0o077);
  const definition = parseCanonicalJson(definitionBytes) as unknown as RepositoryWorkflowV1;
  validateRepositoryWorkflow(definition);
  if (definition.name !== 'production-safety-review') {
    throw new Error('workflow probe packaged definition identity drifted');
  }
  const workflowInput = { candidate_commit: oid };
  const inputBytes = canonicalBytesV1(workflowInput);
  const challenge = crypto.randomBytes(16).toString('hex');
  const plan = planRepositoryWorkflow({
    definition,
    run_id: `production-${challenge}`,
    input_digest: sha256Hex(inputBytes),
    generation: 1,
  });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-product-workflow-'));
  const journalPath = path.join(directory, 'journal.jsonl');
  const prepared: PreparedWorkflowProductionProbeV1 = Object.freeze({
    runId,
    oid,
    execution: Object.freeze({
      definition,
      plan,
      journal_path: journalPath,
      workflow_input: Object.freeze(workflowInput),
      mode: 'production' as const,
    }),
  });
  PREPARED_WORKFLOW_PROBES.set(prepared, { context, definitionBytes, inputBytes });
  return prepared;
}

export function recordPreparedWorkflowProductionProbe(
  prepared: PreparedWorkflowProductionProbeV1,
  snapshot: WorkflowRunSnapshotV1,
): ProductionProbeResult {
  const internal = PREPARED_WORKFLOW_PROBES.get(prepared);
  if (internal === undefined) {
    throw new Error('workflow production probe preparation is absent or already consumed');
  }
  PREPARED_WORKFLOW_PROBES.delete(prepared);
  return recordWorkflowProbe(
    internal.context,
    prepared.execution,
    internal.definitionBytes,
    internal.inputBytes,
    snapshot,
  );
}

export function captureProductionReview(
  kind: ProductionCaptureKind,
  commandArgv: readonly string[],
  context: Readonly<ProductionProbeContext>,
): ProductionProbeResult {
  assertCandidateContext(context);
  if (commandArgv.length === 0) throw new Error('capture requires an allowlisted independent CLI command');
  if (commandArgv.some((entry) => entry === '' || entry.includes('\0'))) {
    throw new Error('capture argv is invalid');
  }
  const requested = commandArgv[0];
  if (path.basename(requested) !== requested || !ALLOWED_CAPTURE_TOOLS.has(requested)) {
    throw new Error('capture executable is not allowlisted');
  }
  const executable = resolveExecutable(requested, context.environment);
  if (executable === null || path.basename(executable) !== requested) {
    throw new Error('capture executable could not be resolved safely');
  }
  const realpath = fs.realpathSync(executable);
  const versionProbe = spawnSync(realpath, ['--version'], captureOptions(
    context.environment, context.repositoryRoot, 15_000, 262_144,
  ));
  if (versionProbe.status !== 0) throw new Error('capture tool version probe failed');
  const version = firstNonEmptyLine(`${versionProbe.stdout ?? ''}\n${versionProbe.stderr ?? ''}`);
  if (version === null) throw new Error('capture tool version is empty');
  const result = spawnSync(realpath, commandArgv.slice(1), captureOptions(
    context.environment, context.repositoryRoot, 10 * 60_000, MAX_CAPTURE_BYTES,
  ));
  if (result.status !== 0 || result.signal !== null || result.error !== undefined) {
    throw new Error('independent capture command did not exit successfully');
  }
  const stdout = Buffer.from(result.stdout ?? '', 'utf8');
  const stderr = Buffer.from(result.stderr ?? '', 'utf8');
  const marker = kind === 'review' ? 'VERDICT: APPROVE' : 'ULTRAQA: PASS';
  const lines = stdout.toString('utf8').split(/\r?\n/u).filter((line) => line === marker);
  if (lines.length !== 1) throw new Error(`capture output requires exactly one ${marker}`);
  const seam: ProductionEvidenceSeam = kind === 'review' ? 'independent-code-review' : 'ultraqa';
  const identityHash = sha256Hex(Buffer.from(realpath, 'utf8'));
  const toolIdentity = `${requested}@${safeIdentityComponent(version)}:${identityHash.slice(0, 16)}`;
  const reviewerIdentity = `${requested}:${identityHash.slice(0, 32)}`;
  return writeProductionEvidenceInternal({
    context,
    seam,
    producerIdentity: reviewerIdentity,
    toolIdentity,
    argv: ['oma', 'production', 'capture', kind, '--run-id', context.runId, '--', ...commandArgv],
    stdout,
    stderr,
    artifact: {
      reviewer_identity: reviewerIdentity,
      tool_identity: toolIdentity,
      executable_realpath_sha256: identityHash,
      tool_version: version.slice(0, 512),
      command_argv: [...commandArgv],
      stdout_sha256: sha256Hex(stdout),
      stderr_sha256: sha256Hex(stderr),
      independent: true,
      verdict: kind === 'review' ? 'approve' : 'pass',
    },
  });
}

export function verifyAllProductionEvidence(input: {
  readonly stateRoot: string;
  readonly runId: string;
  readonly oid: string;
}): { readonly ok: boolean; readonly seams: Array<{ seam: string; passed: boolean; code: string }> } {
  const seam = (name: ProductionEvidenceSeam) =>
    verifyProductionEvidence({ ...input, seam: name });
  const pluginDiscovery = seam('plugin-discovery');
  const workflow = seam('workflow');
  const workflowReverified = workflow !== null
    && verifyCapturedWorkflowEvidence(input, workflow);
  const review = seam('independent-code-review');
  const ultraqa = seam('ultraqa');
  const seams = [
    result('installed-plugin-discovery', pluginDiscovery !== null
      && pluginDiscovery.artifact.fresh_session_discovery === 'observed'
      && pluginDiscovery.artifact.discovery_evidence_tier === 'T2',
    'PRODUCTION_PLUGIN_DISCOVERY'),
    result('managed-lifecycle', seam('managed-lifecycle') !== null, 'PRODUCTION_MANAGED_LIFECYCLE'),
    result('exact-resume', seam('exact-resume') !== null, 'PRODUCTION_EXACT_RESUME'),
    result('interactive-headless-worker', seam('worker-runtime') !== null, 'PRODUCTION_WORKER'),
    result('mcp-lsp-public-status', seam('mcp-lsp') !== null, 'PRODUCTION_MCP_LSP'),
    result('workflow-dag-replay-review', workflowReverified,
    'PRODUCTION_WORKFLOW'),
    result('independent-review-ultraqa', review !== null && ultraqa !== null
      && review.receipt.producer_identity !== ultraqa.receipt.producer_identity
      && review.receipt.tool_identity !== ultraqa.receipt.tool_identity,
    'PRODUCTION_REVIEW_ULTRAQA'),
  ];
  return { ok: seams.every((entry) => entry.passed), seams };
}

async function runPluginProbe(context: Readonly<ProductionProbeContext>): Promise<ProductionProbeResult> {
  const doctor = await runDoctor({
    packageRoot: context.packageRoot,
    packageVersion: context.packageVersion,
    agyCommand: context.agyCommand,
    adapter: context.pluginAdapter,
    strictPlugin: true,
    mode: 'release',
    stateRoot: context.stateRoot,
  });
  if (!doctor.ok) throw new Error(`${doctor.error.code}: ${doctor.error.message}`);
  const native = inspectAntigravityPublicStatus({
    executable: context.agyCommand,
    environment: context.environment,
  });
  const pluginCheck = doctor.value.checks.find((entry) => entry.id === 'plugin_registry');
  if (!doctor.value.ok || native.status !== 'public_cli_observed'
    || native.version === null || pluginCheck?.status !== 'pass') {
    throw new Error('release doctor/public plugin registry preconditions did not pass');
  }
  const active = await verifyPluginActive({
    packageRoot: context.packageRoot,
    adapter: context.pluginAdapter,
    homeDir: context.environment.HOME,
    antigravityConfigRoot: context.environment.OMA_ANTIGRAVITY_CONFIG_ROOT
      ?? context.environment.ANTIGRAVITY_CONFIG_ROOT,
  });
  if (!active.ok) throw new Error(`${active.error.code}: ${active.error.message}`);
  const executable = resolveExecutable(context.agyCommand, context.environment);
  if (executable === null) throw new Error('fresh plugin discovery requires an executable agy realpath');
  const executableRealpath = fs.realpathSync(executable);
  const freshSessionDiscovery = await inspectFreshPluginDiscovery({
    executableRealpath,
    version: native.version,
    environment: context.environment,
    candidateOid: context.oid,
    packageDigest: active.value.sourceDigest,
    installedDigest: active.value.installedDigest,
    installedRealpath: active.value.installPath,
    installedVersion: active.value.version,
    registryListSha256: active.value.listStdoutSha256,
    runner: context.freshPluginDiscoveryRunner,
  });
  const stdout = Buffer.from(freshSessionDiscovery.stdout, 'utf8');
  const stderr = Buffer.from(freshSessionDiscovery.stderr, 'utf8');
  return writeProductionEvidenceInternal({
    context,
    seam: 'plugin-discovery',
    producerIdentity: 'oma-product-probe',
    toolIdentity: `agy@${safeIdentityComponent(native.version)}:${freshSessionDiscovery.agy_realpath_sha256.slice(0, 16)}`,
    argv: CANONICAL_ARGV['plugin-discovery'] as readonly string[],
    stdout,
    stderr,
    artifact: {
      package_name: '@iml1s/oh-my-agy',
      plugin_name: 'oh-my-agy',
      doctor_exit_code: doctor.value.exitCode,
      plugin_check_status: pluginCheck.status,
      public_cli_status: native.status,
      public_cli_version: native.version,
      installed: true,
      enabled: true,
      fresh_session_discovery: freshSessionDiscovery.status,
      discovery_evidence_tier: freshSessionDiscovery.evidence_tier,
      discovery_detail_code: freshSessionDiscovery.detail_code,
      command_argv: freshSessionDiscovery.command_argv,
      agy_realpath_sha256: freshSessionDiscovery.agy_realpath_sha256,
      agy_version_sha256: freshSessionDiscovery.agy_version_sha256,
      candidate_oid: freshSessionDiscovery.candidate_oid,
      package_digest: freshSessionDiscovery.package_digest,
      installed_digest: freshSessionDiscovery.installed_digest,
      installed_realpath_sha256: freshSessionDiscovery.installed_realpath_sha256,
      installed_version: freshSessionDiscovery.installed_version,
      registry_list_sha256: freshSessionDiscovery.registry_list_sha256,
      isolated_cwd_sha256: freshSessionDiscovery.isolated_cwd_sha256,
      fresh_process_pid: freshSessionDiscovery.fresh_process_pid,
      process_exit_code: freshSessionDiscovery.process_exit_code,
      process_signal: freshSessionDiscovery.process_signal,
      timed_out: freshSessionDiscovery.timed_out,
      output_overflow: freshSessionDiscovery.output_overflow,
      canary_output_sha256: freshSessionDiscovery.canary_output_sha256,
      canary_stderr_sha256: freshSessionDiscovery.canary_stderr_sha256,
    },
  }, PLUGIN_DISCOVERY_AUTHORITY);
}

function runMcpLspProbe(context: Readonly<ProductionProbeContext>): ProductionProbeResult {
  const server = path.join(context.packageRoot, 'dist', 'src', 'mcp', 'server.js');
  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
    { jsonrpc: '2.0', id: { invalid: true }, method: 'ping' },
    { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
    { jsonrpc: '2.0', id: 4, method: 'ping', params: {} },
  ];
  const input = `${requests.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  const outcome = spawnSync(process.execPath, [server], {
    encoding: 'utf8',
    input,
    cwd: context.repositoryRoot,
    env: {
      ...context.environment,
      OMA_REPOSITORY_ROOT: context.repositoryRoot,
      OMA_STATE_ROOT: context.stateRoot,
    },
    timeout: 15_000,
    maxBuffer: MAX_CAPTURE_BYTES,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  if (outcome.status !== 0 || outcome.signal !== null || outcome.error !== undefined) {
    throw new Error('candidate MCP server probe failed');
  }
  const responses = (outcome.stdout ?? '').trim().split(/\r?\n/u)
    .filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  if (responses.length !== 4) throw new Error('candidate MCP server response count is invalid');
  const initialize = plainObject(responses[0].result) ? responses[0].result : null;
  const invalid = plainObject(responses[1].error) ? responses[1].error : null;
  const list = plainObject(responses[2].result) ? responses[2].result : null;
  const ping = plainObject(responses[3].result) ? responses[3].result : null;
  const tools = Array.isArray(list?.tools)
    ? list.tools.map((entry) => plainObject(entry) && typeof entry.name === 'string' ? entry.name : null)
      .filter((entry): entry is string => entry !== null)
    : [];
  if (initialize?.protocolVersion !== OMA_MCP_PROTOCOL_VERSION_V1
    || invalid?.code !== -32600 || ping === null
    || !canonicalBytesV1(tools).equals(canonicalBytesV1(MCP_OPERATION_NAMES_V1))) {
    throw new Error('candidate MCP server protocol/tool surface is invalid');
  }
  const lsp = inspectHostLspStatus({ plugin_root: context.packageRoot });
  const stdout = Buffer.from(outcome.stdout ?? '', 'utf8');
  const stderr = Buffer.from(outcome.stderr ?? '', 'utf8');
  return writeProductionEvidenceInternal({
    context,
    seam: 'mcp-lsp',
    producerIdentity: 'oma-product-probe',
    toolIdentity: `node@${safeIdentityComponent(process.version)}`,
    argv: CANONICAL_ARGV['mcp-lsp'] as readonly string[],
    stdout,
    stderr,
    artifact: {
      mcp_tools: tools,
      mcp_protocol_version: OMA_MCP_PROTOCOL_VERSION_V1,
      invalid_request_code: -32600,
      ping_after_invalid: true,
      server_exit_code: outcome.status,
      lsp_status: lsp.status,
      lsp_observation: lsp.host_observation,
      lsp_registration_sha256: lsp.registration_sha256,
      private_sidecar_claimed: false,
      private_memory_claimed: false,
    },
  });
}

function recordWorkflowProbe(
  context: Readonly<ProductionProbeContext>,
  execution: Readonly<{
    definition: RepositoryWorkflowV1;
    plan: WorkflowPlanV1;
    journal_path: string;
    workflow_input: Readonly<Record<string, unknown>>;
    mode: 'production';
  }>,
  definitionBytes: Buffer,
  inputBytes: Buffer,
  snapshot: WorkflowRunSnapshotV1,
): ProductionProbeResult {
  if (productionCandidateOid(context.repositoryRoot) !== context.oid) {
    throw new Error('workflow probe candidate OID does not match exact repository HEAD');
  }
  const { definition, plan, journal_path: journalPath } = execution;
  const agyIdentity = resolveCanonicalAgyIdentity();
  if (fs.realpathSync(context.agyCommand) !== agyIdentity.realpath) {
    throw new Error('workflow probe agy identity changed before execution');
  }
  const authorityStateRoot = resolveProductionStateRoot({
    stateRoot: context.stateRoot,
    environment: context.environment,
    create: true,
  });
  assertRepositoryExternalAuthorityRoot(authorityStateRoot, context.repositoryRoot);
  const events = readWorkflowJournal(journalPath);
  const replayed = replayWorkflowEvents(plan, events, { allow_product_ship: true });
  const review = evaluateWorkflowReview({
    definition,
    plan,
    tasks: replayed.tasks,
    authority_state_root: authorityStateRoot,
    repository_root: context.repositoryRoot,
  });
  if (snapshot.terminal !== 'ship' || replayed.terminal !== 'ship' || review.terminal !== 'ship'
    || review.evidence.product_authority_available !== true) {
    throw new Error(`workflow probe product-owned authority did not reach authenticated ship: ${
      JSON.stringify({
        snapshot: snapshot.terminal,
        replayed: replayed.terminal,
        evidence: review.evidence,
      })
    }`);
  }
  const planBytes = canonicalBytesV1(plan);
  const journalBytes = readBoundedRegularFile(journalPath, 64 * 1024 * 1024, 0o077);
  const capture = captureWorkflowEvidenceBundle({
    stateRoot: resolveProductionStateRoot({
      stateRoot: context.stateRoot,
      environment: context.environment,
      create: true,
    }),
    productionRunId: context.runId,
    repositoryRoot: context.repositoryRoot,
    workflowRunId: plan.run_id,
    definitionBytes,
    inputBytes,
    planBytes,
    journalBytes,
    tasks: replayed.tasks,
  });
  const artifact = {
    workflow_name: 'production-safety-review',
    workflow_run_id: plan.run_id,
    definition_sha256: sha256Hex(definitionBytes),
    input_sha256: sha256Hex(inputBytes),
    plan_sha256: sha256Hex(planBytes),
    journal_sha256: sha256Hex(journalBytes),
    journal_head: replayed.journal_head,
    definition_relative_path: capture.definition,
    input_relative_path: capture.input,
    plan_relative_path: capture.plan,
    journal_relative_path: capture.journal,
    repository_capture_relative_path: capture.repository,
    terminal: replayed.terminal,
    product_owned_ship_authority: true,
    journal_replay_verified: true,
    ship_authority_verified: true,
    authority_error: null,
    native_surface_supported: false,
  };
  return writeProductionEvidenceInternal({
    context,
    seam: 'workflow',
    producerIdentity: 'oma-product-probe',
    toolIdentity: `oma@${safeIdentityComponent(context.packageVersion)}`,
    argv: CANONICAL_ARGV.workflow as readonly string[],
    stdout: canonicalBytesV1({ snapshot: replayed, review }),
    stderr: Buffer.alloc(0),
    artifact,
  }, WORKFLOW_PROBE_AUTHORITY);
}

function captureWorkflowEvidenceBundle(input: {
  stateRoot: string;
  productionRunId: string;
  repositoryRoot: string;
  workflowRunId: string;
  definitionBytes: Buffer;
  inputBytes: Buffer;
  planBytes: Buffer;
  journalBytes: Buffer;
  tasks: Readonly<Record<string, import('../workflows/schema').WorkflowTaskRuntimeV1>>;
}): {
  definition: string;
  input: string;
  plan: string;
  journal: string;
  repository: string;
} {
  const relativeRoot = `workflow-capture/${input.workflowRunId}`;
  const root = productionEvidenceRunRoot(input.stateRoot, input.productionRunId, true);
  const paths = {
    definition: `${relativeRoot}/definition.json`,
    input: `${relativeRoot}/input.json`,
    plan: `${relativeRoot}/plan.json`,
    journal: `${relativeRoot}/journal.jsonl`,
    repository: `${relativeRoot}/repository`,
  };
  writeImmutableFile(path.join(root, ...paths.definition.split('/')), input.definitionBytes);
  writeImmutableFile(path.join(root, ...paths.input.split('/')), input.inputBytes);
  writeImmutableFile(path.join(root, ...paths.plan.split('/')), input.planBytes);
  writeImmutableFile(path.join(root, ...paths.journal.split('/')), input.journalBytes);
  const repositoryCaptureRoot = path.join(root, ...paths.repository.split('/'));
  ensureSafeDirectoryChain(repositoryCaptureRoot);
  for (const runtime of Object.values(input.tasks)) {
    const authority = runtime.receipt?.product_authority;
    if (authority === undefined) throw new Error('workflow capture lacks product authority');
    for (const observed of [
      ...authority.artifacts.map((entry) => ({ relative: entry.path, maximum: 524_288 })),
      ...authority.verifications.flatMap((entry) => [
        { relative: entry.stdout_path, maximum: 1_048_576 },
        { relative: entry.stderr_path, maximum: 1_048_576 },
      ]),
    ]) {
      const source = confinedRepositoryFile(input.repositoryRoot, observed.relative);
      const bytes = readBoundedRegularFile(source, observed.maximum, 0o077);
      const target = path.resolve(repositoryCaptureRoot, observed.relative);
      if (!target.startsWith(`${repositoryCaptureRoot}${path.sep}`)) {
        throw new Error('workflow capture repository path escapes');
      }
      writeImmutableFile(target, bytes);
    }
  }
  return paths;
}

function verifyCapturedWorkflowEvidence(
  input: { stateRoot: string; runId: string; oid: string },
  verified: VerifiedProductionEvidence,
): boolean {
  try {
    const artifact = verified.artifact;
    const workflowRunId = String(artifact.workflow_run_id);
    const root = productionEvidenceRunRoot(input.stateRoot, input.runId, false);
    const definitionBytes = readCapturedWorkflowFile(
      root, artifact.definition_relative_path, `workflow-capture/${workflowRunId}/definition.json`,
      MAX_EVIDENCE_BYTES,
    );
    const inputBytes = readCapturedWorkflowFile(
      root, artifact.input_relative_path, `workflow-capture/${workflowRunId}/input.json`,
      MAX_EVIDENCE_BYTES,
    );
    const planBytes = readCapturedWorkflowFile(
      root, artifact.plan_relative_path, `workflow-capture/${workflowRunId}/plan.json`,
      4 * MAX_EVIDENCE_BYTES,
    );
    const journalBytes = readCapturedWorkflowFile(
      root, artifact.journal_relative_path, `workflow-capture/${workflowRunId}/journal.jsonl`,
      64 * MAX_EVIDENCE_BYTES,
    );
    if (sha256Hex(definitionBytes) !== artifact.definition_sha256
      || sha256Hex(inputBytes) !== artifact.input_sha256
      || sha256Hex(planBytes) !== artifact.plan_sha256
      || sha256Hex(journalBytes) !== artifact.journal_sha256) return false;
    const definition = parseCanonicalJson(definitionBytes) as RepositoryWorkflowV1;
    validateRepositoryWorkflow(definition);
    const workflowInput = parseCanonicalJson(inputBytes);
    if (!plainObject(workflowInput)) return false;
    const candidate = typeof workflowInput.candidate_oid === 'string'
      ? workflowInput.candidate_oid : workflowInput.candidate_commit;
    if (candidate !== input.oid) return false;
    const plan = parseCanonicalJson(planBytes) as WorkflowPlanV1;
    const { plan_digest: ignored, ...planMaterial } = plan;
    void ignored;
    if (workflowPlanDigest(planMaterial) !== plan.plan_digest
      || plan.definition_digest !== definition.definition_digest
      || plan.input_digest !== sha256Hex(inputBytes)
      || plan.run_id !== workflowRunId) return false;
    const journalText = journalBytes.toString('utf8');
    if (!journalText.endsWith('\n')) return false;
    const events = journalText.trim().split('\n').map((line) =>
      JSON.parse(line) as import('../workflows/schema').WorkflowJournalEventV1);
    const replayed = replayWorkflowEvents(plan, events, { allow_product_ship: true });
    const currentAgy = resolveCanonicalAgyIdentity();
    if (Object.values(replayed.tasks).some((runtime) => {
      const authority = runtime.receipt?.product_authority;
      return authority === undefined
        || authority.agy_executable_realpath !== currentAgy.realpath
        || authority.agy_executable_sha256 !== currentAgy.sha256
        || authority.agy_executable_byte_length !== currentAgy.byte_length;
    })) return false;
    const repositoryCaptureRoot = path.resolve(
      root, ...String(artifact.repository_capture_relative_path).split('/'),
    );
    if (repositoryCaptureRoot !== path.join(root, 'workflow-capture', workflowRunId, 'repository')) {
      return false;
    }
    assertSafeDirectory(repositoryCaptureRoot, 0o077);
    const review = evaluateWorkflowReview({
      definition,
      plan,
      tasks: replayed.tasks,
      authority_state_root: input.stateRoot,
      repository_root: repositoryCaptureRoot,
    });
    return replayed.terminal === 'ship' && review.terminal === 'ship'
      && review.evidence.product_authority_available === true
      && replayed.journal_head === artifact.journal_head
      && artifact.terminal === 'ship';
  } catch {
    return false;
  }
}

function readCapturedWorkflowFile(
  root: string,
  relative: unknown,
  expected: string,
  maximum: number,
): Buffer {
  if (relative !== expected) throw new Error('workflow capture path mismatch');
  const target = path.resolve(root, ...expected.split('/'));
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('workflow capture path escapes');
  return readBoundedRegularFile(target, maximum, 0o077);
}

function confinedRepositoryFile(repositoryRoot: string, relative: string): string {
  if (relative === '' || path.isAbsolute(relative) || relative.includes('\0')) {
    throw new Error('workflow repository artifact path is invalid');
  }
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const target = path.resolve(root, relative);
  if (!target.startsWith(`${root}${path.sep}`)) throw new Error('workflow repository artifact path escapes');
  return target;
}

function artifactValidator(
  seam: ProductionEvidenceSeam,
): (value: Readonly<Record<string, unknown>>) => boolean {
  const base = ['schema_version', 'repository_id', 'run_id', 'oid', 'observed_at', 'seam'];
  const validators: Record<ProductionEvidenceSeam, (value: Readonly<Record<string, unknown>>) => boolean> = {
    'plugin-discovery': (value) => exactKeys(value, [...base,
      'package_name', 'plugin_name', 'doctor_exit_code', 'plugin_check_status',
      'public_cli_status', 'public_cli_version', 'installed', 'enabled',
      'fresh_session_discovery', 'discovery_evidence_tier', 'discovery_detail_code',
      'command_argv', 'agy_realpath_sha256', 'agy_version_sha256', 'candidate_oid',
      'package_digest', 'installed_digest', 'installed_realpath_sha256',
      'installed_version', 'registry_list_sha256', 'isolated_cwd_sha256',
      'fresh_process_pid', 'process_exit_code', 'process_signal', 'timed_out',
      'output_overflow', 'canary_output_sha256', 'canary_stderr_sha256'])
      && value.package_name === '@iml1s/oh-my-agy' && value.plugin_name === 'oh-my-agy'
      && (value.doctor_exit_code === 0 || value.doctor_exit_code === 2)
      && value.plugin_check_status === 'pass'
      && value.public_cli_status === 'public_cli_observed'
      && typeof value.public_cli_version === 'string'
      && value.installed === true && value.enabled === true
      && canonicalBytesV1(value.command_argv).equals(canonicalBytesV1(DISCOVERY_PROOF_ARGV_V1))
      && value.candidate_oid === value.oid
      && ['agy_realpath_sha256', 'agy_version_sha256', 'package_digest',
        'installed_digest', 'installed_realpath_sha256', 'registry_list_sha256',
        'canary_output_sha256', 'canary_stderr_sha256']
        .every((key) => /^[a-f0-9]{64}$/u.test(String(value[key])))
      && value.package_digest === value.installed_digest
      && value.installed_version === value.public_cli_version
      && typeof value.discovery_detail_code === 'string'
      && (value.isolated_cwd_sha256 === null
        || /^[a-f0-9]{64}$/u.test(String(value.isolated_cwd_sha256)))
      && (value.fresh_process_pid === null || positiveInteger(value.fresh_process_pid))
      && (value.process_exit_code === null || Number.isSafeInteger(value.process_exit_code))
      && (value.process_signal === null || typeof value.process_signal === 'string')
      && typeof value.timed_out === 'boolean' && typeof value.output_overflow === 'boolean'
      && (
        value.fresh_session_discovery === 'observed'
          ? value.discovery_evidence_tier === 'T2'
            && value.discovery_detail_code === 'FRESH_SESSION_CANARY_OBSERVED'
            && positiveInteger(value.fresh_process_pid)
            && value.process_exit_code === 0 && value.process_signal === null
            && value.timed_out === false && value.output_overflow === false
            && value.isolated_cwd_sha256 !== null
            && value.canary_output_sha256 === sha256Hex(
              Buffer.from(`${DISCOVERY_PROOF_TOKEN_V1}\n`, 'utf8'),
            )
            && value.canary_stderr_sha256 === sha256Hex(Buffer.alloc(0))
          : value.fresh_session_discovery === 'unobserved'
            && value.discovery_evidence_tier === 'T0'
            && value.discovery_detail_code !== 'FRESH_SESSION_CANARY_OBSERVED'
      ),
    'managed-lifecycle': (value) => exactKeys(value, [...base,
      'wrapper_pid', 'child_pid', 'generation_n', 'generation_n_plus_1',
      'pre_invocation_exact_bind', 'stop_n_continue', 'second_launch_count',
      'stop_n_plus_1_final_allow', 'child_exit_code'])
      && positiveInteger(value.wrapper_pid) && positiveInteger(value.child_pid)
      && positiveInteger(value.generation_n)
      && value.generation_n_plus_1 === Number(value.generation_n) + 1
      && value.pre_invocation_exact_bind === true && value.stop_n_continue === true
      && value.second_launch_count === 0 && value.stop_n_plus_1_final_allow === true
      && value.child_exit_code === 0,
    'exact-resume': (value) => exactKeys(value, [...base,
      'conversation_id', 'argv', 'generation', 'next_generation', 'verified'])
      && typeof value.conversation_id === 'string' && value.conversation_id.length > 0
      && canonicalBytesV1(value.argv).equals(canonicalBytesV1(['agy', '--conversation', value.conversation_id]))
      && positiveInteger(value.generation) && value.next_generation === Number(value.generation) + 1
      && value.verified === true,
    'worker-runtime': (value) => exactKeys(value, [...base,
      'interactive_tty_observed', 'headless_exit_verified', 'mailbox_verified',
      'delivery_verified', 'orphan_count'])
      && value.interactive_tty_observed === true && value.headless_exit_verified === true
      && value.mailbox_verified === true && value.delivery_verified === true
      && value.orphan_count === 0,
    'mcp-lsp': (value) => exactKeys(value, [...base,
      'mcp_tools', 'mcp_protocol_version', 'invalid_request_code', 'ping_after_invalid',
      'server_exit_code', 'lsp_status', 'lsp_observation', 'lsp_registration_sha256',
      'private_sidecar_claimed', 'private_memory_claimed'])
      && canonicalBytesV1(value.mcp_tools).equals(canonicalBytesV1(MCP_OPERATION_NAMES_V1))
      && value.mcp_protocol_version === OMA_MCP_PROTOCOL_VERSION_V1
      && value.invalid_request_code === -32600 && value.ping_after_invalid === true
      && value.server_exit_code === 0
      && ['configured_unobserved', 'unavailable'].includes(String(value.lsp_status))
      && value.lsp_observation === 'unobserved'
      && (value.lsp_registration_sha256 === null || /^[a-f0-9]{64}$/u.test(String(value.lsp_registration_sha256)))
      && value.private_sidecar_claimed === false && value.private_memory_claimed === false,
    workflow: (value) => exactKeys(value, [...base,
      'workflow_name', 'workflow_run_id', 'definition_sha256', 'input_sha256',
      'plan_sha256', 'journal_sha256', 'journal_head', 'terminal',
      'definition_relative_path', 'input_relative_path', 'plan_relative_path',
      'journal_relative_path', 'repository_capture_relative_path',
      'product_owned_ship_authority', 'journal_replay_verified', 'ship_authority_verified',
      'authority_error', 'native_surface_supported'])
      && value.workflow_name === 'production-safety-review'
      && typeof value.workflow_run_id === 'string'
      && value.definition_relative_path === `workflow-capture/${String(value.workflow_run_id)}/definition.json`
      && value.input_relative_path === `workflow-capture/${String(value.workflow_run_id)}/input.json`
      && value.plan_relative_path === `workflow-capture/${String(value.workflow_run_id)}/plan.json`
      && value.journal_relative_path === `workflow-capture/${String(value.workflow_run_id)}/journal.jsonl`
      && value.repository_capture_relative_path === `workflow-capture/${String(value.workflow_run_id)}/repository`
      && ['definition_sha256', 'input_sha256', 'plan_sha256', 'journal_sha256', 'journal_head']
        .every((key) => /^[a-f0-9]{64}$/u.test(String(value[key])))
      && value.terminal === 'ship' && value.product_owned_ship_authority === true
      && value.journal_replay_verified === true && value.ship_authority_verified === true
      && value.authority_error === null
      && value.native_surface_supported === false,
    'independent-code-review': (value) => validateCaptureArtifact(value, base, 'independent-code-review', 'approve'),
    ultraqa: (value) => validateCaptureArtifact(value, base, 'ultraqa', 'pass'),
  };
  return (value) => value.schema_version === 1 && value.repository_id === 'OMA'
    && SAFE_RUN_ID.test(String(value.run_id)) && OID.test(String(value.oid))
    && typeof value.observed_at === 'string' && freshTimestamp(value.observed_at)
    && value.seam === seam && validators[seam](value);
}

function validateCaptureArtifact(
  value: Readonly<Record<string, unknown>>,
  base: readonly string[],
  seam: ProductionEvidenceSeam,
  verdict: 'approve' | 'pass',
): boolean {
  return exactKeys(value, [...base,
    'reviewer_identity', 'tool_identity', 'executable_realpath_sha256', 'tool_version',
    'command_argv', 'stdout_sha256', 'stderr_sha256', 'independent', 'verdict'])
    && value.seam === seam && SAFE_ID.test(String(value.reviewer_identity))
    && SAFE_ID.test(String(value.tool_identity))
    && /^[a-f0-9]{64}$/u.test(String(value.executable_realpath_sha256))
    && typeof value.tool_version === 'string' && value.tool_version.length > 0
    && Array.isArray(value.command_argv) && value.command_argv.length > 0
    && /^[a-f0-9]{64}$/u.test(String(value.stdout_sha256))
    && /^[a-f0-9]{64}$/u.test(String(value.stderr_sha256))
    && value.independent === true && value.verdict === verdict;
}

function assertExpectedArgv(seam: ProductionEvidenceSeam, argv: readonly string[]): void {
  if (!Array.isArray(argv) || argv.length === 0
    || argv.some((entry) => typeof entry !== 'string' || entry === '' || entry.includes('\0'))) {
    throw new Error('production evidence argv is invalid');
  }
  const expected = CANONICAL_ARGV[seam];
  if (expected !== null && !canonicalBytesV1(argv).equals(canonicalBytesV1(expected))) {
    throw new Error('production evidence argv is not canonical');
  }
  if (expected === null) {
    const kind = seam === 'independent-code-review' ? 'review' : 'ultraqa';
    const prefix = ['oma', 'production', 'capture', kind, '--run-id'];
    if (!canonicalBytesV1(argv.slice(0, prefix.length)).equals(canonicalBytesV1(prefix))
      || argv[6] !== '--' || argv.length < 8) {
      throw new Error('production capture argv is not canonical');
    }
  }
}

function safeWorkflowRunDirectories(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  assertSafeDirectory(root);
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && SAFE_RUN_ID.test(entry.name))
    .map((entry) => path.join(root, entry.name))
    .filter((entry) => {
      try { assertSafeDirectory(entry); return true; } catch { return false; }
    });
}

function assertCandidateContext(context: Readonly<ProductionProbeContext>): void {
  const repositoryRoot = fs.realpathSync(path.resolve(context.repositoryRoot));
  if (productionCandidateOid(repositoryRoot) !== context.oid) {
    throw new Error('production probe candidate OID does not match repository HEAD');
  }
}

function parseCanonicalJson(bytes: Buffer): unknown {
  const value = JSON.parse(bytes.toString('utf8')) as unknown;
  if (!canonicalBytesV1(value).equals(bytes)) throw new Error('JSON artifact is not canonical');
  return value;
}

function writeImmutableFile(targetPath: string, bytes: Buffer): void {
  const parent = path.dirname(targetPath);
  ensureSafeDirectoryChain(parent);
  if (fs.existsSync(targetPath)) {
    const existing = readBoundedRegularFile(targetPath, Math.max(bytes.length, 1) + 1, 0o077);
    if (!existing.equals(bytes)) throw new Error(`immutable production artifact differs: ${targetPath}`);
    return;
  }
  const descriptor = fs.openSync(targetPath, fs.constants.O_WRONLY | fs.constants.O_CREAT
    | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o600);
  } finally {
    fs.closeSync(descriptor);
  }
}

function ensureSafeDirectoryChain(target: string): void {
  const absolute = path.resolve(target);
  const missing: string[] = [];
  let cursor = absolute;
  while (!fs.existsSync(cursor)) {
    missing.unshift(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new Error('no safe ancestor for production artifact');
    cursor = parent;
  }
  assertSafeDirectory(cursor);
  for (const directory of missing) {
    fs.mkdirSync(directory, { mode: 0o700 });
    assertSafeDirectory(directory, 0o077);
  }
}

function readBoundedRegularFile(targetPath: string, maximumBytes: number, deniedMode = 0): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(path.resolve(targetPath), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximumBytes
      || (deniedMode === 0o077
        ? (stat.mode & 0o777) !== 0o600
        : (stat.mode & deniedMode) !== 0)) {
      throw new Error('bounded owner-only regular file required');
    }
    return fs.readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function confinedEvidencePath(root: string, relative: string, expected: string): string {
  if (relative !== expected || path.isAbsolute(relative) || relative.includes('\0')) {
    throw new Error('production evidence relative path is invalid');
  }
  const target = path.resolve(root, ...relative.split('/'));
  if (!target.startsWith(`${root}${path.sep}`) || fs.realpathSync(target) !== target) {
    throw new Error('production evidence path is unsafe');
  }
  return target;
}

function assertSafeDirectory(targetPath: string, deniedMode = 0): void {
  const stat = fs.lstatSync(targetPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()
    || (deniedMode === 0o077
      ? (stat.mode & 0o777) !== 0o700
      : (stat.mode & deniedMode) !== 0)) {
    throw new Error(`unsafe production directory: ${targetPath}`);
  }
}

function resolveExecutable(name: string, environment: NodeJS.ProcessEnv): string | null {
  if (path.isAbsolute(name)) {
    try {
      const real = fs.realpathSync(name);
      const stat = fs.statSync(real);
      return stat.isFile() && (stat.mode & 0o111) !== 0 ? real : null;
    } catch {
      return null;
    }
  }
  if (path.basename(name) !== name) return null;
  const entries = (environment.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const entry of entries) {
    if (!path.isAbsolute(entry)) continue;
    const candidate = path.join(entry, name);
    try {
      const real = fs.realpathSync(candidate);
      const stat = fs.statSync(real);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      // Continue through the fixed PATH entries. No shell lookup is used.
    }
  }
  return null;
}

function locateInstalledPackageRoot(start: string): string {
  let current = path.resolve(start);
  for (let index = 0; index < 8; index += 1) {
    try {
      const packageJson = JSON.parse(fs.readFileSync(path.join(current, 'package.json'), 'utf8')) as {
        name?: unknown;
      };
      if (packageJson.name === '@iml1s/oh-my-agy'
        && fs.existsSync(path.join(current, 'plugin.json'))) {
        return fs.realpathSync(current);
      }
    } catch {
      // Continue to the package parent.
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new Error('workflow production probe cannot locate installed package root');
}

function realAgyPluginAdapter(
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): PluginCommandAdapter {
  return {
    async run(argv) {
      const outcome = spawnSync(executable, [...argv], captureOptions(
        environment, cwd, 30_000, MAX_CAPTURE_BYTES,
      ));
      return {
        argv: [...argv],
        code: outcome.status ?? 1,
        stdout: outcome.stdout ?? '',
        stderr: `${outcome.stderr ?? ''}${outcome.error?.message ?? ''}`,
      };
    },
  };
}

function captureOptions(
  environment: NodeJS.ProcessEnv,
  cwd: string,
  timeout: number,
  maxBuffer: number,
): import('child_process').SpawnSyncOptionsWithStringEncoding {
  return {
    encoding: 'utf8',
    env: environment,
    cwd: fs.realpathSync(path.resolve(cwd)),
    timeout,
    maxBuffer,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
}

function firstNonEmptyLine(value: string): string | null {
  return value.split(/\r?\n/u).map((entry) => entry.trim()).find(Boolean) ?? null;
}

function safeIdentityComponent(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._@+-]+/gu, '_').slice(0, 96);
  return normalized === '' ? crypto.createHash('sha256').update(value).digest('hex').slice(0, 16) : normalized;
}

function freshTimestamp(value: string, now = Date.now()): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= now + 5 * 60_000
    && timestamp >= now - 24 * 60 * 60_000
    && new Date(timestamp).toISOString() === value;
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareUtf8);
  const sortedExpected = [...expected].sort(compareUtf8);
  return actual.length === sortedExpected.length
    && actual.every((entry, index) => entry === sortedExpected[index]);
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function positiveInteger(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function result(seam: string, passed: boolean, code: string) {
  return { seam, passed, code };
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}
