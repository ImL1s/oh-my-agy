<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# setup

## Purpose

Plugin install transaction for `agy`, multi-host slash install (Claude/Grok), and `oma doctor` health checks.

## Key Files

| File | Description |
|------|-------------|
| `host-install.ts` | `installSlashHosts`, absolute skill links, HostCliAdapter |
| `doctor.ts` | Checks: versions, claude manifest, slash skills, OMC collision, hooks, agy warn |
| `transaction.ts` | Snapshot → validate → install → enable → readback |
| `plugin.ts` | Plugin command adapter + registry readback |

## For AI Agents

### Working In This Directory

- Inject `HostCliAdapter` in tests — never real claude/grok in unit tests.
- Absolute symlinks only; do not destroy non-OMA skill dirs.
- agy missing → doctor **warn** for slash-first; hard fail only when product requires hooks.

### Testing Requirements

`tests/setup/host-install.spec.ts`, `doctor.spec.ts`, `setup-transaction.spec.ts`, `plugin-preflight.spec.ts`.

## Dependencies

### Internal

- `src/runtime/*`

### External

- Optional `claude`, `grok`, `agy` CLIs

<!-- MANUAL: -->
