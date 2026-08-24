---
name: trace
description: "In-session OMA competing-hypothesis causal tracing — invoke /oh-my-agy:trace; ≥2 hypotheses, evidence for/against with path:line, next probe"
argument-hint: "<symptom>"
---

# trace (OMA / in-session)

## You are already in the agent session

When invoked via **`/oh-my-agy:trace`** or this **trace** skill, treat **`$ARGUMENTS` as the symptom / observed result** and run **evidence-driven causal tracing HERE**.

- Canonical slash: **`/oh-my-agy:trace`**.
- This lane explains **why** something happened. It is not a fix-it loop, not `verify`, and not generic debugging chatter.
- There is **no `oma trace` CLI verb** today — see [Appendix](#appendix-current-oma-cli-reality). Do not tell the user to run one.
- Do **not** treat `src/verification/causal-trace.ts` / `oma.production-causal-trace/v1` as this skill's backend. That validator is same-invocation continue proof for production gates, not symptom tracing.

## Purpose

OMC ships `/oh-my-claudecode:trace` plus a dedicated `tracer` agent: competing hypotheses, evidence for and against, uncertainty tracking, and a discriminating next probe. OMX uses the same tracing posture. OMA mirrors that contract for Antigravity sessions so a “why is this happening?” question cannot collapse into the first plausible story (tunnel vision — the failure mode `CLAUDE.md` calls out with 先窮舉再深入 / 10-minute rule).

OMA has **no dedicated tracer agent**. Run the protocol **in this session**. Do not require `oma team` or a foreign CLI worker. If the host can fan out read-only workers, optional parallel lanes are allowed; sequential in-session tracing is the happy path.

## Use when

- User invokes `/oh-my-agy:trace` or asks why this failed / what caused this / trace this regression
- The observation is ambiguous, causal, and evidence-heavy
- Two stories already compete and you need to rank them instead of picking a favorite
- Runtime bugs, performance/latency, config/orchestration surprises, premortem/postmortem, “given this output, what produced it?”

## Do not use when

- The next step is to implement a known fix → `ralph` / `ultrawork`
- You only need source locations, not causes → `search`
- You need fresh proof a change works → `verify`
- You want an external model’s opinion → `ask` (advisory only; not evidence)
- You need production continue-then-allow proof → `oma production verify` / causal-trace validator (different tool)

## HARD RULES (non-negotiable)

1. **≥2 competing hypotheses before any ranking.** A single hypothesis is a blocker, not a trace. Prefer **three** default frames when the prompt does not already partition better (see Default lanes). If two “different” stories reduce to the same mechanism, merge them **explicitly** and spawn a genuinely different replacement so the shortlist stays ≥2 until evidence closes the case.
2. **Every hypothesis gets evidence for AND evidence against** (or an explicit gap). Each bullet cites **`path:line`** or command output. No citation → not evidence.
3. **Separate observation, inference, and unknown.** Do not rewrite the symptom to fit a favorite theory.
4. **Rank evidence by strength** (controlled reproduction > primary artifact with provenance > independent convergence > single-path inference > circumstantial clues > speculation). Speculation may seed a hypothesis; it may not close one.
5. **Name uncertainty.** Confidence is High / Medium / Low. If the leader is only Medium or Low, say so. Never present a guess as a root cause.
6. **Every round ends with one discriminating probe** — the cheapest next observation that would knock out the most remaining hypotheses. “Not sure” without a probe is a failed trace.
7. **Retired hypotheses are retired out loud.** State the disconfirming evidence. Silent retcon is forbidden.
8. **Do not implement** unless the user explicitly asks to fix after the ranked explanation. Tracing is the deliverable.
9. **No shell `exec` in tooling you write.** Use `spawn` / `spawnSync` with an argv array. This mirrors `CLAUDE.md` and `skills/oma-runtime` hard rule 4.

## Default lanes (v1)

Unless `$ARGUMENTS` already names a better partition, open with these three frames:

1. **Code-path / implementation** — the running logic, a recent diff, a missed branch, a race.
2. **Config / environment / orchestration** — host flags, env, plugin identity, managed binding, tmux/team routing.
3. **Measurement / artifact / assumption mismatch** — the observation is a bad probe: wrong test, stale log, catalog drift, one key reused across entities, comparing incomparable grains.

These are deliberately different causal kinds. Do not run the same explanation three times with new labels.

## Steps (in-session)

1. **OBSERVE.** Restate the exact symptom (command, output, timestamp, what was expected). No interpretation yet.
2. **FRAME.** Write the tracing question in one sentence: “Why did X happen (not Y)?”
3. **HYPOTHESIZE.** List ≥2 (default 3) competing causes from different frames. Each must make a **distinctive prediction**.
4. **GATHER.** For each hypothesis, collect supporting **and** disconfirming evidence. Read the code, tests, configs, logs, git history. Cite `path:line`.
5. **LENSES (when they change the ranking).** Systems (queues, retries, boundaries), premortem (assume the leader is wrong), science (confounders, controls, measurement bias).
6. **REBUT.** The strongest non-leader attacks the leader with its best contrary evidence. The leader answers with evidence, not assertion. Re-rank if the attack lands.
7. **SYNTHESIZE.** Ranked table, current best explanation (provisional if uncertain), critical unknown, **one** next probe.
8. **WRITE** the report to **`.agy/trace/<slug>.md`** (create `.agy/trace/` if missing). Slug from the symptom, `[a-z0-9-]+`, keep it short.

If a probe has not discriminated after ~10 minutes, **switch frames** rather than digging the same hole (10-minute rule).

## Workspace artifacts

| What | Path |
|------|------|
| Trace ledger | `.agy/trace/<slug>.md` |

Do **not** invent `.omc` / `.omx` paths. The ledger is a tracing notebook; it is **not** review, QA, or production evidence. Those stay under `.agy/reviews/`, `.agy/qa/`, and the production causal-trace validator.

## Output template

Write this structure both in the session reply **and** in the artifact:

```markdown
## Trace Report

### Observation
[What was observed, no interpretation]

### Tracing question
[One “why” sentence]

### Ranked hypotheses
| Rank | Hypothesis | Confidence | Evidence strength | Why it remains / was retired |
|------|------------|------------|-------------------|------------------------------|
| 1 | … | High / Medium / Low | Strong / Moderate / Weak | … |
| 2 | … | … | … | … |

### Evidence for
- H1 — `path:line` — …
- H2 — `path:line` — …

### Evidence against / gaps
- H1 — `path:line` or *gap: …*
- H2 — …

### Rebuttal round
- Best attack on the leader: …
- Why the leader held / was down-ranked: …

### Retired hypotheses
- Hn — retired because `path:line` / command output …

### Convergence / separation
- [Same mechanism (merged) vs still distinct next probes]

### Current best explanation
[Provisional if confidence is not High]

### Critical unknown
[Single missing fact that still separates the top two]

### Discriminating probe
[Single next observation / command / read — what result would kill which hypothesis]
```

## Checklist

- [ ] Observation stated before any cause
- [ ] ≥2 genuinely different hypotheses (default 3 lanes)
- [ ] Each row has evidence **for** and **against** (or an explicit gap) with `path:line` or command output
- [ ] Confidence and evidence-strength ranked, not flattened
- [ ] Rebuttal round happened before the verdict
- [ ] Retired hypotheses named with the killing evidence
- [ ] Critical unknown + one discriminating probe
- [ ] Artifact written to `.agy/trace/<slug>.md`
- [ ] No completion claim, no silent patch, no invented `oma trace` CLI

## Anti-patterns (forbidden)

- One-hypothesis “probably a race” and start rewriting
- Collecting only confirming evidence
- Treating stack order, naming, or timing as causation
- Fake convergence (“they sound similar, so they are the same cause”)
- Using `src/verification/causal-trace.ts` as if it explained the bug
- Telling the user to run `oma trace`
- Marking the story `verified` / `done` because the trace “looks convincing”
- Quietly replacing hypothesis A with B in later paragraphs

---

## Appendix: current `oma` CLI reality

OMA ships **no `trace` verb** today. `oma --help` lists the shipped surface; `trace` is not on it. This skill is the in-session contract; it does not claim CLI support that does not exist.

Related surfaces that *do* exist and are usually the wrong tool for this job (use them only for their own purpose):

```bash
oma skill show trace     # this playbook
oma skill show search    # read-only path:line research, not causal ranking
oma skill show verify    # fresh build/test evidence, not a why-trace
oma doctor               # install/plugin health, not a code-path explanation
# NOT a tracing backend — production same-invocation continue proof only:
#   src/verification/causal-trace.ts  (oma.production-causal-trace/v1)
```

Design concept mapping: `oh-my-claudecode/skills/trace` (in-session tracing lane),
`oh-my-claudecode/agents/tracer` (competing hypotheses, for/against, uncertainty, next probe),
`oh-my-codex` tracing posture. OMA difference: session-only playbook, **no** `oma trace` CLI and **no** bundled tracer agent.
