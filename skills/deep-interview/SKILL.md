---
name: deep-interview
description: "In-session OMA requirements gate — invoke /oh-my-agy:deep-interview; Socratic clarify HERE, write .agy/specs (no terminal first)"
argument-hint: "<vague idea or task seed>"
---

# deep-interview (OMA / in-session)

## You are already in the agent session

When invoked via **`/oh-my-agy:deep-interview`** or this **deep-interview** skill (including as Autopilot Phase 1), treat **`$ARGUMENTS` as the seed** and run the interview **HERE**.

- Do **not** send the user to a terminal or require SID/CID/revision.
- Produce a **spec artifact** under `.agy/specs/` good enough for planning — not implementation.
- Bare host shortcuts may exist; **OMA canonical slash is `/oh-my-agy:deep-interview`**.

## Purpose

Socratic clarification gate (OMC/OMX `$deep-interview` analogue). Output is a written spec, not code.

## Use when

- Goal is vague (no paths, APIs, acceptance, or non-goals)
- Autopilot phase `deep-interview` / user says deep interview / clarify first
- Invoked as `/oh-my-agy:deep-interview <seed>`

## Do not use when

- Spec already exists and is fresh → skip with rationale in the artifact (or a short skip note)
- User already gave concrete acceptance + paths → hand off to `/oh-my-agy:ralplan` or plan phase

## Output artifact

Write:

```text
.agy/specs/deep-interview-<slug>-<UTC>.md
```

Minimum sections:

1. Goal / non-goals  
2. Constraints (stack, time, safety)  
3. Acceptance criteria (testable)  
4. Open questions remaining (or “none — ready for plan”)  
5. Ambiguity note (why interview stopped)

## Steps (in-session)

1. Restate the seed (`$ARGUMENTS` / user message) in one sentence.
2. Ask **at most 3** high-leverage questions per turn (prefer concrete choices).
3. After answers, re-score: still missing acceptance or non-goals? If yes, one more focused round; if no, crystallize the spec file.
4. Do **not** start coding in this skill.
5. Handoff path to `/oh-my-agy:ralplan` / Autopilot plan phase; mention the `.agy/specs/…` path.

## Stop / skip

- User authorizes skip → record `skip_authorized_by_user: true` + reason in the artifact.
- Credentials/product decision blocked → report blocker; do not invent requirements.

## Anti-patterns (forbidden)

- “Run `oma …` first” before clarifying
- Implementing features inside the interview
- Fake acceptance criteria (“works well”, “implementation is complete”)

## Final checklist

- [ ] Spec written under `.agy/specs/` (or explicit skip rationale)
- [ ] Acceptance criteria are testable
- [ ] Ready for ralplan — or open questions listed honestly

---

## Appendix: optional outer ledger

Only if the user maintains a durable Autopilot session:

```bash
oma autopilot handoff --session <id> --expected-revision <n> \
  --key deepInterview --path .agy/specs/<file>.md
oma autopilot advance --session <id> --expected-revision <n> \
  --evidence <deep-interview-evidence.json>
```

Not required for the happy path.
