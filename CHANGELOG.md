# Changelog

All notable changes to **oh-my-agy (OMA)** are documented here.

Format inspired by [Keep a Changelog](https://keepachangelog.com/). Versions follow semver.

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

[0.3.0]: https://github.com/ImL1s/oh-my-agy/releases/tag/v0.3.0
[0.2.3]: https://github.com/ImL1s/oh-my-agy/releases/tag/v0.2.3
[0.2.2]: https://github.com/ImL1s/oh-my-agy/releases/tag/v0.2.2
[0.2.1]: https://github.com/ImL1s/oh-my-agy/releases/tag/v0.2.1
[0.2.0]: https://github.com/ImL1s/oh-my-agy/releases/tag/v0.2.0
