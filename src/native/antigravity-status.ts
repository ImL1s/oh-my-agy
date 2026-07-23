import { spawn, spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sha256 } from '../runtime/atomic';
import { redactDiagnostic } from '../runtime/redaction';

export type NativeEvidenceTier = 'T0' | 'T1';

export interface NativeCapabilityViewV1 {
  capability:
    | 'public_cli'
    | 'plugins'
    | 'plugin_fresh_session_discovery'
    | 'native_status'
    | 'native_lsp'
    | 'native_team'
    | 'native_workflows';
  status: 'observed' | 'unobserved';
  evidence_tier: NativeEvidenceTier;
}

export interface AntigravityPublicStatusV1 {
  store_kind: 'oma_antigravity_public_status';
  schema_version: 1;
  repository_id: 'OMA';
  status: 'unavailable' | 'public_cli_partial' | 'public_cli_observed';
  executable: string;
  version: string | null;
  version_sha256: string | null;
  public_subcommands: string[];
  capabilities: NativeCapabilityViewV1[];
  detail_code: string;
  diagnostic: string | null;
}

export interface PublicCommandOutcomeV1 {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type PublicCommandRunnerV1 = (
  command: string,
  argv: readonly string[],
) => PublicCommandOutcomeV1;

export interface AntigravityStatusOptionsV1 {
  executable?: string;
  environment?: NodeJS.ProcessEnv;
  run?: PublicCommandRunnerV1;
}

export const DISCOVERY_PROOF_TOKEN_V1 =
  'OMA_DISCOVERY_PROOF_V1_7f39c2e81d4ab6059fa47c13d86e502bf971a640ec28d35b';
export const DISCOVERY_PROOF_ARGV_V1 = [
  '--print-timeout',
  '90s',
  '-p',
  '/oh-my-agy:discovery-proof',
] as const;

export interface FreshProcessRequestV1 {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
}

export interface FreshProcessOutcomeV1 {
  readonly pid: number | null;
  readonly status: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly outputOverflow: boolean;
  readonly error?: string;
}

export type FreshProcessRunnerV1 = (
  request: Readonly<FreshProcessRequestV1>,
) => Promise<FreshProcessOutcomeV1>;

export interface FreshPluginDiscoveryInputV1 {
  readonly executableRealpath: string;
  readonly version: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly candidateOid: string;
  readonly packageDigest: string;
  readonly installedDigest: string;
  readonly installedRealpath: string;
  readonly installedVersion: string;
  readonly registryListSha256: string;
  readonly runner?: FreshProcessRunnerV1;
}

export interface FreshPluginDiscoveryResultV1 {
  readonly status: 'observed' | 'unobserved';
  readonly evidence_tier: 'T2' | 'T0';
  readonly detail_code: string;
  readonly command_argv: string[];
  readonly agy_realpath_sha256: string;
  readonly agy_version: string;
  readonly agy_version_sha256: string;
  readonly candidate_oid: string;
  readonly package_digest: string;
  readonly installed_digest: string;
  readonly installed_realpath_sha256: string;
  readonly installed_version: string;
  readonly registry_list_sha256: string;
  readonly isolated_cwd_sha256: string | null;
  readonly fresh_process_pid: number | null;
  readonly process_exit_code: number | null;
  readonly process_signal: NodeJS.Signals | null;
  readonly timed_out: boolean;
  readonly output_overflow: boolean;
  readonly canary_output_sha256: string;
  readonly canary_stderr_sha256: string;
  readonly stdout: string;
  readonly stderr: string;
}

const PUBLIC_SUBCOMMAND = /^\s{2,}([a-z][a-z0-9-]*)\s{2,}/u;
const VERSION = /(?:^|\s)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:\s|$)/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const OID = /^[a-f0-9]{40,64}$/u;
const DISCOVERY_TIMEOUT_MS = 90_000;
const DISCOVERY_MAXIMUM_OUTPUT_BYTES = 4_096;

/**
 * Probe only the documented public CLI surface. This function deliberately
 * performs no network, port, process-list, IDE-database, or sidecar probing.
 */
export function inspectAntigravityPublicStatus(
  options: Readonly<AntigravityStatusOptionsV1> = {},
): AntigravityPublicStatusV1 {
  const executable = validExecutable(options.executable ?? 'agy')
    ? (options.executable ?? 'agy') : 'agy';
  const run = options.run ?? (
    (command, argv) => defaultPublicRunner(command, argv, options.environment)
  );
  const versionOutcome = safeRun(run, executable, ['--version']);
  const helpOutcome = safeRun(run, executable, ['--help']);
  const version = versionOutcome.status === 0
    ? VERSION.exec(`${versionOutcome.stdout}\n${versionOutcome.stderr}`.trim())?.[1] ?? null
    : null;
  const publicSubcommands = helpOutcome.status === 0
    ? parsePublicSubcommands(`${helpOutcome.stdout}\n${helpOutcome.stderr}`)
    : [];
  const cliObserved = versionOutcome.status === 0 || helpOutcome.status === 0;
  const pluginsObserved = publicSubcommands.includes('plugin') || publicSubcommands.includes('plugins');
  const diagnostic = cliObserved
    ? null
    : boundedDiagnostic((versionOutcome.error ?? versionOutcome.stderr)
      || (helpOutcome.error ?? helpOutcome.stderr) || 'public CLI unavailable');

  return {
    store_kind: 'oma_antigravity_public_status',
    schema_version: 1,
    repository_id: 'OMA',
    status: versionOutcome.status === 0 && helpOutcome.status === 0
      ? 'public_cli_observed'
      : cliObserved ? 'public_cli_partial' : 'unavailable',
    executable: redactDiagnostic(executable, 512),
    version,
    version_sha256: version === null ? null : sha256(version),
    public_subcommands: publicSubcommands,
    capabilities: [
      capability('public_cli', cliObserved),
      capability('plugins', pluginsObserved),
      capability('plugin_fresh_session_discovery', false),
      capability('native_status', false),
      capability('native_lsp', false),
      capability('native_team', false),
      capability('native_workflows', false),
    ],
    detail_code: cliObserved ? 'PUBLIC_CLI_ONLY' : 'PUBLIC_CLI_UNAVAILABLE',
    diagnostic,
  };
}

export function parsePublicSubcommands(help: string): string[] {
  const commands = new Set<string>();
  for (const line of help.split(/\r?\n/u)) {
    const command = PUBLIC_SUBCOMMAND.exec(line)?.[1];
    if (command !== undefined) commands.add(command);
  }
  return [...commands].sort(compareUtf8);
}

export async function inspectFreshPluginDiscovery(
  input: Readonly<FreshPluginDiscoveryInputV1>,
): Promise<FreshPluginDiscoveryResultV1> {
  const base = {
    command_argv: [...DISCOVERY_PROOF_ARGV_V1],
    agy_realpath_sha256: sha256(input.executableRealpath),
    agy_version: input.version,
    agy_version_sha256: sha256(input.version),
    candidate_oid: input.candidateOid,
    package_digest: input.packageDigest,
    installed_digest: input.installedDigest,
    installed_realpath_sha256: sha256(input.installedRealpath),
    installed_version: input.installedVersion,
    registry_list_sha256: input.registryListSha256,
  };
  if (!OID.test(input.candidateOid) || !DIGEST.test(input.packageDigest)
    || !DIGEST.test(input.installedDigest) || !DIGEST.test(input.registryListSha256)
    || input.packageDigest !== input.installedDigest) {
    return unobservedDiscovery(base, 'REGISTRY_IDENTITY_DRIFT');
  }

  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-discovery-proof-'));
  fs.chmodSync(scratch, 0o700);
  const scratchRealpath = fs.realpathSync(scratch);
  const environment = { ...input.environment };
  for (const key of [
    'OMA_SESSION_ID',
    'OMA_LAUNCH_NONCE',
    'OMA_INVOCATION_GENERATION',
    'OMA_CONVERSATION_ID',
  ]) delete environment[key];
  try {
    const outcome = await (input.runner ?? defaultFreshProcessRunner)({
      executable: input.executableRealpath,
      argv: DISCOVERY_PROOF_ARGV_V1,
      cwd: scratchRealpath,
      environment,
      timeoutMs: DISCOVERY_TIMEOUT_MS,
      maximumOutputBytes: DISCOVERY_MAXIMUM_OUTPUT_BYTES,
    });
    const exactOutput = `${DISCOVERY_PROOF_TOKEN_V1}\n`;
    const observed = Number.isSafeInteger(outcome.pid) && Number(outcome.pid) > 0
      && outcome.status === 0 && outcome.signal === null && outcome.error === undefined
      && outcome.timedOut === false && outcome.outputOverflow === false
      && outcome.stdout === exactOutput && outcome.stderr === '';
    return {
      ...base,
      status: observed ? 'observed' : 'unobserved',
      evidence_tier: observed ? 'T2' : 'T0',
      detail_code: observed ? 'FRESH_SESSION_CANARY_OBSERVED' : discoveryFailureCode(outcome),
      isolated_cwd_sha256: sha256(scratchRealpath),
      fresh_process_pid: outcome.pid,
      process_exit_code: outcome.status,
      process_signal: outcome.signal,
      timed_out: outcome.timedOut,
      output_overflow: outcome.outputOverflow,
      canary_output_sha256: sha256(outcome.stdout),
      canary_stderr_sha256: sha256(outcome.stderr),
      stdout: outcome.stdout,
      stderr: outcome.stderr,
    };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function defaultPublicRunner(
  command: string,
  argv: readonly string[],
  environment?: NodeJS.ProcessEnv,
): PublicCommandOutcomeV1 {
  const result = spawnSync(command, [...argv], {
    encoding: 'utf8',
    env: environment,
    timeout: 2_000,
    maxBuffer: 64 * 1024,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error?.message,
  };
}

function defaultFreshProcessRunner(
  request: Readonly<FreshProcessRequestV1>,
): Promise<FreshProcessOutcomeV1> {
  return new Promise((resolve) => {
    let stdout: Buffer = Buffer.alloc(0);
    let stderr: Buffer = Buffer.alloc(0);
    let timedOut = false;
    let outputOverflow = false;
    let settled = false;
    const child = spawn(request.executable, [...request.argv], {
      cwd: request.cwd,
      env: request.environment,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (
      status: number | null,
      signal: NodeJS.Signals | null,
      error?: string,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        pid: child.pid ?? null,
        status,
        signal,
        stdout: stdout.toString('utf8'),
        stderr: stderr.toString('utf8'),
        timedOut,
        outputOverflow,
        ...(error === undefined ? {} : { error: redactDiagnostic(error, 512) }),
      });
    };
    const append = (current: Buffer, chunk: Buffer): Buffer => {
      const combined = Buffer.concat([current, chunk]);
      if (combined.length <= request.maximumOutputBytes) return combined;
      outputOverflow = true;
      child.kill('SIGKILL');
      return combined.subarray(0, request.maximumOutputBytes);
    };
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => finish(null, null, error.message));
    child.once('close', (status, signal) => finish(status, signal));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, request.timeoutMs);
    timer.unref();
  });
}

function unobservedDiscovery(
  base: Pick<FreshPluginDiscoveryResultV1,
  | 'command_argv'
  | 'agy_realpath_sha256'
  | 'agy_version'
  | 'agy_version_sha256'
  | 'candidate_oid'
  | 'package_digest'
  | 'installed_digest'
  | 'installed_realpath_sha256'
  | 'installed_version'
  | 'registry_list_sha256'>,
  detailCode: string,
): FreshPluginDiscoveryResultV1 {
  return {
    ...base,
    status: 'unobserved',
    evidence_tier: 'T0',
    detail_code: detailCode,
    isolated_cwd_sha256: null,
    fresh_process_pid: null,
    process_exit_code: null,
    process_signal: null,
    timed_out: false,
    output_overflow: false,
    canary_output_sha256: sha256(''),
    canary_stderr_sha256: sha256(''),
    stdout: '',
    stderr: '',
  };
}

function discoveryFailureCode(outcome: Readonly<FreshProcessOutcomeV1>): string {
  if (outcome.timedOut) return 'FRESH_SESSION_CANARY_TIMEOUT';
  if (outcome.outputOverflow) return 'FRESH_SESSION_CANARY_OUTPUT_OVERFLOW';
  if (outcome.error !== undefined) return 'FRESH_SESSION_CANARY_PROCESS_ERROR';
  if (outcome.status !== 0 || outcome.signal !== null) return 'FRESH_SESSION_CANARY_PROCESS_FAILED';
  return 'FRESH_SESSION_CANARY_MISMATCH';
}

function safeRun(
  run: PublicCommandRunnerV1,
  command: string,
  argv: readonly string[],
): PublicCommandOutcomeV1 {
  try { return run(command, argv); } catch (error) {
    return {
      status: null,
      stdout: '',
      stderr: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function capability(
  name: NativeCapabilityViewV1['capability'],
  observed: boolean,
): NativeCapabilityViewV1 {
  return {
    capability: name,
    status: observed ? 'observed' : 'unobserved',
    evidence_tier: observed ? 'T1' : 'T0',
  };
}

function boundedDiagnostic(value: string): string {
  return redactDiagnostic(value, 512);
}

function validExecutable(value: string): boolean {
  return value.length > 0 && value.length <= 4096 && !/[\0\r\n]/u.test(value);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

export interface CanonicalAgyIdentityV1 {
  readonly realpath: string;
  readonly sha256: string;
  readonly byte_length: number;
}

export function resolveCanonicalAgyIdentity(): CanonicalAgyIdentityV1 {
  const executableName = process.platform === 'win32' ? 'agy.exe' : 'agy';
  const expected = path.join(os.homedir(), '.local', 'bin', executableName);
  const resolvedFromPath = resolveFromPath(executableName);
  if (resolvedFromPath === null) throw new Error('canonical agy executable is not on PATH');
  if (!fs.existsSync(expected)) throw new Error('canonical agy executable is not installed');
  const expectedRealpath = fs.realpathSync(expected);
  const pathRealpath = fs.realpathSync(resolvedFromPath);
  if (pathRealpath !== expectedRealpath || path.dirname(expectedRealpath) !== path.dirname(expected)) {
    throw new Error('agy executable does not match the canonical installed path');
  }
  const descriptor = fs.openSync(expectedRealpath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const before = fs.fstatSync(descriptor);
    if (!before.isFile() || (before.mode & 0o111) === 0 || before.size <= 0
      || before.size > 512 * 1024 * 1024) {
      throw new Error('canonical agy executable identity is unsafe');
    }
    if (typeof process.getuid === 'function' && before.uid !== process.getuid()) {
      throw new Error('canonical agy executable is not owned by the current user');
    }
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let position = 0;
    while (position < before.size) {
      const read = fs.readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position,
      );
      if (read <= 0) throw new Error('canonical agy executable changed during hashing');
      hash.update(buffer.subarray(0, read));
      position += read;
    }
    const after = fs.fstatSync(descriptor);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
      || after.mtimeMs !== before.mtimeMs) {
      throw new Error('canonical agy executable changed during hashing');
    }
    return {
      realpath: expectedRealpath,
      sha256: hash.digest('hex'),
      byte_length: before.size,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function resolveFromPath(name: string): string | null {
  for (const entry of (process.env.PATH ?? '').split(path.delimiter)) {
    if (entry.trim() === '') continue;
    const candidate = path.join(entry, name);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (stat.mode & 0o111) !== 0) return candidate;
    } catch {
      // Continue through the current process PATH without invoking a shell.
    }
  }
  return null;
}
