# Security Model

English | [简体中文](./security.zh.md) | [繁體中文](./security.zh-TW.md)

## Authority boundaries

OMA uses an external per-user state root for authoritative aggregates and keeps
repository-local `.agy/` content to plans, workflow definitions/runs, recovery
copies, and proposal artifacts. State updates use revision/generation checks;
stale owners cannot silently overwrite newer state.

Managed launches require exact session ID, launch nonce, and invocation
generation. Ordinary `agy` pass-through strips those variables. Nonces and
destinations are fingerprinted or redacted in diagnostics.

## Process and filesystem safety

- External commands use `spawn`/`spawnSync` with argv arrays, never shell `exec`.
- Dangerous `--madmax`/`--yolo` launches require explicit confirmation.
- Circuit breakers never run `git reset --hard` or `git clean -fd`.
- Worktree/team operations use leases, claim tokens, generations, and
  delivery-scope validation.
- `oma team api` is a thin OMX-shaped CLI over the same TeamStateStore
  (P0 mailbox/claim subset). It is not a sandbox and is not full OMX
  33-op parity; state remains under the OMA aggregate path, not
  `.omx/state/team/`. **There is no leader/actor proof** — any process
  with access to the state root can invoke it (fail-open authority for
  actor identity; aggregate updates remain CAS-fenced by revision).
  Ordered mailbox traffic requires `claim_token` + `generation` (partial
  fencing is rejected). Unfenced `mailbox-list` / `mailbox-mark-delivered`
  only covers unordered messages (no `sequence`).
- Runtime files are confined beneath canonical roots; symlink escapes and
  mutable replacements are rejected where contracts require immutability.
- Install/update/uninstall operations are receipt-bound and ownership-aware.

## Workflow and MCP permissions

Repository workflows compile every stage into a frozen permission envelope.
Read-only stages receive no write paths; product writes are proposal-only;
external effects without a reconciled receipt become `effect_unknown`.
Nested supervisors and worker release authority are forbidden.

The MCP server exposes a fixed allowlist of read operations plus immutable
proposal creation. It is not a command execution proxy.

## Recovery and notifications

`oma recovery` reads an immutable, bounded suffix copy and reports partial
recovery honestly. It preserves warnings such as `W_BROKEN_CHAIN`,
`W_UNKNOWN_RECORD_TYPE`, and `W_PARTIAL_RECOVERY`; the prompt is emitted only
with `--include-prompt`.

Notifications are disabled by default. Test dispatch requires matching owner
ID, owner nonce, and generation. HTTPS targets are host-allowlisted and reject
non-public destinations; status output never prints secrets.

## Release safety

CI and release verification run with read-only GitHub permissions. Publication
is a separate privileged transaction with exact byte, tag, asset, and readback
proof. `oma production verify` rejects absent, stale, skipped, or wrong-commit
live evidence. Parity CLI routes are verification-only; signing keys and state
transitions are not exposed as general commands.

Report vulnerabilities privately to the repository owner; do not include live
credentials, nonces, or private transcript contents in an issue.
