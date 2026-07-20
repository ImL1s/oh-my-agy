import * as fs from 'fs';
import * as path from 'path';
import { TeamOrchestrator } from '../../src/team/orchestrator';
import { resolveGitWorktreeIdentity } from '../../src/team/worktree';
import { GitFixture } from '../helpers/git-fixture';
import { TmuxFixture } from '../helpers/tmux-fixture';

const maybe = TmuxFixture.available() ? test : test.skip;

describe('TeamOrchestrator v1 vertical slice', () => {
  let fixture: GitFixture;
  let tmux: TmuxFixture;

  beforeEach(() => {
    fixture = GitFixture.create();
    tmux = new TmuxFixture();
  });

  afterEach(() => {
    tmux.cleanup();
    tmux.assertClean();
    fixture.cleanup();
  });

  maybe('ORCH-01 starts first ready task: worktree + owned tmux + claim + heartbeat', async () => {
    const leader = resolveGitWorktreeIdentity(fixture.repo);
    const manifestPath = path.join(fixture.root, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      schema: 'oma.team-manifest/v1',
      teamId: 'alpha',
      revision: 1,
      tasks: [{
        id: 'task-a',
        dependencies: [],
        // headless 不可用 write_scope none（manifest 契約）
        write_scope: [{ kind: 'file', path: 'task-a.txt' }],
        mode: 'headless',
        verification: { version: 1, commands: [], requiredArtifacts: [] },
      }],
    }));

    // 測試隔離：寫入 fixture 內 hold 腳本，避免依賴 ts-node / dist 解析
    const holdJs = path.join(fixture.root, 'hold.js');
    fs.writeFileSync(holdJs, [
      "const fs = require('fs');",
      'const marker = process.argv[2];',
      "if (!marker) { process.stderr.write('marker required\\n'); process.exit(2); }",
      "fs.writeFileSync(marker, 'ready\\n');",
      'setInterval(() => {}, 1000);',
      '',
    ].join('\n'), 'utf8');

    // sessionNamePrefix 供 orchestrator 組 session；再預先登記衍生 session 以便 cleanup
    const sessionNamePrefix = tmux.session('orch');
    tmux.session('orch-task-a-g1');

    const orch = new TeamOrchestrator({
      stateRoot: fixture.stateRoot,
      workspaceRoot: fixture.repo,
      repoKey: leader.repoKey,
      workspaceKey: leader.workspaceKey,
      managedWorktreesRoot: fixture.managedWorktreesRoot,
      sessionNamePrefix,
      tokenFactory: (() => {
        let n = 0;
        return () => `tok-${++n}`;
      })(),
      nowMs: () => 1_700_000_000_000,
      leaseMs: 60_000,
      workerExecutablePath: process.execPath,
      workerBootstrapArgv: [holdJs],
    });

    const started = await orch.startFromManifest(manifestPath, 'headless');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(started.value.teamId).toBe('alpha');
    expect(started.value.workers).toHaveLength(1);
    const worker = started.value.workers[0];
    expect(worker.taskId).toBe('task-a');
    expect(worker.generation).toBe(1);
    expect(worker.claimToken).toBeTruthy();
    expect(worker.sessionName).toBe(`${sessionNamePrefix}-task-a-g1`);
    expect(fs.existsSync(worker.worktreePath)).toBe(true);
    expect(tmux.hasSession(worker.sessionName)).toBe(true);

    const status = await orch.status(started.value.teamId);
    expect(status.ok).toBe(true);
    if (!status.ok) return;
    expect(status.value.tasks['task-a'].status).toBe('in_progress');
    expect(status.value.heartbeats['task-a']).toBeDefined();
    expect(status.value.tmux[worker.sessionName].alive).toBe(true);

    const stopped = await orch.stop(started.value.teamId);
    expect(stopped.ok).toBe(true);
    if (!stopped.ok) return;
    expect(stopped.value.killedSessions).toContain(worker.sessionName);
    expect(tmux.hasSession(worker.sessionName)).toBe(false);
  }, 20_000);
});
