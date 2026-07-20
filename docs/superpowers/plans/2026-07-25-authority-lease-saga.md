# AuthorityLease + Conflict Resolution Saga Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When parallel team workers (Looks vs Works) touch overlapping write scopes, enforce exclusive `AuthorityLease` with renew; on conflict start resolution saga (pause Looks, require human/oracle evidence) instead of silent clobber.

**Architecture:** New `src/team/authority-lease.ts` + state fields on TeamAggregate or side store under stateRoot. Integrates with T5 multi-worker scheduler: before claim on overlapping scope, acquire lease. Replace e2e mock-theatre with real lease unit tests.

**Index:** MASTER R3b Wave 3. **Depends on T5** multi-worker. Covers DESIGN AuthorityLease / Conflict Resolution Saga.

---

### Task 1: Lease data model + CAS acquire/renew/release

- [ ] **Step 1: Types**

```typescript
export interface AuthorityLeaseV1 {
  schemaVersion: 1;
  pathKey: string; // canonical relative path or scope key
  ownerTaskId: string;
  ownerClaimTokenDigest: string;
  generation: number;
  leasedUntilMs: number;
}
```

- [ ] **Step 2: Tests** acquire exclusive; second acquire fails; renew extends; expire allows reacquire

- [ ] **Step 3: Implement store under `TeamStateStore` or dedicated `LeaseStore`**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(team): AuthorityLease acquire renew release with CAS"
```

---

### Task 2: Scheduler integration

- [ ] **Step 1: Before starting worker on write_scope paths, acquire leases for all scope entries**

- [ ] **Step 2: On conflict → task status `blocked_permission` or new `lease_conflict`; do not start tmux**

- [ ] **Step 3: Test two overlapping tasks — only one runs**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(team): require AuthorityLease before overlapping write workers"
```

---

### Task 3: Conflict Resolution Saga (minimal)

- [ ] **Step 1: When lease holder and challenger both have commits**, open saga record:

```typescript
interface ConflictSagaV1 {
  sagaId: string;
  pathKey: string;
  looksTaskId?: string;
  worksTaskId?: string;
  status: 'open' | 'resolved' | 'cancelled';
  resolutionEvidenceDigest?: string;
}
```

- [ ] **Step 2: CLI** `oma team resolve-conflict --saga --winner-task --expected-revision --evidence`

- [ ] **Step 3: Pause Looks** (status awaiting_interaction) until resolved — unit test

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(team): conflict resolution saga for lease holders"
```

---

### Task 4: Retire mock-theatre claims

- [ ] Mark or rewrite `e2e/tier3` AuthorityLease mock asserts to call real lease API or delete false confidence  

- [ ] Docs DESIGN: lease implemented  

---

## Exit criteria

- [ ] Overlapping parallel writes require lease  
- [ ] Saga path tested  
- [ ] No silent clobber  
- [ ] unit green  
- [ ] DESIGN updated  
