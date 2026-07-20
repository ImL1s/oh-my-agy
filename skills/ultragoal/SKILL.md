---
name: ultragoal
description: "In-session OMA implement+verify — invoke /oh-my-agy:ultragoal; sequential goals + .agy/ultragoal ledger HERE (CLI optional)"
argument-hint: "<approved plan path or goal brief>"
---

# ultragoal (OMA / in-session)

## You are already in the agent session

When invoked via **`/oh-my-agy:ultragoal`** or this **ultragoal** skill (including as Autopilot Phase 3), treat **`$ARGUMENTS` as the approved plan path or goal brief** and implement **HERE**.

- Do **not** require `oma autopilot drive` / SID / CID / revision to start coding.
- Keep a durable workspace ledger under **`.agy/ultragoal/`**.
- Canonical slash: **`/oh-my-agy:ultragoal`**.

## Purpose

Durable **implement + verify** phase (OMX `$ultragoal` analogue). Runs after `ralplan` APPROVE and before `code-review`.

Maps to Autopilot active phase `ultragoal` (legacy: `executing`). Host-native tools + workspace artifacts (not Claude `Task` / OMX `.omx` paths).

Persistence for a single goal may reuse `ralph` discipline; multi-worker slices use `team` **explicitly only**.

## Use when

- Autopilot phase is `ultragoal` / user says ultragoal / implement the approved plan
- Approved `ralplan` exists and critic verdict is **APPROVE**
- Work needs sequential sub-goals with a durable ledger and fresh verify evidence

## Do not use when

- Spec still vague → `/oh-my-agy:deep-interview`
- Plan not approved → `/oh-my-agy:ralplan` (do not implement on REVISE)
- Only parallel independent slices without multi-goal ledger → `ultrawork`
- Full product pipeline orchestration → follow parent `/oh-my-agy:autopilot`

## Artifacts (workspace ledger)

Prefer workspace-safe paths under `.agy/` (not `.omx` / `.omc`):

```text
.agy/ultragoal/<slug>/brief.md          # goal brief (from ralplan / context)
.agy/ultragoal/<slug>/status.json       # active goal + progress
.agy/ultragoal/<slug>/ledger.jsonl      # append-only events
.agy/ultragoal/<slug>/progress.md       # human-readable progress
```

Optional machine summary for handoff:

```text
.agy/ultragoal/<slug>/handoff.json
```

### `status.json` (minimal)

```json
{
  "schemaVersion": 1,
  "goal": "<goal>",
  "planPath": ".agy/plans/…",
  "activeSubgoalId": "SG-001",
  "subgoals": [
    {
      "id": "SG-001",
      "title": "…",
      "acceptanceCriteria": ["testable criterion"],
      "passes": false
    }
  ],
  "verifyEvidencePath": null,
  "complete": false
}
```

### `ledger.jsonl` events (one JSON object per line)

Record at least: `subgoal_started`, `files_touched`, `verify_ran`, `subgoal_passed`, `blocked`, `complete`.

## Related skills

| Skill | Role in this phase |
|-------|--------------------|
| `skills/verify/SKILL.md` | **Mandatory** before marking any subgoal / phase complete |
| `skills/team/SKILL.md` | Optional multi-worker DAG (explicit only) |
| `skills/ralph/SKILL.md` · `/oh-my-agy:ralph` | Persistence loop for single-threaded stories |
| `skills/ultrawork/SKILL.md` | Parallel independent slices inside a subgoal |
| `skills/code-review/SKILL.md` · `/oh-my-agy:code-review` | Next phase after ultragoal evidence |

## Steps (in-session)

1. **Load plan** — read approved `ralplan` + spec; refuse to code if critic verdict is not APPROVE.
2. **Init brief + ledger** — write `brief.md` / `status.json`; decompose into ordered subgoals with **testable** acceptance criteria (no boilerplate “implementation complete”).
3. **Pick next subgoal** — highest priority with `passes: false`; respect dependencies.
4. **Implement** — smallest correct change for that subgoal only; log files in the ledger.
5. **Verify** — follow `skills/verify/SKILL.md` with **fresh** command output for that subgoal (and integrated suite when required).
6. **Mark passes** — only when all acceptance criteria are evidenced; append ledger events.
7. **Loop** until every subgoal `passes: true`.
8. **Phase handoff** — write `handoff.json` summary; prepare for `/oh-my-agy:code-review`.
9. **Do not self-approve merge** — next phase is `code-review`, then `ultraqa`.

## Gates before leaving ultragoal

- [ ] All subgoals `passes: true` with ledger entries
- [ ] Fresh verify evidence for the full change set (`verify` skill)
- [ ] No silent scope reduction vs approved plan (plan revised with reason if needed)
- [ ] Team (if used) stopped / delivers integrated; worktrees not force-cleaned
- [ ] Handoff path ready for code-review

## Stop / return conditions

- Hard blocker (credentials, product decision) → report; do not invent requirements
- Same verify failure 3× with no new diagnosis → escalate; consider return to ralplan via parent autopilot
- User cancel → `cancel` skill
- Plan hole discovered mid-implement → stop coding; return to `ralplan` with findings (do not ad-hoc redesign in silence)

## Anti-patterns (forbidden)

- Claiming phase complete without fresh verify output
- Skipping tests or deleting failing tests to go green
- Starting without approved ralplan
- Using `team` without an explicit multi-worker need / manifest
- Blocking on missing CLI session before implementing
- Writing completion into OMA state as `verified: true` yourself — outer gates own that when used

## Final checklist

- [ ] `.agy/ultragoal/<slug>/` ledger exists and is up to date
- [ ] Every acceptance criterion has evidence
- [ ] `verify` skill satisfied for the change set
- [ ] Ready for `/oh-my-agy:code-review`

---

## Appendix: optional `oma` CLI ledger

Only when the user wants outer Autopilot durability:

```bash
oma autopilot handoff --session <id> --expected-revision <n> \
  --key ultragoal --path .agy/ultragoal/<slug>/handoff.json

oma autopilot advance --session <id> --expected-revision <n> \
  --evidence <path-to-evidence.json>

oma autopilot status --session <id>
```

Optional team (explicit only):

```bash
oma team start --manifest <path>
oma team tick --team <id>
oma team deliver --team <id> --task <id> …
oma team stop --team <id>
```

Evidence JSON must prove implement work + verify ran. Do not advance on “looks good”. In-session ledger under `.agy/ultragoal/` remains the primary artifact.
