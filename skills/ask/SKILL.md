---
name: ask
description: "In-session OMA external advisor broker — invoke /oh-my-agy:ask; second opinions are ADVISORY, never workers, never verified evidence"
argument-hint: "<provider> <question>"
---

# ask (OMA / in-session)

## You are already in the agent session

When invoked via **`/oh-my-agy:ask`** or this **ask** skill, treat **`$ARGUMENTS` as `<provider> <question>`** and broker an **external second opinion** from HERE.

- Canonical slash: **`/oh-my-agy:ask`**.
- The advisor's answer is **advisory input to you**, not a verdict, not a worker result, not verification evidence.
- There is **no `oma ask` CLI verb** today — see [Appendix](#appendix-current-oma-cli-reality). Do not tell the user to run one.

## Purpose

OMC/OMX/OMG expose `ask` as a **broker for locally installed advisor CLIs** (Codex, Claude, Gemini, `agy`). OMA mirrors that posture for Antigravity sessions: cross-model review when a change is risky, without letting a foreign CLI become an execution path.

## Use when

- User asks for a Codex / Claude / Gemini second opinion, cross-model review, or dual-review
- A high-risk change (security module, fail-closed gate, release surface) wants an independent reviewer **in addition to** OMA's own `code-review` / `verify` lanes
- Two internal lanes disagree and you need a tie-breaking perspective

## Do not use when

- Routine implementation, planning, or verification → `ralph` / `ultrawork` / `ralplan` / `verify`
- You want the advisor to *do* the work → forbidden; see HARD RULES
- You need evidence for a completion claim → `verify` (fresh build/test output), never an advisor transcript

## HARD RULES (non-negotiable)

1. **Advisory only.** Never mark a task `verified`, `passing`, or `done` on the strength of an advisor answer. Evidence comes from `npm run build` / `test:unit` / `test:e2e` / gates — nothing else.
2. **Never a worker.** Do not delegate implementation to an advisor CLI, do not pipe its patches in unreviewed, and do not treat it as a team member. OMA workers are governed by the worker envelope and dangerous-launch gate; an advisor bypasses both.
3. **No shell `exec` in tooling you write.** Any code you add that launches an advisor uses `spawn` / `spawnSync` with an argument array — never an assembled shell string. This mirrors `CLAUDE.md` and `skills/oma-runtime` hard rule 4, and it scopes to **source you author**; asking an advisor through the tools already available in this session is the normal path and is not covered by this rule.
4. **No secret leakage.** Redact tokens, credentials, and customer data before sending a question outward. An advisor prompt leaves the machine.
5. **Attribute the source.** When you use an advisor's point, say which advisor said it. Never present it as your own verification.
6. **User-invoked.** Reach for `ask` when the user asked for an outside opinion or the risk clearly warrants one — not as a reflex on every change.

## Steps (in-session)

1. **Scope the question.** State the exact decision, the files involved, and what would change based on the answer. A vague question wastes the round-trip.
2. **Pick the advisor.** Match the request: Codex for adversarial code review, Claude for architecture/reasoning, Gemini when explicitly asked, `agy` for Antigravity-native perspective. If the user named one, use that one.
3. **Redact.** Strip secrets and anything that must not leave the machine.
4. **Ask, and write the answer down.** Invoke the advisor CLI with the tools available in this session, passing the question as a single argument. Save the verbatim reply to **`.agy/ask/<provider>-<slug>.md`** (create the directory if missing) so the reasoning is auditable later and does not have to live in the transcript. Do not give the advisor write access to the repo, and do not let it run the project's build or tests — it answers, it does not act.

   When the second opinion has to be **evidence-bound to an exact commit** (release review, production gate), use the existing governed surface instead of an ad-hoc launch:

   ```bash
   oma production capture <review|ultraqa> [--run-id <id>] -- <codex|claude|grok|agy|cursor-agent> <args...>
   ```

   That path allowlists the executable and resolves it without a shell (`src/production/evidence.ts`), which is exactly the guarantee HARD RULE 3 is asking for.
5. **Judge it.** Advisors are wrong regularly. For each claim, decide: does repo evidence support it? Cite `path:line` when you accept a point.
6. **Report the split.** Say plainly which points you accepted, which you rejected, and why. Never silently adopt an advisor's framing.
7. **Then do the work yourself** through the normal OMA lanes, and verify with `verify`.

## Workspace artifacts

| What | Path |
|------|------|
| Advisor transcript | `.agy/ask/<provider>-<slug>.md` |

Do **not** invent `.omc` / `.omx` paths. The transcript is advisory input; it never counts as review or QA evidence, which live under `.agy/reviews/` and `.agy/qa/`.

## Checklist

- [ ] Question states a concrete decision, not "review this"
- [ ] Secrets redacted before the question left the session
- [ ] Advisor transcript saved under `.agy/ask/`
- [ ] Advisor identified by name in the report
- [ ] Each accepted claim backed by repo evidence (`path:line` or command output)
- [ ] No completion claim rests on the advisor's word
- [ ] Implementation went through OMA lanes, not the advisor

## Anti-patterns (forbidden)

- "Codex approved it, so it's done" — advisors do not close gates
- Pasting an advisor's diff without reading it
- Shelling an advisor CLI as a background worker to parallelize work
- Sending an unredacted `.env`, token, or customer record outward
- Asking three advisors and reporting only the one that agreed with you

---

## Appendix: current `oma` CLI reality

OMA ships **no `ask` verb** today. `oma --help` lists the shipped surface; `ask` is not on it. This skill is the in-session contract for advisor brokering; it does not claim CLI support that does not exist.

Related OMA surfaces that *do* exist and are usually the right call first:

```bash
oma doctor            # install/plugin health before blaming code
oma skill show verify # the evidence lane that actually closes claims

# The one existing OMA surface that does launch advisor CLIs, allowlisted and
# shell-free — use it when the second opinion must bind to an exact commit:
oma production capture <review|ultraqa> [--run-id <id>] -- <codex|claude|grok|agy|cursor-agent> <args...>
```

Design concept mapping: `oh-my-grok/skills/omg-ask` (advisory-only HARD RULES, artifact posture),
`oh-my-codex/skills/ask` (advisor-CLI selection replacing per-vendor skills),
`oh-my-claudecode/skills/ask`.
