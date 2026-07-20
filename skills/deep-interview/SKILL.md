---
name: deep-interview
description: "OMA requirements clarification gate before planning/execution"
argument-hint: "<vague idea or task seed>"
---

# deep-interview (OMA / Antigravity)

## Purpose

Socratic clarification gate (OMC/OMX `$deep-interview` analogue). Produces a **spec artifact** good enough for planning — not implementation.

## Use when

- Goal is vague (no paths, APIs, acceptance, or non-goals)
- Autopilot Phase `clarify` needs a real interview
- User says deep interview / clarify requirements first

## Do not use when

- Spec already exists and is fresh → skip with rationale
- User already gave concrete acceptance + paths → go to plan/implement

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

## Steps

1. Restate the seed in one sentence.
2. Ask **at most 3** high-leverage questions per turn (prefer concrete choices).
3. After answers, re-score: still missing acceptance or non-goals? If yes, one more focused round; if no, crystallize the spec file.
4. Do **not** start coding in this skill.
5. Handoff path to `ralplan` / autopilot plan phase.

## Stop / skip

- User authorizes skip → record `skip_authorized_by_user: true` + reason in the artifact.
- Credentials/product decision blocked → report blocker; do not invent requirements.
