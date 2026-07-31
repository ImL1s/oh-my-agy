/**
 * 設計概念映射：Team worker bootstrap，對齊 OMC team pane 啟動 CLI worker。
 * 讀 descriptor + 可選 capability 檔，spawn agy（或 descriptor.agyCommand），stdio inherit；結束碼透傳。
 * argv: [markerPath, descriptorPath]（TmuxController 附加 descriptor 為最後一參）
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { sha256 } from '../runtime/atomic';
import { buildAgy115Argv } from './agy-argv';
import { isCanonicalTeamIdentifier } from './manifest';
import { consumeWorkerRouteAuthority } from './route-authority';

interface WorkerDescriptorV1 {
  schemaVersion: 1;
  teamId: string;
  taskId: string;
  workerId: string;
  generation: number;
  workerMode: 'interactive' | 'headless';
  claimTokenDigest: string;
  worktreePath: string;
  stateRoot: string;
  sessionId?: string;
  launchNonce?: string;
  invocationGeneration?: number;
  agyCommand: string;
  taskPrompt?: string;
  packageRoot?: string;
  provider: 'agy_headless' | 'tmux_agy';
  providerProfileDigest: string;
  routeReceiptDigest: string;
  routeContextDigest: string;
  routeAuthorityDigest: string;
  capabilityMode?: 'read-only' | 'read-write';
  boundedDuration?: string;
  conversationId?: string;
}

function main(): void {
  const markerPath = process.argv[2];
  const descriptorPath = process.argv[3];
  if (!markerPath || markerPath.includes('\0')) {
    process.stderr.write('worker-bootstrap: marker path required\n');
    process.exit(2);
  }
  if (!descriptorPath || !fs.existsSync(descriptorPath)) {
    process.stderr.write('worker-bootstrap: descriptor path required\n');
    process.exit(2);
  }

  let desc: WorkerDescriptorV1;
  try {
    const descriptorStat = fs.lstatSync(descriptorPath);
    if (!descriptorStat.isFile() || descriptorStat.isSymbolicLink()
      || descriptorStat.size < 1 || descriptorStat.size > 64 * 1024) {
      throw new Error('descriptor type or size is invalid');
    }
    desc = validateWorkerDescriptor(JSON.parse(fs.readFileSync(descriptorPath, 'utf8')));
  } catch (error) {
    process.stderr.write(`worker-bootstrap: bad descriptor: ${
      error instanceof Error ? error.message : String(error)
    }\n`);
    process.exit(1);
  }
  try {
    const canonicalWorktree = fs.realpathSync(desc.worktreePath);
    const canonicalDescriptor = fs.realpathSync(descriptorPath);
    const markerRelative = path.relative(canonicalWorktree, path.resolve(markerPath));
    const descriptorRelative = path.relative(canonicalWorktree, canonicalDescriptor);
    if (canonicalWorktree !== desc.worktreePath
      || markerRelative.startsWith('..') || path.isAbsolute(markerRelative)
      || descriptorRelative.startsWith('..') || path.isAbsolute(descriptorRelative)) {
      throw new Error('descriptor/marker paths are outside the canonical worktree');
    }
  } catch (error) {
    process.stderr.write(`worker-bootstrap: bad descriptor: ${
      error instanceof Error ? error.message : String(error)
    }\n`);
    process.exit(1);
  }

  // 設計概念映射：bootstrap 僅消費 leader 已驗證的 route receipt binding；
  // 不得依 workerMode、PATH 或版本自行選 provider。
  try {
    const requestMode = desc.provider === 'agy_headless' ? 'headless' : 'interactive';
    const authority = consumeWorkerRouteAuthority({
      stateRoot: desc.stateRoot,
      teamId: desc.teamId,
      taskId: desc.taskId,
      generation: desc.generation,
      contextDigest: desc.routeContextDigest,
      provider: desc.provider,
      requestMode,
      resolvedExecutable: desc.agyCommand,
      now: new Date().toISOString(),
    });
    const executableRealpath = fs.realpathSync(desc.agyCommand);
    const executableDigest = sha256(fs.readFileSync(executableRealpath));
    if (authority.authorityDigest !== desc.routeAuthorityDigest
      || authority.profile.profileDigest !== desc.providerProfileDigest
      || authority.receipt.receiptDigest !== desc.routeReceiptDigest
      || executableRealpath !== authority.profile.hostIdentity.realpath
      || executableDigest !== authority.profile.hostIdentity.binarySha256) {
      throw new Error('route authority or executable identity binding is invalid');
    }
  } catch (error) {
    process.stderr.write(`worker-bootstrap: descriptor lacks valid profile-backed route authority: ${
      error instanceof Error ? error.message : String(error)
    }\n`);
    process.exit(1);
  }

  try {
    fs.writeFileSync(markerPath, `ready ${new Date().toISOString()}\n`, 'utf8');
  } catch (error) {
    process.stderr.write(`worker-bootstrap: cannot write marker: ${
      error instanceof Error ? error.message : String(error)
    }\n`);
    process.exit(1);
  }

  const capPath = path.join(path.dirname(descriptorPath), '.oma', 'worker-capability.json');
  let claimToken = '';
  if (fs.existsSync(capPath)) {
    try {
      claimToken = String(JSON.parse(fs.readFileSync(capPath, 'utf8')).claimToken ?? '');
    } catch (_) {
      claimToken = '';
    }
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OMA_SESSION_ID: desc.sessionId ?? '',
    OMA_LAUNCH_NONCE: desc.launchNonce ?? '',
    OMA_INVOCATION_GENERATION: String(desc.invocationGeneration ?? 1),
    OMA_WORKSPACE_PATH: desc.worktreePath,
    OMA_STATE_ROOT: desc.stateRoot,
    OMA_TEAM_ID: desc.teamId,
    OMA_TASK_ID: desc.taskId,
    OMA_CLAIM_TOKEN_DIGEST: desc.claimTokenDigest,
    OMA_WORKER_PROVIDER: desc.provider,
    OMA_PROVIDER_PROFILE_DIGEST: desc.providerProfileDigest,
    OMA_ROUTE_RECEIPT_DIGEST: desc.routeReceiptDigest,
  };
  if (desc.packageRoot) env.OMA_PACKAGE_ROOT = desc.packageRoot;
  // claim 明文僅經 env 短生命週期交給子程序；descriptor 永不寫明文
  if (claimToken !== '') env.OMA_CLAIM_TOKEN = claimToken;

  const agy = desc.agyCommand;
  const prompt = desc.taskPrompt && desc.taskPrompt.trim() !== ''
    ? desc.taskPrompt
    : `Execute team task ${desc.taskId}`;
  const provider = desc.provider;
  const launchMode = provider === 'agy_headless' ? 'headless' : 'interactive';
  const argv = buildAgy115Argv({
    launchMode,
    capabilityMode: desc.capabilityMode ?? 'read-write',
    prompt,
    ...(desc.boundedDuration === undefined ? {} : { boundedDuration: desc.boundedDuration }),
    ...(desc.conversationId === undefined ? {} : { conversationId: desc.conversationId }),
  });
  if (!argv.ok) {
    process.stderr.write(`worker-bootstrap: invalid Antigravity argv: ${argv.error.message}\n`);
    try { fs.rmSync(capPath, { force: true }); } catch (_) { /* best-effort */ }
    process.exit(1);
  }
  const child = spawn(agy, [...argv.value], {
    cwd: desc.worktreePath,
    env,
    stdio: 'inherit',
    shell: false,
  });

  child.on('error', (error) => {
    process.stderr.write(`worker-bootstrap: spawn failed: ${error.message}\n`);
    try { fs.rmSync(capPath, { force: true }); } catch (_) { /* best-effort */ }
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    try { fs.rmSync(capPath, { force: true }); } catch (_) { /* best-effort */ }
    if (signal === 'SIGINT') process.exit(130);
    process.exit(code ?? 1);
  });
}

function validateWorkerDescriptor(value: unknown): WorkerDescriptorV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('descriptor must be an object');
  }
  const desc = value as Record<string, unknown>;
  const required = [
    'schemaVersion', 'teamId', 'taskId', 'workerId', 'generation', 'workerMode', 'claimTokenDigest',
    'worktreePath', 'stateRoot', 'agyCommand', 'provider', 'providerProfileDigest', 'routeReceiptDigest',
    'routeContextDigest', 'routeAuthorityDigest',
  ];
  const optional = [
    'sessionId', 'launchNonce', 'invocationGeneration', 'taskPrompt', 'packageRoot', 'capabilityMode',
    'boundedDuration', 'conversationId',
  ];
  if (required.some((key) => !Object.prototype.hasOwnProperty.call(desc, key))
    || Object.keys(desc).some((key) => !required.includes(key) && !optional.includes(key))) {
    throw new Error('descriptor keys are invalid');
  }
  const digest = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
  const safeString = (entry: unknown): entry is string =>
    typeof entry === 'string' && entry !== '' && !entry.includes('\0') && !entry.includes('\n');
  const provider = desc.provider;
  const workerMode = desc.workerMode;
  const modeMatches = provider === 'agy_headless'
    ? workerMode === 'headless'
    : provider === 'tmux_agy' && workerMode === 'interactive';
  if (desc.schemaVersion !== 1 || !Number.isSafeInteger(desc.generation) || Number(desc.generation) < 1
    || !isCanonicalTeamIdentifier(desc.teamId) || !isCanonicalTeamIdentifier(desc.taskId)
    || desc.workerId !== desc.taskId
    || !safeString(desc.claimTokenDigest) || !digest(desc.claimTokenDigest)
    || !safeString(desc.worktreePath) || !path.isAbsolute(desc.worktreePath)
    || !safeString(desc.stateRoot) || !path.isAbsolute(desc.stateRoot)
    || !safeString(desc.agyCommand) || !path.isAbsolute(desc.agyCommand)
    || (provider !== 'agy_headless' && provider !== 'tmux_agy') || !modeMatches
    || !digest(desc.providerProfileDigest) || !digest(desc.routeReceiptDigest)
    || !digest(desc.routeContextDigest) || !digest(desc.routeAuthorityDigest)) {
    throw new Error('descriptor identity, route, or path fields are invalid');
  }
  for (const key of optional) {
    const entry = desc[key];
    if (entry !== undefined && key === 'invocationGeneration') {
      if (!Number.isSafeInteger(entry) || Number(entry) < 1) throw new Error('descriptor invocation generation is invalid');
    } else if (entry !== undefined && !safeString(entry)) {
      throw new Error(`descriptor ${key} is invalid`);
    }
  }
  if (desc.capabilityMode !== undefined && desc.capabilityMode !== 'read-only' && desc.capabilityMode !== 'read-write') {
    throw new Error('descriptor capability mode is invalid');
  }
  return desc as unknown as WorkerDescriptorV1;
}

main();
