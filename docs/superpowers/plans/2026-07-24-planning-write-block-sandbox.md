# Planning Write-Block Sandbox Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fail-closed planning write restriction: agents in plan/search mode cannot write outside allowed paths (`.agy/plans/` or designated), via host-level sandbox and/or additional hook surface if product accepts expanding beyond PreInvocation+Stop.

**Architecture:** Two-phase plan — **Phase A ADR** (required) then **Phase B implementation**.

**Index:** MASTER R3a Wave 2→3. Covers DESIGN blueprint planning lock + read-only probe sandbox.

---

### Task 1: ADR decision record

- [ ] **Step 1: Write** `docs/adr/0001-planning-write-block.md` choosing ONE:

| Option | Pros | Cons |
|--------|------|------|
| A. Expand hooks to PreToolUse | precise tool deny | breaks “only PreInvocation+Stop” package surface |
| B. OS sandbox only (bwrap/sandbox-exec) around managed search/plan launches | no host hook change | platform matrix macOS/Linux; Windows later |
| C. Hybrid | defense in depth | complexity |

**Council default for implementation:** **B first** (keep plugin surface), add A only if B insufficient.

- [ ] **Step 2: User-visible decision in ADR status Accepted**

- [ ] **Step 3: Commit ADR**

```bash
git commit -m "docs(adr): planning write-block sandbox approach"
```

---

### Task 2: Sandbox launcher (Phase B — after ADR)

- [ ] **Step 1: `src/runtime/sandbox.ts`**

```typescript
export function wrapWithReadOnlySandbox(input: {
  command: string;
  argv: string[];
  cwd: string;
  writablePaths: string[];
}): Result<{ command: string; argv: string[] }> {
  // Linux: bwrap --ro-bind / / --bind writable...
  // macOS: sandbox-exec profile
  // If tool missing: return E_RETRYABLE_BLOCKER fail-closed when policy required
}
```

- [ ] **Step 2: Unit tests** with fake command that tries write outside → fails; write inside allowed → ok (or skip if no bwrap)

- [ ] **Step 3: Wire** to managed `search` mode launches only first

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(runtime): fail-closed read-only sandbox for search/plan launches"
```

---

### Task 3: Read-only probe command allowlist (optional same PR)

- [ ] Maintain argv allowlist for probe mode (git status, ls, etc.) in addition to sandbox  
- [ ] Tests for deny `rm`, `git push`, interpreters  

---

## Exit criteria

- [ ] ADR accepted  
- [ ] search/plan managed launch uses fail-closed sandbox when available  
- [ ] Missing sandbox binary → fail closed when policy on (env `OMA_REQUIRE_SANDBOX=1`)  
- [ ] DESIGN blueprint updated  
- [ ] unit green (skips documented)  
