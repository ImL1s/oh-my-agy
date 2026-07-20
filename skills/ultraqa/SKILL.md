---
name: ultraqa
description: "In-session OMA adversarial QA — invoke /oh-my-agy:ultraqa; try to break the change HERE, write .agy/qa (docs-only SKIP with reason)"
argument-hint: "<feature under test or code-review path>"
---

# ultraqa (OMA / in-session)

## You are already in the agent session

When invoked via **`/oh-my-agy:ultraqa`** or this **ultraqa** skill (including as Autopilot Phase 5), treat **`$ARGUMENTS` as the feature under test or code-review path** and run adversarial QA **HERE**.

- Do **not** require terminal `oma autopilot qa` / SID / CID / revision to start.
- Actively try to break the change (happy path + edges + regressions) — not restate unit tests.
- Canonical slash: **`/oh-my-agy:ultraqa`**.

## Purpose

**Adversarial QA gate** after `code-review` APPROVE+CLEAR and before Autopilot **complete** / production evidence.

OMX ultraqa analogue. Maps to Autopilot active phase `ultraqa` (legacy: `qa`).

## Use when

- Autopilot phase is `ultraqa` / user says ultraqa / adversarial QA / ship gate
- Code-review verdict is `APPROVE+CLEAR`
- User-facing or behavioral change needs walkthrough / failure hunting

## Do not use when

- Review not clean → stay in fix loop / return to ralplan
- Implementation incomplete → `ultragoal`
- Pure research / no product change → not applicable

## Skip policy (docs-only / no runtime risk)

QA **may be skipped only** when all of the following hold:

1. Change is documentation / comments / non-executable metadata only (no runtime behavior).
2. No build, CLI, hook, skill-protocol, or user-facing behavior path is affected.
3. You write an explicit **skip artifact** with reason (not a silent skip).

Code, config, tests-as-product, skills that alter agent behavior, or CLI surface → **do not skip**.

## Artifacts

```text
.agy/qa/ultraqa-<slug>-<UTC>.md
.agy/qa/ultraqa-<slug>-verdict.json
```

### Markdown (required sections)

1. Scope under test (links to review + ultragoal handoff)
2. Threat / break hypotheses (what you tried to break)
3. Scenarios executed (steps + expected + actual)
4. Defects found (severity + repro)
5. Residual risks
6. **Verdict** — one of:
   - `PASS` — no open blockers; ready for production/complete gate
   - `FAIL` — blockers found; return to plan/implement
   - `SKIP` — docs-only skip with reason (see policy)

### Verdict JSON

```json
{
  "schemaVersion": 1,
  "verdict": "PASS",
  "clean": true,
  "skipped": false,
  "reason": null,
  "qaPath": ".agy/qa/…",
  "defects": [],
  "returnToRalplanReason": null
}
```

Skip example:

```json
{
  "schemaVersion": 1,
  "verdict": "SKIP",
  "clean": true,
  "skipped": true,
  "reason": "docs-only: README typo; no runtime/CLI/skill behavior change",
  "qaPath": ".agy/qa/…",
  "defects": [],
  "returnToRalplanReason": null
}
```

Fail example:

```json
{
  "schemaVersion": 1,
  "verdict": "FAIL",
  "clean": false,
  "skipped": false,
  "reason": null,
  "qaPath": ".agy/qa/…",
  "defects": [{ "severity": "blocker", "title": "…", "repro": "…" }],
  "returnToRalplanReason": "QA blocker: …"
}
```

## Related skills

| Skill | Relationship |
|-------|----------------|
| `skills/code-review/SKILL.md` · `/oh-my-agy:code-review` | Prior merge-readiness gate |
| `skills/verify/SKILL.md` | Automated build/test evidence (QA is adversarial on top) |
| `skills/ultragoal/SKILL.md` · `/oh-my-agy:ultragoal` | Fix loop target for implementation defects |
| `skills/ralplan/SKILL.md` · `/oh-my-agy:ralplan` | Replan on systemic / design defects |
| `skills/autopilot/SKILL.md` · `/oh-my-agy:autopilot` | Parent loop |

## Adversarial focus areas

Minimum attack surface (scale to risk):

1. **Happy path** — primary user/agent flow works end-to-end
2. **Empty / missing inputs** — flags, files, env
3. **Boundary values** — empty string, large payloads, unicode paths
4. **Idempotency / rerun** — second run does not corrupt state
5. **Failure injection** — bad revision, missing session, dirty worktree
6. **Regression** — adjacent commands still work (`status`, `doctor`, prior phase)
7. **Safety** — no destructive git, no secret leakage in logs

Prefer real commands and walkthrough notes over “should work”.

## Steps (in-session)

1. **Confirm entry** — code-review is `APPROVE+CLEAR` (or document exception).
2. **Decide skip** — if docs-only, write SKIP artifact + reason; stop.
3. **List break hypotheses** — 3–8 concrete ways this change could fail users.
4. **Execute scenarios** — run them; capture commands + outcomes.
5. **Triage defects** — blockers/majors fail the gate; nits may ship with residual-risk note.
6. **Write artifacts** under `.agy/qa/`.
7. **Branch**
   - `PASS` / justified `SKIP` → ready for production/complete gates
   - `FAIL` → return to ralplan or ultragoal fix loop; re-run ultraqa after fix

## Anti-patterns (forbidden)

- Skipping QA on code changes “because unit tests passed”
- SKIP without written reason
- Only re-reading unit test output without new adversarial scenarios
- Marking PASS with open blockers
- Claiming autopilot complete without QA (or justified skip) evidence
- Blocking QA on missing CLI session

## Final checklist

- [ ] `.agy/qa/…` markdown + verdict JSON written
- [ ] Verdict is `PASS`, `FAIL`, or `SKIP` (with reason if SKIP)
- [ ] FAIL paths set `returnToRalplanReason` or explicit fix plan
- [ ] Residual risks listed even on PASS

---

## Appendix: optional outer ledger

Only when session-bound Autopilot durability is in use:

```bash
oma autopilot handoff --session <id> --expected-revision <n> \
  --key ultraqa --path .agy/qa/ultraqa-<slug>-verdict.json

oma autopilot qa --session <id> --expected-revision <n> \
  --evidence <path-to-qa-evidence.json>

oma autopilot advance --session <id> --expected-revision <n> \
  --evidence <path-to-qa-evidence.json>

oma autopilot return-ralplan --session <id> --expected-revision <n> \
  --reason "<QA findings>"

oma autopilot status --session <id>
```

Evidence must align with verdict (`clean` / `skipped` / `reason`). Skip without `reason` is invalid. In-session `.agy/qa/` artifacts are the primary gate.
