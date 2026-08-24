<!-- Parent: ../AGENTS.md -->
<!-- Generated: 2026-07-21 | Updated: 2026-07-21 -->

# team

## Purpose

Multi-worker Team orchestration: manifest DAG, claims, worktrees, tmux panes, heartbeat, deliver, reclaim, recovery-fork, authority leases.

## Key Files

| File | Description |
|------|-------------|
| `orchestrator.ts` | start → claim → worktree → tmux → tick → wait |
| `api-interop.ts` | OMX-shaped `team api` P0 dispatch (mailbox/claim) |
| `manifest.ts` | Manifest validation / cycles / scope |
| `commands.ts` | Typed team CLI surface |
| `state.ts` | Team aggregate, claims, mailbox |
| `worktree.ts` | Safe managed worktree lifecycle |
| `tmux.ts` | Owned pane create/kill |
| `worker-bootstrap.ts` | Spawn agy worker with managed env |
| `worker-hold.ts` | Hold worker pane protocol |
| `delivery.ts` / `publisher.ts` | Deliver + publish with verification |
| `supervisor.ts` / `reclaim.ts` / `liveness.ts` | Hung worker / DeadProof |
| `recovery-fork.ts` | Leader-only fork resolution |
| `authority-lease.ts` | Exclusive write-scope leases |
| `integration.ts` | Integration helpers |
| `types.ts` | Team types |

## For AI Agents

### Working In This Directory

- Leader-only operations for fork resolution.
- Reclaim requires DeadProof (pane+process).
- No shell `exec`; git/tmux via spawn.

### Testing Requirements

`tests/team/*` — extensive unit/integration; some need real git/tmux.

## Dependencies

### Internal

- `src/runtime/*`, process runner

### External

- `git`, `tmux` on PATH for full paths

<!-- MANUAL: -->
