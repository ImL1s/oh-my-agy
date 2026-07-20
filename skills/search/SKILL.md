---
name: search
description: "In-session OMA read-only research — invoke /oh-my-agy:search; evidence with path:line HERE (CLI sandbox optional)"
argument-hint: "<research question>"
---

# search (OMA / in-session)

## You are already in the agent session

When invoked via **`/oh-my-agy:search`** or this **search** skill, treat **`$ARGUMENTS` as the research question** and answer **HERE** with source evidence.

- Do **not** require `oma search -- …` / terminal as the default path.
- Canonical slash: **`/oh-my-agy:search`**.
- Managed sandbox launch is optional (see [Appendix](#appendix-optional-oma-cli)); in-session search is still **read-only**.

## Purpose

Read-only research with source evidence. Sibling of OMC/OMX research posture for Antigravity hosts.

## Use when

- User invokes `/oh-my-agy:search` or asks research-only / find where / evidence-backed explore
- Need path:line citations without mutating the tree

## Do not use when

- Implementation required → `ralph` / `ultrawork` / direct work
- Full delivery pipeline → `autopilot`

## Rules

1. **No mutations** — no file writes, installs, commits, or destructive git.
2. Every claim needs **path + line** (or command output) evidence.
3. Prefer repo-local truth over guesswork.
4. If write is required to answer, stop and say so — do not silently write.

## Steps (in-session)

1. Restate the question and success criteria.
2. Locate candidates (symbols, configs, tests, docs).
3. Read and extract evidence.
4. Answer with structured findings + residual unknowns.

## Output template

```markdown
## Answer
…

## Evidence
- `path:line` — quote/summary
- …

## Unknowns / next probes
- …
```

## Anti-patterns (forbidden)

- Editing files “just to check”
- Answers without path:line (or command) evidence
- Telling the user to open a terminal and run `oma search` before researching

---

## Appendix: optional `oma` CLI

Use when the user wants a managed plan/sandbox launch:

```bash
oma search -- "<research question>"
```

With `OMA_REQUIRE_SANDBOX=1`, managed search may fail-closed if sandbox cannot load (ADR-0001). In-session discipline remains: no mutations.
