---
name: workflow
description: "OMA repository workflows — deterministic DAG, permission envelopes, durable replay, independent review, and fail-closed ship decisions"
argument-hint: "<workflow-name> <input-json-path>"
---

# workflow (OMA repository runner)

## Purpose

Run a versioned `repository-workflow/v1` definition through OMA’s authoritative
runner. The definition fixes stage order, bounded fan-out, permissions, worker
envelopes, verification, skeptic/verifier independence, and the final
`ship`/`no_ship` decision. Durable journal replay preserves interrupted work;
an external effect without a reconciled receipt becomes `effect_unknown`.

## Invocation

```bash
oma workflow run <workflow-name> --input <input.json>
```

Antigravity entries under `.agents/workflows/` are generated **T1 saved
prompts only**. They delegate to this CLI command and must not duplicate the
DAG, spawn workers, grant permissions, or decide whether to ship.

## Execution contract

1. Load one immutable workflow name/version/digest from the registry.
2. Validate the deterministic DAG and bounded matrix/agent parallelism.
3. Compile every stage into the frozen `oma_worker_envelope` contract.
4. Permit only declared write paths and the six registered OMA MCP operations.
5. Journal dispatch intent before execution and append canonical receipts.
6. Replay/reconcile interrupted effects; fail closed as `effect_unknown` when
   an effect cannot be proven.
7. Require independent skeptic and verifier approval plus a ship-gate proof.
8. Return the exact terminal and evidence; never translate `no_ship` into
   success.

## Native capability boundary

No public, live-verified Antigravity schema currently proves an equivalent
native team/workflow, native agent/command registry, semantic LSP, or private
memory sidecar. Those surfaces remain `optional_unclaimed` at T0. Do not infer
them from UI labels or private files. A saved workflow prompt claims at most T1;
OMA’s repository runner supplies the higher orchestration tiers.

## Safety

- Never add release/publish authority to a worker envelope.
- Never permit nested workflow supervisors.
- Read-only stages have no write scope.
- Proposals go under `.agy/artifacts/` and are not authoritative state.
- Do not bypass verifier/skeptic review or fabricate effect receipts.
