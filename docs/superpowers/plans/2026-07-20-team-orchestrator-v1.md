# Team Orchestrator v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the existing Team library parts so `oma team start --manifest` actually creates a managed git worktree, starts an owned tmux worker pane, claims the first ready task, and records heartbeat — plus minimal `status` / `stop`.

**Architecture:** Add a thin `TeamOrchestrator` in `src/team/orchestrator.ts` that composes `validateTeamManifest` → `TeamStateStore.create` → `GitWorktreeManager.create` → `TeamStateStore.claimTask` → `TmuxController.startWorker` → `TeamStateStore.recordHeartbeat`. CLI `teamCommand` becomes a thin argv→orchestrator adapter. Worker process for v1 is a long-lived Node bootstrap that keeps the pane alive and writes a marker file (real `agy` launch is a later plan). No delivery/integration/publish/supervisor loop in this plan.

**Tech Stack:** TypeScript (strict), Node 20+, Jest (`ts-jest`), real `git` + real `tmux` in unit tests (skip if tmux missing), spawnSync for tmux (existing pattern).

**Out of scope (separate plans):** `--madmax` / confirmDangerousLaunch; Autopilot process drive (`resumeConversation` wiring); multi-task DAG scheduling; delivery→integration→publish; supervisor poll loop; AuthorityLease/Saga.

**Spec source:** Fable 5 review §2 + §6 P0-1 / P1-4 (`.omc/research/fable-review/fable5-full-review.md`).

---

## File map

| Path | Responsibility |
|------|----------------|
| `src/team/orchestrator.ts` | **Create** — `TeamOrchestrator` start/status/stop vertical slice |
| `src/team/worker-hold.ts` | **Create** — tiny worker bootstrap (hold pane + write ready marker) |
| `src/team/commands.ts` | **Modify** — wire start to orchestrator; add `status` / `stop` parse + dispatch |
| `src/cli/application.ts` | **Modify** — help text for new team subcommands |
| `README.md` | **Modify** — honest team start/status/stop docs |
| `skills/oma-runtime/SKILL.md` | **Modify** if present — remove hallucinated commands / align |
| `tests/team/orchestrator.spec.ts` | **Create** — real git + real tmux integration for start/status/stop |
| `tests/team/commands.spec.ts` | **Modify** — CLI start no longer stub; status/stop flags |

**Reuse (do not reimplement):**
- `src/team/tmux.ts` — `TmuxController`
- `src/team/worktree.ts` — `GitWorktreeManager`, `resolveGitWorktreeIdentity`
- `src/team/state.ts` — `TeamStateStore`
- `src/team/manifest.ts` — `validateTeamManifest`
- `tests/helpers/git-fixture.ts`, `tests/helpers/tmux-fixture.ts`

**Naming conventions (repo):** PascalCase types/classes; camelCase functions; UPPER_SNAKE constants; Traditional Chinese comments with design mapping; never `exec` — only `spawn`/`spawnSync`.

---

### Task 1: TeamOrchestrator — start first ready task (library)

**Files:**
- Create: `src/team/orchestrator.ts`
- Create: `src/team/worker-hold.ts`
- Create: `tests/team/orchestrator.spec.ts`

- [ ] **Step 1: Write the failing orchestrator test**

Create `tests/team/orchestrator.spec.ts`:

```typescript
import * as fs from 'fs';
import * as path from 'path';
import { GitFixture } from '../helpers/git-fixture';
import { TmuxFixture } from '../helpers/tmux-fixture';
import { TeamOrchestrator } from '../../src/team/orchestrator';
import { resolveGitWorktreeIdentity } from '../../src/team/worktree';

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
        write_scope: 'none',
        mode: 'headless',
        verification: { version: 1, commands: [], requiredArtifacts: [] },
      }],
    }));

    const orch = new TeamOrchestrator({
      stateRoot: fixture.stateRoot,
      workspaceRoot: fixture.repo,
      repoKey: leader.repoKey,
      workspaceKey: leader.workspaceKey,
      managedWorktreesRoot: fixture.managedWorktreesRoot,
      sessionNamePrefix: tmux.session('orch'),
      tokenFactory: (() => {
        let n = 0;
        return () => `tok-${++n}`;
      })(),
      nowMs: () => 1_700_000_000_000,
      leaseMs: 60_000,
      workerHoldScriptPath: require.resolve('../../src/team/worker-hold.ts'),
    });

    const started = await orch.startFromManifest(manifestPath, 'headless');
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    expect(started.value.teamId).toBe('alpha');
    expect(started.value.workers).toHaveLength(1);
    const worker = started.value.workers[0];
    expect(worker.taskId).toBe('task-a');
    expect(worker.generation).toBe(1);
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
    expect(tmux.hasSession(worker.sessionName)).toBe(false);
  }, 20000);
});
```

Notes for implementer:
- `TmuxFixture.session(name)` already exists in `tests/helpers/tmux-fixture.ts` and returns a unique session name; if the API differs, read that file and match it (prefix uniqueness is required to avoid cross-test leaks).
- If `require.resolve('../../src/team/worker-hold.ts')` fails under Jest, pass an absolute path to a **compiled** hold script written into the temp fixture by the test, or use `process.execPath` + inline `setInterval` file written in the test (preferred for isolation). Prefer writing a hold script into `fixture.root` if resolution is flaky:

```typescript
const holdJs = path.join(fixture.root, 'hold.js');
fs.writeFileSync(holdJs, `
const fs = require('fs');
const marker = process.argv[2];
fs.writeFileSync(marker, 'ready\\n');
setInterval(() => {}, 1000);
`);
// pass workerExecutable = process.execPath, workerArgvPrefix = [holdJs]
```

Adjust `TeamOrchestrator` options so tests inject `workerExecutablePath` + `workerBootstrapArgv` rather than depending on ts-node.

- [ ] **Step 2: Run test to verify it fails**

```bash
cd ~/src/oh-my-agy
npx jest tests/team/orchestrator.spec.ts --runInBand
```

Expected: FAIL — `Cannot find module '../../src/team/orchestrator'` (or similar).

- [ ] **Step 3: Implement `worker-hold` bootstrap (minimal)**

Create `src/team/worker-hold.ts`:

```typescript
/**
 * 設計概念映射：Team v1 worker hold 程序。
 * 僅維持 tmux pane 存活並寫入 ready marker；不啟動 agy（後續 plan）。
 * argv: [markerPath, descriptorPath?]
 */
import * as fs from 'fs';

const markerPath = process.argv[2];
if (!markerPath || markerPath.includes('\0')) {
  process.stderr.write('worker-hold: marker path required\n');
  process.exit(2);
}
try {
  fs.writeFileSync(markerPath, `ready ${new Date().toISOString()}\n`, 'utf8');
} catch (error) {
  process.stderr.write(`worker-hold: cannot write marker: ${
    error instanceof Error ? error.message : String(error)
  }\n`);
  process.exit(1);
}
setInterval(() => {}, 60_000);
```

Also ensure package/tsconfig compiles this file (it lives under `src/team/`, so `tsc` already includes it). For tmux spawn in production, orchestrator will run:

`node <dist-or-src-path>/worker-hold.js <marker> <descriptor.json>`

In tests, inject `process.execPath` + hold script path as in Step 1 note.

- [ ] **Step 4: Implement `TeamOrchestrator`**

Create `src/team/orchestrator.ts` with this public surface (exact names):

```typescript
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { runtimeError, RuntimeError } from '../runtime/errors';
import { Result, err, ok } from '../runtime/types';
import { validateTeamManifest } from './manifest';
import { TeamStateStore } from './state';
import { TmuxController } from './tmux';
import { GitWorktreeManager, resolveGitWorktreeIdentity } from './worktree';
import {
  CanonicalTeamManifestV1,
  SupervisorHeartbeatV1,
  TeamAggregateV1,
  TeamTaskRuntimeV1,
} from './types';

export interface TeamOrchestratorOptions {
  stateRoot: string;
  workspaceRoot: string;
  repoKey: string | null;
  workspaceKey: string;
  managedWorktreesRoot: string;
  /** Prefixed unique base for tmux session names; default `oma-${teamId}` */
  sessionNamePrefix?: string;
  tokenFactory?: () => string;
  nowMs?: () => number;
  leaseMs?: number;
  tmux?: TmuxController;
  worktrees?: GitWorktreeManager;
  /** Default: process.execPath */
  workerExecutablePath?: string;
  /**
   * Bootstrap argv inserted between executable and marker/descriptor.
   * Default: path to compiled worker-hold.js relative to package, resolved by caller.
   * Tests inject e.g. [holdJsPath].
   */
  workerBootstrapArgv?: readonly string[];
  /** Absolute path to worker-hold entry (js). Required if workerBootstrapArgv omitted. */
  workerHoldEntryPath?: string;
}

export interface StartedWorkerView {
  taskId: string;
  generation: number;
  sessionName: string;
  paneId: string;
  worktreePath: string;
  branchName: string;
  claimToken: string;
  markerPath: string;
}

export interface StartTeamView {
  teamId: string;
  ownerNonce: string;
  aggregateRevision: number;
  workers: StartedWorkerView[];
}

export interface TeamStatusView {
  teamId: string;
  revision: number;
  ownerNonce: string;
  tasks: Readonly<Record<string, TeamTaskRuntimeV1>>;
  heartbeats: TeamAggregateV1['heartbeats'];
  tmux: Readonly<Record<string, { alive: boolean; paneId?: string }>>;
}

export interface StopTeamView {
  teamId: string;
  killedSessions: string[];
}

export class TeamOrchestrator {
  private readonly stateRoot: string;
  private readonly workspaceRoot: string;
  private readonly repoKey: string | null;
  private readonly workspaceKey: string;
  private readonly managedWorktreesRoot: string;
  private readonly sessionNamePrefix: string | undefined;
  private readonly tokenFactory: () => string;
  private readonly nowMs: () => number;
  private readonly leaseMs: number;
  private readonly tmux: TmuxController;
  private readonly worktrees: GitWorktreeManager;
  private readonly workerExecutablePath: string;
  private readonly workerBootstrapArgv: readonly string[];

  constructor(options: Readonly<TeamOrchestratorOptions>) {
    this.stateRoot = options.stateRoot;
    this.workspaceRoot = fs.realpathSync(options.workspaceRoot);
    this.repoKey = options.repoKey;
    this.workspaceKey = options.workspaceKey;
    this.managedWorktreesRoot = options.managedWorktreesRoot;
    this.sessionNamePrefix = options.sessionNamePrefix;
    this.tokenFactory = options.tokenFactory
      ?? (() => crypto.randomBytes(16).toString('hex'));
    this.nowMs = options.nowMs ?? (() => Date.now());
    this.leaseMs = options.leaseMs ?? 300_000;
    this.tmux = options.tmux ?? new TmuxController();
    this.worktrees = options.worktrees
      ?? new GitWorktreeManager(this.workspaceRoot, options.managedWorktreesRoot);
    this.workerExecutablePath = options.workerExecutablePath ?? process.execPath;
    if (options.workerBootstrapArgv !== undefined) {
      this.workerBootstrapArgv = options.workerBootstrapArgv;
    } else if (options.workerHoldEntryPath !== undefined) {
      this.workerBootstrapArgv = [options.workerHoldEntryPath];
    } else {
      // production default: dist next to this module
      const entry = path.resolve(__dirname, 'worker-hold.js');
      this.workerBootstrapArgv = [entry];
    }
  }

  async startFromManifest(
    manifestPath: string,
    workerMode: 'interactive' | 'headless',
  ): Promise<Result<StartTeamView, RuntimeError>> {
    if (!fs.existsSync(manifestPath)) {
      return err(runtimeError('E_MANIFEST_INVALID', `manifest not found: ${manifestPath}`));
    }
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      return err(runtimeError(
        'E_MANIFEST_INVALID',
        `cannot parse manifest: ${error instanceof Error ? error.message : String(error)}`,
      ));
    }
    const validated = validateTeamManifest(raw, this.workspaceRoot);
    if (!validated.ok) return validated;

    const ownerNonce = this.tokenFactory();
    const store = new TeamStateStore(
      this.stateRoot,
      this.repoKey,
      this.workspaceKey,
      validated.value.teamId,
    );
    const created = await store.create(
      validated.value,
      ownerNonce,
      this.repoKey,
      this.workspaceKey,
    );
    if (!created.ok) return created;

    const ready = pickFirstReadyTask(validated.value);
    if (ready === null) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'No ready task with empty dependencies'));
    }

    // v1: only first ready task
    const baseSha = gitHead(this.workspaceRoot);
    if (!baseSha.ok) return baseSha;

    const workerId = ready.id;
    const generation = 1;
    const branchName = `oma-team/${validated.value.teamId}/${workerId}-g${generation}`;
    const worktree = this.worktrees.create({
      teamId: validated.value.teamId,
      workerId,
      generation,
      branchName,
      baseSha: baseSha.value,
      ownerNonce,
    });
    if (!worktree.ok) return worktree;

    const claimToken = this.tokenFactory();
    const claimed = await store.claimTask(
      ready.id,
      workerId,
      created.value.revision,
      this.nowMs(),
      this.leaseMs,
      claimToken,
    );
    if (!claimed.ok) {
      // best-effort cleanup worktree if clean at base
      this.worktrees.removeIfSafe(worktree.value, { ownerNonce, integrated: true });
      return claimed;
    }

    const sessionBase = this.sessionNamePrefix
      ?? `oma-${validated.value.teamId}`;
    const sessionName = sanitizeSession(`${sessionBase}-${workerId}-g${generation}`);
    const markerPath = path.join(worktree.value.path, '.oma-worker-ready');
    const descriptorPath = path.join(worktree.value.path, '.oma-worker-descriptor.json');
    const descriptor = {
      schemaVersion: 1 as const,
      teamId: validated.value.teamId,
      taskId: ready.id,
      workerId,
      generation,
      workerMode,
      claimTokenDigest: crypto.createHash('sha256').update(claimToken, 'utf8').digest('hex'),
      worktreePath: worktree.value.path,
      stateRoot: this.stateRoot,
    };
    fs.writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');

    const workerNonce = this.tokenFactory();
    const pane = this.tmux.startWorker({
      sessionName,
      cwd: worktree.value.path,
      executablePath: this.workerExecutablePath,
      descriptorPath,
      bootstrapArgv: [...this.workerBootstrapArgv, markerPath],
      ownerNonce,
      workerNonce,
    });
    if (!pane.ok) {
      this.worktrees.removeIfSafe(worktree.value, { ownerNonce, integrated: true });
      return pane;
    }

    const heartbeat: SupervisorHeartbeatV1 = {
      schemaVersion: 1,
      workerId,
      ownerNonce,
      workerNonce,
      process: { pid: process.pid, startMarker: `tmux:${sessionName}` },
      paneId: pane.value.paneId,
      recordedAtMs: this.nowMs(),
    };
    const hb = await store.recordHeartbeat(claimed.value.revision, heartbeat);
    if (!hb.ok) {
      this.tmux.killOwnedSession(sessionName, ownerNonce);
      return hb;
    }

    return ok({
      teamId: validated.value.teamId,
      ownerNonce,
      aggregateRevision: hb.value.revision,
      workers: [{
        taskId: ready.id,
        generation,
        sessionName,
        paneId: pane.value.paneId,
        worktreePath: worktree.value.path,
        branchName,
        claimToken,
        markerPath,
      }],
    });
  }

  async status(teamId: string): Promise<Result<TeamStatusView, RuntimeError>> {
    const store = new TeamStateStore(
      this.stateRoot,
      this.repoKey,
      this.workspaceKey,
      teamId,
    );
    const snapshot = store.read();
    if (!snapshot.ok) return snapshot;
    const aggregate = snapshot.value.value;
    const tmuxView: Record<string, { alive: boolean; paneId?: string }> = {};
    for (const [workerId, hb] of Object.entries(aggregate.heartbeats)) {
      const sessionName = inferSessionName(this.sessionNamePrefix, aggregate.teamId, workerId, hb);
      const alive = this.tmux.hasSession(sessionName);
      let paneId = hb.paneId;
      if (alive) {
        const inspected = this.tmux.inspectOwnedPane(sessionName);
        if (inspected.ok) paneId = inspected.value.paneId;
      }
      tmuxView[sessionName] = { alive, paneId };
    }
    return ok({
      teamId: aggregate.teamId,
      revision: snapshot.value.revision,
      ownerNonce: aggregate.ownerNonce,
      tasks: aggregate.tasks,
      heartbeats: aggregate.heartbeats,
      tmux: tmuxView,
    });
  }

  async stop(teamId: string): Promise<Result<StopTeamView, RuntimeError>> {
    const store = new TeamStateStore(
      this.stateRoot,
      this.repoKey,
      this.workspaceKey,
      teamId,
    );
    const snapshot = store.read();
    if (!snapshot.ok) return snapshot;
    const aggregate = snapshot.value.value;
    const killed: string[] = [];
    for (const [workerId, hb] of Object.entries(aggregate.heartbeats)) {
      const sessionName = inferSessionName(this.sessionNamePrefix, aggregate.teamId, workerId, hb);
      if (!this.tmux.hasSession(sessionName)) continue;
      const result = this.tmux.killOwnedSession(sessionName, aggregate.ownerNonce);
      if (!result.ok) return result;
      killed.push(sessionName);
    }
    return ok({ teamId, killedSessions: killed });
  }
}

function pickFirstReadyTask(manifest: CanonicalTeamManifestV1) {
  return manifest.tasks.find((task) => task.dependencies.length === 0) ?? null;
}

function sanitizeSession(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 80);
}

function inferSessionName(
  prefix: string | undefined,
  teamId: string,
  workerId: string,
  heartbeat: SupervisorHeartbeatV1,
): string {
  // Prefer startMarker if it encodes session: "tmux:<sessionName>"
  if (heartbeat.process.startMarker.startsWith('tmux:')) {
    return heartbeat.process.startMarker.slice('tmux:'.length);
  }
  const base = prefix ?? `oma-${teamId}`;
  return sanitizeSession(`${base}-${workerId}-g1`);
}

function gitHead(cwd: string): Result<string, RuntimeError> {
  const { spawnSync } = require('child_process') as typeof import('child_process');
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    return err(runtimeError('E_RETRYABLE_BLOCKER', 'Unable to resolve leader HEAD', {
      stderr: result.stderr,
    }));
  }
  return ok(result.stdout.trim());
}
```

Important implementer constraints:
1. Use proper `import { spawnSync } from 'child_process'` at top — do **not** leave `require` in final code (snippet above is illustrative; final code must match project style with top-level import).
2. **Never store plaintext claimToken in durable aggregate** — only return once in `StartedWorkerView` (claim already stores token in claim lease inside TeamStateStore — that is existing design; do not add extra durable files with the raw token except the in-memory return). Descriptor stores **digest only**.
3. `TmuxController.startWorker` appends `descriptorPath` as last argv after bootstrap — see `tmux.ts` `shellCommand = [executable, ...bootstrap, descriptor]`. So `bootstrapArgv` must be `[holdEntry, markerPath]` and descriptor is appended by controller → hold receives `marker`, then descriptor as argv[3] if needed. Adjust `worker-hold.ts` accordingly: argv[2]=marker, argv[3]=descriptor (optional).
4. Session name inference in status/stop **must** match what start used. Prefer storing sessionName in heartbeat `process.startMarker` as `tmux:${sessionName}` (as above).
5. Comments in Traditional Chinese with design mapping.

- [ ] **Step 5: Run orchestrator tests to pass**

```bash
npx jest tests/team/orchestrator.spec.ts --runInBand
```

Expected: PASS (or skip if no tmux — on CI/Linux with tmux, must PASS). If skipped locally without tmux, still ensure TypeScript compiles:

```bash
npm run build
```

- [ ] **Step 6: Commit**

```bash
git add src/team/orchestrator.ts src/team/worker-hold.ts tests/team/orchestrator.spec.ts
git commit -m "$(cat <<'EOF'
feat(team): add TeamOrchestrator v1 start/status/stop vertical slice

Compose worktree + claim + owned tmux worker hold for the first ready
task so team lifecycle is no longer library-only.
EOF
)"
```

---

### Task 2: Wire CLI `team start` to orchestrator (remove stub)

**Files:**
- Modify: `src/team/commands.ts`
- Modify: `tests/team/commands.spec.ts`

- [ ] **Step 1: Write failing CLI test for real start**

Append to `tests/team/commands.spec.ts` (or create `tests/team/commands-start.spec.ts` if file is large):

```typescript
import { TmuxFixture } from '../helpers/tmux-fixture';
// ... existing imports

const maybeTmux = TmuxFixture.available() ? test : test.skip;

maybeTmux('teamCommand start creates tmux worker (not manifest-validated stub)', async () => {
  const fixture = GitFixture.create();
  const tmux = new TmuxFixture();
  try {
    const leader = resolveGitWorktreeIdentity(fixture.repo);
    const manifestPath = path.join(fixture.root, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      schema: 'oma.team-manifest/v1',
      teamId: 'cli-team',
      revision: 1,
      tasks: [{
        id: 't1',
        dependencies: [],
        write_scope: 'none',
        mode: 'headless',
        verification: { version: 1, commands: [], requiredArtifacts: [] },
      }],
    }));

    // Write hold.js for bootstrap
    const holdJs = path.join(fixture.root, 'hold.js');
    fs.writeFileSync(holdJs, "require('fs').writeFileSync(process.argv[2],'ready\\n'); setInterval(()=>{},1000);\n");

    let stdout = '';
    let stderr = '';
    // teamCommand must accept optional orchestrator deps OR read env OMA_TEAM_TEST_* 
    // Prefer: export createTeamOrchestratorFromContext in orchestrator and inject via TeamCommandOptions.
    const code = await teamCommand(
      ['start', '--manifest', manifestPath, '--worker-mode', 'headless'],
      {
        context: {
          stateRoot: fixture.stateRoot,
          workspaceRoot: fixture.repo,
          repoKey: leader.repoKey,
          workspaceKey: leader.workspaceKey,
          tokenFactory: (() => { let i = 0; return () => `cli-tok-${++i}`; })(),
        },
        stdout: (v) => { stdout += v; },
        stderr: (v) => { stderr += v; },
        orchestratorFactory: (ctx) => new TeamOrchestrator({
          stateRoot: ctx.stateRoot,
          workspaceRoot: ctx.workspaceRoot,
          repoKey: ctx.repoKey,
          workspaceKey: ctx.workspaceKey,
          managedWorktreesRoot: fixture.managedWorktreesRoot,
          sessionNamePrefix: tmux.session('cli'),
          tokenFactory: ctx.tokenFactory,
          workerExecutablePath: process.execPath,
          workerBootstrapArgv: [holdJs],
        }),
      },
    );
    expect(stderr).toBe('');
    expect(code).toBe(0);
    const body = JSON.parse(stdout);
    expect(body.ok).toBe(true);
    expect(body.kind).toBe('team-started');
    expect(body.workers).toHaveLength(1);
    expect(body.note).toBeUndefined();
    expect(tmux.hasSession(body.workers[0].sessionName)).toBe(true);

    const stopCode = await teamCommand(
      ['stop', '--team', 'cli-team'],
      {
        context: {
          stateRoot: fixture.stateRoot,
          workspaceRoot: fixture.repo,
          repoKey: leader.repoKey,
          workspaceKey: leader.workspaceKey,
        },
        stdout: () => {},
        stderr: (v) => { stderr += v; },
        orchestratorFactory: (ctx) => new TeamOrchestrator({
          stateRoot: ctx.stateRoot,
          workspaceRoot: ctx.workspaceRoot,
          repoKey: ctx.repoKey,
          workspaceKey: ctx.workspaceKey,
          managedWorktreesRoot: fixture.managedWorktreesRoot,
          sessionNamePrefix: tmux.session('cli'),
          workerExecutablePath: process.execPath,
          workerBootstrapArgv: [holdJs],
        }),
      },
    );
    // Note: stop must use SAME sessionNamePrefix as start — store sessionName in heartbeat only.
    // Prefer stop that reads startMarker from heartbeat so prefix injection is not required.
    expect(stopCode).toBe(0);
  } finally {
    tmux.cleanup();
    fixture.cleanup();
  }
}, 20000);
```

Critical design for stop without factory coupling: **heartbeat `process.startMarker` = `tmux:${sessionName}`** so stop/status never need the test prefix.

- [ ] **Step 2: Run test — expect fail on stub JSON `kind: manifest-validated`**

```bash
npx jest tests/team/commands.spec.ts --runInBand -t "team-started"
```

Expected: FAIL (stub still returns `manifest-validated`).

- [ ] **Step 3: Modify `TeamCommandOptions` + start/stop/status in `commands.ts`**

Update types and parse:

```typescript
export type ParsedTeamCommand =
  | {
      kind: 'resolve-fork';
      teamId: string;
      forkId: string;
      winnerGeneration: number;
      expectedRevision: number;
      evidencePath: string;
    }
  | {
      kind: 'start';
      manifestPath: string;
      workerMode: 'interactive' | 'headless';
    }
  | {
      kind: 'status';
      teamId: string;
    }
  | {
      kind: 'stop';
      teamId: string;
    };
```

In `parseTeamCommand`, after `start` block, add:

```typescript
  if (subcommand === 'status') {
    const flags = parseStrictFlags(argv.slice(1));
    if (!flags.ok) return flags;
    if (flags.value.size !== 1 || !flags.value.has('--team')) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'team status requires --team'));
    }
    return ok({ kind: 'status', teamId: flags.value.get('--team')! });
  }
  if (subcommand === 'stop') {
    const flags = parseStrictFlags(argv.slice(1));
    if (!flags.ok) return flags;
    if (flags.value.size !== 1 || !flags.value.has('--team')) {
      return err(runtimeError('E_VALIDATOR_REJECTED', 'team stop requires --team'));
    }
    return ok({ kind: 'stop', teamId: flags.value.get('--team')! });
  }
```

Extend options:

```typescript
import { TeamOrchestrator, TeamOrchestratorOptions } from './orchestrator';

export interface TeamCommandOptions {
  context: RuntimeContext;
  storeRoot?: string;
  stdout?: (value: string) => void;
  stderr?: (value: string) => void;
  /**
   * 測試注入點；production 使用 defaultOrchestrator。
   * 設計概念映射：CLI 不內嵌編排細節，委派 TeamOrchestrator。
   */
  orchestratorFactory?: (context: RuntimeContext) => TeamOrchestrator;
}
```

Default factory:

```typescript
function defaultOrchestrator(context: RuntimeContext): TeamOrchestrator {
  const managedRoot = path.join(context.stateRoot, 'managed-worktrees');
  const holdEntry = path.resolve(__dirname, 'worker-hold.js');
  return new TeamOrchestrator({
    stateRoot: context.stateRoot,
    workspaceRoot: context.workspaceRoot,
    repoKey: context.repoKey,
    workspaceKey: context.workspaceKey,
    managedWorktreesRoot: managedRoot,
    tokenFactory: context.tokenFactory,
    workerHoldEntryPath: holdEntry,
  });
}
```

Replace start stub body with:

```typescript
  if (parsed.value.kind === 'start') {
    const factory = options.orchestratorFactory ?? defaultOrchestrator;
    const orch = factory(options.context);
    const result = await orch.startFromManifest(
      parsed.value.manifestPath,
      parsed.value.workerMode,
    );
    if (!result.ok) {
      stderr(`${result.error.code}: ${result.error.message}\n`);
      return result.error.code === 'E_VALIDATOR_REJECTED' || result.error.code === 'E_MANIFEST_INVALID'
        ? 2
        : 1;
    }
    // 單次回傳 claimToken；勿寫入日誌以外的 durable 檔
    stdout(`${JSON.stringify({
      ok: true,
      kind: 'team-started',
      teamId: result.value.teamId,
      aggregateRevision: result.value.aggregateRevision,
      workers: result.value.workers.map((w) => ({
        taskId: w.taskId,
        generation: w.generation,
        sessionName: w.sessionName,
        paneId: w.paneId,
        worktreePath: w.worktreePath,
        branchName: w.branchName,
        claimToken: w.claimToken,
        markerPath: w.markerPath,
      })),
    })}\n`);
    return 0;
  }

  if (parsed.value.kind === 'status') {
    const factory = options.orchestratorFactory ?? defaultOrchestrator;
    const result = await factory(options.context).status(parsed.value.teamId);
    if (!result.ok) {
      stderr(`${result.error.code}: ${result.error.message}\n`);
      return 1;
    }
    stdout(`${JSON.stringify({ ok: true, kind: 'team-status', ...result.value })}\n`);
    return 0;
  }

  if (parsed.value.kind === 'stop') {
    const factory = options.orchestratorFactory ?? defaultOrchestrator;
    const result = await factory(options.context).stop(parsed.value.teamId);
    if (!result.ok) {
      stderr(`${result.error.code}: ${result.error.message}\n`);
      return 1;
    }
    stdout(`${JSON.stringify({ ok: true, kind: 'team-stopped', ...result.value })}\n`);
    return 0;
  }
```

Keep resolve-fork path unchanged.

- [ ] **Step 4: Run CLI tests**

```bash
npx jest tests/team/commands.spec.ts tests/team/orchestrator.spec.ts --runInBand
```

Expected: all PASS (tmux cases skip only if tmux binary missing).

- [ ] **Step 5: Commit**

```bash
git add src/team/commands.ts tests/team/commands.spec.ts tests/team/commands-start.spec.ts 2>/dev/null
git add src/team/commands.ts tests/team/
git commit -m "$(cat <<'EOF'
feat(team): wire CLI start/status/stop to TeamOrchestrator

Replace manifest-validated stub with real worktree+tmux lifecycle.
EOF
)"
```

---

### Task 3: Help text + README honesty

**Files:**
- Modify: `src/cli/application.ts` (help strings)
- Modify: `README.md` (Commands + table)
- Modify: `skills/oma-runtime/SKILL.md` if it lists fake `team status` without implementation context

- [ ] **Step 1: Update help in `application.ts`**

Find the help block listing team commands and replace with:

```text
  oma team start --manifest <file> [--worker-mode interactive|headless]
  oma team status --team <id>
  oma team stop --team <id>
  oma team resolve-fork --team <id> --fork <id> --winner-generation <n> --expected-revision <n> --evidence <file>
```

- [ ] **Step 2: Update README Commands section**

Replace the team lines with:

```markdown
oma team start --manifest <file> [--worker-mode interactive|headless]
  # v1: validates manifest, creates Team aggregate, starts FIRST ready task
  # (empty deps) in a managed git worktree + owned tmux pane (worker-hold).
  # Does NOT yet run full DAG, delivery, or integration.
oma team status --team <id>
oma team stop --team <id>
oma team resolve-fork --team <id> --fork <id> --winner-generation <n> --expected-revision <n> --evidence <file>
```

In the “If you need…” table, add:

| Multi-agent first worker (v1) | `oma team start --manifest …` then `status` / `stop` |

- [ ] **Step 3: Fix SKILL.md if present**

```bash
rg -n "team status|team start|manifest-validated" skills README.md src/cli/application.ts
```

Ensure no claim that multi-worker DAG or delivery is live.

- [ ] **Step 4: Build + unit suite**

```bash
npm run build && npm run test:unit
```

Expected: build OK; unit 111+ new tests green (or skip tmux cases only without tmux).

- [ ] **Step 5: Commit**

```bash
git add src/cli/application.ts README.md skills/
git commit -m "$(cat <<'EOF'
docs: document team start/status/stop v1 honestly

Clarify first-ready-task vertical slice; no fake full DAG claims.
EOF
)"
```

---

### Task 4: Regression gate + smoke

**Files:** none new (verification only)

- [ ] **Step 1: Full unit suite**

```bash
npm run build && npm run test:unit
```

Expected: all suites pass.

- [ ] **Step 2: Targeted team suites**

```bash
npx jest tests/team --runInBand
```

Expected: PASS (tmux tests run when available).

- [ ] **Step 3: Manual smoke (if tmux available)**

```bash
# from a throwaway git repo with built dist
npm run build
node -e "
const fs=require('fs');
fs.writeFileSync('/tmp/oma-man.json', JSON.stringify({
  schema:'oma.team-manifest/v1', teamId:'smoke', revision:1,
  tasks:[{id:'a',dependencies:[],write_scope:'none',mode:'headless',
    verification:{version:1,commands:[],requiredArtifacts:[]}}]
}));
"
# Requires OMA state root + git repo cwd — prefer reusing jest smoke rather than brittle manual.
```

Prefer automated proof from Task 1–2 tests over manual.

- [ ] **Step 4: Final commit only if docs/tests needed; else no-op**

If any fixups, commit:

```bash
git commit -m "test(team): fix orchestrator v1 regression gaps"
```

---

## Self-review (plan author)

**Spec coverage (Fable P0-1 / P1-4):**
| Requirement | Task |
|-------------|------|
| worktree.create → tmux.startWorker → state.claim | Task 1 |
| CLI start not stub | Task 2 |
| team status / stop | Task 1 + Task 2 |
| heartbeat with pane identity | Task 1 |
| Docs honesty | Task 3 |
| No delivery/supervisor loop (YAGNI) | Explicitly out of scope |

**Not in this plan (separate):** madmax gate; autopilot process drive; multi-task DAG; publish path.

**Placeholder scan:** none intentional.

**Type consistency:** `StartTeamView`, `TeamStatusView`, `StopTeamView`, `team-started` / `team-status` / `team-stopped` kinds used consistently across tasks.

---

## Execution notes for subagent-driven-development

1. Work on a feature branch (not force-push main without consent): `git checkout -b feat/team-orchestrator-v1`.
2. Fresh implementer subagent per task; after each: spec review then code quality review.
3. Tmux may be missing in some environments — tests must `skip` not fail.
4. `worker-hold.js` path after `tsc` is `dist/src/team/worker-hold.js` — default factory must resolve via `__dirname` after compile (commands run from `dist/`). When running via `ts-node`/`jest` on `.ts` sources, tests inject bootstrap argv.
5. Do not expand into delivery/integration.
