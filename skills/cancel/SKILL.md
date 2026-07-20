---
name: cancel
description: "In-session OMA cancel — invoke /oh-my-agy:cancel; stop active modes HERE, leave resume-friendly state (CLI stop optional)"
---

# cancel (OMA / in-session)

## You are already in the agent session

When invoked via **`/oh-my-agy:cancel`** (or user says cancel / abort / stop OMA) or this **cancel** skill, stop active OMA workflows **HERE** without destroying user work.

- Do **not** require a terminal first for workspace ledger notes.
- Canonical slash: **`/oh-my-agy:cancel`**.
- Optional CLI stop/resume commands live in the [Appendix](#appendix-optional-oma-cli) when durable autopilot/team sessions were started via `oma`.

## Purpose

Stop active OMA workflows without destroying user work (OMC/OMX `$cancel` analogue).

## Use when

- User invokes `/oh-my-agy:cancel` or says cancel / abort / stop / enough
- Need to freeze mid-autopilot / ralph / team cleanly

## Steps (in-session)

1. Identify active mode: autopilot / ralph / ultrawork / team / managed session.
2. Persist a short cancellation note under `.agy/` (what was done, what remains) — e.g. `.agy/autopilot/state.json` → `active: false`, or a note in `.agy/ralph/progress.md`.
3. Team: if a durable team is running, stop via CLI when available (see appendix); otherwise record that workers may still be live and how the user can stop them.
4. Autopilot: mark workspace phase state inactive; do not delete evidence (specs/plans/reviews/qa).
5. Do **not** run destructive git cleanups.
6. Tell the user how to resume (re-invoke slash skill, or optional `oma autopilot resume` / `oma team status` if they used durable CLI).

## Forbidden

- `git reset --hard`, `git clean -fd`
- Deleting worktrees with unintegrated commits
- Claiming "cancelled and cleaned everything" without listing what remains
- Requiring SID/terminal before writing a cancel note in-session

## Final checklist

- [ ] Active mode identified and noted inactive
- [ ] Cancellation note with remaining work
- [ ] No destructive git
- [ ] Resume path stated

---

## Appendix: optional `oma` CLI

Use when durable sessions were started via CLI:

```bash
oma team stop --team <id>
oma autopilot cancel --session <id> --expected-revision <n> --reason <text>
oma autopilot resume --session <id> --conversation <cid> --expected-revision <n>
oma team status --team <id>
```

Workspace artifacts under `.agy/` remain the quality/progress source of truth for in-session work.
