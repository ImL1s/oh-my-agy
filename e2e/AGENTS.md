<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# e2e

## Purpose

End-to-end and structured CLI tests against compiled / process-level behavior. Uses `jest.config.js` with serial execution. Replaces real `agy` with `mocks/agy` where needed.

## Key Files

| File | Description |
|------|-------------|
| `helper.ts` | Sandbox fixtures, condition waits |
| `tier1.spec.ts` | Narrowest e2e scenarios |
| `tier2.spec.ts` | Broader integration |
| `tier3.spec.ts` | Advanced / multi-component |
| `tier4.spec.ts` | Widest scenarios |
| `structured-cli.spec.ts` | Structured CLI surface (skill/autopilot routing) |

## Subdirectories

| Directory | Purpose |
|-----------|---------|
| `mocks/` | Fake `agy` executable for tests (see `mocks/AGENTS.md`) |

## For AI Agents

### Working In This Directory

- Case names: `TC-T<tier>-<number>` pattern.
- Prefer `helper.ts` isolation; never leave sandbox dirs behind.
- Do not require network or real Antigravity auth for CI e2e.

### Testing Requirements

```bash
npm run test:e2e
npx jest e2e/tier1.spec.ts --runInBand
```

### Common Patterns

- Spawn compiled `dist/bin/oma.js` with controlled PATH
- Assert JSON stdout / exit codes

## Dependencies

### Internal

- Built `dist/`, `e2e/helper.ts`, `e2e/mocks/agy`

### External

- Jest Node environment

<!-- MANUAL: -->
