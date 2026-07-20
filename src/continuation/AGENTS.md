<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# continuation

## Purpose

Durable session continuation: locate binding, aggregate Stop history, progress oracle, and continuation decision outputs for hooks.

## Key Files

| File | Description |
|------|-------------|
| `session-aggregate.ts` | Revisioned aggregate + CAS Stop contract |
| `state.ts` | Aggregate state shapes |
| `progress-oracle.ts` | Progress vs no-progress classification |
| `decision.ts` | continue / allow decision building |
| `event-identity.ts` | Event/idempotency identity |

## For AI Agents

### Working In This Directory

- Duplicate Stop must be byte-identical replay; conflicting input rejected.
- Never treat fail-open allow as task complete.

### Testing Requirements

`tests/runtime/session-aggregate.spec.ts`, `tests/hooks/continuation-decision.spec.ts`, locator tests.

## Dependencies

### Internal

- `src/runtime/state-store`, locks, state-root

<!-- MANUAL: -->
