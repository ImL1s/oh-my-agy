---
name: verify
description: "Evidence before completion — build/test/doctor gates for OMA work"
---

# verify (OMA)

## Purpose

OMC/OMX verification-before-completion for Antigravity sessions.

## Policy

- No completion claims without **fresh** command output from this turn.
- Prefer project scripts: `npm run build`, `npm run test:unit`, `npm run test:e2e`, `./scripts/smoke.sh`, `oma doctor`.
- Size the suite to risk: small fix → focused tests; release → full gates.

## Steps

1. List what changed and which gates matter.
2. Run gates; capture exit codes + key lines.
3. If fail: fix or report blocker — do not redefine success.
4. Only then mark stories/phases complete.

## Checklist

- [ ] Build/typecheck (when TS/JS touched)
- [ ] Unit/e2e relevant to change
- [ ] `oma doctor --no-strict-plugin` when install/plugin surface changed
- [ ] No new errors introduced intentionally left unexplained
