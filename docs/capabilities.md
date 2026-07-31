# Capability Matrix

English | [简体中文](./capabilities.zh.md) | [繁體中文](./capabilities.zh-TW.md)

OMA separates product-owned capabilities from observations about Antigravity.
Host observations now use the versioned `HostCapabilityProfile` and evidence
tiers `configured → installed → enabled → loadable → observed → healthy →
verified`. Repository-workflow `T0…T5` remains a separate product contract; it
must not be used as native-host evidence.

| Surface | OMA implementation | Native claim | Command |
|---|---|---|---|
| Managed modes | Exact-env launch, durable state, safe process runner | Product-owned | `oma ralph -- …` |
| Autopilot | Five-phase FSM with CAS gates and evidence | Product-owned | `oma autopilot …` |
| Team | tmux/worktree workers, mailbox, fencing, delivery | Product-owned | `oma team …` |
| Repository workflows | Versioned DAG, exact verdict schema, exact parent verification, authenticated receipts, captured-evidence replay, enforced ship gate | Product-owned T4; product-authenticated, not host-signed | `oma workflow …` |
| Saved workflow prompt | Thin CLI delegate in `.agents/workflows/` | T1 projection only | `oma workflow native-status` |
| Host capability negotiation | Identity-bound tri-state profile, policy ceilings, cache, route candidates/receipts | Product-owned truth/routing layer; each native claim is assessed separately | `oma native capabilities` |
| Public Antigravity CLI/plugins | Passive help/config/plugin readback | At most the source-specific evidence ceiling; never verified from version/help alone | `oma native capabilities --json` |
| Public hooks, custom agents, headless, sidecars, UI, conversations, projects, permissions, model/effort, MCP | Canonical profile keys with explicit fallbacks | `supported`, `unsupported`, or `unknown` at the recorded tier/source | `oma native capabilities` / `oma native probe --live` |
| Native Team worker adapter | Profile-routed boundary exists; adapter is not implemented in Issue #3 | Fails closed with `E_NATIVE_ADAPTER_UNAVAILABLE` before bootstrap | `oma team …` |
| Headless/tmux Team fallback | Existing OMA adapters selected through profile-bound routing receipts; headless consumes verified text `--print` directly | Product-owned fallback, not proof of a native Team adapter | `oma team …` |
| Host semantic LSP | Compatibility status projection only | Not a native/fallback routing authority | `oma lsp-status` |
| Private memory sidecar/brain internals | Intentionally never probed | Forbidden | `oma sidecar-status` |
| HUD | Redacted state/adapters projection | Product-owned | `oma hud --json` |
| Wiki | Deterministic repository docs/provenance index | Product-owned | `oma wiki …` |
| Notifications | Owner-fenced terminal/tmux/HTTPS adapters | Product-owned, opt-in | `oma notify …` |
| Resume/recovery | Exact conversation resume plus bounded partial recovery | Product-owned | `oma resume`, `oma recovery` |

## MCP surface

`.mcp.json` launches `oma mcp-server`. It exposes exactly six operations:

- `run_status.read`
- `recovery_manifest.read`
- `wiki.search`
- `team_status.read`
- `mailbox.list`
- `proposal.create`

There is no generic shell, filesystem-write, publish, or secret-reading tool.
`proposal.create` writes only immutable proposal artifacts under
`.agy/artifacts/`; it cannot mutate authoritative state.

## Truth rules

- A configured file is not fresh-session discovery.
- Version strings are metadata and cache identity, not feature gates.
- Timeout, parse failure, contradictory/stale evidence, or identity drift is
  `unknown`; it is neither unsupported nor success.
- Native probe policy enforces wall-clock, combined-output, and process-count
  limits. A process-tree overflow or unavailable counter cannot yield verified
  evidence. Process-tree inspection is non-blocking and deadline-bound, and
  timeout cleanup has a bounded force-settle backstop.
- `supported: true` is a compatibility projection. Routing additionally
  requires the policy's minimum tier and a valid identity-bound candidate or
  receipt.
- UI labels and private files are not public capability evidence.
- Optional adapters stay disabled or unclaimed until explicitly configured.
- `oma native capabilities` and `oma doctor --native` are passive. Only
  `oma native probe --live` opts in; v1 verifies the exact-text worker route and
  separately verifies structured JSON when advertised. Every other side-effect
  domain remains explicitly indeterminate.
- Offline fixtures and tests prove implementation behavior, not live-host
  parity. See [Native capability negotiation](./native-capabilities.md).
- `oma production verify` is the authority for the `production_verified`
  claim; ordinary unit tests establish implementation evidence only.
- Workflow production evidence is created only by
  `oma production probe workflow` with canonical host, plugin, repository, and
  repository-external state-root resolution. Host authority binds the canonical
  installed `agy` realpath, byte length, and SHA-256—not only its reported
  version/help output. Package consumers cannot import internal workflow
  authority or production-evidence modules. Product execution exists only as a
  non-exported CLI closure; every emitted workflow module has an exact export
  allowlist and exposes neither an executor, dispatcher, nor authority factory.
  The importable generic runner is permanently advisory and dispatches zero
  tasks, even if package code reads the receipt key and recreates an old
  structural marker.
