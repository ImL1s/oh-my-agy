---
name: autopilot
description: "In-session OMA autonomous delivery — invoke /oh-my-agy:autopilot with a goal; run deep-interview→ralplan→ultragoal→code-review→ultraqa HERE (no terminal required)"
argument-hint: "<product idea or task>"
---

# autopilot (OMA / in-session)

## You are already in the agent session

When invoked via **`/oh-my-agy:autopilot`** (canonical namespaced slash) or this **autopilot** skill, treat **`$ARGUMENTS` as the goal** and run the full delivery phases **HERE in this conversation**.

- Do **not** tell the user to open a terminal first.
- Do **not** require `oma autopilot start` / `drive` / SID / CID / revision as the default happy path.
- Bare `/autopilot` is left to OMC (or host) if present; **OMA’s canonical form is `/oh-my-agy:autopilot`**.
- Optional durable ledger via `oma` CLI lives only in the [Appendix](#appendix-optional-oma-cli-ledger)--use it when the user wants cross-session resume, never as a gate to start work.

## Purpose

End-to-end autonomous delivery **inside the current agent session** (Claude Code / Grok / Antigravity host). Sibling of OMC/OMX autopilot; tools are host-native. Workspace artifacts stay under **`.agy/`**.

Maps to the **OMX five-phase** contract.

## Default loop (strict OMX)

```text
deep-interview → ralplan → ultragoal → code-review → ultraqa → complete
```

Optional: `team` during `ultragoal` for multi-worker DAG (**explicit only**).  
Non-clean `code-review` / `ultraqa` → **return to `ralplan`** with `return_to_ralplan_reason` — do not ad-hoc patch outside the loop.  
Production / causal-trace evidence may still be required as a terminal gate before claiming **complete**.

### Legacy phase aliases (compat)

| OMX canonical   | Legacy OMA   |
|-----------------|--------------|
| deep-interview  | requirements  |
| ralplan         | planning     |
| ultragoal       | executing    |
| code-review     | review       |
| ultraqa         | qa           |

## Canonical skill handoffs (in-session)

| # | Phase | Slash / skill | Workspace artifacts |
|---|-------|---------------|---------------------|
| 1 | deep-interview | `/oh-my-agy:deep-interview` · `skills/deep-interview/SKILL.md` | `.agy/specs/…` |
| 2 | ralplan | `/oh-my-agy:ralplan` · `skills/ralplan/SKILL.md` | `.agy/plans/…` (critic **APPROVE**) |
| 3 | ultragoal | `/oh-my-agy:ultragoal` · `skills/ultragoal/SKILL.md` | `.agy/ultragoal/…` + `skills/verify` (+ optional `team`) |
| 4 | code-review | `/oh-my-agy:code-review` · `skills/code-review/SKILL.md` | `.agy/reviews/…` → **APPROVE+CLEAR** or **REQUEST CHANGES** |
| 5 | ultraqa | `/oh-my-agy:ultraqa` · `skills/ultraqa/SKILL.md` | `.agy/qa/…` → **PASS** / **FAIL** / justified **SKIP** |
| 6 | complete | — | production evidence + mode inactive |

Within ultragoal, `ralph` / `ultrawork` remain component disciplines; they do not replace the phase skill.

## Use when

- User invokes `/oh-my-agy:autopilot` or says autopilot / full auto / build me / handle it all
- Multi-phase work needs clarify → plan → implement → review → QA in one session

## Do not use when

- Single small fix → use `/oh-my-agy:ralph` or direct work
- User only wants explanation → conversational answer
- User only wants a plan → stop after `ralplan` (do not enter ultragoal)

## In-session state (workspace mirror)

Happy path needs **no** session id. Optionally maintain a workspace note for continuity:

```text
.agy/autopilot/state.json
```

Minimum fields:

```json
{
  "mode": "autopilot",
  "active": true,
  "current_phase": "deep-interview",
  "phase_cycle": [
    "deep-interview",
    "ralplan",
    "ultragoal",
    "code-review",
    "ultraqa"
  ],
  "iteration": 1,
  "goal": "<goal from $ARGUMENTS>",
  "handoffs": {
    "deepInterview": null,
    "ralplan": null,
    "ultragoal": null,
    "codeReview": null,
    "ultraqa": null
  },
  "return_to_ralplan_reason": null
}
```

Update `current_phase` and `handoffs` as you finish each phase. This file is a **workspace convenience**, not a hard dependency.

## Steps (by phase) — run HERE

### 0. Start

1. Parse `$ARGUMENTS` (or the user message) as the goal.
2. Write/refresh `.agy/autopilot/state.json` with `active: true`, `current_phase: "deep-interview"`.
3. Enter Phase 1 immediately — no CLI preamble.

### 1. deep-interview (clarify)

- Follow `skills/deep-interview/SKILL.md` (slash: `/oh-my-agy:deep-interview`).
- Restate goal, non-goals, constraints, acceptance.
- If still vague: max 3 focused questions **or** write explicit skip rationale authorized by user.
- Handoff: `.agy/specs/…` → set `handoffs.deepInterview` → advance phase to `ralplan`.

### 2. ralplan (plan)

- Follow `skills/ralplan/SKILL.md` (slash: `/oh-my-agy:ralplan`).
- Author + steelman + critic passes; write plan artifact.
- Do **not** implement until critic **APPROVE**.
- Handoff: `.agy/plans/…` → advance phase to `ultragoal`.

### 3. ultragoal (implement + verify)

- Follow `skills/ultragoal/SKILL.md` (slash: `/oh-my-agy:ultragoal`).
- Ledger under `.agy/ultragoal/`; mandatory `skills/verify/SKILL.md` with fresh command output.
- Independent slices → `ultrawork`; multi-worker → `team` (**explicit only**).
- Never reduce scope silently.
- Handoff → advance phase to `code-review`.

### 4. code-review (merge readiness)

- Follow `skills/code-review/SKILL.md` (slash: `/oh-my-agy:code-review`).
- Artifact under `.agy/reviews/` with **APPROVE+CLEAR** or **REQUEST CHANGES**.
- On REQUEST CHANGES → return to `ralplan` (or fix + re-review; do not skip the artifact).
- On APPROVE+CLEAR → advance to `ultraqa`.

### 5. ultraqa (adversarial QA)

- Follow `skills/ultraqa/SKILL.md` (slash: `/oh-my-agy:ultraqa`).
- Artifact under `.agy/qa/`. Docs-only may **SKIP** with written reason; code changes must run scenarios.
- On FAIL → return to `ralplan` / fix loop; re-run ultraqa after fix.
- On PASS / justified SKIP → ready for complete.

### 6. Complete

- Mark inactive only when review + QA are clean (or QA skip justified) and any required production gate passes.
- Set `.agy/autopilot/state.json` → `active: false` (or delete/archive).
- Summarize: what shipped, evidence commands, residual risks.

## Stop conditions

- User: stop / cancel / abort → follow `cancel` skill; stop advancing phases
- Same failure 3× with no new plan → report blocker
- Missing credentials / irreversible production action → ask user

## Anti-patterns (forbidden)

- Opening with “run `oma autopilot start` / `drive` first”
- Blocking work on missing SID / CID / revision in the happy path
- Claiming complete without review + QA (or justified QA skip) artifacts
- Silent scope reduction or skipping phases without written rationale

## Final checklist

- [ ] Spec + plan artifacts exist; ralplan critic APPROVE
- [ ] Ultragoal ledger complete; fresh verify evidence
- [ ] Code-review **APPROVE+CLEAR** under `.agy/reviews/`
- [ ] Ultraqa **PASS** or justified **SKIP** under `.agy/qa/`
- [ ] Workspace phase state updated (or blockers explicit)
- [ ] Autopilot inactive / phase complete when done

---

## Appendix: optional `oma` CLI ledger

Use **only** when the user wants a durable outer ledger (cross-session resume, managed binding). Not required to start or finish in-session work.

### Discover skills

```bash
oma skill list
oma skill show autopilot
```

### Start / drive / status (optional)

```bash
oma autopilot start -- "Ship feature X"
oma autopilot status --session <id>
oma autopilot doctor --session <id>

# bind + managed spawn; injects skill for *current* phase
oma autopilot drive --session <id> --conversation <cid> --expected-revision <n>
oma autopilot resume --session <id> --conversation <cid> --expected-revision <n>
```

### Handoff & phase advance (optional)

```bash
oma autopilot handoff --session <id> --expected-revision <n> \
  --key deepInterview|ralplan|ultragoal|codeReview|ultraqa \
  --path <artifact>

oma autopilot advance --session <id> --expected-revision <n> --evidence <file>

oma autopilot consensus --session <id> --expected-revision <n> \
  --role architect|critic --verdict approve|revise --note <text>

oma autopilot return-ralplan --session <id> --expected-revision <n> --reason <text>

oma autopilot review --session <id> --expected-revision <n> --evidence <review-evidence.json>
oma autopilot qa --session <id> --expected-revision <n> --evidence <qa-evidence.json>

oma autopilot checkpoint --session <id> --expected-revision <n> --evidence <file>
oma autopilot cancel --session <id> --expected-revision <n> --reason <text>
oma autopilot reset-breaker --session <id> --expected-revision <n>
```

When session-bound, keep CLI revision/handoff in sync with the `.agy/` artifacts you already wrote in-session. The in-session artifact is the source of truth for phase quality; CLI records durability.
