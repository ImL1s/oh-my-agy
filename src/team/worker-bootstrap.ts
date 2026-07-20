/**
 * 設計概念映射：Team worker bootstrap，對齊 OMC team pane 啟動 CLI worker。
 * 讀 descriptor + 可選 capability 檔，spawn agy（或 descriptor.agyCommand），stdio inherit；結束碼透傳。
 * argv: [markerPath, descriptorPath]（TmuxController 附加 descriptor 為最後一參）
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

interface WorkerDescriptorV1 {
  schemaVersion: 1;
  teamId: string;
  taskId: string;
  workerId: string;
  generation: number;
  workerMode: 'interactive' | 'headless' | string;
  claimTokenDigest: string;
  worktreePath: string;
  stateRoot: string;
  sessionId?: string;
  launchNonce?: string;
  invocationGeneration?: number;
  agyCommand?: string;
  taskPrompt?: string;
  packageRoot?: string;
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
    desc = JSON.parse(fs.readFileSync(descriptorPath, 'utf8')) as WorkerDescriptorV1;
  } catch (error) {
    process.stderr.write(`worker-bootstrap: bad descriptor: ${
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
  };
  if (desc.packageRoot) env.OMA_PACKAGE_ROOT = desc.packageRoot;
  // claim 明文僅經 env 短生命週期交給子程序；descriptor 永不寫明文
  if (claimToken !== '') env.OMA_CLAIM_TOKEN = claimToken;

  const agy = desc.agyCommand && desc.agyCommand.trim() !== '' ? desc.agyCommand : 'agy';
  const prompt = desc.taskPrompt && desc.taskPrompt.trim() !== ''
    ? desc.taskPrompt
    : `Execute team task ${desc.taskId}`;
  const child = spawn(agy, [prompt], {
    cwd: desc.worktreePath,
    env,
    stdio: 'inherit',
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

main();
