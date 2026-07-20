<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# docs

## Purpose

Long-form documentation: architecture decisions (ADR) and superpowers-style implementation plans. Not runtime code.

## Key Files

| File | Description |
|------|-------------|
| `npm-publishing.md` | GH Packages / Release tarball / npmjs blockers |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `adr/` | Architecture Decision Records |
| `superpowers/` | Plans + process docs (see nested plans) |
| `superpowers/plans/` | Dated implementation plans (slash-first, team, autopilot, …) |

## For AI Agents

### Working In This Directory

- Prefer updating plans when product decisions lock; link from CHANGELOG/README when shipping.
- Keep `npm-publishing.md` version examples in sync with current release.

### Testing Requirements

- Docs-only: no automated tests; release checklist may cite doc paths.

### Common Patterns

- Plan frontmatter: Goal / Architecture / Tech Stack
- Task checklists with file paths for zero-context executors

## Dependencies

### Internal

- Aligns with `DESIGN.md`, `README.md`, `CHANGELOG.md` at repo root

### External

- None

<!-- MANUAL: -->
