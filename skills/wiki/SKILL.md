---
name: wiki
description: "In-session OMA repository-docs lookup — invoke /oh-my-agy:wiki; read-only, index derived fresh per call, cite the file not the record"
argument-hint: "<query>"
---

# wiki (OMA / in-session)

## You are already in the agent session

When invoked via **`/oh-my-agy:wiki`** or this **wiki** skill, treat **`$ARGUMENTS` as the lookup query** and answer **HERE**.

- Canonical slash: **`/oh-my-agy:wiki`**.
- The index is **derived fresh on every call** from the working tree and **persists nothing**. There is no store, no cache, and **no write verb**.
- Read-only. This lane never writes project files.

## Purpose

OMC/OMX/OMG expose `wiki` as an in-session knowledge surface. OMA already ships the retrieval half — the `wiki.search` MCP operation (reachable in-session via `.mcp.json`) and `oma wiki index|list|search` — but nothing told a session agent that lane existed or how to reason with its output. This skill is that prompt.

## What the index actually covers

This is the part that decides whether an answer is trustworthy, so check it before concluding anything:

| Property | Reality |
|----------|---------|
| Roots | `docs/`, `.agy/wiki/`, `.agy/decisions/` — **nothing else** |
| Extensions | `.md`, `.mdx`, `.txt`, `.json` |
| **Not indexed** | root `README.md`, `CHANGELOG.md`, `CLAUDE.md`, `AGENTS.md`, and all of `skills/**` |
| Persistence | none — recomputed in memory per invocation |
| Ranking | per-token **OR** scoring; every record with a non-zero score is returned |

Two consequences you must act on:

1. **A multi-word query matches nearly everything.** Measured on this repo: `oma wiki search "AGENTS.md must not be modified"` returns `total_matches: 41` out of 41 records — the entire index. `total_matches` is **not** a relevance count. Judge by `score` and by actually reading the cited file; treat low-score hits as no match.
2. **"Not in the wiki" ≠ "not documented."** If the answer lives in root `CLAUDE.md` or under `skills/`, the wiki cannot see it. Say "not in the indexed roots" and fall back to the `search` lane, rather than reporting the project has no record.

## Use when

- User invokes `/oh-my-agy:wiki` or asks what is recorded under `docs/` / `.agy/decisions/`
- Before re-deriving an architectural decision that may already be written down
- You want a provenance-carrying pointer into the docs tree

## Do not use when

- You need current code truth → `search` (read-only source research with `path:line`)
- You need to prove something works → `verify` (fresh command output)
- The answer requires **writing** a record → there is no write path anywhere. Records are plain files; recording a decision means creating or editing a markdown file under `docs/`, `.agy/wiki/`, or `.agy/decisions/`. Do not look for a CLI verb — none exists, and inventing one (`oma wiki add`) is a fabrication.

## Rules

1. **Read-only.** No file writes and no commits from this lane.
2. **Cite the file, not the record.** Every wiki-sourced claim quotes the record's `path` (and `record_id` when disambiguation matters). A record is a pointer; the file is the truth — re-read the path before relying on it.
3. **Rank honestly.** Because scoring is token-OR, a hit is not evidence of relevance. If the top hit does not actually answer the question after you read it, say so rather than citing it.
4. **Report scope misses as scope misses.** No match, or only low-score matches, means *not found in the indexed roots* — not "undocumented". Name the roots when you say it.
5. **Never invent a record.** Do not paraphrase a plausible-sounding page that does not exist.
6. **Wiki is not verification.** A recorded decision says what was decided, not that the code still does it.

## Steps (in-session)

1. Restate the query and what a useful answer would let the user decide.
2. **Search using `wiki.search`** (the MCP operation, the session-reachable surface) — or `oma wiki search <query> --limit <n>` when you have a terminal. Both return records with `path`, `record_id`, and `provenance`.
3. **Read the cited files.** The record is a pointer; do not answer from the search payload alone.
4. Answer with `path` citations, separating **what is recorded** from **what you verified in the tree right now**.
5. If nothing scores meaningfully, say the indexed roots have no record and offer the `search` lane.

## Checklist

- [ ] Query restated, decision framed
- [ ] Every wiki-sourced claim carries a `path` citation
- [ ] Cited files actually read, not just matched
- [ ] Low-relevance hits reported as such rather than cited confidently
- [ ] A miss stated as "not in `docs/` / `.agy/wiki/` / `.agy/decisions/`", not as "undocumented"
- [ ] No files written

## Anti-patterns (forbidden)

- Answering from memory and attributing it to the wiki
- Citing the top hit of an OR-scored multi-word query without reading it
- Reporting a decision record as proof the behavior still holds
- Claiming or inventing a wiki write command
- Concluding "the project has no record of X" when X lives outside the indexed roots

---

## Appendix: `oma` CLI (needed for the terminal path)

Not optional when you are working from a terminal — Rule 2 and the Checklist depend on this output.

```bash
oma wiki list                       # all records + index_digest + provenance
oma wiki search <query> --limit 20  # --limit accepts 1..50; the query must come BEFORE --limit
oma wiki index                      # recompute and print index_digest + per-source content hashes
```

`oma wiki index` **writes nothing** — it derives the index in memory and prints it. There is no store to rebuild.

`oma wiki search --limit 3 autopilot` fails with `E_CLI_USAGE: wiki search requires a query`, because query tokens are only collected before the first option.

`oma wiki` with no subcommand fails with `E_CLI_USAGE: wiki requires index|list|search` (exit 2) — intended fail-closed behavior, not a bug.

Design concept mapping: `oh-my-claudecode/skills/wiki`, `oh-my-codex/skills/wiki`,
`oh-my-grok/skills/omg-wiki`. Note the divergence: OMC's wiki is a **persistent, writable** markdown base (`wiki_add` / `wiki_ingest` / `wiki_delete` MCP tools); OMA's is a **derived, read-only** index over the docs tree. Do not carry OMC's write model over.
