# Team Multi-Task DAG Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Schedule all ready tasks (deps all `completed`, claimable status) up to `maxParallelWorkers`; advance after completions via `tick` / supervise hook.

**Architecture:** Replace `pickFirstReadyTask` with `listReadyTasks(aggregate)` using `deps.every(id => tasks[id].status === 'completed')`. `startFromManifest` starts up to N ready tasks. `tick(teamId)` starts newly ready tasks without re-creating aggregate.

**Tech Stack:** Existing claimTask dependency checks in state.ts; orchestrator composition.

**Index:** MASTER T5. **Depends on T4** (write tasks can complete). T3 preferred for auto tick.

---

### Task 1: listReadyTasks pure function

- [ ] **Step 1: Unit tests**

```typescript
// A completed, B deps [A] pending → ready = [B]
// A pending, B deps [A] → ready = [] if A not completed; A ready if empty deps
// cycle already forbidden by manifest validate
```

- [ ] **Step 2: Implement** in `orchestrator.ts` or `src/team/schedule.ts`

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(team): listReadyTasks for DAG dependency readiness"
```

---

### Task 2: startFromManifest multi-worker

- [ ] **Step 1: Test** two independent tasks, maxParallelWorkers=2 → workers.length===2

- [ ] **Step 2: Loop ready tasks**, create worktree+claim+tmux each, stop at maxParallel

- [ ] **Step 3: maxParallelWorkers option default 1** (safe); CLI `--max-parallel N`

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(team): start multiple ready workers up to max parallel"
```

---

### Task 3: tick advances DAG

- [ ] **Step 1: Test** A then complete A (mock mark completed in store) then tick starts B

- [ ] **Step 2: `TeamOrchestrator.tick` + CLI `team tick --team`

JSON kind: `team-tick` with `started: StartedWorkerView[]`

- [ ] **Step 3: Optionally call tick at end of deliverTask success**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(team): tick schedules newly unblocked DAG tasks"
```

---

### Task 4: Docs + e2e

- [ ] Remove “first ready only” README language  
- [ ] e2e structured case for 2-task serial DAG with mock complete path  

---

## Exit criteria

- [ ] Serial A→B works  
- [ ] Parallel independents with maxParallel≥2  
- [ ] Single-task regression green  
- [ ] Docs accurate  
- [ ] unit (+ e2e if present) green  
