<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# helpers

## Purpose

Shared fixtures for unit tests: git repos, hook I/O, process spawn fakes, state roots, tmux doubles.

## Key Files

| File | Description |
|------|-------------|
| `git-fixture.ts` | Isolated git workspaces |
| `hook-fixture.ts` | Hook stdin/stdout harness |
| `process-fixture.ts` | Controlled process behavior |
| `state-fixture.ts` | Temp state roots |
| `tmux-fixture.ts` | tmux test helpers |

## For AI Agents

### Working In This Directory

- Prefer fixtures over copy-paste temp setup.
- Always clean up temp dirs.

<!-- MANUAL: -->
