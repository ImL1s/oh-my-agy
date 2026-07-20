# ADR-0001: Planning write-block sandbox approach

- Status: **Accepted**
- Date: 2026-07-20

## Context

DESIGN blueprint requires planning/search write restriction. Package surface currently exposes only PreInvocation + Stop hooks. Expanding to PreToolUse changes the public plugin contract.

## Decision

**Option B first:** OS-level fail-closed sandbox wrapper for managed `search` (and plan-like) launches:

- Linux: prefer `bwrap` when available
- macOS: prefer `sandbox-exec` when available
- If `OMA_REQUIRE_SANDBOX=1` and sandbox binary missing → **fail closed** (do not launch)
- If sandbox not required and binary missing → launch without sandbox (documented)

Do **not** expand hook surface to PreToolUse in this ADR.

## Consequences

- Cross-platform matrix complexity; unit tests skip when tool absent unless policy requires sandbox (then assert fail-closed).
- Defense-in-depth can later add PreToolUse via a new ADR.
