# Team Delivery → Integration → Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Single-task endgame: validate delivery evidence → acceptDelivery → temporary integration → FF publish → markIntegrated → `completed`.

**Architecture:** Explicit CLI first: `oma team deliver --team --task --expected-revision` (leader-side). Compose existing `createDeliveryEvidence` / `DeliveryValidator` / `IntegrationManager` / `FastForwardPublisherV1` / `TeamStateStore.acceptDelivery` / `markIntegrated`. No rewrite of library internals.

**Tech Stack:** Real git fixtures (copy delivery-integration.spec patterns).

**Index:** MASTER T4. Depends on T2. Unlocks T5.

**Plan boundary:** No multi-task scheduler (but completed status enables next claims).

---

### Task 1: Orchestrator.deliverTask wiring

- [ ] **Step 1: Integration test** (true git)

1. Create leader repo + team aggregate + claimed task worktree with a commit ahead of base  
2. `createDeliveryEvidence` from worktree  
3. `orchestrator.deliverTask` → task status `completed`, leader HEAD includes commit, worktree removable if clean integrated  

- [ ] **Step 2: Implement `TeamOrchestrator.deliverTask`**

```typescript
async deliverTask(input: {
  teamId: string;
  taskId: string;
  expectedRevision: number;
  // claimToken from operator/file — required for acceptDelivery
  claimToken: string;
  generation: number;
}): Promise<Result<DeliverView, RuntimeError>> {
  // read store + task delivery preconditions
  // createDeliveryEvidence / DeliveryValidator.validate
  // acceptDelivery
  // IntegrationManager.prepare + run verification if any
  // FastForwardPublisherV1 publish
  // markIntegrated
  // optional removeIfSafe worktree
}
```

Read `tests/team/delivery-integration.spec.ts` for exact API usage and copy patterns.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(team): deliverTask composes evidence integration and FF publish"
```

---

### Task 2: CLI deliver

- [ ] **Step 1: parse `deliver` flags** — `--team --task --expected-revision --claim-token --generation` (strict)

JSON kind: `team-delivered` / include integrated revision

- [ ] **Step 2: Tests** parse + services path

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(team): CLI team deliver for leader-side integration"
```

---

### Task 3: read_only complete shortcut

- [ ] For tasks with `mode: 'read_only'` and `write_scope: 'none'`, support `oma team complete-readonly --team --task ...` calling `completeReadOnlyTask` so DAG can complete without git delivery.

- [ ] Test + commit

```bash
git commit -m "feat(team): complete-readonly path for read_only tasks"
```

---

### Task 4: Docs

- [ ] README: single-task deliver endgame available; full DAG still T5  
- [ ] DESIGN: mark delivery wiring implemented  

---

## Exit criteria

- [ ] One real-git path to `completed` for write task  
- [ ] non-FF rejected without polluting leader ref  
- [ ] dirty worktree preserved  
- [ ] CLI kinds stable/additive  
- [ ] unit green  
