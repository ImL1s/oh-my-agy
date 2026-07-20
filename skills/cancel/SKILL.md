---
name: cancel
description: "Cancel OMA active modes and leave resume-friendly state"
---

# cancel (OMA)

## Purpose

Stop active OMA workflows without destroying user work (OMC/OMX `$cancel` analogue).

## Steps

1. Identify active mode: autopilot / ralph / ultrawork / team / managed session.
2. Persist a short cancellation note (what was done, what remains).
3. Team: `oma team stop --team <id>` when a team is running.
4. Autopilot: mark ledger inactive if using `oma autopilot` state; do not delete evidence.
5. Do **not** run destructive git cleanups.
6. Tell the user how to resume (`oma autopilot resume`, re-run ralph, `oma team status`).

## Forbidden

- `git reset --hard`, `git clean -fd`
- Deleting worktrees with unintegrated commits
- Claiming "cancelled and cleaned everything" without listing what remains
