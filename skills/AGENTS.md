<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# skills

## Purpose

In-session skill playbooks shipped with the plugin. Each subdirectory has a `SKILL.md` (YAML frontmatter + body). Bodies are **session-first**: host agent runs phases here; `oma` CLI only in appendices for durable ledger.

## Key Files

| Path | Description |
|------|-------------|
| `autopilot/SKILL.md` | Full OMX five-phase delivery loop |
| `deep-interview/SKILL.md` | Clarify / specs |
| `ralplan/SKILL.md` | Plan + critic APPROVE gate |
| `ultragoal/SKILL.md` | Implement + verify ledger |
| `code-review/SKILL.md` | Merge readiness review |
| `ultraqa/SKILL.md` | Adversarial QA |
| `ralph/SKILL.md` | Single-task persistence loop |
| `ultrawork/SKILL.md` | Parallel high-throughput |
| `team/SKILL.md` | Multi-worker coordination |
| `search/SKILL.md` | Read-only / plan-style |
| `cancel/SKILL.md` | Abort modes safely |
| `verify/SKILL.md` | Fresh evidence gates |
| `setup/SKILL.md` | Install/doctor checks in-session |
| `oma-runtime/SKILL.md` | Skill index / runtime notes |

## Subdirectories

Each named skill directory contains only `SKILL.md` (no nested AGENTS.md). Treat the table above as the catalog.

## For AI Agents

### Working In This Directory

- Lead with “You are already in the agent session”; never require terminal-first happy path.
- agy bare name: `/autopilot`; Claude/Grok: `/oh-my-agy:autopilot`.
- Keep OMX phase names stable: deep-interview → ralplan → ultragoal → code-review → ultraqa.
- Artifacts under workspace `.agy/` (specs, plans, reviews, qa, ultragoal).

### Testing Requirements

- `tests/modes/skill-surface.spec.ts` — skills exist, pack includes skills
- `oma skill list` / `oma skill show <name>` smoke
- Doctor `slash_skills` checks autopilot body markers

### Common Patterns

- Frontmatter: `name`, `description`, optional `argument-hint`
- Appendix for optional `oma autopilot …` durable commands

## Dependencies

### Internal

- Loaded by `src/modes/skill-loader.ts`; listed in `.claude-plugin/plugin.json`

### External

- Host skill discovery (agy plugin, Claude plugin, Grok plugin)

<!-- MANUAL: -->
