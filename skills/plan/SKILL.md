---
name: plan
description: "In-session OMA light planning — invoke /oh-my-agy:plan; bounded step list with verifiable completion under ralplan (no consensus, no terminal first)"
argument-hint: "<goal>"
---

# plan (OMA / in-session)

## You are already in the agent session

When invoked via **`/oh-my-agy:plan`** or this **plan** skill, treat **`$ARGUMENTS` as the goal** and produce a **light, bounded plan** HERE.

- Do **not** require terminal CLI, SID, CID, or revision to plan.
- Output is a **plan artifact** under `.agy/plans/` only — not code, not a new artifact tree.
- Canonical slash: **`/oh-my-agy:plan`**.
- There is **no `oma plan` CLI verb** today — see [Appendix](#appendix-current-oma-cli-reality). Do not tell the user to run one.

## Purpose

OMC `omc-plan` (direct mode) / OMX `$plan` analogue: a **lightweight planning layer under `ralplan`**.

- `plan` splits a medium, bounded request into executable steps with **verifiable completion** (same evidence bar as `skills/verify`).
- `ralplan` remains the **consensus-gated** planning lane (author + steelman + critic **APPROVE**).
- This skill does **not** start the critic APPROVE loop. If consensus is needed, **upgrade to `ralplan`**.

## plan vs ralplan (selection)

| Use | Skill | Why |
|-----|--------|-----|
| Requirements are clear, risk is bounded, one person can finish in this session / a short loop | **`plan`** (`/oh-my-agy:plan`) | Direct step list; no Planner/Architect/Critic triad |
| Requirements are vague, span multiple days, or touch schema / production data / multiple platforms | **`ralplan`** (`/oh-my-agy:ralplan`) | Consensus gate; critic **APPROVE** before implement |
| Spec is missing or the goal is still a slogan | **`deep-interview`** first, then choose `plan` or `ralplan` | Clarify before planning |
| User already said ralplan / consensus / steelman the plan | **`ralplan`** | Honor the heavy lane |

### Upgrade-to-ralplan (mandatory)

Stay on `plan` only while **all** of these hold:

1. Goal, non-goals, and acceptance are already clear (or become clear after at most one short clarify round).
2. Blast radius is bounded: no schema change, no production-data migration, no multi-platform rollout, no multi-day program.
3. A single implementer can execute the steps without a critic APPROVE gate.

**If any of those fail while planning, stop this skill and upgrade to `/oh-my-agy:ralplan`.** Write a short reason in the `.agy/plans/` artifact (`upgrade_to: ralplan`, `upgrade_reason: …`) and do **not** force a light plan. Do not implement from a plan that should have been consensus-gated.

## Use when

- User invokes `/oh-my-agy:plan` or says "plan this" / "make a plan" for a **medium, bounded** task
- Spec exists (or the request already names files, acceptance, and non-goals)
- Need a step list with testable done-conditions before `ralph` / `ultrawork` / `ultragoal`

## Do not use when

- Vague idea with no acceptance → `/oh-my-agy:deep-interview`
- High-stakes / multi-day / schema / production / multi-platform / "consensus plan" → `/oh-my-agy:ralplan`
- Already implementing under an approved plan → `ralph` / `ultrawork` / `ultragoal`
- User only wants research → `search`
- User wants end-to-end delivery → `autopilot` (which still uses `ralplan` as Phase 2)

## Artifacts

Write **only** under `.agy/plans/` (already listed in `skills/oma-runtime` Workspace artifacts). Do **not** invent `.agy/plan/`, `.omc/plans/`, or `.omx/plans/`.

```text
.agy/plans/plan-<slug>-<UTC>.md
```

Optional machine summary (same directory only):

```text
.agy/plans/plan-<slug>-summary.json
```

## Required plan sections

1. Summary (goal / non-goals / why `plan` not `ralplan`)
2. Ordered tasks — **each task MUST include a verifiable completion condition** (command, test, or path:line evidence; same bar as `skills/verify`)
3. Risks / mitigations (if a risk is unbounded → upgrade to `ralplan` instead of listing it)
4. Verification plan (fresh build/test evidence; no "looks good")
5. Upgrade decision: `stay_on_plan` **or** `upgrade_to_ralplan` with reason
6. Handoff path (`ralph` / `ultrawork` / `ultragoal` / stop after plan)

## Steps (in-session)

Every step below has a **verifiable completion condition**. Do not mark the step done without that evidence.

1. **Select the lane.** Read `$ARGUMENTS` and any `.agy/specs/` artifact. Decide `plan` vs `ralplan` using the table above.
   - Done when: the artifact records `lane: plan` **or** `upgrade_to: ralplan` with a concrete reason.
2. **Bound the goal.** Restate goal, non-goals, files likely touched, and out-of-scope.
   - Done when: those four items are written; if any stay slogans, upgrade to `ralplan` (or `deep-interview` if the spec is missing).
3. **Draft ordered tasks.** Each task names the files and a **verifiable completion condition** (e.g. `npm run test:unit -- tests/foo.spec.ts` exits 0; `path:line` exists).
   - Done when: every task has a checkable condition; zero tasks say "implement later" or "works well".
4. **Check risk.** Schema, production data, multi-platform, multi-day, or unresolved architecture fork?
   - Done when: either all risks are bounded with mitigations, **or** the artifact says `upgrade_to: ralplan` and this skill stops.
5. **Write the artifact** under `.agy/plans/plan-<slug>-<UTC>.md` only.
   - Done when: the file exists with all required sections; no other artifact roots were created.
6. **Handoff, do not implement.** State the next slash (`/oh-my-agy:ralph`, `/oh-my-agy:ultrawork`, `/oh-my-agy:ultragoal`) or stop if the user only wanted a plan.
   - Done when: the artifact names the handoff; this session has not started product-code edits under this skill.

## Rule

**Do not start implementation from this skill.** `plan` produces a step list; execution is `ralph` / `ultrawork` / `ultragoal` / Autopilot implement. **Do not fake consensus** — if you need critic APPROVE, call `/oh-my-agy:ralplan`.

## Anti-patterns (forbidden)

- Running author+steelman+critic here and calling it `plan` (that is `ralplan`)
- Staying on `plan` after discovering vagueness, schema change, production data, or multi-platform scope
- Steps without verifiable completion ("tidy up", "handle edge cases", "should work")
- Writing plans outside `.agy/plans/`
- Telling the user to run `oma plan` (verb does not exist)
- Implementing product code in the planning turn

## Final checklist

- [ ] Lane recorded: stay on `plan` **or** explicit upgrade to `ralplan`
- [ ] Artifact under `.agy/plans/` only
- [ ] Every step has a verifiable completion condition (command / test / path:line)
- [ ] No product implementation in this skill
- [ ] Handoff path stated

---

## Appendix: current `oma` CLI reality

OMA ships **no `plan` verb** today. `oma --help` lists the shipped surface; `plan` is not on it. This skill is the in-session contract for light planning; it does not claim CLI support that does not exist.

Do not add or imply `oma plan`. Durable consensus planning still uses the Autopilot ledger **only when** the user is already on that path:

```bash
oma skill show plan
oma skill show ralplan
oma autopilot consensus --session <id> --expected-revision <n> \
  --role critic --verdict approve --note <text>
```

`oma autopilot consensus` is the optional outer ledger for **`ralplan`**, not a substitute for this skill.

Design concept mapping: `oh-my-claudecode/skills/plan` (OMC `omc-plan` direct mode; consensus is `--consensus` / `ralplan`), `oh-my-codex/skills/plan` (OMX `$plan` lightweight; `$ralplan` is the consensus gate). OMA keeps those as **two skills**, not one skill with flags.
