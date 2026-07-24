# Capability Matrix

English | [简体中文](./capabilities.zh.md) | [繁體中文](./capabilities.zh-TW.md)

OMA separates product-owned capabilities from observations about Antigravity.
`T0` means unavailable or unobserved; `T1` means a public surface or saved
projection was observed. Neither tier implies a hidden native runtime.

| Surface | OMA implementation | Native claim | Command |
|---|---|---|---|
| Managed modes | Exact-env launch, durable state, safe process runner | Product-owned | `oma ralph -- …` |
| Autopilot | Five-phase FSM with CAS gates and evidence | Product-owned | `oma autopilot …` |
| Team | tmux/worktree workers, mailbox, fencing, delivery | Product-owned | `oma team …` |
| Repository workflows | Versioned DAG, exact verdict schema, exact parent verification, authenticated receipts, captured-evidence replay, enforced ship gate | Product-owned T4; product-authenticated, not host-signed | `oma workflow …` |
| Saved workflow prompt | Thin CLI delegate in `.agents/workflows/` | T1 projection only | `oma workflow native-status` |
| Public Antigravity CLI/plugins | Version and public help inspection | T1 when observed | `oma native-status` |
| Native team/workflow runtime | No fresh public proof | T0, unclaimed | `oma native-status` |
| Host semantic LSP | Registration readback only | T0 unless configured and observed | `oma lsp-status` |
| Private memory sidecar | Intentionally not probed | T0, forbidden | `oma sidecar-status` |
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
- UI labels and private files are not public capability evidence.
- Optional adapters stay disabled or unclaimed until explicitly configured.
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
