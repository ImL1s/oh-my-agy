# OMA Full Completeness Master Roadmap

> **For agentic workers:** This is the INDEX. Implement via individual plan files with superpowers:subagent-driven-development. **Nothing is product-out-of-scope.** Wave labels are **schedule only**.

**Goal:** Ship every incomplete surface from Fable 5 review + DESIGN blueprint so OMA is a full OMC-style product (single-agent + team + safety + process defense).

**Architecture:** Vertical slices that leave the tree green. Wire existing `src/team/*` libraries; do not rewrite. Shared contracts frozen below. Three tracks in parallel: Team core, Safety/CLI, Autopilot, plus Quality e2e expansion after each ship.

**Tech Stack:** TypeScript strict, Jest unit (real git/tmux), Jest e2e (mock agy), Node 20+, spawn/spawnSync only.

**Council evidence (2026-07-20):**
- `.omc/research/council/team-completion-research.md`
- `.omc/research/council/madmax-autopilot-research.md`
- `.omc/research/council/architect-sequencing.md`
- `.omc/research/fable-review/fable5-full-review.md`
- Codex council: BLOCKED (usage limit); synthesis without Codex vote

---

## Coverage matrix (union of all plans = 100% of gaps)

| ID | Surface | Plan file | Wave | Depends on |
|----|---------|-----------|------|------------|
| B0 | Team v1 hold start/status/stop | `2026-07-20-team-orchestrator-v1.md` | 0 DONE | — |
| S1 | madmax/yolo gate + parser silent-drop | `2026-07-20-dangerous-launch-gate.md` | 1 | — |
| A1 | Autopilot process drive | `2026-07-20-autopilot-process-drive.md` | 1 | — |
| Q1 | Structured CLI e2e baseline | `2026-07-20-structured-cli-e2e-baseline.md` | 1 | B0 |
| T2 | Real agy worker in tmux | `2026-07-21-team-agy-worker.md` | 1 | B0 |
| T3 | Supervisor poll + reclaim | `2026-07-21-team-supervisor-reclaim.md` | 1 | T2 |
| T4 | Delivery → integration → FF publish | `2026-07-22-team-delivery-publish.md` | 1 | T2 |
| T5 | Multi-task DAG scheduler | `2026-07-22-team-dag-scheduler.md` | 1 | T4 (+T3 preferred) |
| R2 | maxOutputBytes kill + maxProcessCount | `2026-07-23-runtime-process-defense.md` | 2 | T2 preferred |
| R3a | Planning write-block sandbox | `2026-07-24-planning-write-block-sandbox.md` | 2→3 | ADR first in plan |
| R3b | AuthorityLease + Conflict Saga | `2026-07-25-authority-lease-saga.md` | 3 | T5 |

**Docs honesty (D1):** every plan exit must sync README / SKILL / DESIGN / AGENTS — not a separate plan.

---

## Dependency graph

```
B0 DONE
  ├─► T2 agy worker ──┬─► T3 supervise/reclaim ──┐
  │                   └─► T4 deliver/publish ────┼─► T5 DAG
  ├─► Q1 e2e baseline (expand after each T*/S1/A1)
  ├─► S1 dangerous gate (parallel)
  └─► A1 autopilot drive (parallel)

After T2: R2 process defense (parallel with T3/T4)
After T5: R3b AuthorityLease
R3a: ADR (hook surface) then implement anytime after Q1
```

## Shared contracts (freeze — all plans must respect)

1. **CLI JSON kinds (additive only):** `team-started`, `team-status`, `team-stopped`, `Selected`/`Rejected` (fork). New: `team-supervise-report`, `team-reclaimed`, `team-delivered`, `team-integrated`, `team-tick`, `autopilot-driven`.
2. **claimToken:** plaintext once in start response / memory; descriptor stores **digest only**.
3. **Heartbeat:** `process.startMarker = tmux:<sessionName>`; `process.pid` must become **worker** pid after T2 (not orchestrator).
4. **Kill sessions:** only with matching `ownerNonce` via `TmuxController.killOwnedSession`.
5. **Managed binding env:** `OMA_SESSION_ID`, `OMA_LAUNCH_NONCE`, `OMA_INVOCATION_GENERATION`, `OMA_WORKSPACE_PATH`, `OMA_STATE_ROOT`, `OMA_PACKAGE_ROOT` — per-worker session, never share leader session id with workers without decision log.
6. **No** `git reset --hard` / `git clean -fd` in any path.
7. **spawn/spawnSync only** — never shell `exec` with string commands.

## Implementation order (human / SDD)

**Parallel wave 1a (independent tracks):** S1, A1, Q1, T2  
**Wave 1b:** T3 ∥ T4  
**Wave 1c:** T5  
**Wave 2:** R2, R3a (ADR→code)  
**Wave 3:** R3b  

## Open decisions locked by council (defaults)

| # | Decision | Default for plans |
|---|----------|-------------------|
| D-drive | resume mutates ledger vs new `drive` | **New `oma autopilot drive`** + keep `resume` ledger-only for CAS safety |
| D-agy | exact_env depth for team workers | **Full managed env subset** with unique per-worker session id |
| D-claim | durable claim.token plaintext | Keep state store as-is for v1; **T2 must not add disk plaintext**; digest-only descriptor |
| D-gate | non-TTY | **Fail-closed** unless `--i-understand-dangerous-launch` |
| D-flags | list | `--madmax`, `--yolo` only (token exact match) |
| D-baseSha | next task worktree base | Leader HEAD at schedule time (includes published FF) |

## Exit for “product complete”

- [ ] All plan files’ exit criteria met
- [ ] unit + e2e green on CI
- [ ] DESIGN.md “blueprint” items either implemented or moved to explicit “won’t do” with user sign-off (none by default — implement all)
- [ ] No stub CLI that pretends lifecycle
- [ ] Fable matrix rows 8–14 and 21 are COMPLETE or COMPLETE(headless) for process defense
