<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# cli

## Purpose

CLI surface: argv parsing, application wiring, managed exact_env launches, dangerous-launch gates, skill subcommands, and setup/doctor service methods.

## Key Files

| File | Description |
|------|-------------|
| `application.ts` | Top-level command dispatch + help (slash-first UX text) |
| `parser.ts` | Mode / team / autopilot argv routing |
| `services.ts` | setupCommand (multi-host), doctor, team, autopilot services |
| `managed-invocation.ts` | exact_env bind + spawn for ralph/ultrawork/search |
| `skill-commands.ts` | `oma skill list|show` |
| `dangerous-launch.ts` | madmax/yolo detection + TTY confirm |
| `runtime-adapter.ts` | Process/runtime seams for tests |

## For AI Agents

### Working In This Directory

- `setup --host all`: agy fail must not block slash install (except `--host agy`).
- Preserve `--` task delimiter semantics for managed modes.
- Help must document `/oh-my-agy:autopilot` primary UX.

### Testing Requirements

`tests/cli/*.spec.ts` — parser, application, managed-invocation, dangerous-launch, skill-commands.

## Dependencies

### Internal

- `src/setup/*`, `src/modes/*`, `src/autopilot/*`, `src/team/*`, `src/runtime/*`

<!-- MANUAL: -->
