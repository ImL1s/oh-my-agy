---
name: oma-runtime
description: "OMA skill index — session workflows for Antigravity (autopilot, ralph, ultrawork, search, team, cancel, verify, setup)"
---

# oma-runtime (skill index)

You are running under **oh-my-agy (OMA)** — the Antigravity orchestration layer (sibling of OMC / OMX).

## Important: CLI ≠ session skill

`oma` / `omy` **starts and binds** managed sessions. **In-session behavior** is governed by workflow skills in this plugin:

| User intent | Skill | CLI helper |
|-------------|-------|------------|
| Full autonomous delivery | `skills/autopilot/SKILL.md` | `oma autopilot start|drive|status|resume` |
| Persist until verified done | `skills/ralph/SKILL.md` | `oma ralph -- <task>` |
| Parallel independent work | `skills/ultrawork/SKILL.md` | `oma ultrawork -- <task>` |
| Read-only research | `skills/search/SKILL.md` | `oma search -- <query>` |
| Multi-worker tmux team | `skills/team/SKILL.md` | `oma team start|status|tick|deliver|…` |
| Stop active modes | `skills/cancel/SKILL.md` | stop managed session / clear blockers |
| Evidence before "done" | `skills/verify/SKILL.md` | tests/build/doctor evidence |
| Install/enable plugin | `skills/setup/SKILL.md` | `oma setup` / `oma doctor` |

When a managed launch includes `<<<OMA_SKILL_PROTOCOL …>>>`, **that protocol is mandatory** for the run.

## Hard rules (always)

1. Never modify `AGENTS.md` unless the user explicitly requests a merge policy change.
2. Managed binding uses exact env: `OMA_SESSION_ID`, `OMA_LAUNCH_NONCE`, `OMA_INVOCATION_GENERATION`.
3. Circuit breaker never runs `git reset --hard` / `git clean -fd`.
4. Prefer `spawn`/`spawnSync` argv arrays in any tooling you write — no shell `exec`.
5. Do not claim completion without **fresh** verification evidence (`skills/verify`).

## Host notes (Antigravity)

- Authoritative hooks: **PreInvocation** + **Stop** only.
- Ordinary pass-through must fail open (no managed binding env).
- Team / Autopilot durable state lives under OMA state root (`OMA_STATE_ROOT` or platform default), not invent `.omc` / `.omx` paths unless migrating.
