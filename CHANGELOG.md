# Changelog

All notable changes to **oh-my-agy (OMA)** are documented here.

Format inspired by [Keep a Changelog](https://keepachangelog.com/). Versions follow semver.

## [Unreleased]

## [0.5.0] — 2026-07-31

### Added

- **Identity-bound Antigravity capability negotiation:** `oma native
  capabilities [--json]`, explicit `oma native probe --live`, and passive `oma
  doctor --native` now share one tri-state `HostCapabilityProfile`. Evidence
  tiers/sources have policy ceilings; timeouts and identity drift remain
  unknown; caches and Team route receipts bind exact host/plugin identity.
  The native Team worker adapter remains deliberately unavailable and fails
  with `E_NATIVE_ADAPTER_UNAVAILABLE`; existing headless/tmux paths are explicit
  profile-routed fallbacks.
- **P0 OMX-shaped `oma team api <op> --input JSON [--json]`** over the existing
  TeamStateStore claim/mailbox aggregate (not full OMX 33-op parity). Shipped
  ops: `send-message`, `mailbox-list`, `mailbox-mark-delivered`, `create-task`,
  `list-tasks`, `claim-task`, `transition-task-status`, `release-task-claim`,
  `get-summary`, `write-worker-inbox`. State stays under OMA
  `{stateRoot}/repositories/…/teams/<id>/aggregate` (not `.omx/state/team/`).
  Ordered mailbox requires `claim_token`+`generation`; body digests verified on
  list; subject/description persisted on create-task. No leader/actor proof
  (documented). P1 backlog: broadcast, events, shutdown ack, cleanup, monitor
  snapshots, etc.

### Fixed

- Immutable Antigravity upgrades now remove the registry-owned previous plugin
  before installing the staged candidate, preventing same-name overlay installs
  from retaining stale files. Rollback clears partial candidate bytes before
  restoring the exact snapshot.
- Capability-authorized workflow routes now refresh exact host identity before
  every dependent batch, sample route time only after each probe finishes, and
  renew live evidence when a 30-second route receipt lacks five seconds of
  headroom.
- Live canary observations are stamped after completion, and the existing
  text-only 1.1.6 headless adapter no longer requires unused JSON output.
- When JSON is advertised, its optional canary now runs before the required
  exact-text worker canaries so optional probing cannot consume route-authority
  freshness or authorize a different output mode. Route authority now requires
  both the read-write `accept-edits` grammar in a disposable empty workspace and
  the final read-only `plan --sandbox` grammar with the product
  `--add-dir <repository>` mount. Both use the production worker argv builder.
- Bounded native probes now enforce the policy process-count ceiling as well as
  combined output and wall-clock limits. Process-tree scans are asynchronous
  and share the probe deadline. POSIX probes bind a pre-spawn PID baseline to
  a persistent parent-tree/process-group lineage keyed by PID plus process start
  marker, so observed detached descendants remain counted after the root exits
  without charging unrelated, reused, or zombie PIDs. The first snapshot also
  retains new PID-1-reparented baseline-delta candidates even while the root is
  alive, so rapid double-forks cannot escape before lineage is established;
  later unrelated processes are not adopted.
  Timeout/overflow termination covers
  the whole Windows process tree, and a fixed force-settle backstop
  prevents a detached descendant from holding inherited pipes open indefinitely.
- Model-bearing live canaries now use a 32-process cumulative lineage budget,
  allowing Antigravity's bounded MCP startup fan-out without weakening the
  passive help/version budget of 8.
- Bounded plugin-registry commands now terminate the owned POSIX process group
  or Windows descendant tree and destroy pipe readers at the settlement
  backstop, so a timed-out or oversized `agy plugin list` cannot leave an
  inherited-pipe orphan behind.
- Windows host identity lookup resolves `.exe` commands from a semicolon PATH
  and does not apply POSIX execute/ownership mode bits. Host, plugin, and route
  paths use the profile platform's absolute-path rules.
- Worker route-authority files enforce POSIX permission bits only on POSIX;
  Windows still validates type, bounds, containment, identity, and digest.

## [0.4.1] — 2026-07-24

### Fixed

- Host-launch no longer swallows ordinary `oma <agy-args…>` before the
  enforcer (circuit breaker / Sisyphus continuation). Host-launch is bare
  interactive plus explicit launcher flags (`--madmax` / `--yolo` / `--direct` /
  `--tmux`); other argv stays on the passthrough + todo path so e2e/CI green.
- Restore bare `oma help` / `oma version` passthrough to `agy` (only
  `--help`/`-h`/`--version`/`-v` use the structured oma help surface).

## [0.4.0] — 2026-07-24

Host-launch parity release (OMX/Sol).


### Changed

- **Host launch (OMX/Sol):** bare `oma` opens interactive `agy` at safe
  defaults; `oma --madmax` is break-glass consent that injects
  `--dangerously-skip-permissions` (no TTY `yes`). Bare `--yolo` still requires
  TTY confirmation or `--i-understand-dangerous-launch`. Transport policy:
  `OMA_LAUNCH_POLICY` / `--direct` / `--tmux` (last flag wins; explicit `--tmux`
  fails closed). Arguments after `--` are opaque. Ordinary non-launcher argv
  stays on enforcer passthrough. Legacy magic (`ralph` / `ultrawork` / `search`)
  and structured subcommands stay on their existing paths. Managed forms like
  `oma ralph --madmax -- …` remain rejected.
- Worker host pin refreshed to Antigravity CLI `1.1.6` (required help flags and
  `gemini-3.6-flash-high` model unchanged from the 1.1.5 contract).

### Fixed

- Install / bootstrap no longer exit `2` when post-install doctor only soft-warns
  (for example slash collision with OMC). A written receipt is treated as success;
  `oma doctor` still exits `2` for warnings when run on its own.

## [0.3.0] — 2026-07-23

### Added

- Immutable GitHub/offline installer paths with checksum verification,
  ownership receipts, update preflight, and receipt-aware uninstall.
- Versioned repository workflows with bounded parallel DAG execution,
  permission envelopes, durable journal replay, skeptic/verifier independence,
  and fail-closed `ship` / `no_ship` decisions.
- MCP server with six bounded read/proposal operations; deterministic wiki
  index/search; redacted HUD; owner-fenced notification adapters.
- Public capability commands: `native-status`, `lsp-status`,
  `sidecar-status`, and `workflow native-status`, with explicit T0/T1 claims.
- Exact conversation `resume`, bounded immutable transcript `recovery`,
  read-only parity/composition verification, and `production verify`.
- Managed team/runtime hardening for Antigravity 1.1.5, worker envelopes,
  mailbox/control-plane fencing, lifecycle hooks, compaction, and redaction.

### Fixed

- Live-host worker dispatch, fixed across seams that only a real Antigravity
  1.1.5 session exposes: `--print`/`--prompt-interactive` take the prompt as
  their immediate value; the repository is mounted into the worker workspace
  with `--add-dir`; the model is pinned to a current `agy models` id
  (`gemini-3.6-flash-high`) instead of agy's ambient default (a retired default
  such as `gemini-2.5-pro` fails every worker with "Agent execution terminated
  due to error"); worker stdout is parsed as the last balanced JSON object
  (live sessions narrate before the answer) with explicit duplicate-key
  rejection; stage budgets are 300s; and the workflow probe scratch dir is
  realpath'd for macOS `/tmp` symlinks.
- `production probe plugin-discovery` binds `installed_version` to the observed
  public CLI version; the packaged workflow definition is stored in canonical
  bytes so the probe's canonical-JSON read admits it. The fresh-session canary
  tolerates agy 1.1.5's trailing double newline and pins its model.
- Bounded processes force-settle after the deadline even when an agy grandchild
  holds the inherited stdout/stderr pipe open, so `boundedHeadless` can no
  longer hang past its bound; version/help probe timeouts widened (2s/5s → 15s)
  for fork+exec under host memory pressure.
- Workflow stages clean their proposal root before every attempt (idempotent
  against a stale proposal) and carry a retry budget so a single transient agy
  turn does not fail the whole DAG.

Full seven-seam `oma production verify` (installed plugin discovery, managed
lifecycle, exact resume, interactive/headless worker, MCP+LSP status,
workflow DAG replay/review, independent review + UltraQA) passes on a real
Antigravity 1.1.5 host for this release.

### Changed

- Public manifests and package surface are synchronized at `0.3.0` and include
  `.mcp.json`, the workflow skill/saved prompt, installer, and workflow fixture.
- Release CI is verification-only with read permissions. Publishing and exact
  external readback remain a separate privileged transaction.
- Registry claims were removed: no npmjs.org or GitHub Packages channel is
  currently advertised.

### Security

- Production verification requires fresh evidence bound to the exact Git OID
  across seven live seams and fails closed with `E_PRODUCTION_EVIDENCE`.
- Workflow writes are proposal-only; private memory/sidecar surfaces are not
  probed or inferred; partial recovery preserves broken-chain and unknown-record
  warnings.
- Diagnostic redaction also matches JSON-string secret shapes
  (`"password":"…"` and the rest of the sensitive-name list), so secrets in
  stringified JSON no longer pass through `redactDiagnostic`/`assertRedacted`.
- Known boundary: the experimental team worker loop validates envelopes by
  schema and mailbox generation/digest fencing; forged-completion rejection is
  owned by the CLI host claim CAS. The loop is not wired into production
  orchestration paths in this release.

## [0.2.3] — 2026-07-21

### Fixed

- **Default `oma setup` no longer hard-fails on agy** before installing Claude/Grok slash hosts; only `--host agy` fails closed on agy errors.
- **Doctor** treats missing `agy` as **warn** (optional for slash-first), not fail.
- **Host CLI adapter** for unit tests — no real `claude`/`grok` spawn side effects.
- Slash step **timeouts** (`failed`) cause setup **exit 1**; `needs_manual` remains soft success.
- Skill symlink replace limited to this package’s `skills/` targets; foreign symlinks preserved.
- Doctor slash-first heuristic requires in-session hard markers (not bare word `slash`).
- Grok / Claude **already installed** treated as setup success.

### Documentation

- README dual-host slash table: agy bare `/autopilot` vs Claude/Grok `/oh-my-agy:autopilot`.
- `docs/npm-publishing.md` updated to v0.2.3 install paths.
- Version sync across `package.json`, `plugin.json`, `.claude-plugin/plugin.json`.

### Verified

- Unit suite green (host-install mock paths + doctor slash checks).
- Live **agy** session: `/autopilot` loads OMA skill at  
  `~/.gemini/config/plugins/oh-my-agy/skills/autopilot/SKILL.md` (five-phase OMX loop).

## [0.2.2] — 2026-07-21

### Added

- **Slash-first primary UX**: session skills for autopilot / OMX five-phase set.
- **Claude Code** surface: `.claude-plugin/plugin.json` + `marketplace.json`.
- **Multi-host setup**: `oma setup --host all|agy|claude|grok`.
- **Doctor**: Claude manifest, slash skill surface, OMC bare `/autopilot` collision warn, `.claude-plugin` version sync.
- Absolute project skill symlinks; install.sh / README slash-first quick start.
- In-session rewrite of workflow `skills/*/SKILL.md` (CLI moved to appendices).

### Changed

- Package version **0.2.2**; description emphasizes session slash + optional CLI ledger.

## [0.2.1] — 2026-07-20

### Added

- Ship as **`@iml1s/oh-my-agy`** on GitHub Packages + Release tarball.
- OMX five-phase autopilot FSM + session skill discovery.
- npm publishing blockers documented (`docs/npm-publishing.md`).

## [0.2.0] — 2026-07-20

### Added

- Session skill surface aligned with OMC/OMX workflows.
- Team / autopilot foundations as shipped on `v0.2.0`.

---

[0.5.0]: https://github.com/ImL1s/oh-my-agy/releases/tag/v0.5.0
[0.4.1]: https://github.com/ImL1s/oh-my-agy/releases/tag/v0.4.1
[0.4.0]: https://github.com/ImL1s/oh-my-agy/releases/tag/v0.4.0
[0.3.0]: https://github.com/ImL1s/oh-my-agy/releases/tag/v0.3.0
[0.2.3]: https://github.com/ImL1s/oh-my-agy/releases/tag/v0.2.3
[0.2.2]: https://github.com/ImL1s/oh-my-agy/releases/tag/v0.2.2
[0.2.1]: https://github.com/ImL1s/oh-my-agy/releases/tag/v0.2.1
[0.2.0]: https://github.com/ImL1s/oh-my-agy/releases/tag/v0.2.0
