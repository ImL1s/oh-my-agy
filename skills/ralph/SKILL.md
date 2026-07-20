---
name: ralph
description: "OMA persistence loop until PRD stories pass with verification evidence"
argument-hint: "<task description>"
---

# ralph (OMA / Antigravity)

## Purpose

Self-referential **persistence loop** until work is actually done. Sibling of OMC/OMX Ralph, adapted for Antigravity:

- Outer launch: `oma ralph -- <task>` (managed directive + skill protocol)
- Inner loop: you keep going until stories pass + verify skill is satisfied

## Use when

- User says ralph / don't stop / keep going until done / must complete
- Work needs story tracking and anti-premature-stop

## Do not use when

- Full product-from-idea pipeline → `autopilot`
- Pure parallel fan-out without persistence → `ultrawork`
- Read-only research → `search`

## PRD (required)

Maintain a PRD file (create if missing):

- Preferred: `.agy/ralph/prd.json` (workspace)
- Session note: update progress in `.agy/ralph/progress.md`

Schema (minimal):

```json
{
  "schemaVersion": 1,
  "goal": "<task>",
  "stories": [
    {
      "id": "US-001",
      "title": "…",
      "acceptanceCriteria": ["specific, testable criterion"],
      "passes": false
    }
  ]
}
```

**Startup gate:** replace any generic criteria ("implementation is complete") with task-specific criteria before coding.

## Steps

1. **Init PRD** — refine stories + acceptance criteria.
2. **Pick next story** — highest priority with `passes: false`.
3. **Implement** — only that story; record files touched.
4. **Verify story** — for each criterion, produce fresh evidence.
5. **Mark passes** — only when all criteria for the story are evidenced.
6. **Loop** until all stories `passes: true`.
7. **Final verify** — run `verify` skill on the whole change set.
8. **Complete** — summary + evidence; do not stop after first story.

## Anti-patterns (forbidden)

- Claiming done because code "looks good"
- Deleting/skipping tests to go green
- Stopping after an intermediate approval without final verify
- Silent scope reduction

## Stop conditions

- Hard blocker (credentials, ambiguous product decision) → report + wait
- User cancel → `cancel` skill
- Same root failure 3 iterations → escalate with diagnosis

## Final checklist

- [ ] All PRD stories `passes: true`
- [ ] Acceptance criteria are specific (not boilerplate)
- [ ] Fresh build/test evidence for the full set
- [ ] Progress log updated
