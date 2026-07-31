# oh-my-agy Architecture

OMA is an out-of-process orchestration and safety layer for Antigravity CLI
(`agy`). It does not replace the host and does not infer private host features.
The primary UX is in-session slash skills; the `oma`/`omy` binary adds durable
state, process control, team execution, repository workflows, and diagnostics.

## Entry paths

`bin/oma.ts` preserves three distinct paths:

1. **Structured CLI** — `autopilot`, `team`, setup/doctor, workflow/MCP/wiki/HUD,
   adapter status, resume/recovery, update/uninstall, parity, and production.
2. **Managed modes** — `oma ralph|ultrawork|search -- <task>` injects exact
   session ID, launch nonce, and generation.
3. **Ordinary pass-through** — unknown argv goes to `agy` after managed binding
   variables are stripped.

`src/cli/application.ts` owns routing. CLI services are adapters: authoritative
state machines stay in their domain modules.

## Runtime and continuation

`src/runtime/*` provides confined state-root selection, atomic writes, CAS state,
tokenized locks, process limits, redaction, tracking, and compaction. A stale
writer or owner loses by revision/generation mismatch. A circuit breaker marks
state `tripped` and preserves user work; it never runs destructive Git cleanup.

The packaged public plugin surface contains only **PreInvocation** and **Stop**.
Other lifecycle modules may provide product-owned helpers but are not advertised
as host hooks. Managed continuation is anchored by exact environment binding and
the durable session aggregate, not UI labels or a guessed current directory.

`src/continuation/resume.ts` selects an exact conversation target and builds the
literal `agy --conversation <id>` launch. `recovery.ts` copies a bounded immutable
suffix, reconstructs complete turns, and reports partial/broken/unknown data
without pretending the original chain is complete.

## Autopilot and team

`src/autopilot/*` implements the five-phase workflow:

`deep-interview → ralplan → ultragoal → code-review → ultraqa`

Transitions require evidence and expected-revision CAS. `src/team/*` implements
manifest validation, dependency scheduling, tmux/worktree workers, claim and
lease fencing, ordered mailboxes, liveness/reclaim, delivery, temporary
integration, and guarded fast-forward publication. Agent planning creates the
manifest; the CLI does not claim to perform LLM decomposition itself.

## Repository workflows

`src/workflows/*` is a product-owned `repository-workflow/v1` planning and
durable-journal engine:

- immutable name/version/digest registry;
- deterministic DAG and bounded parallel plan;
- per-stage capability mode, MCP allowlist, write scope, and artifacts;
- intent-before-effect journal and deterministic replay;
- bounded retries and `effect_unknown` reconciliation;
- independent skeptic/verifier gates and authenticated terminal `ship`/`no_ship`.

OMA provides T4 product authority without claiming host-signed identity. The
closed CLI executor observes distinct process/start identities, executes exact
verification argv without a shell, rereads artifacts/transcripts, and MACs the
full binding with a repository-external trust root. Generic adapters remain
`no_ship`; caller- or worker-minted approvals and digests cannot authorize.
Stage output is an exact product-validated artifact/verdict schema. Negative
verdicts and error findings fail closed, while production aggregation recaptures
and independently replays the definition, input, plan, journal, artifacts, and
verification transcripts before accepting `ship`.
The production workflow probe is CLI-only and non-injectable: it resolves and
validates the real `agy` host and standard-path installed plugin, binds the
current repository HEAD, rejects state/plugin/run environment overrides, and
uses the canonical external platform state root. Restrictive package exports
prevent consumers from importing workflow authority or production-evidence
internals. The authority receipt additionally binds the owner-installed
`~/.local/bin/agy` realpath, byte length, and SHA-256 from a stable descriptor;
an emulator that merely reproduces version/help output is insufficient.

`.agents/workflows/*.md` files are thin saved-prompt projections that delegate to
`oma workflow run`. They are not a second workflow engine.

## MCP, wiki, HUD, and adapters

- `src/mcp/*` exposes exactly six read/proposal operations over NDJSON JSON-RPC.
- `src/wiki/*` creates a deterministic bounded repository documentation index.
- `src/hud/*` renders redacted session/team/adapter projections and watch output.
- `src/native/*` probes only bounded public Antigravity surfaces and explicit
  contained configuration. One identity-bound `HostCapabilityProfile` records
  tri-state outcomes, evidence tiers/sources, fallbacks, and route receipts;
  version strings remain metadata rather than feature gates.
- `src/notify/*` provides owner-fenced terminal, tmux, and allowlisted HTTPS
  notifications; all are disabled until configured.

Native team/workflow/LSP/public-sidecar support stays unclaimed until the
profile carries sufficient fresh public evidence. Private sidecar/brain
internals are intentionally never probed. Offline fixtures and tests establish
implementation behavior, not live-host parity.

## Installation and release

`src/setup/*` validates installed identity, snapshots and removes a
registry-owned prior plugin before the Antigravity overlay install, performs
install/enable/list/exact-readback transactions, writes immutable ownership
receipts, updates to preverified package roots, and uninstalls only owned
inventory. Failed switches clear partial candidate bytes before restoring the
snapshot. `scripts/install.sh` supports local development, verified GitHub
assets, and offline tarball+checksum installation.

CI is deterministic and read-only. `oma production verify` is a separate
fail-closed live gate requiring fresh, exact-commit evidence across seven seams.
Publishing is a privileged external transaction; no npm registry channel is
currently claimed. See `docs/RELEASE.md`.

## Security invariants

- Use `spawn`/`spawnSync` argv arrays; never shell `exec`.
- Do not expose signing keys, generic signing, generic shell, or release authority.
- Confine runtime paths and reject symlink/path escapes.
- Keep workflow product writes proposal-only unless a frozen envelope declares a
  narrower owned path.
- Treat timeout and missing readback as unknown/failure, never success.
- Keep `AGENTS.md` protected and avoid destructive workspace rollback.

See `docs/security.md`, `docs/capabilities.md`, and `docs/workflows.md` for the
public contracts.
