# OMA (oh-my-agy) Full Feature Completeness Review Brief
Date: 2026-07-20
Repo: /Users/iml1s/Documents/mine/oh-my-agy
Reviewer: Claude Fable 5 xhigh — READ-ONLY, no code changes, no workflow modes.

## Mission
You are an adversarial senior engineer reviewing **feature completeness** of oh-my-agy (OMA), an Antigravity (`agy`) orchestration layer.

Focus hard on:
1. **tmux team worker lifecycle** — is it production-complete end-to-end?
2. **`--madmax` / `--yolo` / confirmDangerousLaunch** — implemented or design-only?
3. **All other major surfaces** — what is actually complete vs stub vs design blueprint?

Deliver a rigorous Traditional Chinese report written to:
`/Users/iml1s/Documents/mine/oh-my-agy/.omc/research/fable-review/fable5-full-review.md`

Also print the full report to stdout.

## Hard rules
- READ-ONLY. Do not edit source. Do not run destructive commands.
- You MAY: `git`, `rg`, `cat`/`read`, `npm run build`, `npm run test:unit`, limited targeted tests.
- Evidence over vibes: every verdict needs file path + symbol/line or command output.
- Distinguish: **Implemented + wired to CLI**, **Implemented library only (typed API)**, **Stub/CLI validation only**, **Design-only / unbuilt**.
- This brief intentionally avoids OMC magic keywords that hijack sessions. Do not invent workflows.

## Known hints from orchestrator (verify yourself — do not trust blindly)
1. `src/cli/parser.ts` — managed modes are only `RALPH_SKILL`, `ULTRA_WORK_SKILL`, `search`. No madmax flag parsing.
2. `DESIGN.md` lists confirmDangerousLaunch (`--madmax` / `--yolo`) under **Design Blueprint / Future Plans**, not "currently implemented".
3. `src/team/commands.ts` `team start` comment explicitly says CLI only validates manifest; "tmux worker lifecycle is started via typed Team APIs, not this CLI stub".
4. Real tmux code exists: `src/team/tmux.ts` (TmuxController start/inspect/kill with owner nonces), tests in `tests/team/tmux.spec.ts`, fixture `tests/helpers/tmux-fixture.ts`.
5. Team subsystem is large: manifest, state, worktree, delivery, publisher, reclaim, recovery-fork, supervisor, integration (~2.4k LOC under src/team).
6. README documents managed modes, AUTO_PILOT_SKILL FSM, team start/resolve-fork, setup, doctor, hooks PreInvocation+Stop.
7. v0.1.0 release exists; unit/e2e green on GHA recently after SIGINT Linux fix.

## Required investigation checklist
For each area, answer: complete? partial? missing? evidence? gaps vs OMC/OMX sibling expectations?

### A. tmux / Team
- Map `TmuxController` API surface vs callers (who starts workers in production CLI path?).
- Does `oma team start --manifest` actually spawn tmux panes / worktrees / supervisor heartbeats?
- What does `worker-mode interactive|headless` do after parse?
- Recovery-fork CLI path completeness (`resolve-fork`).
- Worktree create/cleanup dirty blockers.
- Delivery + publisher + temporary integration.
- Reclaim / ownership nonces.
- Supervisor attach/heartbeat.
- Tests: unit with real tmux vs e2e coverage.
- User-facing docs honesty vs code.

### B. madmax / dangerous flags
- Any argv handling of `--madmax`, `--yolo`, confirmDangerousLaunch in bin/ or src/?
- Pass-through path: would `oma --madmax ...` just forward to agy without gate?
- DESIGN / research_report claims vs code.
- Security implication if missing.

### C. Other major surfaces (completeness matrix)
Evaluate each:
1. Managed modes (`oma RALPH_SKILL --`, ULTRA_WORK_SKILL, search) + exact_env binding
2. Legacy magic keyword intercept (no `--`)
3. Pass-through + env strip (`ordinaryEnvironment`)
4. Hooks: PreInvocation bind, Stop ProgressOracle, processedStops
5. Continuation enforcer / circuit breaker (no git hard reset)
6. AUTO_PILOT_SKILL FSM (start/status/checkpoint/review/qa/resume/cancel/reset-breaker/doctor)
7. Plugin setup transaction + doctor
8. State root / session aggregate / lock
9. Install scripts / CI / release packaging
10. Intent filter (codeblock denoise, informational context)
11. Process spawn safety (spawn not exec, signal exit mapping)
12. Anything DESIGN says implemented but missing, or code exists but undocumented

### D. Completeness verdict format
Use a table:
| Surface | Status | CLI wired? | Tests | User-ready? | Gap summary |

Status enum: COMPLETE | LIBRARY_ONLY | STUB | PARTIAL | DESIGN_ONLY | ABSENT

### E. Ranking
- P0 blockers for claiming "full OMC-style product"
- P1 important incompleteness
- P2 nice-to-have
- What is genuinely production-grade today

## Report structure (Traditional Chinese)
1. Executive verdict (5-10 lines, blunt)
2. tmux/Team deep dive
3. madmax/dangerous flags deep dive
4. Full feature completeness matrix
5. Evidence index (paths)
6. Recommended next implementation order (concrete, smallest useful increments)
7. Final score: completeness % for (a) core single-agent loop (b) team/tmux (c) product polish

Do not self-censor bad news. Prefer "not wired" over "almost done".
