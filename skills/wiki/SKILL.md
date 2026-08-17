---
name: wiki
description: "In-session OMA provenance-tracked knowledge lookup — invoke /oh-my-agy:wiki; read-only, cite record provenance, never invent pages"
argument-hint: "<query>"
---

# wiki (OMA / in-session)

## You are already in the agent session

When invoked via **`/oh-my-agy:wiki`** or this **wiki** skill, treat **`$ARGUMENTS` as the lookup query** and answer **HERE** from the indexed record set.

- Canonical slash: **`/oh-my-agy:wiki`**.
- The wiki index is **provenance-tracked**: every record carries `record_id`, `path`, and a `provenance` list. Cite them.
- Read-only. A wiki lookup never writes project files.

## Purpose

OMC/OMX/OMG expose `wiki` as an in-session knowledge surface. OMA already ships the durable half — `oma wiki index|list|search` over a digest-locked record store (`src/wiki/`) plus the `wiki.search` MCP operation — but had no session entry point, so agents never reached for it. This skill is that entry point.

## Use when

- User invokes `/oh-my-agy:wiki` or asks what do we already know about / is this documented / where is the decision on X
- Before re-deriving an architectural decision that may already be recorded
- You need a provenance-backed answer rather than a fresh read of scattered files

## Do not use when

- You need current code truth → `search` (read-only source research with `path:line`)
- You need to prove something works → `verify` (fresh command output)
- The answer requires writing a record → out of scope here; index changes go through the CLI deliberately

## Rules

1. **Read-only.** No file writes, no index mutation, no commits from this lane.
2. **Cite provenance.** Every claim sourced from the wiki quotes the record's `path` (and `record_id` when disambiguation matters). An uncited wiki claim is indistinguishable from a guess.
3. **Index staleness is a finding, not a footnote.** If `index_digest` predates the change you are reasoning about, say so before answering.
4. **Never invent a record.** If the query has no match, report no match. Do not paraphrase a plausible-sounding page that does not exist.
5. **Wiki is not verification.** A recorded decision says what was decided, not that the code still does it.

## Steps (in-session)

1. Restate the query and what a useful answer would let the user decide.
2. Look up matching records; note `index_digest` so staleness is visible.
3. Read the matching records' source paths — the record is a pointer, the file is the truth.
4. Answer with `path` citations, separating **what is recorded** from **what you verified in the tree right now**.
5. If nothing matches, say so plainly and offer the `search` lane instead.

## Checklist

- [ ] Query restated, decision framed
- [ ] Every wiki-sourced claim carries a `path` citation
- [ ] Index staleness checked and reported when relevant
- [ ] Recorded-vs-verified clearly separated
- [ ] No files written

## Anti-patterns (forbidden)

- Answering from memory and attributing it to the wiki
- Reporting a decision record as proof the behavior still holds
- Silently ignoring a stale `index_digest`
- Writing to the index from this lane to "fix" a missing page

---

## Appendix: optional `oma` CLI

```bash
oma wiki list                      # dump records + index_digest + provenance
oma wiki search <query> --limit 20 # bounded search, --limit accepts 1..50
oma wiki index                     # rebuild the record store
```

`oma wiki` with no subcommand fails with `E_CLI_USAGE: wiki requires index|list|search` — that is the intended fail-closed behavior, not a bug.

Design concept mapping: `oh-my-claudecode/skills/wiki`, `oh-my-codex/skills/wiki`,
`oh-my-grok/skills/omg-wiki`; OMA adds provenance/digest discipline from `src/wiki/`.
