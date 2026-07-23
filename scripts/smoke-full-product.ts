/**
 * 本機產品 smoke：team start→deliver→tick + autopilot start→drive（mock agy）。
 * 執行：npx ts-node scripts/smoke-full-product.ts
 */
import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const MOCK_AGY = path.join(ROOT, 'e2e/mocks/agy');
const DIST_OMA = path.join(ROOT, 'dist/bin/oma.js');

function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv },
): { code: number; stdout: string; stderr: string } {
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    encoding: 'utf8',
  });
  return {
    code: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function main(): void {
  assert(fs.existsSync(DIST_OMA), 'dist/bin/oma.js missing — run npm run build');
  assert(fs.existsSync(MOCK_AGY), 'e2e/mocks/agy missing');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-smoke-'));
  const repo = path.join(scratch, 'repo');
  const stateRoot = path.join(scratch, 'state');
  fs.mkdirSync(repo);
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateRoot, 0o700);
  const identityModule = require(path.join(ROOT, 'dist/src/setup/installed-identity.js')) as {
    stageImmutablePackage(input: { packageRoot: string; stagesRoot: string }): {
      ok: boolean;
      value?: { stagePath: string; identity: { digest: string } };
      error?: unknown;
    };
    computePackageIdentity(packageRoot: string): {
      ok: boolean;
      value?: { digest: string };
      error?: unknown;
    };
  };
  const stagedInstall = identityModule.stageImmutablePackage({
    packageRoot: ROOT,
    stagesRoot: path.join(stateRoot, 'install', 'stages'),
  });
  assert(stagedInstall.ok && stagedInstall.value !== undefined, 'immutable package stage failed');
  const installedRoot = path.join(scratch, 'home', '.gemini', 'config', 'plugins', 'oh-my-agy');
  fs.mkdirSync(path.dirname(installedRoot), { recursive: true });
  fs.cpSync(stagedInstall.value.stagePath, installedRoot, { recursive: true, dereference: true });
  const installedIdentity = identityModule.computePackageIdentity(installedRoot);
  assert(installedIdentity.ok && installedIdentity.value !== undefined, 'installed identity unreadable');
  assert(
    installedIdentity.value.digest === stagedInstall.value.identity.digest,
    'installed identity differs from immutable stage',
  );
  console.log('INSTALL_IDENTITY_SMOKE_OK', installedIdentity.value.digest);
  const baseEnv: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: `${path.dirname(MOCK_AGY)}:${process.env.PATH ?? ''}`,
    OMA_STATE_ROOT: stateRoot,
    HOME: path.join(scratch, 'home'),
    OMA_ANTIGRAVITY_CONFIG_ROOT: path.join(scratch, 'home', '.gemini', 'config'),
    OMA_MANAGED_HEADLESS: '1',
    MOCK_AGY_EXIT_CODE: '0',
    MOCK_AGY_STDOUT: 'mock-agy-ok\n',
  };

  // --- git repo ---
  run('git', ['init', '-b', 'main'], { cwd: repo });
  run('git', ['config', 'user.email', 'smoke@test'], { cwd: repo });
  run('git', ['config', 'user.name', 'smoke'], { cwd: repo });
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', '.keep'), '');
  fs.writeFileSync(path.join(repo, 'README.md'), 'smoke\n');
  run('git', ['add', '.'], { cwd: repo });
  run('git', ['commit', '-m', 'init'], { cwd: repo });

  const holdJs = path.join(scratch, 'hold.js');
  fs.writeFileSync(
    holdJs,
    "require('fs').writeFileSync(process.argv[2],'ready\\n'); setInterval(()=>{},1000);\n",
  );

  console.log('=== 1) autopilot start → drive (first bind) ===');
  const apStart = run('node', [DIST_OMA, 'autopilot', 'start', '--', 'smoke goal for drive'], {
    cwd: repo,
    env: baseEnv,
  });
  console.log(apStart.stdout || apStart.stderr);
  assert(apStart.code === 0, `autopilot start failed: ${apStart.stderr}`);
  const startBody = JSON.parse(apStart.stdout);
  const drive = run('node', [
    DIST_OMA, 'autopilot', 'drive',
    '--session', startBody.sessionId,
    '--conversation', `conv-smoke-${crypto.randomBytes(4).toString('hex')}`,
    '--expected-revision', String(startBody.revision),
  ], { cwd: repo, env: baseEnv });
  console.log(drive.stdout || drive.stderr);
  assert(drive.code === 0, `autopilot drive failed: ${drive.stderr}\n${drive.stdout}`);
  const driveBody = JSON.parse(drive.stdout);
  assert(driveBody.ok === true && driveBody.kind === 'autopilot-driven', 'drive json not ok');
  assert(driveBody.process?.code === 0, 'drive process exit non-zero');

  console.log('=== 2) team start → deliver → tick ===');
  // Use unit-style orchestrator via node -e for deliver (CLI needs claim token from start)
  // Prefer CLI where possible; start with hold inject via direct orchestrator is cleaner.
  const script = `
const fs = require('fs');
const path = require('path');
const { TeamOrchestrator } = require(${JSON.stringify(path.join(ROOT, 'dist/src/team/orchestrator.js'))});
const { resolveGitWorktreeIdentity } = require(${JSON.stringify(path.join(ROOT, 'dist/src/team/worktree.js'))});
const { spawnSync } = require('child_process');
(async () => {
  const repo = ${JSON.stringify(repo)};
  const stateRoot = ${JSON.stringify(stateRoot)};
  const holdJs = ${JSON.stringify(holdJs)};
  const leader = resolveGitWorktreeIdentity(repo);
  const orch = new TeamOrchestrator({
    stateRoot, workspaceRoot: repo, repoKey: leader.repoKey, workspaceKey: leader.workspaceKey,
    managedWorktreesRoot: path.join(stateRoot, 'managed-worktrees'),
    sessionNamePrefix: 'smoke-' + process.pid,
    maxParallelWorkers: 1,
    tokenFactory: (() => { let n=0; return () => 's'+(++n); })(),
    workerExecutablePath: process.execPath,
    workerBootstrapArgv: [holdJs],
  });
  const m = path.join(${JSON.stringify(scratch)}, 'm.json');
  fs.writeFileSync(m, JSON.stringify({
    schema: 'oma.team-manifest/v1', teamId: 'smoke', revision: 1,
    tasks: [
      { id: 'a', dependencies: [], write_scope: [{kind:'dir',path:'src'}], mode: 'headless',
        verification: { version: 1, commands: [], requiredArtifacts: [] } },
      { id: 'b', dependencies: ['a'], write_scope: 'none', mode: 'read_only',
        verification: { version: 1, commands: [], requiredArtifacts: [] } },
    ],
  }));
  const started = await orch.startFromManifest(m, 'headless');
  if (!started.ok) { console.error(started.error); process.exit(1); }
  const w = started.value.workers[0];
  // commit in worktree
  fs.writeFileSync(path.join(w.worktreePath, 'src', 'feat.txt'), 'feat\\n');
  spawnSync('git', ['add', 'src/feat.txt'], { cwd: w.worktreePath });
  spawnSync('git', ['-c','user.email=s@t','-c','user.name=s','commit','-m','feat'], { cwd: w.worktreePath });
  const delivered = await orch.deliverTask({
    teamId: 'smoke', taskId: 'a', expectedRevision: started.value.aggregateRevision,
    claimToken: w.claimToken, generation: w.generation, worktreePath: w.worktreePath,
  });
  if (!delivered.ok) { console.error(JSON.stringify(delivered.error)); process.exit(2); }
  console.log('delivered', delivered.value.status, delivered.value.integrationTip);
  await orch.stop('smoke');
  // complete path for b via tick after a completed
  const tick = await orch.tick('smoke', 'headless');
  if (!tick.ok) { console.error(tick.error); process.exit(3); }
  console.log('tick started', tick.value.started.map(x => x.taskId));
  if (tick.value.started.length !== 1 || tick.value.started[0].taskId !== 'b') process.exit(4);
  await orch.stop('smoke');
  console.log('TEAM_SMOKE_OK');
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(9); });
`;
  const teamRun = run('node', ['-e', script], { cwd: repo, env: baseEnv });
  console.log(teamRun.stdout || teamRun.stderr);
  assert(teamRun.code === 0, `team smoke failed code=${teamRun.code}`);

  console.log('=== 3) CLI help lists new commands ===');
  const help = run('node', [DIST_OMA, '--help'], { cwd: repo, env: baseEnv });
  assert(help.stdout.includes('team deliver'), 'help missing deliver');
  assert(help.stdout.includes('team supervise'), 'help missing supervise');
  assert(help.stdout.includes('autopilot drive'), 'help missing drive');

  console.log('ALL_SMOKE_OK', scratch);
}

main();
