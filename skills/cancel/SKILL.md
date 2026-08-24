---
name: cancel
description: "In-session OMA cancel — invoke /oh-my-agy:cancel then oma cancel; stop active modes HERE, leave resume-friendly state"
---

# cancel (OMA / in-session)

## You are already in the agent session

When invoked via **`/oh-my-agy:cancel`** (or user says cancel / abort / stop OMA) or this **cancel** skill, stop active OMA workflows **HERE** without destroying user work.

- Do **not** require a terminal first for workspace ledger notes.
- Canonical slash: **`/oh-my-agy:cancel`**.
- Durable CLI stop is **`oma cancel`** (CAS-fenced). Do **not** hand-write session or team aggregates.

## Purpose

Stop active OMA workflows without destroying user work (OMC `$cancel` / OMX `omx cancel` / OMG `omg cancel` analogue).

## Use when

- User invokes `/oh-my-agy:cancel` or says cancel / abort / stop / enough
- Need to freeze mid-autopilot / ralph / team cleanly

## Steps (in-session)

1. Identify active mode: autopilot / ralph / ultrawork / team / managed session.
2. Call **`oma cancel`** to persist the CAS-fenced stop. Optional flags:
   `--session <id> --workspace-key <key>`, `--team <id>`, `--all`, `--reason <text>`, `--json`.
   Also write a short remaining-work note under `.agy/` (for example `.agy/ralph/progress.md`).
   The CLI verb is the only mutation path for managed session/team state.
3. Team: `oma cancel --team <id>` (or `--all`) stops the durable team ledger. If workers may still be live, tell the user how to confirm with `oma team status`.
4. Autopilot: `oma cancel --session <id> --workspace-key <key>` marks the session cancelled with reason + UTC timestamp (`oma session list` shows `terminal=true`). Do not delete evidence (specs/plans/reviews/qa).
5. Do **not** run destructive git cleanups, and do **not** remove worktrees that still have unintegrated commits. Worktree recycle is a separate verb: `oma team cleanup --dry-run` then `oma team cleanup --team <id> --expected-revision <n>`. `oma cancel` / `oma team stop` do not delete managed worktrees.
6. Tell the user how to resume (re-invoke slash skill, or optional `oma autopilot resume` / `oma team status` if they used durable CLI).

## Forbidden

- Destructive git restore / force-clean of the working tree
- Deleting worktrees with unintegrated commits
- Claiming "cancelled and cleaned everything" without listing what remains
- Requiring SID/terminal before writing a cancel note in-session
- Bypassing `oma cancel` by editing authoritative aggregates by hand

## Final checklist

- [ ] Active mode identified and noted inactive
- [ ] `oma cancel` invoked (or confirmed no active session/team)
- [ ] Cancellation note with remaining work
- [ ] No destructive git
- [ ] Resume path stated

---

## Appendix: optional `oma` CLI

Use when durable sessions were started via CLI. Prefer the top-level verb; keep the low-level autopilot cancel unchanged for callers that already have `--expected-revision`.

```bash
oma cancel [--session <id> --workspace-key <key>] [--team <id>] [--all] [--reason <text>] [--json]
oma team stop --team <id>
oma team cleanup --team <id> --expected-revision <n> [--dry-run] [--json]
oma autopilot cancel --session <id> --expected-revision <n> --reason <text>
oma autopilot resume --session <id> --conversation <cid> --expected-revision <n>
oma team status --team <id>
```

Workspace artifacts under `.agy/` remain the quality/progress source of truth for in-session work.
