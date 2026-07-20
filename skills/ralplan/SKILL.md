---
name: ralplan
description: "OMA consensus-style planning gate before durable implementation"
argument-hint: "<spec path or task>"
---

# ralplan (OMA / Antigravity)

## Purpose

Planning gate with self-challenge (OMC/OMX `$ralplan` / `$plan --consensus` analogue), **Antigravity-native**:

- No Claude `Task(architect)` — you perform **author + steelman + critic** passes yourself (or via separate `agy` sessions if the user runs them).
- Output is a plan artifact, not code.

## Use when

- After `deep-interview` / a clear spec
- Autopilot plan phase
- User says ralplan / consensus plan / steelman the plan

## Do not use when

- Already implementing under `ralph` / `ultrawork` with an approved plan
- User only wants research → `search`

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

## Steps

1. Read spec / seed (`deep-interview` artifact preferred).
2. Draft plan (author pass).
3. Steelman: list a real alternative; keep or reject with reason.
4. Critic: attack missing tests, scope holes, security, migration risk.
5. If critic finds material issues → revise plan (do not implement).
6. Only on **APPROVE** hand off to implement (`ralph` / `ultrawork` / `team` / autopilot implement phase).

## Rule

**Planning artifacts alone are not consensus** until the critic pass is written and verdict is `approve`. Do not start implementation while verdict is `revise`.
