# Structured CLI E2E Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** E2E coverage for structured CLI surfaces (setup/doctor/autopilot ledger/team v1) using mock `agy`, without mock-theatre string asserts as sole proof.

**Architecture:** New `e2e/tier5-structured.spec.ts` (or `e2e/structured-cli.spec.ts`) using existing `runOma` helper + sandbox todo paths. Team start/status/stop skip if no tmux (mirror unit). Setup/doctor may need plugin adapter env or `--no-strict-plugin`.

**Tech Stack:** Jest e2e config (`jest.config.js`), mock agy on PATH via helper.

**Index:** MASTER Q1. Expand this file’s cases when T2/T3/T4/S1/A1 ship.

---

### Task 1: doctor + help structured smoke

- [ ] **Step 1: Write test**

```typescript
// e2e/structured-cli.spec.ts
import { runOma } from './helper';

test('TC-S-01: oma --help documents team status/stop', async () => {
  const r = await runOma(['--help']);
  expect(r.code).toBe(0);
  expect(r.stdout).toContain('team status');
  expect(r.stdout).toContain('team stop');
});

test('TC-S-02: oma doctor --no-strict-plugin exits 0|1|2 with result line', async () => {
  const r = await runOma(['doctor', '--no-strict-plugin']);
  expect([0, 1, 2]).toContain(r.code);
  expect(r.stdout + r.stderr).toMatch(/result:|Node|doctor/i);
});
```

- [ ] **Step 2: Run**

```bash
npx jest e2e/structured-cli.spec.ts --runInBand
```

- [ ] **Step 3: Fix CLI/help only if failing for real bugs**

- [ ] **Step 4: Commit**

```bash
git commit -m "test(e2e): structured CLI help and doctor baseline"
```

---

### Task 2: autopilot ledger e2e (no spawn required)

- [ ] **Step 1: Test start → status JSON**

```typescript
test('TC-S-03: autopilot start then status', async () => {
  const start = await runOma(['autopilot', 'start', '--', 'goal text for e2e']);
  // If start requires different argv, match src/autopilot/commands.ts exactly
  expect(start.code).toBe(0);
  const body = JSON.parse(start.stdout);
  expect(body.sessionId).toBeTruthy();
  const status = await runOma([
    'autopilot', 'status', '--session', body.sessionId,
  ]);
  expect(status.code).toBe(0);
  expect(JSON.parse(status.stdout).sessionId).toBe(body.sessionId);
}, 30000);
```

Adjust flags to match real `parseAutopilotCommand` (read file first).

- [ ] **Step 2–4: green + commit**

```bash
git commit -m "test(e2e): autopilot start/status structured path"
```

---

### Task 3: team start/status/stop e2e (tmux optional)

- [ ] **Step 1: Test with real git sandbox + skip without tmux**

```typescript
import { spawnSync } from 'child_process';
const hasTmux = spawnSync('tmux', ['-V']).status === 0;
const maybe = hasTmux ? test : test.skip;

maybe('TC-S-04: team start status stop vertical slice', async () => {
  // create temp git repo, write manifest, runOma with OMA_STATE_ROOT
  // expect team-started, then status in_progress, then stop
}, 30000);
```

Reuse patterns from `tests/team/orchestrator.spec.ts` but invoke **compiled CLI** via `runOma` / `TEST_DIST=true`.

- [ ] **Step 2–4: green + commit**

```bash
git commit -m "test(e2e): team start/status/stop when tmux available"
```

---

### Task 4: forbid new mock-theatre cases

- [ ] Document in `TEST_INFRA.md` or `e2e/README` if exists: new structured tests must assert exit codes + JSON kinds + filesystem/tmux state, not `MOCK_AGY_STDOUT` keyword echo.
- [ ] Tag legacy tier3 theatre tests with comment `// legacy-mock-theatre` (no behavior change required in this plan).

- [ ] Commit docs/comment only if needed.

---

## Exit criteria

- [ ] `npm run test:e2e` green
- [ ] Structured cases exist for help, doctor, autopilot ledger, team v1 (skip rules documented)
- [ ] No new mock-theatre-only proofs
