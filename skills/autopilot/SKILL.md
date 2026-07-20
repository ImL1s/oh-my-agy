---
name: autopilot
description: "OMA autonomous delivery loop: deep-interview → ralplan → ultragoal → code-review → ultraqa → complete"
argument-hint: "<product idea or task>"
---

# autopilot (OMA / Antigravity)

## Purpose

End-to-end autonomous delivery **inside an Antigravity session**, coordinated with the OMA CLI ledger.

Maps to the **OMX five-phase** autopilot contract. Tools are Antigravity-native + `oma` CLI (not Claude `Task` / OMX state CLI).

## Default loop (strict OMX)

```text
deep-interview → ralplan → ultragoal → code-review → ultraqa → complete
```

Optional: `team` during `ultragoal` for multi-worker DAG (explicit only).  
Non-clean `code-review` / `ultraqa` → **return to `ralplan`** with `return_to_ralplan_reason` — do not ad-hoc patch outside the loop.  
Production / causal-trace evidence may still be required as an OMA-specific terminal gate before `completed`.

### Legacy phase aliases (compat)

| OMX canonical   | Legacy OMA   |
|-----------------|--------------|
| deep-interview  | requirements  |
| ralplan         | planning     |
| ultragoal       | executing    |
| code-review     | review       |
| ultraqa         | qa           |

## Canonical skill handoffs

| # | Phase | Skill | Workspace artifacts |
|---|-------|-------|---------------------|
| 1 | deep-interview | `skills/deep-interview/SKILL.md` | `.agy/specs/…` |
| 2 | ralplan | `skills/ralplan/SKILL.md` | `.agy/plans/…` (critic **APPROVE**) |
| 3 | ultragoal | `skills/ultragoal/SKILL.md` | `.agy/ultragoal/…` + `skills/verify` (+ optional `team`) |
| 4 | code-review | `skills/code-review/SKILL.md` | `.agy/reviews/…` → **APPROVE+CLEAR** or **REQUEST CHANGES** |
| 5 | ultraqa | `skills/ultraqa/SKILL.md` | `.agy/qa/…` → **PASS** / **FAIL** / justified **SKIP** |
| 6 | complete | — | production evidence + autopilot inactive |

Within ultragoal, `ralph` / `ultrawork` remain component disciplines; they do not replace the phase skill or CLI gates.

## Use when

- User says autopilot / full auto / build me / handle it all
- Multi-phase work needs durable progress across clarify → plan → implement → review → QA

## Do not use when

- Single small fix → use `ralph` or direct work
- User only wants explanation → conversational answer
- User only wants a plan → stop after `ralplan` (do not enter ultragoal)

## CLI surface (outer ledger)

### Discover skills

```bash
oma skill list
oma skill show autopilot
oma skill show deep-interview
oma skill show ralplan
oma skill show ultragoal
oma skill show code-review
oma skill show ultraqa
```

### Start / drive / status

```bash
oma autopilot start -- "Ship feature X"
oma autopilot status --session <id>
oma autopilot doctor --session <id>

# bind + managed spawn; injects skill for *current* phase
oma autopilot drive --session <id> --conversation <cid> --expected-revision <n>
oma autopilot resume --session <id> --conversation <cid> --expected-revision <n>
```

### Handoff artifacts

```bash
oma autopilot handoff --session <id> --expected-revision <n> \
  --key deepInterview|ralplan|ultragoal|codeReview|ultraqa \
  --path <artifact>
```

### Phase advance & consensus

```bash
# advance current gate with evidence (OMX-aware; alias of checkpoint messaging)
oma autopilot advance --session <id> --expected-revision <n> --evidence <file>

# ralplan architect/critic consensus records
oma autopilot consensus --session <id> --expected-revision <n> \
  --role architect|critic --verdict approve|revise --note <text>

# non-clean review/QA → back to planning
oma autopilot return-ralplan --session <id> --expected-revision <n> --reason <text>
```

### Review & QA gates

```bash
oma autopilot review --session <id> --expected-revision <n> --evidence <review-evidence.json>
oma autopilot qa --session <id> --expected-revision <n> --evidence <qa-evidence.json>
```

### Other

```bash
oma autopilot checkpoint --session <id> --expected-revision <n> --evidence <file>
oma autopilot cancel --session <id> --expected-revision <n> --reason <text>
oma autopilot reset-breaker --session <id> --expected-revision <n>
```

### Session playbook (happy path)

```bash
oma setup && oma doctor --no-strict-plugin
oma skill list
oma skill show autopilot

oma autopilot start -- "Ship feature X"
# phase = deep-interview
oma autopilot drive --session $SID --conversation $CID --expected-revision 0
# agent follows deep-interview skill; writes .agy/specs/...

oma autopilot handoff --session $SID --expected-revision N \
  --key deepInterview --path .agy/specs/foo.md
oma autopilot advance --session $SID --expected-revision N \
  --evidence evidence/deep-interview.json
# → ralplan

oma autopilot consensus --session $SID --expected-revision N \
  --role architect --verdict approve --note ok
oma autopilot consensus --session $SID --expected-revision N \
  --role critic --verdict approve --note ok
oma autopilot advance --session $SID --expected-revision N \
  --evidence evidence/ralplan.json
# → ultragoal

# implement + verify (skills/ultragoal + skills/verify; optional oma team)
oma autopilot handoff --session $SID --expected-revision N \
  --key ultragoal --path .agy/ultragoal/<slug>/handoff.json
oma autopilot advance --session $SID --expected-revision N \
  --evidence evidence/ultragoal.json
# → code-review

oma autopilot review --session $SID --expected-revision N \
  --evidence evidence/code-review.json
# → ultraqa

oma autopilot qa --session $SID --expected-revision N \
  --evidence evidence/ultraqa.json

# production / causal-trace terminal evidence → completed
oma autopilot advance --session $SID --expected-revision N \
  --evidence evidence/production.json
```

On `REQUEST CHANGES` or QA `FAIL`:

```bash
oma autopilot return-ralplan --session $SID --expected-revision N \
  --reason "review: missing migration tests"
```

## In-session state note (optional workspace mirror)

CLI SessionAggregate is authoritative. Optional workspace note:

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
  "goal": "<goal>",
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

## Steps (by phase)

### 1. deep-interview (clarify)

- Follow `skills/deep-interview/SKILL.md`.
- Restate goal, non-goals, constraints, acceptance.
- If still vague: max 3 focused questions **or** write explicit skip rationale authorized by user.
- Handoff: `.agy/specs/…` → `handoff --key deepInterview` → `advance` with requirements/deep-interview evidence.

### 2. ralplan (plan)

- Follow `skills/ralplan/SKILL.md` (author + steelman + critic).
- Record consensus: `oma autopilot consensus --role architect|critic …`.
- Do **not** implement until critic **APPROVE**.
- Handoff: `.agy/plans/…` → `advance` into ultragoal.

### 3. ultragoal (implement + verify)

- Follow `skills/ultragoal/SKILL.md` (ledger under `.agy/ultragoal/`).
- Mandatory `skills/verify/SKILL.md` with fresh command output.
- Independent slices → `ultrawork`; multi-worker → `team` + `oma team …` (explicit only).
- Never reduce scope silently.
- Handoff → advance into code-review.

### 4. code-review (merge readiness)

- Follow `skills/code-review/SKILL.md`.
- Artifact under `.agy/reviews/` with **APPROVE+CLEAR** or **REQUEST CHANGES**.
- Wire: `oma autopilot review --evidence …` (and `handoff --key codeReview`).
- On REQUEST CHANGES → `return-ralplan` (or fix + re-review; do not skip the artifact).

### 5. ultraqa (adversarial QA)

- Follow `skills/ultraqa/SKILL.md`.
- Artifact under `.agy/qa/`. Docs-only may **SKIP** with written reason; code changes must run scenarios.
- Wire: `oma autopilot qa --evidence …`.
- On FAIL → `return-ralplan` / fix loop.

### 6. Complete

- Mark inactive only when review + QA are clean (or QA skip justified) and any required production gate passes.
- Summarize: what shipped, evidence commands, residual risks.

## Stop conditions

- User: stop / cancel / abort → `cancel` skill + `oma autopilot cancel` when session-bound
- Same failure 3× with no new plan → report blocker
- Missing credentials / irreversible production action → ask user

## Final checklist

- [ ] Spec + plan artifacts exist; ralplan critic APPROVE
- [ ] Ultragoal ledger complete; fresh verify evidence
- [ ] Code-review **APPROVE+CLEAR** artifact under `.agy/reviews/`
- [ ] Ultraqa **PASS** or justified **SKIP** under `.agy/qa/`
- [ ] CLI gates advanced (or blockers explicit)
- [ ] Autopilot state inactive / phase complete when done
