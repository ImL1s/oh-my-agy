# oh-my-agy (OMA / OMY)

<p align="center">
  <img src="assets/oma-character.png" alt="oh-my-agy character" width="300">
  <br>
  <em>Start Antigravity stronger — then let OMA own managed modes, exact-env binding, and continuation.</em>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License: MIT">
  <img src="https://img.shields.io/badge/node-%3E%3D20-brightgreen" alt="Node.js 20+">
  <img src="https://img.shields.io/badge/host-Antigravity%20CLI-black" alt="Antigravity CLI">
  <img src="https://img.shields.io/badge/hooks-PreInvocation%20%2B%20Stop-blue" alt="hooks">
</p>

English | [简体中文](docs/readme/README.zh.md) | [繁體中文](docs/readme/README.zh-TW.md)

**Orchestration layer for Google Antigravity CLI (`agy`).**  
Sibling of [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) (OMC), [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) (OMX), [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (OmO), and [oh-my-grok](https://github.com/ImL1s/oh-my-grok) (OMG) — same *orchestration idea*, **Antigravity-native** runtime.

_Don't learn every `agy` flag. Prefer **in-session slash skills** (`/autopilot` on agy, `/oh-my-agy:autopilot` on Claude/Grok). Optional `oma` / `omy` CLI binds managed modes and durable ledger when you need them._

> **Session-first (primary):** After `oma setup`, restart the host and run slash skills in-session. On **Antigravity (`agy`)** the plugin skill is bare **`/autopilot`**. On **Claude Code / Grok** use namespaced **`/oh-my-agy:autopilot`** so OMC can keep bare `/autopilot`.  
> **CLI (secondary):** `oma ralph|ultrawork|search|autopilot|team` for managed exact_env / durable FSM. Skill bodies stay the source of truth for the loop.

> **Unofficial.** Not affiliated with Google / Antigravity. Requires a working, authenticated `agy` on your `PATH` for managed hooks.

---

## Mental model

OMA does **not** replace Antigravity.

| Layer | Job |
|-------|-----|
| **`agy`** | Agent work (TUI, tools, conversation) |
| **Plugin + hooks** | `PreInvocation` / `Stop` lifecycle entrypoints |
| **`oma` CLI** | Managed modes, Autopilot FSM, Team, setup |
| **Session skills** | Plugin `skills/*` workflows (autopilot/ralph/ultrawork/…) — **in-session** protocol (OMC/OMX-style) |
| **State root** | Session aggregate, binding, processedStops (owner-only) |

| Component | Role |
|-----------|------|
| **Plugin** | `plugin.json` + `hooks.json` (PreInvocation, Stop only) |
| **Workspace hooks** | Optional `.agents/hooks.json` for project-local host load |
| **`oma` / `omy`** | Same binary → managed launch / autopilot / team / pass-through |

---

## Quick start

### Primary UX (in-session slash)

After install, **restart the host session** and type:

| Host | Canonical slash |
|------|-----------------|
| **Antigravity (`agy`)** | `/autopilot <goal>` (oh-my-agy plugin skill) |
| **Claude Code / Grok** | `/oh-my-agy:autopilot <goal>` (namespaced; coexist with OMC bare `/autopilot`) |

```text
# agy session
/autopilot <your goal>

# Claude Code / Grok session
/oh-my-agy:autopilot <your goal>
```

Also: `ralph`, `ultrawork`, `team`, … (bare on agy; `/oh-my-agy:…` on Claude/Grok).

### One-shot install (clone)

```bash
git clone https://github.com/ImL1s/oh-my-agy.git
cd oh-my-agy
./scripts/install.sh
# build + PATH + oma setup (agy plugin + Claude/Grok slash surface)
oma doctor --no-strict-plugin
# restart host, then:
#   agy:     /autopilot …
#   Claude/Grok: /oh-my-agy:autopilot …
```

### Optional: Antigravity managed CLI ledger

**Requirements:** Node **20+** · `agy` on `PATH` (for managed modes / hooks)

```bash
npm ci && npm run build
ln -sf "$(pwd)/dist/bin/oma.js" ~/.local/bin/oma
oma setup                    # agy plugin + Claude/Grok slash surface
oma setup --host claude      # slash only (no agy hard-fail)
oma setup --host agy         # agy plugin only
oma setup --host all         # same as default; agy fail continues slash install
oma autopilot start -- "…"   # durable SessionAggregate (optional)
```

Optional project-local hooks (some hosts load `.agents/hooks.json` more reliably):

```text
.agents/hooks.json → node "../dist/src/hooks/{pre-invocation,stop}.js"
```

Smoke:

```bash
oma --help
oma ralph -- "Reply with exactly one word: pong"
```

### Verified release install

Registry publication is **not configured**: do not install the unrelated
unscoped `oh-my-agy` package from npmjs.org, and do not assume `@iml1s/oh-my-agy`
exists in a registry. Install from the GitHub Release, which carries both the
package tarball and `SHA256SUMS`.

Convenient one-liner (latest verified release is `v0.5.2`):

```bash
curl -fsSL https://raw.githubusercontent.com/ImL1s/oh-my-agy/main/scripts/install.sh \
  | bash -s -- --github --tag v0.5.2
```

Manual / reproducible options:

```bash
# Download the installer first, then resolve the pinned release.
curl -fsSLo /tmp/oma-install.sh \
  https://raw.githubusercontent.com/ImL1s/oh-my-agy/main/scripts/install.sh
bash /tmp/oma-install.sh --github --tag v0.5.2

# Fully offline: verify + install the exact files, no network/npm/build step.
bash /tmp/oma-install.sh \
  --asset ./iml1s-oh-my-agy-0.5.2.tgz \
  --checksums ./SHA256SUMS
```

Release bytes are checksum-verified before activation. The installer writes an
immutable receipt used by ownership-aware `oma update` and `oma uninstall`.
See [Release and installation](docs/RELEASE.md) and
[registry policy](docs/npm-publishing.md).

---

## Recommended default flow

When the task is non-trivial (**session-first**):

```text
1. Install once: ./scripts/install.sh   # or: oma setup
2. Restart agy / Claude Code / Grok
3. /autopilot <goal>   (agy)  or  /oh-my-agy:autopilot <goal>  (Claude/Grok)
4. Stay in-session; write artifacts under .agy/
5. Optional durable ledger (cross-session): oma autopilot start|drive|…
```

**OMX-aligned Autopilot phases:** `deep-interview → ralplan → ultragoal → code-review → ultraqa`  
Discover skills: host slash menu, or `oma skill list` / `oma skill show autopilot`.

| If you need… | Use |
|--------------|-----|
| Full autonomous delivery | `/autopilot` (agy) or `/oh-my-agy:autopilot` (Claude/Grok) |
| Persistent single-task loop | `/oh-my-agy:ralph` or `oma ralph -- "…"` |
| Parallel / high-throughput | `/oh-my-agy:ultrawork` or `oma ultrawork -- "…"` |
| Read-only plan-style launch | `oma search -- "…"` |
| Durable Autopilot FSM | `oma autopilot start / status / checkpoint / resume` |
| Multi-agent first worker (v1) | `oma native probe --live`, then `oma team start --manifest … --worker-mode headless` |
| Team mailbox / claim API (P0) | `oma team api <op> --input JSON` (subset of OMX ops) |
| Team fork resolution | `oma team resolve-fork …` |
| Versioned repository review | `oma workflow install`, then `oma workflow run …` |
| MCP read/proposal tools | configure [`.mcp.json`](.mcp.json) or run `oma mcp-server` |
| State overview | `oma hud --json` (optionally `--watch`) |
| Docs index | `oma wiki index`, then `oma wiki search <query>` |
| Honest host capability view | `oma native capabilities` (passive) / `oma native probe --live` (opt-in) |
| Exact continuation / bounded recovery | `oma resume …` / `oma recovery …` |
| Ordinary `agy` | `oma <agy args…>` (pass-through; strips managed binding env) |

**Hook fired ≠ task complete.** First Stop may `continue`; trip after no-progress streak; do not treat fail-open `allow` as success.

---

## Commands

```bash
oma --help
# Managed exact_env (recommended — note the -- delimiter)
oma ralph -- <task>
oma ultrawork -- <task>
oma search -- <read-only query>

oma autopilot start -- <goal>
oma autopilot status --session <id>
oma autopilot checkpoint --session <id> --expected-revision <n> --evidence <file>
oma autopilot resume --session <id> --conversation <id> --expected-revision <n>
  # ledger-only binding update (no spawn)
oma autopilot drive --session <id> --conversation <id> --expected-revision <n>
  # ledger bind + managed agy spawn via resumeConversation (requires prior exact_env bind)
oma autopilot cancel --session <id> --expected-revision <n> --reason <text>
oma autopilot doctor --session <id>
oma autopilot review|qa|reset-breaker …   # see oma --help

oma team start --manifest <file> [--worker-mode interactive|headless] [--max-parallel <n>]
  # Ready tasks (deps completed) up to max-parallel; managed worktree + tmux + agy bootstrap.
oma team status --team <id>
oma team stop --team <id>
oma team supervise --team <id>
oma team reclaim --team <id> --task <id> --expected-revision <n> --pane dead --process dead
oma team deliver --team <id> --task <id> --expected-revision <n> --claim-token <tok> --generation <n> --worktree <path>
oma team tick --team <id> [--max-parallel <n>]
oma team api <op> --input '{"team_name":"<id>",…}' [--json]
  # P0 only (not full OMX): send-message, mailbox-list, mailbox-mark-delivered,
  # create-task, list-tasks, claim-task, transition-task-status, release-task-claim,
  # get-summary, write-worker-inbox
  # No leader/actor proof — any process with state-root access can call (CAS-fenced state).
oma team resolve-fork --team <id> --fork <id> --winner-generation <n> --expected-revision <n> --evidence <file>

oma workflow install [--source <repository-workflow-v1.json>]
oma workflow list|native-status
oma workflow run <name> --input <input.json> [--version <semver>] [--generation <n>]
oma workflow status|replay --run <run-id>
oma mcp-server
oma wiki index|list|search <query> [--limit <1..50>]
oma hud [--json] [--watch] [--preset minimal|focused|full] [--session <id> --workspace-key <key>]
oma native capabilities [--json]
oma native probe --live [--json]
oma native-status | lsp-status | sidecar-status
oma notify status|test …
oma resume --session <id> --conversation <id> --expected-revision <n>
oma recovery --source <transcript.jsonl> [--include-prompt]
oma update [--release] …
oma uninstall --receipt <receipt.json> [--project-state <.agy>] [--purge]
oma parity verify-composition --run-id <id> --aggregate <aggregate-handoff.json>
oma production verify [--run-id <id>]
oma production probe <seam> [--run-id <id>]
oma production capture <review|ultraqa> [--run-id <id>] -- <allowlisted-cli> …

oma setup
oma doctor [--json] [--no-strict-plugin] [--native]
oma <agy args...>   # pass-through (strips managed binding env)
```

Bins after build: `oma`, `omy` → `dist/bin/oma.js`.

`oma doctor` checks Node ≥20, `dist` hooks, `package.json`/`plugin.json` version sync, `agy` on PATH, state root, and plugin installed+enabled (fail-closed by default). `oma doctor --native` adds passive, identity-bound capability diagnostics; it never runs live probes.

### Native capability evidence

`oma native capabilities` reports the versioned `HostCapabilityProfile` used by
native/fallback routing. It distinguishes `supported`, `unsupported`, and
`unknown`, records evidence tier/source plus an explicit fallback, and binds the
cache to the exact `agy` and installed-plugin identities. Version strings are
metadata, not feature gates. Timeouts, parse errors, stale evidence, or identity
drift stay `unknown` and fail closed.

`oma native probe --live` is an explicit opt-in; v1 runs bounded public
headless JSON/read-write/read-only canaries and records every other side-effect
domain as explicitly unavailable/indeterminate. Live model canaries use a fixed
32-process cumulative lineage budget for Antigravity's MCP startup fan-out;
passive help/version inspection remains capped at 8.
Ordinary capability display and `oma doctor --native` are passive. Offline
fixtures, help text, docs, and green tests prove implementation behavior; this
does not prove live host parity. See
[Native capability negotiation](docs/native-capabilities.md).

### Dual entry paths (read this)

| Invocation | Path | Binding |
|------------|------|---------|
| `oma ralph -- "task"` | **Managed** (structured CLI) | Injects `OMA_*` exact_env |
| `oma ralph task` (no `--`) | **Legacy magic** (e2e / keyword intercept) | No exact_env; strips ambient binding |
| `oma models list` / other | **Pass-through** | Strips managed binding env |

Prefer the **`--` managed form** for production continuation.

---

## Hooks (authoritative surface)

Only **PreInvocation** and **Stop** (no PreToolUse/PostToolUse in the package surface).

| Event | Job |
|-------|-----|
| **PreInvocation** | exact_env bind (`OMA_SESSION_ID` + launch nonce + generation) → SessionLocator |
| **Stop** | ProgressOracle continue/allow; durable `processedStops`; exact-env re-check |

Managed launch injects:

- `OMA_SESSION_ID` / `OMA_LAUNCH_NONCE` / `OMA_INVOCATION_GENERATION`
- `OMA_STATE_ROOT` / `OMA_PACKAGE_ROOT` / `OMA_WORKSPACE_PATH`

Host workspace identity prefers **`workspacePaths` / `OMA_WORKSPACE_PATH`** — hook cwd is the directory containing `hooks.json` (often `.agents/`), not the repo root.

Live host Antigravity 1.1.4 often sends `terminationReason: NO_TOOL_CALL` for normal idle stops; the oracle treat that as eligible (alongside `model_stop`).

---

## Safety

- Circuit breaker never runs `git reset --hard` / `git clean -fd`.
- Managed binding requires exact env; ordinary pass-through strips binding env.
- Launch nonce is capability material — debug logs store fingerprint only, not plaintext.
- Workflow workers receive frozen permission envelopes; repository writes are proposal-only.
- MCP exposes six bounded read/proposal operations, never a generic command runner.
- Transcript recovery is explicitly partial and preserves broken-chain / unknown-record warnings.
- Native workflow/team/LSP/public-sidecar claims remain unclaimed until the
  capability profile carries sufficient fresh public evidence; private
  sidecar/brain internals are never probed.
- `oma production verify` reads only canonical product-owned receipts and fails
  closed without fresh, commit-bound evidence for every live seam.
- `oma production probe <seam>` derives claims from actual product/host
  behavior; `capture review|ultraqa` executes only an allowlisted independent
  CLI and records bounded transcripts. Caller-supplied claim JSON and evidence
  paths are never trusted.
- Do not modify `AGENTS.md` without an intentional merge policy.
- **Dangerous launch gate / host launch:** bare `oma` launches interactive `agy`
  (tmux when eligible). Top-level `--madmax` is explicit consent (no TTY `yes`);
  OMA strips the wrapper token and injects Antigravity
  `--dangerously-skip-permissions`. Bare `--yolo` still requires TTY confirmation
  (`yes`) or `--i-understand-dangerous-launch` (stripped before forward). Launch
  policy: `OMA_LAUNCH_POLICY` / `--direct` / `--tmux`. Managed form
  `oma ralph --madmax -- task` is **rejected** (no silent drop of tokens before
  `--`). Legacy magic keywords remain intercepted.

---

## Troubleshooting

OMA failures are usually **fail-closed** or **silent fail-open**, so the error
text often does not include the fix. Start with `oma doctor`. This release does
**not** ship `oma hooks status` — do not treat that as a diagnostic command.

| Symptom | Diagnose | Fix |
|---------|----------|-----|
| Hooks never fire | `oma doctor` (plugin installed+enabled). Check `DISABLE_OMA` / `OMA_SKIP_HOOKS`. With `OMA_HOOK_DEBUG=1` and `OMA_STATE_ROOT` set, inspect `<state-root>/logs/hook-debug.jsonl`. | `oma setup`, then **restart the host**. Plugin install is only half the surface. Unset kill-switch env. Optional project-local `.agents/hooks.json`. |
| `E_PLUGIN_NOT_ACTIVE` (installed but not enabled) | `oma doctor` / `oma doctor --json` — look for `plugin is installed but not enabled` or registry absent. | `oma setup`. Confirm with `oma doctor`. Slash-only hosts may use `oma doctor --no-strict-plugin` (plugin check becomes warn). |
| Slash skill missing after `oma setup` | `oma skill list`; `oma doctor` checks `slash_skills` and `slash_collision`. | Restart the host session. On Claude/Grok use `/oh-my-agy:autopilot` (OMC may own bare `/autopilot`). Re-run `oma setup --host claude` or `--host grok`. |
| Legacy magic (`oma ralph task`, no `--`) prints a mode banner then silence | Non-TTY (CI) ignores child stdio unless `OMA_LEGACY_STDIO=inherit`. | Prefer managed `oma ralph -- "task"`. Interactive TTY inherits by default; override with `OMA_LEGACY_STDIO=inherit` or `ignore`. |

### Environment variables

Operator-facing env only. Binding env (`OMA_SESSION_ID`, `OMA_LAUNCH_NONCE`, …)
is injected by managed launch — do not set it by hand.

There is no `OMA_STATE_DIR`; the shipped name is `OMA_STATE_ROOT`.

| Variable | Default | Effect |
|----------|---------|--------|
| `DISABLE_OMA` | unset (off) | `1` or `true` (case-insensitive) disables **all** Antigravity hooks. Suppressed PreInvocation/Stop return `allow` with empty `injectSteps` and exit 0; they do not resolve workspace or create a state root. |
| `OMA_SKIP_HOOKS` | unset | Comma-separated logical names to skip: `pre-invocation`, `stop`, `session-start`, `post-invocation` (whitespace and case ignored). |
| `OMA_HOOK_DEBUG` | unset (off) | `1` or `true` appends redacted diagnostics to `<OMA_STATE_ROOT>/logs/hook-debug.jsonl` (bounded 1 MiB). Off by default; never writes into the install directory. No-ops if `OMA_STATE_ROOT` is unset. |
| `OMA_LEGACY_STDIO` | TTY-gated | Legacy magic spawn stdio. Unset: `inherit` on TTY, `ignore` otherwise. Explicit `inherit` or `ignore` overrides; unknown values fall back to the TTY gate. |
| `OMA_TIMEOUT_MS` | path-specific | Positive milliseconds. Bounded headless (`oma search --`, or any managed mode with `OMA_MANAGED_HEADLESS=1`): default `3600000`. Default `oma ralph --` is interactive and ignores this unless that env is set. Autopilot `drive` bounded spawn: default `30000`. Legacy pass-through: no timeout unless set. |
| `OMA_LAUNCH_POLICY` | `auto` | Bare host-launch transport: `auto`, `direct`, `tmux`, or `detached-tmux` (the last maps to `tmux`). CLI `--direct` / `--tmux` override (last flag wins). |
| `OMA_STATE_ROOT` | platform default | Durable state root (session aggregate, hook debug log). macOS: `~/Library/Application Support/oh-my-agy/state`. Windows: `%LOCALAPPDATA%/oh-my-agy/state`. Else `${XDG_STATE_HOME:-~/.local/state}/oh-my-agy`. |

---

## Tests / CI / release

```bash
npm run build
npm run test:unit
npm run test:e2e
npm run test:package
npm run smoke
npm run test:production    # intentionally fails without fresh live evidence
```

| Surface | What |
|---------|------|
| **CI** | `.github/workflows/ci.yml` — Node 20/22 build + unit + pack smoke; e2e with mock `agy` |
| **Release verification** | `.github/workflows/release.yml` — read-only build/test/package/readback; verifies the live production gate fails closed without evidence; does **not** publish |
| **Install script** | `./scripts/install.sh` |
| **Release procedure** | [docs/RELEASE.md](docs/RELEASE.md) — candidate, live evidence, external publication, and readback boundaries |
| **Registry policy** | [docs/npm-publishing.md](docs/npm-publishing.md) — no configured registry channel |

Tag example:

```bash
# Only after deterministic checks, live evidence, independent review, and UltraQA pass.
# Tag must match package.json / plugin.json / .claude-plugin version.
git tag -a v0.5.2 -m "v0.5.2"
git push origin v0.5.2
```

Changelog: **[CHANGELOG.md](CHANGELOG.md)**.  
Tagging does not publish artifacts in this repository workflow. GitHub Release
creation/upload and exact readback are separate, privileged operations. No npm
registry channel is currently claimed.

---

## Sibling projects

| Project | Host | Alias |
|---------|------|-------|
| [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) | Claude Code | OMC |
| [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) | OpenAI Codex CLI | OMX |
| [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) | OpenCode | OmO |
| [oh-my-grok](https://github.com/ImL1s/oh-my-grok) | Grok Build | OMG |
| **oh-my-agy** (this repo) | Antigravity CLI | **OMA** |

Same family idea: **better workflow around a host agent**, not a replacement agent.

---

## Contributing and security

- [Contributing](CONTRIBUTING.md) — dev setup, local gates, ground rules.
- [Security policy](SECURITY.md) and the [security model](docs/security.md) —
  isolation boundaries and private vulnerability reporting.
- [Code of Conduct](CODE_OF_CONDUCT.md).

## Languages

| Language | README |
| --- | --- |
| English | [README.md](./README.md) |
| 简体中文 | [docs/readme/README.zh.md](docs/readme/README.zh.md) |
| 繁體中文 | [docs/readme/README.zh-TW.md](docs/readme/README.zh-TW.md) |

Translation index and maintenance rules: [docs/readme/README.md](docs/readme/README.md).

## License

[MIT](./LICENSE) — see the `LICENSE` file in the repository root.
