# Runtime Process Defense Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce `maxOutputBytes` by **killing** the child when exceeded (not only truncating), and add `maxProcessCount` defense for headless process groups.

**Architecture:** Extend `src/runtime/process.ts` ProcessRunner policies. Apply to managed headless and team headless worker spawns. Interactive inherit stdio paths opt-in only.

**Tech Stack:** Node child_process, existing PGID kill patterns in process.ts.

**Index:** MASTER R2 Wave 2. Preferred after T2.

---

### Task 1: Kill on maxOutputBytes

- [ ] **Step 1: Read** `src/runtime/process.ts` current truncate behavior (`:115-128` area)

- [ ] **Step 2: Failing test** — child prints forever; policy maxOutputBytes small → child killed; outcome signals overflow

- [ ] **Step 3: Implement** — on byte threshold, `kill` process group / child; set `outcome.overflow = true` or error code

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(runtime): kill child when maxOutputBytes exceeded"
```

---

### Task 2: maxProcessCount

- [ ] **Step 1: API** `policy.maxProcessCount?: number`  
  On Linux, count descendants via `/proc` or `pgrep -P` carefully **without self-matching kill patterns**. Prefer reading `/proc/<pid>/task` / children files.

- [ ] **Step 2: Test** — mock or controlled fork script; skip on darwin if unreliable with documented skip

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(runtime): maxProcessCount defense for headless process groups"
```

---

### Task 3: Wire policies

- [ ] Managed headless / team worker-bootstrap uses defaults from env `OMA_MAX_OUTPUT_BYTES`, `OMA_MAX_PROCESS_COUNT`

- [ ] Docs DESIGN blueprint → implemented (headless)

- [ ] Commit

```bash
git commit -m "feat(runtime): wire output and process count limits to headless launches"
```

---

## Exit criteria

- [ ] Overflow kills child  
- [ ] Process count enforced where platform allows  
- [ ] No git reset  
- [ ] unit green  
