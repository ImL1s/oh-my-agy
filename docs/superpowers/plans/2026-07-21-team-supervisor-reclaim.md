# Team Supervisor + Reclaim Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Executable supervise/reclaim using existing `assessWorker` + reclaim fence; CLI reports assessments and reclaims only on DeadProof.

**Architecture:** `TeamOrchestrator.superviseOnce(teamId)` loops tasks, probes pane/process liveness (tmux has-session + `/proc` or `kill -0 pid`), calls `assessWorker`, optionally transitions status. `reclaimTask` requires DeadProof then clears claim / bumps generation path for relaunch.

**Tech Stack:** Existing supervisor.ts / reclaim.ts (wire only), TypeScript, Jest.

**Index:** MASTER T3. **Depends on T2** (real process markers). Plan boundary: no delivery, no DAG auto-schedule (may call hook later).

---

### Task 1: Liveness probe helpers

- [ ] **Step 1: Test** probe alive/dead for pid and pane

```typescript
// tests/team/liveness.spec.ts
// spawn sleep process, probe alive; kill; probe dead
// tmux session hasSession true/false
```

- [ ] **Step 2: Implement** `src/team/liveness.ts` using spawnSync only:

```typescript
export function probeProcess(pid: number): ProcessLiveness {
  if (pid <= 0) return { kind: 'unknown' };
  try {
    process.kill(pid, 0);
    return { kind: 'alive' };
  } catch {
    return { kind: 'dead' };
  }
}
```

Map to types expected by `inspectReclaimFence` in `reclaim.ts` (read file for exact shape).

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(team): process and pane liveness probes for supervisor"
```

---

### Task 2: superviseOnce on orchestrator

- [ ] **Step 1: Failing test** with hold worker: after kill session, assessment reclaimable

- [ ] **Step 2: Implement**

```typescript
async superviseOnce(teamId: string): Promise<Result<SuperviseReport, RuntimeError>> {
  // read aggregate
  // for each heartbeat+task in_progress:
  //   paneLiveness = hasSession ? alive : dead
  //   processLiveness = probeProcess(hb.process.pid)
  //   assessWorker(task, hb, now, pane, process)
  // collect report
}
```

- [ ] **Step 3: CLI** `team supervise --team <id> [--once]` (default once for v1; `--interval-ms` optional loop with clear exit)

JSON kind: `team-supervise-report`

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(team): superviseOnce CLI and orchestrator assessments"
```

---

### Task 3: reclaim on DeadProof only

- [ ] **Step 1: Test** — Alive fence → reclaim rejected; DeadProof → claim cleared / status orphan or pending

Read `state.ts` for available transitions; if no clearClaim API, add `async releaseClaim(taskId, expectedRevision, reason)` with CAS — **minimal** addition, not rewrite.

- [ ] **Step 2: `oma team reclaim --team --task --expected-revision`**

JSON kind: `team-reclaimed`

- [ ] **Step 3: Never reclaim without DeadProof** — unit matrix from reclaim.spec patterns

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(team): reclaim only with DeadProof fence"
```

---

## Exit criteria

- [ ] CLI supervise + reclaim
- [ ] No reclaim without DeadProof
- [ ] Uses assessWorker/inspectReclaimFence unchanged semantically
- [ ] unit green with tmux where available
- [ ] Docs updated
