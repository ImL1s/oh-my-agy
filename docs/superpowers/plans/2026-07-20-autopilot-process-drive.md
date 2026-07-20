# Autopilot Process Drive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Autopilot actually spawn managed `agy` via `ManagedInvocationService.resumeConversation`, without breaking ledger-only `resume` CAS semantics.

**Architecture:** Add **`oma autopilot drive`** that (1) ensures binding/conversation on the session aggregate, (2) calls `resumeConversation(sessionId, conversationId, expectedRevision)`. Keep existing `resume` as **ledger-only** (binding update, no spawn) so tests and CAS stay stable. Wire production caller in `src/cli/services.ts`.

**Tech Stack:** TypeScript, Jest, existing ProcessRunner + ManagedInvocationService.

**Index:** MASTER A1. Plan boundary: no Team, no madmax, no multi-phase auto-loop.

**Council default:** Prefer new `drive` over overloading `resume` (madmax-autopilot-research D-drive).

---

## File map

| Path | Role |
|------|------|
| `src/autopilot/commands.ts` | Parse `drive` flags |
| `src/autopilot/runtime.ts` | Optional helper to load conversationId for drive |
| `src/cli/services.ts` | After dispatch, if drive → spawn |
| `src/cli/application.ts` | Help text |
| `tests/autopilot/*`, `tests/cli/*` | Drive + spawn mocks |
| `README.md` | Document drive vs resume |

---

### Task 1: Parse `autopilot drive`

**Files:** `src/autopilot/commands.ts`, tests

- [ ] **Step 1: Failing test**

```typescript
// tests/autopilot/commands.spec.ts (extend)
expect(parseAutopilotCommand([
  'drive', '--session', 's1', '--conversation', 'c1', '--expected-revision', '2',
])).toEqual({
  ok: true,
  value: {
    kind: 'drive',
    sessionId: 's1',
    conversationId: 'c1',
    expectedRevision: 2,
  },
});

expect(parseAutopilotCommand(['drive', '--session', 's1', '--expected-revision', '0']).ok).toBe(false);
```

- [ ] **Step 2: FAIL**

- [ ] **Step 3: Add to ParsedAutopilotCommand + parseAutopilotCommand**

Required flags: `--session`, `--conversation`, `--expected-revision` (same strict pair parsing as resume).

- [ ] **Step 4: PASS + commit**

```bash
git commit -m "feat(autopilot): parse drive subcommand for process launch"
```

---

### Task 2: Runtime `drive` prepares binding then returns launch plan

**Files:** `src/autopilot/runtime.ts`, tests

- [ ] **Step 1: Failing test** — `runtime.drive(...)` returns view + `{ sessionId, conversationId, expectedRevisionAfter }` after CAS that sets binding like resume.

Implementation approach:
1. Call same CAS as `resume` to set conversationId / clear blockers.
2. Return `ok({ view, launch: { sessionId, conversationId, expectedRevision: newRevision } })`.

Do **not** spawn inside runtime (keeps pure state machine testable).

- [ ] **Step 2–4: implement + tests + commit**

```bash
git commit -m "feat(autopilot): drive mutates binding and returns launch coordinates"
```

---

### Task 3: Wire services.ts to resumeConversation

**Files:** `src/cli/services.ts`, `tests/cli/*`

- [ ] **Step 1: Failing integration test** with mock ManagedInvocationService / ProcessRunner:

```typescript
// When autopilotCommand(['drive', ...]) 
// expect runner received agy argv including '--conversation', c1
// expect env OMA_SESSION_ID set
```

- [ ] **Step 2: Implementation sketch**

```typescript
async autopilotCommand(argv) {
  const runtime = AutopilotRuntime.create(...);
  // if first token is drive:
  const parsed = parseAutopilotCommand(argv);
  if (parsed.ok && parsed.value.kind === 'drive') {
    const driven = await runtime.value.drive(...);
    if (!driven.ok) { /* stderr */ return 1; }
    const managed = buildManagedService(...);
    const outcome = await managed.value.resumeConversation(
      driven.value.launch.sessionId,
      driven.value.launch.conversationId,
      driven.value.launch.expectedRevision,
    );
    // print JSON { ok, kind: 'autopilot-driven', view, process: outcome }
    return outcome.ok ? 0 : 1;
  }
  // existing dispatch path for other subcommands
}
```

**Contract fix (research noted conflict):** `resumeConversation` / `prepareResume` may require bound session. `drive` must leave binding in a state that `prepareResume` accepts. Read `src/cli/runtime-adapter.ts` `prepareResume` and align CAS fields before spawn. If unbound start never created launch nonce, **drive must call prepareLaunch-equivalent once** or require prior managed mode launch — document in test.

If prepareResume requires generation ≥ 2 and bound nonce, implement:

Option A: `drive` first path uses `ManagedInvocationService.launchMode` for first generation then switches conversation.  
Option B: extend transaction adapter for autopilot-origin sessions.

**Council preference:** Make drive work end-to-end with unit proof; prefer minimal adapter extension over silent fail.

- [ ] **Step 3: Ensure `rg resumeConversation src/` shows production caller**

- [ ] **Step 4: Help + README**

```
oma autopilot drive --session <id> --conversation <id> --expected-revision <n>
  # ledger bind + spawn managed agy (exact_env)
oma autopilot resume ...
  # ledger-only binding update (no spawn)
```

- [ ] **Step 5: unit green + commit**

```bash
git commit -m "feat(autopilot): wire drive to ManagedInvocationService.resumeConversation"
```

---

## Exit criteria

- [ ] Production caller for `resumeConversation` exists
- [ ] `resume` remains ledger-only
- [ ] Mock proves spawn argv + exact_env
- [ ] Docs distinguish drive vs resume
- [ ] build + test:unit green
