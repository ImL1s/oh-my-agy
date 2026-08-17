---
name: oma-runtime
description: "OMA skill index (SLASH-FIRST) — /oh-my-agy:autopilot five-phase + ralph, ultrawork, team, verify, setup; CLI is optional ledger only"
---

# oma-runtime (skill index — SLASH-FIRST)

You are running under **oh-my-agy (OMA)** — the Antigravity / Claude Code / Grok orchestration layer (sibling of OMC / OMX).

## Primary UX: slash skills in-session

User habit matches Claude Code **`/autopilot`**: work happens **inside the agent session**.

| Rule | Detail |
|------|--------|
| **Canonical form** | **`/oh-my-agy:<skill-name>`** (namespaced) |
| **Bare `/autopilot`** | Left to **OMC** (or host) if present — do not steal it |
| **Happy path** | No SID / CID / revision required to start |
| **CLI `oma …`** | Optional durable outer ledger only — never “open a terminal first” |

When a skill is invoked via slash or skill protocol, treat **`$ARGUMENTS` as the goal/seed** and execute **HERE**.

## Slash catalog

| User intent | Canonical slash | Skill body | Optional CLI helper |
|-------------|-----------------|------------|---------------------|
| Full autonomous delivery (OMX five-phase) | `/oh-my-agy:autopilot` | `skills/autopilot/SKILL.md` | `oma autopilot …` (ledger only) |
| Clarify requirements | `/oh-my-agy:deep-interview` | `skills/deep-interview/SKILL.md` | (phase of autopilot) |
| Consensus-style plan gate | `/oh-my-agy:ralplan` | `skills/ralplan/SKILL.md` | `oma autopilot consensus` (optional) |
| Durable implement + verify | `/oh-my-agy:ultragoal` | `skills/ultragoal/SKILL.md` | handoff/advance (optional); `oma team` explicit |
| Merge-readiness review | `/oh-my-agy:code-review` | `skills/code-review/SKILL.md` | `oma autopilot review` (optional) |
| Adversarial QA gate | `/oh-my-agy:ultraqa` | `skills/ultraqa/SKILL.md` | `oma autopilot qa` (optional) |
| Persist until verified done | `/oh-my-agy:ralph` | `skills/ralph/SKILL.md` | `oma ralph -- <task>` (optional) |
| Parallel independent work | `/oh-my-agy:ultrawork` | `skills/ultrawork/SKILL.md` | `oma ultrawork -- <task>` (optional) |
| Read-only research | `/oh-my-agy:search` | `skills/search/SKILL.md` | `oma search -- <query>` (optional) |
| Multi-worker tmux team | `/oh-my-agy:team` | `skills/team/SKILL.md` | `oma team start\|status\|tick\|…` |
| Stop active modes | `/oh-my-agy:cancel` | `skills/cancel/SKILL.md` | cancel managed session if bound |
| Evidence before “done” | `/oh-my-agy:verify` | `skills/verify/SKILL.md` | tests/build/doctor evidence |
| External advisor second opinion | `/oh-my-agy:ask` | `skills/ask/SKILL.md` | none — advisory only, never a worker |
| Provenance-tracked knowledge lookup | `/oh-my-agy:wiki` | `skills/wiki/SKILL.md` | `oma wiki index\|list\|search <query>` |
| Install/enable plugin | `/oh-my-agy:setup` | `skills/setup/SKILL.md` | `oma setup` / `oma doctor` |
| This index | `/oh-my-agy:oma-runtime` | (this file) | `oma skill list` / `oma skill show <name>` |

### Autopilot phase cycle (canonical OMX)

```text
deep-interview → ralplan → ultragoal → code-review → ultraqa → complete
```

Invoke end-to-end with:

```text
/oh-my-agy:autopilot <goal>
```

The autopilot skill runs each phase **in this conversation**, writing artifacts under `.agy/`. It does **not** require `oma autopilot drive` to begin.

When a managed launch includes `<<<OMA_SKILL_PROTOCOL …>>>`, **that protocol is mandatory** for the run. Autopilot `drive` (optional) injects the skill for the **current** phase when the user maintains an outer ledger.

## Workspace artifacts (always)

| Phase | Path |
|-------|------|
| Specs | `.agy/specs/` |
| Plans | `.agy/plans/` |
| Implement ledger | `.agy/ultragoal/` |
| Reviews | `.agy/reviews/` |
| QA | `.agy/qa/` |
| Ralph PRD | `.agy/ralph/` |
| Autopilot mirror | `.agy/autopilot/state.json` (optional) |

Do **not** invent `.omc` / `.omx` paths unless migrating.

## Hard rules (always)

1. Never modify `AGENTS.md` unless the user explicitly requests a merge policy change.
2. Managed binding (when used) uses exact env: `OMA_SESSION_ID`, `OMA_LAUNCH_NONCE`, `OMA_INVOCATION_GENERATION`.
3. Circuit breaker never runs `git reset --hard` / `git clean -fd`.
4. Prefer `spawn`/`spawnSync` argv arrays in any tooling you write — no shell `exec`.
5. Do not claim completion without **fresh** verification evidence (`skills/verify`).
6. Non-clean review/QA returns to `ralplan` with reason — no silent scope reduction.
7. **Slash-first:** never instruct the user to open a terminal as the default first step for autopilot / phase skills.

## Host notes

- Authoritative hooks (Antigravity): **PreInvocation** + **Stop** only.
- Ordinary pass-through must fail open (no managed binding env).
- Team / Autopilot durable CLI state lives under OMA state root (`OMA_STATE_ROOT` or platform default) when CLI is used.
- In-session quality gates are the **`.agy/` artifacts** written by the phase skills.

---

## Appendix: optional `oma` CLI surface

For operators who want a durable outer ledger (not the happy path):

```bash
oma skill list
oma skill show autopilot
oma autopilot start -- "<goal>"
oma autopilot status --session <id>
oma autopilot drive --session <id> --conversation <cid> --expected-revision <n>
oma autopilot handoff --session <id> --expected-revision <n> --key <key> --path <artifact>
oma autopilot advance --session <id> --expected-revision <n> --evidence <file>
oma autopilot consensus --session <id> --expected-revision <n> --role architect|critic --verdict approve|revise --note <text>
oma autopilot review --session <id> --expected-revision <n> --evidence <file>
oma autopilot qa --session <id> --expected-revision <n> --evidence <file>
oma autopilot return-ralplan --session <id> --expected-revision <n> --reason <text>
oma ralph -- "<task>"
oma setup && oma doctor --no-strict-plugin
```

Keep CLI handoffs consistent with existing `.agy/` artifacts when both are used. In-session slash remains primary.
