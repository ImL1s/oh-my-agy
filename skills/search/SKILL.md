---
name: search
description: "OMA read-only research mode — evidence with path:line, no mutations"
argument-hint: "<research question>"
---

# search (OMA / Antigravity)

## Purpose

Read-only research with source evidence. Managed launch uses plan/sandbox posture (`oma search -- …`).

## Rules

1. **No mutations** — no file writes, installs, commits, or destructive git.
2. Every claim needs **path + line** (or command output) evidence.
3. Prefer repo-local truth over guesswork.
4. If write is required to answer, stop and say so — do not silently write.

## Steps

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
