---
name: ralplan
description: "In-session OMA planning gate — invoke /oh-my-agy:ralplan; author+steelman+critic HERE, write .agy/plans (no terminal first)"
argument-hint: "<spec path or task>"
---

# ralplan (OMA / in-session)

## You are already in the agent session

When invoked via **`/oh-my-agy:ralplan`** or this **ralplan** skill (including as Autopilot Phase 2), treat **`$ARGUMENTS` as the spec path or task** and produce the plan **HERE**.

- Do **not** require terminal CLI, SID, CID, or revision to plan.
- Output is a **plan artifact** under `.agy/plans/`, not code.
- Canonical slash: **`/oh-my-agy:ralplan`**.

## Purpose

Planning gate with self-challenge (OMC/OMX `$ralplan` / `$plan --consensus` analogue):

- Perform **author + steelman + critic** passes in this session (or via separate host sessions if the user runs them).
- Planning artifacts alone are not consensus until the critic pass is written and the verdict is **APPROVE**.

## Use when

- After `/oh-my-agy:deep-interview` / a clear spec
- Autopilot plan phase
- User says ralplan / consensus plan / steelman the plan

## Do not use when

- Already implementing under `ralph` / `ultrawork` with an approved plan
- User only wants research → `search`
- Light, bounded, single-person plan without consensus → `/oh-my-agy:plan`

## Artifacts

```text
.agy/plans/ralplan-<slug>-<UTC>.md
.agy/plans/ralplan-<slug>-consensus.json   # optional machine summary
```

Plan markdown must include:

1. Summary  
2. Ordered tasks (dependencies)  
3. Risks / mitigations  
4. Test / verification plan  
5. **Steelman alternative** (at least one rejected approach + why)  
6. **Critic pass** findings (even if “none”)  
7. Explicit **APPROVE** or **REVISE** decision

Optional JSON:

```json
{
  "schemaVersion": 1,
  "verdict": "approve",
  "planPath": ".agy/plans/…",
  "architectNotes": "…",
  "criticNotes": "…",
  "blockedReason": null
}
```

## Steps (in-session)

1. Read spec / seed (`deep-interview` artifact preferred; else `$ARGUMENTS`).
2. Draft plan (author pass).
3. Steelman: list a real alternative; keep or reject with reason.
4. Critic: attack missing tests, scope holes, security, migration risk.
5. If critic finds material issues → revise plan (do **not** implement).
6. Only on **APPROVE** hand off to implement (`/oh-my-agy:ultragoal`, `ralph`, `ultrawork`, `team`, or Autopilot implement phase).

## Rule

**Do not start implementation while verdict is `revise`.** Critic APPROVE is the gate into ultragoal.

## Anti-patterns (forbidden)

- Jumping to code before critic APPROVE
- Rubber-stamp critic with no written findings section
- Requiring `oma autopilot consensus` before the plan file exists

## Final checklist

- [ ] Plan under `.agy/plans/` with steelman + critic
- [ ] Verdict is APPROVE or REVISE (explicit)
- [ ] Handoff path stated for ultragoal when APPROVE

---

## Appendix: optional outer ledger

Only when session-bound Autopilot durability is in use:

```bash
oma autopilot consensus --session <id> --expected-revision <n> \
  --role architect --verdict approve --note <text>
oma autopilot consensus --session <id> --expected-revision <n> \
  --role critic --verdict approve --note <text>
oma autopilot handoff --session <id> --expected-revision <n> \
  --key ralplan --path .agy/plans/<file>.md
oma autopilot advance --session <id> --expected-revision <n> \
  --evidence <ralplan-evidence.json>
```

In-session plan quality does not depend on these commands.
