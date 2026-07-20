---
name: code-review
description: "In-session OMA merge-readiness gate — invoke /oh-my-agy:code-review; write APPROVE+CLEAR or REQUEST CHANGES under .agy/reviews HERE"
argument-hint: "<change summary or ultragoal handoff path>"
---

# code-review (OMA / in-session)

## You are already in the agent session

When invoked via **`/oh-my-agy:code-review`** or this **code-review** skill (including as Autopilot Phase 4), treat **`$ARGUMENTS` as the change summary or ultragoal handoff path** and run the review **HERE**.

- Do **not** require terminal `oma autopilot review` / SID / CID / revision to produce the gate.
- Output is a **review artifact** under `.agy/reviews/`, not more feature code (unless fixing a small review-blocking bug you own in this session).
- Canonical slash: **`/oh-my-agy:code-review`**.

## Purpose

**Merge-readiness gate** after `ultragoal` implement+verify and before `ultraqa`. OMX / OMC code-reviewer analogue, in-session:

- Structured review pass against the approved plan + fresh verify evidence.
- Verdict drives Autopilot: clean → advance to `ultraqa`; dirty → return to `ralplan` with reason.

Maps to Autopilot active phase `code-review` (legacy: `review`).

## Use when

- Autopilot phase is `code-review` / user says code review / merge readiness
- Ultragoal handoff claims implement complete with verify evidence
- Pre-merge / pre-push quality gate is required

## Do not use when

- Implementation still incomplete → stay in `ultragoal` / `ralph`
- User only wants a plan → `ralplan`
- Docs-only change with no code risk → may be light review, but still write a short artifact

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
| `skills/ultragoal/SKILL.md` · `/oh-my-agy:ultragoal` | Prior phase — implementation ledger + verify |
| `skills/verify/SKILL.md` | Re-run or validate evidence if stale / missing |
| `skills/ralplan/SKILL.md` · `/oh-my-agy:ralplan` | Target on `REQUEST CHANGES` / non-clean gate |
| `skills/ultraqa/SKILL.md` · `/oh-my-agy:ultraqa` | Next phase after `APPROVE+CLEAR` |
| `skills/autopilot/SKILL.md` · `/oh-my-agy:autopilot` | Parent loop |

## Review checklist (minimum)

- [ ] Diff matches approved plan (or plan was revised with recorded reason)
- [ ] No TODO / `test.skip` / stub “implement later” presented as done
- [ ] Tests cover new behavior and regressions; verify evidence is real
- [ ] No secrets committed; no `exec` of shell strings in new tooling
- [ ] Circuit-breaker / git safety: no `git reset --hard` / `git clean -fd`
- [ ] Error paths and edge cases considered
- [ ] Public CLI / skill / docs updated if user-facing surface changed
- [ ] Scope creep or silent feature drop called out

## Steps (in-session)

1. **Gather inputs** — plan path, ultragoal ledger/handoff, verify outputs, file list (`$ARGUMENTS` if given).
2. **Re-verify if needed** — if evidence is missing, stale, or untrusted, run `verify` again.
3. **Structured review** — walk checklist; write findings with severity.
4. **Decide verdict** — `APPROVE+CLEAR` only if no blockers/majors remain (nits may remain with explicit deferral).
5. **Write artifacts** under `.agy/reviews/`.
6. **Branch on verdict**
   - `APPROVE+CLEAR` → hand off to `/oh-my-agy:ultraqa`
   - `REQUEST CHANGES` → return to ralplan (or fix under ultragoal if tiny and in-scope, then re-review — do not skip the artifact)

## Verdict rules

| Verdict | `clean` | Next |
|---------|---------|------|
| `APPROVE+CLEAR` | `true` | `ultraqa` phase |
| `REQUEST CHANGES` | `false` | fix / `ralplan`; do not mark autopilot complete |

Self-approval without the **written artifact** is not enough.

## Anti-patterns (forbidden)

- Rubber-stamp APPROVE without reading diff / evidence
- Approving with open blockers “to fix later”
- Implementing large new features inside the review skill without returning to plan
- Claiming merge-ready when verify never ran
- Blocking review on missing CLI session

## Final checklist

- [ ] `.agy/reviews/…` markdown + verdict JSON written
- [ ] Verdict is exactly `APPROVE+CLEAR` or `REQUEST CHANGES`
- [ ] Non-clean path has `returnToRalplanReason` or explicit fix loop
- [ ] Next step stated (ultraqa vs replan/fix)

---

## Appendix: optional outer ledger

Only when session-bound Autopilot durability is in use:

```bash
oma autopilot handoff --session <id> --expected-revision <n> \
  --key codeReview --path .agy/reviews/code-review-<slug>-verdict.json

oma autopilot review --session <id> --expected-revision <n> \
  --evidence <path-to-review-evidence.json>

oma autopilot advance --session <id> --expected-revision <n> \
  --evidence <path-to-review-evidence.json>

oma autopilot return-ralplan --session <id> --expected-revision <n> \
  --reason "<findings summary>"

oma autopilot status --session <id>
```

Evidence must match the verdict (`clean: true|false`). Do not call review “passed” if verdict is `REQUEST CHANGES`.
