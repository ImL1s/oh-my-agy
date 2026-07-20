# Team Real agy Worker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** tmux worker runs real `agy` (or mock on PATH) via bootstrap; heartbeat records **worker** process identity; hold remains available for tests.

**Architecture:** New `src/team/worker-bootstrap.ts` reads descriptor + optional capability side-file, sets managed env, `spawn`s agy with stdio inherit, exits when agy exits. Orchestrator default bootstrap switches from hold to bootstrap; inject `workerBootstrapArgv` still works. Extend descriptor schema additively.

**Tech Stack:** TypeScript, real tmux unit tests, mock agy script fixture.

**Index:** MASTER T2 — **Team critical path**. Depends on B0. Unlocks T3/T4.

**Plan boundary:** No multi-task DAG, no delivery publish, no supervisor poll loop (only correct heartbeat writes).

---

## File map

| Path | Role |
|------|------|
| `src/team/worker-bootstrap.ts` | **Create** — launch agy |
| `src/team/worker-hold.ts` | Keep for tests |
| `src/team/orchestrator.ts` | Default to bootstrap; write capability file; fix heartbeat pid source |
| `src/team/types.ts` | Optional descriptor type export |
| `src/team/tmux.ts` | Optional env passthrough if needed |
| `tests/team/worker-bootstrap.spec.ts` | **Create** |
| `tests/team/orchestrator.spec.ts` | Add ORCH-S1 mock agy case |
| `README.md` | v1.1 real worker |

---

### Task 1: Descriptor + capability contract

- [ ] **Step 1: Spec in code comments + types**

Descriptor JSON (worktree `.oma-worker-descriptor.json`) fields:

```typescript
{
  schemaVersion: 1,
  teamId, taskId, workerId, generation, workerMode,
  claimTokenDigest, // only digest
  worktreePath, stateRoot,
  agyCommand: 'agy',
  taskPrompt: string, // from manifest extension or default "Execute team task <id>"
  packageRoot?: string,
  sessionId: string, // per-worker UUID
  launchNonce: string,
  invocationGeneration: number, // start at 1
}
```

Capability file (mode 0o600): `.oma/worker-capability.json` containing `{ claimToken }` — **not** committed; unlink on bootstrap exit. Orchestrator writes it only inside managed worktree.

- [ ] **Step 2: Unit test** that orchestrator descriptor has no `claimToken` key plaintext.

- [ ] **Step 3: Commit types + orchestrator write path**

```bash
git commit -m "feat(team): worker descriptor capability file without plaintext in descriptor"
```

---

### Task 2: worker-bootstrap launches mock agy

- [ ] **Step 1: Failing test** with temp dir:

```typescript
// write descriptor + capability + mockAgy.js that writes process.env.OMA_SESSION_ID to out.txt and exits 0
// spawn: node worker-bootstrap.js marker descriptor
// expect out.txt contains session id; marker ready; exit 0
```

- [ ] **Step 2: Implement worker-bootstrap.ts**

```typescript
/**
 * 設計概念映射：Team worker bootstrap，對齊 OMC team pane 啟動 CLI worker。
 * spawn agy（或 descriptor.agyCommand），stdio inherit；結束碼透傳。
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

async function main() {
  const markerPath = process.argv[2];
  const descriptorPath = process.argv[3];
  // validate paths, write marker
  const desc = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
  const capPath = path.join(path.dirname(descriptorPath), '.oma', 'worker-capability.json');
  let claimToken = '';
  if (fs.existsSync(capPath)) {
    claimToken = JSON.parse(fs.readFileSync(capPath, 'utf8')).claimToken;
  }
  const env = {
    ...process.env,
    OMA_SESSION_ID: desc.sessionId,
    OMA_LAUNCH_NONCE: desc.launchNonce,
    OMA_INVOCATION_GENERATION: String(desc.invocationGeneration),
    OMA_WORKSPACE_PATH: desc.worktreePath,
    OMA_STATE_ROOT: desc.stateRoot,
    OMA_TEAM_ID: desc.teamId,
    OMA_TASK_ID: desc.taskId,
    OMA_CLAIM_TOKEN: claimToken, // memory for child only via env — document risk; prefer not if avoidable
  };
  // Prefer not putting claim in env long-term; for v1.1 mock evidence OK with digest-only progress later
  const child = spawn(desc.agyCommand || 'agy', buildArgv(desc), {
    cwd: desc.worktreePath,
    env,
    stdio: 'inherit',
  });
  const code = await new Promise<number>((resolve) => child.on('exit', (c) => resolve(c ?? 1)));
  try { fs.rmSync(capPath, { force: true }); } catch (_) {}
  process.exit(code);
}

function buildArgv(desc: any): string[] {
  // headless: pass prompt as single arg if mock supports; interactive: same
  return [String(desc.taskPrompt || `Execute team task ${desc.taskId}`)];
}

main().catch((e) => { console.error(e); process.exit(1); });
```

**Security note in plan:** Prefer removing `OMA_CLAIM_TOKEN` from env once progress API uses side channel; T2 may use env only for mock — document in code comment.

- [ ] **Step 3: PASS + commit**

```bash
git commit -m "feat(team): worker-bootstrap spawns agy with managed env"
```

---

### Task 3: Orchestrator defaults to bootstrap + real heartbeat pid

- [ ] **Step 1: Change default `workerHoldEntryPath` → worker-bootstrap.js**

- [ ] **Step 2: After startWorker, do not set heartbeat.pid = process.pid (orchestrator).**

Problem: parent does not know child pid inside tmux easily without `tmux list-panes -F '#{pane_pid}'`.

Implement helper:

```typescript
function readPanePid(sessionName: string): number | null {
  const r = spawnSync('tmux', ['list-panes', '-t', sessionName, '-F', '#{pane_pid}'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const n = Number(r.stdout.trim().split('\n')[0]);
  return Number.isFinite(n) ? n : null;
}
```

Set `process: { pid: panePid ?? -1, startMarker: `tmux:${sessionName}` }`.

- [ ] **Step 3: ORCH-S1 test** with mock agy on PATH that sleeps; assert heartbeat pid ≠ orchestrator pid when possible.

- [ ] **Step 4: Keep hold inject path for ORCH-01**

- [ ] **Step 5: Docs + commit**

```bash
git commit -m "feat(team): default orchestrator to agy worker-bootstrap with pane pid heartbeat"
```

---

## Exit criteria

- [ ] Default production bootstrap is agy launcher
- [ ] Descriptor has no plaintext claimToken
- [ ] Heartbeat pid is pane/worker oriented
- [ ] Mock agy unit proof
- [ ] hold still injectable for tests
- [ ] README: real worker, still not full DAG/delivery
- [ ] build + unit green
