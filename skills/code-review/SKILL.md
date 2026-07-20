---
name: code-review
description: "OMA merge-readiness gate — independent review artifact with APPROVE+CLEAR or REQUEST CHANGES"
argument-hint: "<change summary or ultragoal handoff path>"
---

# code-review (OMA / Antigravity)

## Purpose

**Merge-readiness gate** after `ultragoal` implement+verify and before `ultraqa`. OMX / OMC code-reviewer analogue, Antigravity-native:

- You perform a structured review pass against the approved plan + fresh verify evidence.
- Output is a **review artifact**, not more feature code (unless fixing a review-blocking bug you own in this session).
- Verdict drives Autopilot: clean → advance to `ultraqa`; dirty → return to `ralplan` with reason.

Maps to Autopilot active phase `code-review` (legacy: `review`).

## Use when

- Autopilot phase is `code-review` / user says code review / merge readiness
- Ultragoal handoff claims implement complete with verify evidence
- Pre-merge / pre-push quality gate is required

## Do not use when

- Implementation still incomplete → stay in `ultragoal` / `ralph`
- Docs-only change with no code risk → may be light review, but still write a short artifact
- User only wants a plan → `ralplan`

## Artifacts

```text
.agy/reviews/code-review-<slug>-<UTC>.md
.agy/reviews/code-review-<slug>-verdict.json
```

### Markdown (required sections)

1. Scope (what changed; plan / PRD / ultragoal paths referenced)
2. Evidence reviewed (verify commands + outcomes — must be fresh or explicitly re-run)
3. Findings (severity: blocker / major / minor / nit)
4. Security / safety notes (spawn vs exec, secrets, destructive git, auth)
5. Test gaps
6. **Verdict** — exactly one of:
   - `APPROVE+CLEAR` — merge-ready for QA phase
   - `REQUEST CHANGES` — not merge-ready; list required fixes

### Verdict JSON (machine summary)

```json
{
  "schemaVersion": 1,
  "verdict": "APPROVE+CLEAR",
  "clean": true,
  "recommendation": "proceed_to_ultraqa",
  "reviewPath": ".agy/reviews/…",
  "blockers": [],
  "ultragoalHandoff": ".agy/ultragoal/…/handoff.json",
  "returnToRalplanReason": null
}
```

When dirty:

```json
{
  "schemaVersion": 1,
  "verdict": "REQUEST CHANGES",
  "clean": false,
  "recommendation": "return_to_ralplan",
  "reviewPath": ".agy/reviews/…",
  "blockers": ["…"],
  "returnToRalplanReason": "concise root cause for replan"
}
```

## Related skills

| Skill | Relationship |
|-------|----------------|
| `skills/ultragoal/SKILL.md` | Prior phase — implementation ledger + verify |
| `skills/verify/SKILL.md` | Re-run or validate evidence if stale / missing |
| `skills/ralplan/SKILL.md` | Target on `REQUEST CHANGES` / non-clean gate |
| `skills/ultraqa/SKILL.md` | Next phase after `APPROVE+CLEAR` |
| `skills/autopilot/SKILL.md` | Parent loop + CLI gates |

## CLI ledger (outer)

Wire review evidence into Autopilot:

```bash
# record review artifact
oma autopilot handoff --session <id> --expected-revision <n> \
  --key codeReview --path .agy/reviews/code-review-<slug>-verdict.json

# submit review gate evidence (kind: code-review | review)
oma autopilot review --session <id> --expected-revision <n> \
  --evidence <path-to-review-evidence.json>

# alias-style advance when using generic gate file
oma autopilot advance --session <id> --expected-revision <n> \
  --evidence <path-to-review-evidence.json>

# non-clean: return to planning with reason
oma autopilot return-ralplan --session <id> --expected-revision <n> \
  --reason "<findings summary>"

oma autopilot status --session <id>
```

Evidence file should reference the verdict JSON path and include `clean: true|false` consistent with the artifact. Do not call review "passed" if verdict is `REQUEST CHANGES`.

## Review checklist (minimum)

- [ ] Diff matches approved plan (or plan was revised with recorded reason)
- [ ] No TODO / `test.skip` / stub "implement later" presented as done
- [ ] Tests cover new behavior and regressions; verify evidence is real
- [ ] No secrets committed; no `exec` of shell strings in new tooling
- [ ] Circuit-breaker / git safety: no `git reset --hard` / `git clean -fd`
- [ ] Error paths and edge cases considered
- [ ] Public CLI / skill / docs updated if user-facing surface changed
- [ ] Scope creep or silent feature drop called out

## Steps

1. **Gather inputs** — plan path, ultragoal ledger/handoff, verify outputs, file list.
2. **Re-verify if needed** — if evidence is missing, stale, or untrusted, run `verify` again.
3. **Structured review** — walk checklist; write findings with severity.
4. **Decide verdict** — `APPROVE+CLEAR` only if no blockers/majors remain (nits may remain with explicit deferral).
5. **Write artifacts** under `.agy/reviews/`.
6. **CLI wire-up** — `handoff --key codeReview` + `oma autopilot review` (or `advance` with review evidence).
7. **Branch on verdict**
   - `APPROVE+CLEAR` → hand off to `ultraqa`
   - `REQUEST CHANGES` → `return-ralplan` (or fix under ultragoal if tiny and in-scope, then re-review — do not skip the artifact)

## Verdict rules

| Verdict | `clean` | Next |
|---------|---------|------|
| `APPROVE+CLEAR` | `true` | `ultraqa` phase |
| `REQUEST CHANGES` | `false` | fix / `ralplan`; do not mark autopilot complete |

Self-approval alone is not enough: the **artifact + CLI evidence** are the gate.

## Anti-patterns (forbidden)

- Rubber-stamp APPROVE without reading diff / evidence
- Approving with open blockers "to fix later"
- Implementing large new features inside the review skill without returning to plan
- Claiming merge-ready when verify never ran

## Final checklist

- [ ] `.agy/reviews/…` markdown + verdict JSON written
- [ ] Verdict is exactly `APPROVE+CLEAR` or `REQUEST CHANGES`
- [ ] Autopilot `review` / handoff updated when session-bound
- [ ] Non-clean path has `returnToRalplanReason` or explicit fix loop
