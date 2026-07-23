# Slash-First Autopilot (Claude Code `/autopilot` UX) Implementation Plan

> **For Codex / Grok / Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or subagent-driven-development task-by-task.

**Goal:** Make OMA’s primary entrypoint the same as the user’s real habit in Claude Code: type **`/autopilot`** (or namespaced equivalent) **inside the session** and have the agent run the five-phase loop — not open a terminal for `oma autopilot` first.

**Architecture:** Split UX into two layers. (1) **Primary:** host-discoverable slash skills (Claude `.claude-plugin` + Grok plugin/skill roots) whose bodies are in-session playbooks. (2) **Secondary:** `oma` CLI as optional durable ledger (start/handoff/advance/review/qa) when on PATH; fail-open without CLI. Setup installs host plugins so slash appears on next session.

**Tech Stack:** Existing `skills/*` SKILL.md trees; Claude Code plugin layout (OMC pattern); Grok plugin install; TypeScript only for `oma setup` multi-host + doctor collision checks.

**Evidence base (multi-agent 2026-07-21):**
- Explore Claude Code: OMC registers via `.claude-plugin/plugin.json` `skills: ["./skills/autopilot/",…]`; bare `/autopilot` vs `/oh-my-claudecode:autopilot`
- Explore Grok: bare `/autopilot` today → `~/.claude/skills/autopilot` (OMX body); OMA not in discovery roots
- Explore OMA: root `plugin.json` is **agy-only**; `oma setup` only talks to `agy`; skill bodies are CLI-first
- Critic + Opus: REQUEST CHANGES — slash-first not shipped; namespace vs bare collision; setup must install Claude/Grok surface

---

## Product decisions (locked for P0)

| Decision | Choice |
|----------|--------|
| Primary UX | **In-session slash skill** |
| Canonical slash (P0) | **`/oh-my-agy:autopilot`** (plugin-namespaced; unambiguous with OMC) |
| Optional bare alias | **Do not steal bare `/autopilot`** while OMC installed; document `/oh-my-agy:autopilot` |
| Optional short alias skill | `name: oma-autopilot` → `/oma-autopilot` if desired P1 |
| CLI role | Optional durable ledger + install/doctor |
| Happy path | User never needs SID/CID/revision to start thinking/working in-session |

---

### Task 1: Claude Code plugin manifest (registration)

**Files:**
- Create: `.claude-plugin/plugin.json`
- Create: `.claude-plugin/marketplace.json`
- Modify: `package.json` → `files` include `.claude-plugin`

**Step 1: Write `.claude-plugin/plugin.json`**

```json
{
  "name": "oh-my-agy",
  "version": "0.2.2",
  "description": "OMA — Antigravity/Claude session orchestration (slash-first autopilot)",
  "author": { "name": "ImL1s" },
  "repository": "https://github.com/ImL1s/oh-my-agy",
  "license": "MIT",
  "keywords": ["claude-code", "antigravity", "autopilot", "oma"],
  "skills": [
    "./skills/autopilot/",
    "./skills/deep-interview/",
    "./skills/ralplan/",
    "./skills/ultragoal/",
    "./skills/code-review/",
    "./skills/ultraqa/",
    "./skills/ralph/",
    "./skills/ultrawork/",
    "./skills/search/",
    "./skills/team/",
    "./skills/cancel/",
    "./skills/verify/",
    "./skills/setup/",
    "./skills/oma-runtime/"
  ]
}
```

**Step 2: Write marketplace.json** (local path install)

```json
{
  "name": "oh-my-agy",
  "owner": { "name": "ImL1s" },
  "plugins": [
    {
      "name": "oh-my-agy",
      "source": "./",
      "description": "OMA slash skills + optional oma CLI ledger"
    }
  ]
}
```

**Step 3: Validate**

```bash
claude plugin validate ~/src/oh-my-agy
```

Expected: valid (or fix reported issues).

**Step 4: Commit** `feat: Claude Code plugin manifest for slash skills`

---

### Task 2: Reorder skill bodies — in-session primary

**Files:**
- Modify: `skills/autopilot/SKILL.md` (and phase skills as needed)
- Modify: `skills/oma-runtime/SKILL.md`

**Step 1: Structure for `skills/autopilot/SKILL.md`**

```markdown
---
name: autopilot
description: "OMA autopilot — in-session five-phase delivery (deep-interview→…→ultraqa). Use when user invokes /oh-my-agy:autopilot or says full auto."
argument-hint: "<goal or product idea>"
---

# autopilot (OMA) — IN-SESSION PRIMARY

You are already inside the agent session. **Do not** tell the user to open a terminal first.

## When invoked via slash
1. Treat $ARGUMENTS as the goal.
2. Run phases **in this conversation** (tools available now).
3. Optionally call `oma autopilot …` if `oma` is on PATH for durable ledger; if not, write soft state under `.agy/autopilot/` and continue.

## Phase loop (OMX)
deep-interview → ralplan → ultragoal → code-review → ultraqa → complete

## Optional CLI ledger (appendix)
…move current long CLI playbook here…
```

**Step 2:** Same invert for `ultragoal`, `code-review`, `ultraqa`, `ralph`, `ralplan`, `deep-interview` (lead with “you are in-session”).

**Step 3:** Commit `docs(skills): slash-first in-session primary bodies`

---

### Task 3: Multi-host setup + doctor

**Files:**
- Modify: `src/setup/transaction.ts` or create `src/setup/host-install.ts`
- Modify: `src/setup/doctor.ts`
- Modify: `scripts/install.sh`
- Modify: `src/cli/services.ts` setup flags
- Test: `tests/setup/host-install.spec.ts`

**Step 1: Design `oma setup` hosts**

```text
oma setup                 # all detected hosts
oma setup --host agy      # existing
oma setup --host claude   # print + try: marketplace add + install instructions
oma setup --host grok     # grok plugin install <packageRoot> --trust (if CLI available)
```

**Step 2: Claude install steps (automated where safe)**

```bash
claude plugin marketplace add <packageRoot>
claude plugin install oh-my-agy@oh-my-agy
# or document: claude plugin install with path per current CLI
```

If automation fails (permissions/TTY): print exact commands; exit 0 with `needsManual: true`.

**Step 3: Doctor checks**

- Detect OMC installed + OMA Claude plugin → warn collision; recommend `/oh-my-agy:autopilot`
- List resolved skill paths for autopilot if discoverable
- Keep existing agy plugin checks

**Step 4: Tests with mocked adapters (no real claude required in CI)**

**Step 5: Commit** `feat(setup): multi-host Claude/Grok slash install path`

---

### Task 4: Install for this machine (operator)

**Step 1:** From repo:

```bash
cd ~/src/oh-my-agy
npm run build
# Claude
claude plugin marketplace add .
claude plugin install oh-my-agy@oh-my-agy   # adjust to actual CLI syntax after validate
# Grok
grok plugin install . --trust
```

**Step 2:** New Claude Code session → type `/` → confirm `oh-my-agy:autopilot` appears.

**Step 3:** New Grok session → `/oh-my-agy:autopilot` or plugin-qualified form.

**Step 4:** Document in README “Slash-first (Claude Code)” section at top of Quick start.

---

### Task 5: README / DESIGN mental model fix

**Files:**
- `README.md` — lead with slash UX; CLI under “Optional durable ledger”
- `DESIGN.md` — dual-track: slash primary / CLI secondary / agy managed tertiary
- `docs/npm-publishing.md` — no change required

**Copy sketch:**

```markdown
## Primary UX (Claude Code / Grok)

/oh-my-agy:autopilot <goal>

Agent follows skills/autopilot in **this session** (same habit as Claude Code /autopilot).

## Optional durable ledger

oma autopilot start|status|advance|…   # only if you want SessionAggregate durability
```

---

### Task 6: Tests + verify

```bash
npm run build
npm run test:unit
claude plugin validate .
# manual: slash appears in Claude session
```

Commit + push. Version bump to 0.2.2 when shipping.

---

## Out of scope (explicit)

- Replacing OMC bare `/autopilot` on machines that have OMC
- Full Claude Stop-hook parity with agy ProgressOracle (P2)
- npmjs publish
- Forcing `oma autopilot drive` inside Claude sessions

---

## Success criteria

| Check | Pass |
|-------|------|
| Claude session after setup | `/oh-my-agy:autopilot` (or listed skill) invocable |
| Skill body | Starts with in-session steps; CLI is appendix |
| OMC coexist | No silent overwrite of bare OMC `/autopilot` |
| `oma setup --host claude` | Installs or prints actionable install commands |
| User habit | Matches “我在 claudecode 打 /autopilot” for OMA via namespaced form |

---

## Session playbook (target after P0)

```text
# Claude Code
/oh-my-agy:autopilot Ship feature X

# Agent (in same session):
# 1 deep-interview → .agy/specs/…
# 2 ralplan → .agy/plans/… + self dual-pass
# 3 ultragoal implement + verify
# 4 code-review artifact
# 5 ultraqa pass/skip
# optional: oma autopilot start/advance if available
```

## Open questions for user (defaults applied if no reply)

1. **Slash name:** default **`/oh-my-agy:autopilot`** (safe with OMC). Want bare `/autopilot` only when OMC disabled? → P1.
2. **Ledger:** P0 = **ledger-optional** (pure in-session). Force `oma start` every run? → No unless requested.
