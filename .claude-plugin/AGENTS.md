<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# .claude-plugin

## Purpose

Claude Code plugin registration for namespaced slash skills (`/oh-my-agy:…`). Separate from root `plugin.json` (agy hooks surface).

## Key Files

| File | Description |
|------|-------------|
| `plugin.json` | name `oh-my-agy`, version (must = package.json), skills[] paths |
| `marketplace.json` | Local marketplace entry for `claude plugin marketplace add` |

## Subdirectories

None.

## For AI Agents

### Working In This Directory

- Bump `version` in lockstep with `package.json` and root `plugin.json`.
- `skills` array must list every skill directory under `skills/`.
- Doctor `version_sync` / package tests assert alignment.

### Testing Requirements

- `tests/package/plugin-surface.spec.ts`
- `tests/setup/doctor.spec.ts` (claude_plugin_manifest)

## Dependencies

### Internal

- Points at repo `skills/*/`

### External

- Claude Code plugin CLI

<!-- MANUAL: -->
