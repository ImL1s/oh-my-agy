<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# verification

## Purpose

Evidence and causal-trace validators used as gates (e.g. production completion, continue-then-allow chains).

## Key Files

| File | Description |
|------|-------------|
| `evidence.ts` | GateValidator — bind evidence to workspace/runner |
| `causal-trace.ts` | CausalTraceValidatorV1 — same-invocation continue then final allow |

## For AI Agents

### Working In This Directory

- Validators are strict by design; do not weaken for convenience.
- Fresh command output required for user-facing “verified” claims (see skills/verify).

### Testing Requirements

`tests/runtime/verification-contracts.spec.ts`.

## Dependencies

### Internal

- Used by autopilot/team completion paths as needed

<!-- MANUAL: -->
