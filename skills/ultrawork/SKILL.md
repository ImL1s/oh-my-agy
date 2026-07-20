---
name: ultrawork
description: "In-session OMA parallel execution — invoke /oh-my-agy:ultrawork; slice independent work HERE (no terminal required)"
argument-hint: "<task with parallel items>"
---

# ultrawork (OMA / in-session)

## You are already in the agent session

When invoked via **`/oh-my-agy:ultrawork`** (or keyword `ulw`) or this **ultrawork** skill, treat **`$ARGUMENTS` as the task** and run parallel lanes **HERE**.

- Do **not** require `oma ultrawork` / terminal / SID as the default path.
- Canonical slash: **`/oh-my-agy:ultrawork`**.
- Outer managed launch (if any) is optional; start slicing in-session immediately.

## Purpose

High-throughput **parallel execution discipline**. Component skill — not full persistence (use `ralph`) and not multi-tmux team lifecycle (use `team`).

## Use when

- User invokes `/oh-my-agy:ultrawork` or says ultrawork / ulw / parallelize
- Multiple independent slices exist

## Do not use when

- Durable multi-iteration completion promise → `/oh-my-agy:ralph` or `/oh-my-agy:autopilot`
- Coordinated workers/worktrees/manifest → `/oh-my-agy:team`
- Single sequential task → just do it

## Steps (in-session)

1. **Ground context** — intent, constraints, unknowns in 3–6 bullets.
2. **Acceptance criteria** — commands/artifacts that prove success **before** edits.
3. **Slice independence**
   - Independent → parallel lanes
   - Shared-file / prerequisite → sequential or single lane
4. **Execute**
   - Prefer concurrent tool work when truly independent
   - Do not invent fake parallelism
5. **Lightweight verify** — build/tests relevant to touched slices (`/oh-my-agy:verify`, proportional)
6. **Integrate** — one coherent summary; no orphan half-lanes

## Escalation

- Needs durable loop → hand off to `ralph`
- Needs tmux workers / DAG / deliver → `team` (explicit only; CLI optional appendix on that skill)
- Needs full product pipeline → `autopilot`

## Anti-patterns (forbidden)

- Claiming parallel done without per-lane or integrated evidence
- Opening with “run `oma ultrawork` in a terminal first”
- Silent scope reduction on a blocked lane

## Final checklist

- [ ] Acceptance criteria stated before coding
- [ ] Parallel only for independent work
- [ ] Evidence for each lane or integrated suite
- [ ] No unverified "done"
