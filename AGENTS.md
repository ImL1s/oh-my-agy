<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# oh-my-agy (OMA)

## Purpose

Orchestration layer for Google Antigravity CLI (`agy`): session slash skills (primary), optional `oma`/`omy` durable CLI ledger (secondary), and PreInvocation/Stop plugin hooks (tertiary). Sibling of OMC/OMX/OmO/OMG — Antigravity-native runtime. Package `@iml1s/oh-my-agy` (v0.2.3+); plugin id `oh-my-agy`.

## Key Files

| File | Description |
|------|-------------|
| `package.json` | Scoped package, bin `oma`/`omy`, scripts, `files` surface |
| `plugin.json` | Antigravity plugin name/version (hooks via `hooks.json`) |
| `hooks.json` | Registers PreInvocation + Stop only |
| `.claude-plugin/plugin.json` | Claude Code slash skill marketplace manifest |
| `bin/oma.ts` | CLI entry (compiled to `dist/bin/oma.js`) |
| `README.md` | User-facing install, slash UX, commands |
| `CHANGELOG.md` | Release notes |
| `DESIGN.md` | Architecture + dual-track UX |
| `PROJECT.md` | Project overview |
| `TEST_INFRA.md` | Test infrastructure rationale |
| `CLAUDE.md` | Build/test + coding style (zh-TW comments, spawn-only) |
| `tsconfig.json` | Strict TypeScript → `dist/` |
| `jest.unit.config.js` | Unit tests under `tests/**` |
| `jest.config.js` | E2E tests under `e2e/**` |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `src/` | TypeScript implementation (see `src/AGENTS.md`) |
| `tests/` | Unit tests (see `tests/AGENTS.md`) |
| `e2e/` | E2E / structured CLI tests (see `e2e/AGENTS.md`) |
| `skills/` | Session skill bodies SKILL.md (see `skills/AGENTS.md`) |
| `docs/` | ADRs + implementation plans (see `docs/AGENTS.md`) |
| `bin/` | CLI entry source (see `bin/AGENTS.md`) |
| `scripts/` | install.sh, smoke helpers (see `scripts/AGENTS.md`) |
| `rules/` | Host/plugin rule snippets |
| `assets/` | README images |
| `.claude-plugin/` | Claude marketplace manifests |
| `.github/` | CI + release workflows |
| `dist/` | **Generated** `tsc` output — do not edit |
| `.agents/` | Local agent run artifacts — not product source |

## For AI Agents

### Working In This Directory

- **Primary UX:** in-session slash — agy: `/autopilot`; Claude/Grok: `/oh-my-agy:autopilot`.
- **Secondary:** `oma setup|doctor|autopilot|team|ralph|…` durable/managed path.
- Never edit `dist/`; always `npm run build` after TS changes.
- Never `exec` external commands — only `spawn` / `spawnSync` with argv arrays.
- Comments: Traditional Chinese with design-mapping to OMC/OMX when porting concepts.
- Runtime dirs gitignored: `.agy/`, `.omc/`, `.omx/`, `.claude/`, `.grok/` (local skill links).

### Testing Requirements

```bash
npm ci && npm run build
npm run test:unit    # jest.unit.config.js, runInBand
npm run test:e2e     # jest.config.js, runInBand
```

Full unit + e2e green before release claims. Tag `v*` must match `package.json` / `plugin.json` / `.claude-plugin/plugin.json`.

### Common Patterns

- Result types (`ok`/`err`) for fallible paths
- CAS/revisioned state stores under platform state root
- Managed binding env: `OMA_SESSION_ID`, `OMA_LAUNCH_NONCE`, `OMA_INVOCATION_GENERATION`
- Skills are in-session playbooks; CLI is optional ledger

## Dependencies

### Internal

- Hierarchical docs: `src/`, `tests/`, `skills/`, `docs/` AGENTS.md children

### External

- Node ≥20, TypeScript 5.x, Jest + ts-jest
- Host CLIs: `agy` (hooks), optional `claude` / `grok` (slash install)
- GitHub Packages: `@iml1s/oh-my-agy`

<!-- MANUAL: Repository guidelines preserved from prior AGENTS.md -->

## Project Structure & Module Organization (quick map)

| Path | Role |
|------|------|
| `bin/oma.ts` | CLI entry — structured CLI vs legacy pass-through |
| `src/cli/` | argv parse, managed invocation, services |
| `src/hooks/` | PreInvocation / Stop |
| `src/continuation/` | SessionLocator, SessionAggregate, ProgressOracle |
| `src/autopilot/` | Durable Autopilot FSM |
| `src/team/` | Team/tmux/worktree/recovery-fork |
| `src/enforcer.ts` | Legacy todo continuation + non-destructive circuit breaker |
| `src/runtime/` | locks, atomic writes, process, state-root |
| `src/setup/` | doctor, host-install, plugin transaction |

## Coding Style & Safety (must follow)

- Strict TS, two-space, semicolons, single quotes; PascalCase types; camelCase fns; UPPER_SNAKE constants
- Circuit breaker must **never** `git reset --hard` / `git clean -fd`
- Launch nonce is capability material — debug logs fingerprint only
- Conventional Commits preferred for PRs

## Host slash cheat sheet

| Host | Canonical |
|------|-----------|
| Antigravity (`agy`) | `/autopilot` |
| Claude Code / Grok | `/oh-my-agy:autopilot` |
