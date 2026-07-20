---
name: verify
description: "In-session OMA verify — invoke /oh-my-agy:verify; fresh build/test evidence HERE before completion claims"
---

# verify (OMA / in-session)

## You are already in the agent session

When invoked via **`/oh-my-agy:verify`** or this **verify** skill (or as a handoff from ralph/ultragoal/autopilot), run evidence gates **HERE** before any completion claim.

- Do **not** tell the user to open a separate terminal “first” if you can run project scripts from this session.
- Canonical slash: **`/oh-my-agy:verify`**.
- CLI health (`oma doctor`) is one optional gate — see [Appendix](#appendix-optional-oma-cli) — not a substitute for project build/tests.

## Purpose

OMC/OMX verification-before-completion for Antigravity sessions. No “done” without **fresh** command output from this turn.

## Use when

- User invokes `/oh-my-agy:verify` or asks prove it / before merge / acceptance gates
- End of a story, ultragoal lane, or pre-complete autopilot phase

## Policy

- No completion claims without **fresh** command output from this turn.
- Prefer project scripts: `npm run build`, `npm run test:unit`, `npm run test:e2e`, `./scripts/smoke.sh`.
- Size the suite to risk: small fix → focused tests; release → full gates.

## Steps (in-session)

1. List what changed and which gates matter.
2. Run gates; capture exit codes + key lines.
3. If fail: fix or report blocker — do not redefine success.
4. Only then mark stories/phases complete.

## Checklist

- [ ] Build/typecheck (when TS/JS touched)
- [ ] Unit/e2e relevant to change
- [ ] Install/plugin surface changed → `oma doctor` (or `--no-strict-plugin` when appropriate)
- [ ] No new errors introduced intentionally left unexplained

## Anti-patterns (forbidden)

- Claiming done because code “looks good”
- Reusing stale test output from an earlier turn as “fresh”
- Skipping gates by narrowing the claim without saying so

---

## Appendix: optional `oma` CLI

```bash
oma doctor
oma doctor --no-strict-plugin
```

Use doctor when install/hooks/plugin registry may have drifted; project `npm run *` remains the primary evidence for code changes.
