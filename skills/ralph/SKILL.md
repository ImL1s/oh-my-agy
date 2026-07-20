---
name: ralph
description: "In-session OMA persistence loop — invoke /oh-my-agy:ralph; keep going until PRD stories pass with verify evidence (CLI optional)"
argument-hint: "<task description>"
---

# ralph (OMA / in-session)

## You are already in the agent session

When invoked via **`/oh-my-agy:ralph`** or this **ralph** skill, treat **`$ARGUMENTS` as the task** and run the persistence loop **HERE** until stories pass with verification evidence.

- Do **not** require `oma ralph -- …` / terminal / SID as the default path.
- Outer `oma ralph` is an **optional** managed launch (see [Appendix](#appendix-optional-oma-cli)); it is not required to start.
- Canonical slash: **`/oh-my-agy:ralph`**.

## Purpose

Self-referential **persistence loop** until work is actually done. Sibling of OMC/OMX Ralph:

- Inner loop (primary): you keep going in this session until stories pass + verify skill is satisfied
- Outer launch (optional): `oma ralph -- <task>` for managed directive + skill protocol

## Use when

- User invokes `/oh-my-agy:ralph` or says ralph / don't stop / keep going until done / must complete
- Work needs story tracking and anti-premature-stop

## Do not use when

- Full product-from-idea pipeline → `/oh-my-agy:autopilot`
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

**Startup gate:** replace any generic criteria (“implementation is complete”) with task-specific criteria before coding.

## Steps (in-session)

1. **Init PRD** — refine stories + acceptance criteria from `$ARGUMENTS`.
2. **Pick next story** — highest priority with `passes: false`.
3. **Implement** — only that story; record files touched.
4. **Verify story** — for each criterion, produce fresh evidence.
5. **Mark passes** — only when all criteria for the story are evidenced.
6. **Loop** until all stories `passes: true`.
7. **Final verify** — run `verify` skill on the whole change set.
8. **Complete** — summary + evidence; do not stop after first story.

## Anti-patterns (forbidden)

- Claiming done because code “looks good”
- Deleting/skipping tests to go green
- Stopping after an intermediate approval without final verify
- Silent scope reduction
- Telling the user to open a terminal and run `oma ralph` before working

## Stop conditions

- Hard blocker (credentials, ambiguous product decision) → report + wait
- User cancel → `cancel` skill
- Same root failure 3 iterations → escalate with diagnosis

## Final checklist

- [ ] All PRD stories `passes: true`
- [ ] Acceptance criteria are specific (not boilerplate)
- [ ] Fresh build/test evidence for the full set
- [ ] Progress log updated under `.agy/ralph/`

---

## Appendix: optional `oma` CLI

Use only when the user wants a managed outer launch:

```bash
oma ralph -- "<task description>"
```

Managed binding injects skill protocol when configured. The in-session PRD under `.agy/ralph/` remains the progress source of truth for this loop.
