---
name: team
description: "OMA multi-worker team via oma team CLI (manifest, deliver, tick, reclaim)"
argument-hint: "[manifest path or team goal]"
---

# team (OMA / Antigravity)

## Purpose

Coordinated multi-worker execution through **OMA TeamOrchestrator** (tmux + worktrees + delivery). Explicit only — never implied by ralph/ultrawork.

## CLI surface

```bash
oma team start --manifest <path> [--mode headless|interactive]
oma team status --team <id>
oma team tick --team <id>
oma team deliver --team <id> --task <id> --claim-token <tok> --generation <n> --worktree <path> --expected-revision <n>
oma team supervise --team <id>
oma team reclaim --team <id> --task <id> …
oma team stop --team <id>
oma team resolve-fork …
```

## Leader protocol

1. Write a valid team manifest (`oma.team-manifest/v1`) with DAG deps + write_scope.
2. `start` → record workers, claim tokens, worktree paths (tokens shown once).
3. Workers implement inside write_scope; keep worktree clean for deliver (no leftover runtime files).
4. On task complete: commit in worktree → `deliver` → leader integrates FF.
5. `tick` starts ready dependents after deps complete.
6. Hung workers: `supervise` + DeadProof `reclaim` only.
7. `stop` when done or cancelled.

## Safety

- AuthorityLease blocks overlapping write scopes.
- Dirty worktrees are preserved — never force-clean user work.
- No `git reset --hard` / `git clean -fd`.
- Deliver requires clean porcelain after OMA runtime files are removed (orchestrator does this).

## Do not

- Start team without a manifest
- Share one claim token across tasks
- Deliver with dirty unrelated files
- Kill sessions without owner nonce proof
