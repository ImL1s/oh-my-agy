# Native capability authority ledger

This ledger identifies every remaining native/fallback decision surface after
Issue #3. A version string, help projection, status command, descriptor digest,
or compatibility fixture is never routing authority by itself.

| Surface | Classification | Authority rule |
|---|---|---|
| `src/native/capability-profile.ts` | Canonical truth | Owns the policy registry, profile assembly/validation, cache identity, route candidates, and route receipts. Assessments are recomputed from canonical observations during validation. |
| `src/cli/runtime-adapter.ts::inspectNativeCapabilities` | Evidence assembler | Runs bounded public probes, fences host/plugin identity, and assembles or reads the profile. It may not select a Team provider. |
| `src/cli/runtime-adapter.ts::issueProductWorkflowRoute` | Workflow router | Issues product-workflow routes only through a validated fresh profile. |
| `src/team/provider.ts::routeTeamWorkerProvider` | Sole Team selector | Evaluates the native contract first and then the declared fallback policy. No CLI service or bootstrap code may reconstruct this decision. |
| `src/team/route-authority.ts` | Downstream authority carrier | Persists the complete profile and receipt in leader-owned external state, bound to team, task, generation, context, provider, mode, and executable; bootstrap atomically renames and consumes it so concurrent replay fails. |
| `src/team/worker-bootstrap.ts` | Authority consumer | Validates the single-use external authority and the executable realpath/SHA-256 before spawn. Worktree descriptor digests are references, not authority. |
| `src/production/evidence.ts` | Production consumer | Requires a fresh identity-bound live profile and validated route receipt. Host version remains metadata. |
| `src/team/agy-argv.ts::validateAgy115Help` and `src/team/provider.ts::probeAgy115` | Compatibility observation only | Describe the frozen fallback argv grammar. They never select a provider or authorize execution. |
| `src/native/antigravity-status.ts`, `src/native/lsp-status.ts`, `src/native/sidecar-status.ts` | Legacy/status projection | Read-only compatibility and T0/T1 reporting only. New native/fallback decisions must not consume them. |
| Repository-workflow T0-T5 status | Separate product contract | Describes OMA workflow maturity; it is not host capability evidence. |
| Private sidecar/brain internals | Forbidden | Never probed or used as evidence. Only documented public surfaces may contribute observations. |

## Invariants

1. All profile assessments are derived from bounded observations under the
   versioned policy registry; callers cannot submit a trusted assessment.
2. Timeout, malformed output, identity drift, stale evidence, and ambiguous
   plugin state remain `unknown` and fail closed.
3. Every fallback is declared in the profile policy and selected by the same
   router that evaluated native authority.
4. Live execution authority requires opt-in live evidence bound to the current
   host and plugin identity. Offline fixtures prove implementation behavior
   only.
