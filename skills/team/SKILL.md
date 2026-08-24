---
name: team
description: "In-session OMA multi-worker team — invoke /oh-my-agy:team; plan manifest + coordinate HERE (oma team CLI optional for orchestrator)"
argument-hint: "[manifest path or team goal]"
---

# team (OMA / in-session)

## You are already in the agent session

When invoked via **`/oh-my-agy:team`** or this **team** skill, treat **`$ARGUMENTS`** as the team goal or manifest path and run **leader coordination HERE**.

- Do **not** open with “run `oma team start` first” as the only path — author the manifest and plan workers in-session first.
- Canonical slash: **`/oh-my-agy:team`**.
- `oma team …` orchestrator commands live in the [Appendix](#appendix-optional-oma-cli) for durable tmux/worktree lifecycle when the user wants managed TeamOrchestrator — not required to draft the plan.

## Purpose

Coordinated multi-worker execution (tmux + worktrees + delivery). **Explicit only** — never implied by ralph/ultrawork. Sibling of OMC/OMX team.

## Use when

- User invokes `/oh-my-agy:team` or explicitly asks for multi-worker / DAG / worktree team
- Parallel slices need separate write_scopes and deliver/FF publish

## Do not use when

- Independent slices in one session without workers → `ultrawork`
- Single-agent persistence → `ralph`
- Full product pipeline → `autopilot` (team only if user opts in during ultragoal)

## Leader protocol (in-session)

1. Write a valid team manifest (`oma.team-manifest/v1`) with DAG deps + write_scope (workspace path under `.agy/team/…` when used).
2. Record workers, claim tokens, worktree paths (tokens shown once when CLI starts the team).
3. Workers implement inside write_scope; keep worktree clean for deliver (no leftover runtime files).
4. On task complete: commit in worktree → deliver → leader integrates FF.
5. Tick starts ready dependents after deps complete.
6. Hung workers: supervise + DeadProof reclaim only.
7. Stop when done or cancelled (`cancel` skill).

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
- Imply team from ralph/ultrawork without user opt-in

## Final checklist

- [ ] Manifest valid (DAG + write_scope)
- [ ] Claim tokens / worktrees recorded
- [ ] Deliver only from clean worktrees
- [ ] Stop/reclaim used safely; no destructive git

---

## Appendix: optional `oma` CLI

Use when the user wants durable TeamOrchestrator (tmux/worktrees):

```bash
oma team start --manifest <path> [--mode headless|interactive]
oma team status --team <id>
oma team tick --team <id>
oma team wait --team <id> [--timeout-ms <n>] [--poll-interval-ms <n>] [--json]
oma team deliver --team <id> --task <id> --claim-token <tok> --generation <n> --worktree <path> --expected-revision <n>
oma team supervise --team <id>
oma team reclaim --team <id> --task <id> …
oma team stop --team <id>
oma team resolve-fork …
# CLI-first messaging / claims (P0 OMX-shaped subset — prefer over tmux send-keys):
oma team api send-message --input '{"team_name":"<id>","from_worker":"leader","to_worker":"<task>","body":"…"}' --json
# unordered list (no sequence). Ordered traffic needs claim_token+generation:
oma team api mailbox-list --input '{"team_name":"<id>","worker":"<task>"}' --json
oma team api mailbox-list --input '{"team_name":"<id>","worker":"<task>","claim_token":"<tok>","generation":1,"after_cursor":0}' --json
oma team api claim-task --input '{"team_name":"<id>","task_id":"<task>","worker":"<id>"}' --json
oma team api write-worker-inbox --input '{"team_name":"<id>","worker":"<id>","content":"…"}' --json
```

P0 `team api` ops: `send-message`, `mailbox-list`, `mailbox-mark-delivered`,
`create-task`, `list-tasks`, `claim-task`, `transition-task-status`,
`release-task-claim`, `get-summary`, `write-worker-inbox`. Not full OMX parity.
Ordered mailbox requires both `claim_token` and `generation` (partial fencing
fails closed). Do **not** use primary `tmux send-keys` for mailbox traffic when
`team api` is available.

In-session plan + artifacts remain the coordination source of truth; CLI owns process lifecycle when started.
