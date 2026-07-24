# OMA OMX Team Mailbox / API Parity Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Expose OMX-shaped `oma team api <op> --input JSON [--json]` over the existing OMA team orchestrator (claim/deliver/tick/mailbox in aggregate state), so workers/leaders use CLI-first messaging instead of ad-hoc pane typing.

**Architecture:** Keep `src/team/orchestrator.ts` + `state.ts` as the authority. Add a thin `src/team/api-interop.ts` (names aligned with OMX `TEAM_API_OPERATIONS`) and route `oma team api …` from `src/team/commands.ts` / CLI parser. Do not relocate platform state root in P0; document path differences vs `.omx/state/team/`.

**Tech Stack:** TypeScript, Jest unit + e2e, existing `src/team/*`, OMX reference `api-interop.ts` (33 ops).

**Reference:**
- OMX: `.omx/tmp/upstreams-current/oh-my-codex/src/team/api-interop.ts`
- OMA today: `oma team start|tick|deliver|supervise|reclaim|status|stop` + ordered mailbox in aggregate
- Host launch (`oma`/`--madmax`/tmux) is **out of scope** for this plan

**Honesty / non-goals:**
- Not a native Antigravity “team” product feature — OMA-owned orchestrator.
- P0 = subset of OMX ops mapped onto existing store methods.
- No silent drop of managed `oma ralph --madmax -- …` (already rejected).

---

### Task 1: P0 contract tests

**Files:**
- Create: `src/team/api-interop.ts`
- Create: `tests/team/api-interop.spec.ts`

**Step 1: Failing tests**

Cover:
- unknown op → `ok:false` / `E_TEAM_API_UNKNOWN`
- `send-message` + `mailbox-list` roundtrip via store fixture
- `claim-task` + `transition-task-status` token rule
- `get-summary` shape

**Step 2:** `npm run test:unit -- --testPathPattern=api-interop` → FAIL

**Step 3:** Stub dispatch table exporting `TEAM_API_OPERATIONS_P0`

**Step 4:** Commit `test(team): OMX-shaped oma team api contract`

---

### Task 2: Map mailbox + claim onto TeamStateStore

**Files:**
- Modify: `src/team/api-interop.ts`, possibly thin wrappers in `src/team/state.ts`
- Test: `tests/team/api-interop.spec.ts`

**Step 1:** Failing tests for ordered mailbox sequence + ack cursor
**Step 2:** Implement using existing `claimTask` / mailbox methods (no duplicate stores)
**Step 3:** Unit green
**Step 4:** Commit `feat(team): wire mailbox and claim ops to store`

---

### Task 3: CLI `oma team api`

**Files:**
- Modify: `src/team/commands.ts`, `src/cli/parser.ts` if needed, `bin/oma.ts` structured path already covers `team`
- Modify: help text in `src/cli/application.ts`
- Test: unit parse + one e2e structured-cli case if cheap

**Step 1:** Failing parse test for `team api send-message --input … --json`
**Step 2:** Implement; JSON envelope includes `schema_version`, `timestamp`, `command`, `ok`, `operation`, `data|error`
**Step 3:** `npm run test:unit` green for team/api
**Step 4:** Commit `feat(cli): oma team api subcommand`

---

### Task 4: Leader inbox write + worker skill note

**Files:**
- API: `write-worker-inbox` → path under team working dir / state
- Modify: `skills/team/SKILL.md` (or docs) — CLI-first messaging; no primary `tmux send-keys`
- Test: unit path write

**Steps:** TDD → commit `feat(team): write-worker-inbox + skill guidance`

---

### Task 5: Docs + CHANGELOG honesty

**Files:**
- `README.md`, `docs/security.md`, `CHANGELOG.md`, locale readmes if they mention team
- List P0 ops shipped; P1 backlog (broadcast, events, shutdown ack, cleanup, …)

**Commit:** `docs(team): document OMX-shaped team api P0`

---

### Task 6: Package/version gate

**Step 1:** `npm run build && npm run test:unit -- --testPathPattern='team|api-interop'`
**Step 2:** `npm run test:package` if manifests/help strings changed
**Step 3:** Do **not** bump version in this plan pass unless releasing

---

## P1 / P2

- **P1:** Full remaining OMX ops; optional `.oma/.../team/<name>/` mirror layout for operator familiarity
- **P2:** Big Five coordination overlays; ultragoal bridge; mixed worker CLI map (agy-only default stays)

## Verification gate

- Unit tests for api-interop green
- `oma team api --help` lists P0 ops
- README does not claim full OMX 33-op parity
- Existing e2e team/enforcer tests still green
