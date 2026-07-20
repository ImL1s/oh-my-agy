<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# autopilot

## Purpose

Durable Autopilot FSM aligned with OMX five phases: deep-interview → ralplan → ultragoal → code-review → ultraqa. CLI `oma autopilot *` is optional ledger; session skill is primary.

## Key Files

| File | Description |
|------|-------------|
| `phases.ts` | OMX aliases, phase order, skill name mapping |
| `commands.ts` | Argv parse for start/drive/handoff/advance/… |
| `runtime.ts` | Durable session mutations, gates, cancel/breaker |

## For AI Agents

### Working In This Directory

- Keep phase names dual-compatible (legacy OMA aliases).
- QA gate alone must not mark completed without production gate when required.
- Session skill body: `skills/autopilot/SKILL.md`.

### Testing Requirements

`tests/autopilot/*` — commands, phases, runtime.

## Dependencies

### Internal

- `src/runtime/*`, skill names under `skills/`

<!-- MANUAL: -->
