---
name: hud
description: "In-session OMA run-state readout — invoke /oh-my-agy:hud; report orchestration state from the snapshot, never guess progress"
argument-hint: "[minimal|focused|full]"
---

# hud (OMA / in-session)

## You are already in the agent session

When invoked via **`/oh-my-agy:hud`** or this **hud** skill, treat **`$ARGUMENTS` as an optional preset** (`minimal` | `focused` | `full`) and report the current OMA run state **HERE**.

- Canonical slash: **`/oh-my-agy:hud`**.
- The HUD reads a **snapshot**, not your memory of what you did. Report what the snapshot says.
- Default preset is `focused`.

## Purpose

OMC and OMX both expose a HUD so a long-running orchestration is legible at a glance: which mode is active, how far the team got, what is blocked. OMA collects a far richer snapshot than it displays (`src/hud/status.ts` carries iteration, review cycle, no-progress streak, blocker list, worker bindings, adapter health) — this skill is the in-session readout over it.

## Use when

- User invokes `/oh-my-agy:hud` or asks where are we / what is running / is anything stuck
- Resuming after a break, a compaction, or a crash and you need orientation before acting
- A team run has been going a while and you owe the user a status line

## Do not use when

- You need proof something works → `verify`
- You need to diagnose an install/plugin problem → `oma doctor`
- You want to change state → HUD is strictly a readout

## Presets

| Preset | Shows |
|--------|-------|
| `minimal` | Session phase + team completion count. One glance, nothing else. |
| `focused` (default) | Session phase/revision/generation, team completed/total/blocked, adapter status. |
| `full` | Everything in `focused`, then — when a session is bound — `iter`, `review`, `streak`, `evidence` (accepted/verified), `binding`, plus `terminal` / `retryable` / `interaction` when set; when a team is bound — `active`, `terminal_tasks`, `mailbox`, `workers` (a binding count), `supervisor`, and `blockers` listed by task ID; and whenever adapters are present, `adapter_details` with each adapter's `detail_code`. |

`full` is a strict superset of `focused` — it appends, never rewrites, so anything that parses the `focused` prefix keeps working.

Two deliberate omissions, so you do not read the table as promising more than it gives: per-task `worker_provider` / `worker_state` are **not** rendered (only the binding count), and no preset renders the per-task list. Use `--json` when you need those.

## Rules

1. **Read-only.** The HUD never mutates session or team state.
2. **Report unavailability honestly.** `session=-` means no bound session, not "everything is fine". `status: corrupt` is a finding you must surface, not noise to skip.
3. **A stale snapshot is worse than none.** If `collected_at` is old relative to work you just did, say so.
4. **Blockers get named — and an unqueried team is not a clean team.** When `blocker_count > 0`, list the blocking task IDs; a count alone is not actionable. Note that team fields are populated **only** when you pass `--team <id> --workspace-key <key>` (see the Appendix). A bare `oma hud` shows `team=-`, which means the team was never queried — never report that as "nothing is blocked".
5. **Never infer progress.** If the snapshot says `no_progress_streak: 4`, that is the truth even if the transcript looks busy.

## Steps (in-session)

1. Pick the preset — default `focused`; use `full` when something looks wrong.
2. Read the snapshot.
3. Report: session phase, team progress, adapters, and **anything blocked**.
4. If blocked, say what would unblock it and which lane owns that (`team`, `verify`, `ultraqa`, …).
5. Do not start work off the back of the HUD unless the user asked — orientation is the deliverable.

## Checklist

- [ ] Preset stated
- [ ] Unavailable / corrupt views reported rather than skipped
- [ ] Blocker task IDs named when `blocker_count > 0`
- [ ] Adapter status included (`focused` / `full`)
- [ ] No state mutated

## Anti-patterns (forbidden)

- Reporting "all good" when the snapshot says `unavailable`
- Summarizing progress from the conversation instead of the snapshot
- Hiding a `no_progress_streak` because the transcript looks productive
- Using the HUD as evidence of completion — that is `verify`'s job

---

## Appendix: optional `oma` CLI

```bash
oma hud                                  # focused (default)
oma hud --preset minimal
oma hud --preset full
oma hud --json                           # canonical snapshot; preset does not affect JSON
oma hud --watch                          # live updates; --preset applies to every tick

# Bind a session / team, or the corresponding fields stay '-'
oma hud --session <id> --workspace-key <key>
oma hud --team <id> --workspace-key <key> [--repo-key <key>]
```

**The team fields — including `blockers` — only exist when you pass `--team`.** A bare `oma hud` prints `team=-`, which means *nothing was queried*, not *nothing is blocked*. Reporting "nothing is stuck" off an unqueried HUD is the anti-pattern this skill forbids; if you cannot supply a team id, say the team was not queried.

Flags take a **space-separated** value: `--preset minimal`, not `--preset=minimal` (the equals form is rejected as an unexpected argument).

Design concept mapping: `oh-my-codex/skills/hud` (preset tiers + `--watch` + `--json`),
`oh-my-claudecode/skills/hud` (statusline presets), `oh-my-grok/skills/omg-hud`.
