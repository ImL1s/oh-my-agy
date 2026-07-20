---
name: autopilot
description: "OMA autonomous delivery loop: clarify → plan → implement → verify → review/QA"
argument-hint: "<product idea or task>"
---

# autopilot (OMA / Antigravity)

## Purpose

End-to-end autonomous delivery **inside an Antigravity session**, coordinated with the OMA CLI ledger.

Maps to OMC/OMX autopilot **phase contract**, but tools are Antigravity-native + `oma` CLI (not Claude `Task` / OMX state CLI).

## Default loop (strict)

```text
deep-interview (clarify) → ralplan (plan) → implement(+team if needed)
  → verify → review/QA → complete
```

Canonical skill handoffs (OMC/OMX-shaped, Antigravity-native tools):

1. `skills/deep-interview/SKILL.md` → `.agy/specs/…`
2. `skills/ralplan/SKILL.md` → `.agy/plans/…` with critic **APPROVE**
3. implement via `ralph` / `ultrawork` / `team` as appropriate
4. `skills/verify/SKILL.md` then review/QA

If review or QA is not clean, return to **ralplan** with findings — do not ad-hoc patch outside the loop.

## Use when

- User says autopilot / full auto / build me / handle it all
- Multi-phase work needs durable progress

## Do not use when

- Single small fix → use `ralph` or direct work
- User only wants explanation → conversational answer
- User only wants a plan → plan phase only, stop before implement

## CLI ledger (outer)

Prefer durable autopilot state via CLI when available:

```bash
oma autopilot start -- "<goal>"
oma autopilot status --session <id>
oma autopilot drive --session <id> --conversation <cid> --expected-revision <n>
oma autopilot resume --session <id>
```

In-session, keep a phase note under workspace-safe path (example):

- `.agy/autopilot/state.json` (or OMA state root autopilot session if already bound)

Minimum state fields:

```json
{
  "mode": "autopilot",
  "active": true,
  "current_phase": "clarify",
  "iteration": 1,
  "goal": "<goal>",
  "handoffs": {
    "spec": null,
    "plan": null,
    "implementation": null,
    "verify": null,
    "review": null
  },
  "return_to_plan_reason": null
}
```

## Steps

### 1. Clarify (`deep-interview`)
- Follow `skills/deep-interview/SKILL.md`.
- Restate goal, non-goals, constraints, acceptance.
- If still vague (no paths/APIs/anchors): ask focused questions (max 3) **or** write an explicit skip rationale authorized by user.
- Handoff: spec path under `.agy/specs/` recorded in state.

### 2. Plan (`ralplan`)
- Follow `skills/ralplan/SKILL.md` (author + steelman + critic; verdict APPROVE).
- Produce implementation plan with ordered tasks, risks, test plan.
- Handoff: plan path under `.agy/plans/`; do not implement until critic **APPROVE**.

### 3. Implement
- Execute plan with evidence.
- Independent slices may follow `ultrawork` skill.
- Multi-worker / worktree needs → `team` skill + `oma team …` (explicit only).
- Never reduce scope silently.

### 4. Verify (mandatory)
- Follow `verify` skill: build/tests/lint relevant to change with **fresh** command output.
- No "should work".

### 5. Review / QA
- Self-review for regressions, security, missing tests.
- If user-facing behavior: manual walkthrough notes.
- On failure: set `return_to_plan_reason`, go back to Plan.

### 6. Complete
- Mark autopilot inactive only when verify + review are clean.
- Summarize: what shipped, evidence commands, residual risks.

## Stop conditions

- User: stop / cancel / abort → `cancel` skill
- Same failure 3× with no new plan → report blocker
- Missing credentials / irreversible production action → ask user

## Final checklist

- [ ] Spec + plan artifacts exist
- [ ] Implementation matches plan (or plan was revised with reason)
- [ ] Fresh verify evidence attached
- [ ] Review/QA clean or explicitly blocked
- [ ] Autopilot state `active:false` / phase `complete`
