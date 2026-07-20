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

**Orchestration layer for Google Antigravity CLI (`agy`).**  
Sibling of [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) (OMC), [oh-my-codex](https://github.com/Yeachan-Heo/oh-my-codex) (OMX), [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) (OmO), and [oh-my-grok](https://github.com/ImL1s/oh-my-grok) (OMG) — same *orchestration idea*, **Antigravity-native** runtime.

_Don't learn every `agy` flag. Use `oma` / `omy`: launch managed → bind exact_env → Stop continue until progress or trip._

> **Unofficial.** Not affiliated with Google / Antigravity. Requires a working, authenticated `agy` on your `PATH`.

---

## Mental model

OMA does **not** replace Antigravity.

| Layer | Job |
|-------|-----|
| **`agy`** | Agent work (TUI, tools, conversation) |
| **Plugin + hooks** | `PreInvocation` / `Stop` lifecycle entrypoints |
| **`oma` CLI** | Managed modes, Autopilot FSM, Team, setup |
| **State root** | Session aggregate, binding, processedStops (owner-only) |

| Component | Role |
|-----------|------|
| **Plugin** | `plugin.json` + `hooks.json` (PreInvocation, Stop only) |
| **Workspace hooks** | Optional `.agents/hooks.json` for project-local host load |
| **`oma` / `omy`** | Same binary → managed launch / autopilot / team / pass-through |

---

## Quick start

**Requirements:** Node.js **20+** · Antigravity CLI (`agy` on `PATH`, authenticated)

You need **all three**: `agy` (auth) + **plugin hooks** + **`oma` on PATH**.

### One-shot (recommended from a clone)

```bash
git clone https://github.com/ImL1s/oh-my-agy.git
cd oh-my-agy
./scripts/install.sh
# builds, symlinks oma/omy → ~/.local/bin, runs: oma setup
oma doctor
```

### Manual (same steps)

```bash
npm ci && npm run build
ln -sf "$(pwd)/dist/bin/oma.js" ~/.local/bin/oma
ln -sf "$(pwd)/dist/bin/oma.js" ~/.local/bin/omy   # ensure ~/.local/bin is on PATH

# Authority is "agy plugin" (singular), not "plugins"
agy plugin validate .
agy plugin install .
agy plugin enable oh-my-agy
# or one transaction:
oma setup

oma doctor
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

### Future / npm (when published)

```bash
npm i -g oh-my-agy@latest
oma setup
oma doctor
```

`npm i -g` only puts **`oma` on PATH** — you still need `oma setup` (or `agy plugin install`) for hooks.

---

## Recommended default flow

When the task is non-trivial:

```text
1. oma setup                         # plugin + preflight
2. oma ralph -- "<task>"             # managed Sisyphus-style loop
3. (or) oma ultrawork -- "<task>"    # high-throughput managed mode
4. oma autopilot start -- "<goal>"   # durable FSM when you need gates
5. Stop hooks decide continue/allow  # exact_env + ProgressOracle
```

| If you need… | Use |
|--------------|-----|
| Persistent completion loop | `oma ralph -- "…"` |
| Parallel / high-throughput mode | `oma ultrawork -- "…"` |
| Read-only plan-style launch | `oma search -- "…"` |
| Durable Autopilot FSM | `oma autopilot start / status / checkpoint / resume` |
| Team fork resolution | `oma team resolve-fork …` |
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
oma autopilot cancel --session <id> --expected-revision <n> --reason <text>
oma autopilot doctor --session <id>
oma autopilot review|qa|reset-breaker …   # see oma --help

oma team start --manifest <file>
oma team resolve-fork --team <id> --fork <id> --winner-generation <n> --expected-revision <n> --evidence <file>
oma setup
oma doctor [--json] [--no-strict-plugin]
oma <agy args...>   # pass-through (strips managed binding env)
```

Bins after build: `oma`, `omy` → `dist/bin/oma.js`.

`oma doctor` checks Node ≥20, `dist` hooks, `package.json`/`plugin.json` version sync, `agy` on PATH, state root, and plugin installed+enabled (fail-closed by default).

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
- Do not modify `AGENTS.md` without an intentional merge policy.

---

## Tests / CI / release

```bash
npm run build
npm run test:unit
npm run test:e2e
./scripts/smoke.sh          # unit + package + npm pack hook surface
```

| Surface | What |
|---------|------|
| **CI** | `.github/workflows/ci.yml` — Node 20/22 build + unit + pack smoke; e2e with mock `agy` |
| **Release** | `.github/workflows/release.yml` — on tag `v*` (must match `package.json` / `plugin.json`): test, `npm pack`, GH Release asset; optional `npm publish` if `NPM_TOKEN` set |
| **Install script** | `./scripts/install.sh` |

Tag example:

```bash
# after main is green
git tag -a v0.1.0 -m "v0.1.0"
git push origin v0.1.0
```

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

## License

[MIT](./LICENSE) — see the `LICENSE` file in the repository root.
