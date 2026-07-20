---
name: ultrawork
description: "OMA parallel execution discipline for independent work slices"
argument-hint: "<task with parallel items>"
---

# ultrawork (OMA / Antigravity)

## Purpose

High-throughput **parallel execution discipline**. Component skill — not full persistence (use `ralph`) and not multi-tmux team lifecycle (use `team`).

## Use when

- User says ultrawork / ulw / parallelize
- Multiple independent slices exist

## Do not use when

- Durable multi-iteration completion promise → `ralph` or `autopilot`
- Coordinated workers/worktrees/manifest → `team`
- Single sequential task → just do it

## Steps

1. **Ground context** — intent, constraints, unknowns in 3–6 bullets.
2. **Acceptance criteria** — commands/artifacts that prove success **before** edits.
3. **Slice independence**
   - Independent → parallel lanes
   - Shared-file / prerequisite → sequential or single lane
4. **Execute**
   - Prefer concurrent tool work when truly independent
   - Do not invent fake parallelism
5. **Lightweight verify** — build/tests relevant to touched slices (`verify` skill, proportional)
6. **Integrate** — one coherent summary; no orphan half-lanes

## Escalation

- Needs durable loop → hand off to `ralph`
- Needs tmux workers / DAG / deliver → `team` + `oma team …`
- Needs full product pipeline → `autopilot`

## Final checklist

- [ ] Acceptance criteria stated before coding
- [ ] Parallel only for independent work
- [ ] Evidence for each lane or integrated suite
- [ ] No unverified "done"
