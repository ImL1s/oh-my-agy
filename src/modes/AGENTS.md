<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# modes

## Purpose

Managed mode directives (ralph/ultrawork/search) and session skill loading/protocol injection for managed launches.

## Key Files

| File | Description |
|------|-------------|
| `directives.ts` | Versioned mode directive render + validate |
| `commands.ts` | Mode command helpers |
| `skill-loader.ts` | Discover `skills/<name>/SKILL.md` from package root |
| `skill-protocol.ts` | Inject protocol outside task delimiters |

## For AI Agents

### Working In This Directory

- Directive digests must reject tampering / delimiter collisions.
- Task bytes round-trip literally without shell interpretation.
- Skill protocol complements slash skills; does not replace SKILL.md bodies.

### Testing Requirements

`tests/cli/directives.spec.ts`, `tests/modes/skill-surface.spec.ts`.

## Dependencies

### Internal

- Package `skills/` tree

<!-- MANUAL: -->
