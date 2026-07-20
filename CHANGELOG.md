# Changelog

All notable changes to **oh-my-agy (OMA)** are documented here.

Format inspired by [Keep a Changelog](https://keepachangelog.com/). Versions follow semver.

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

[0.2.3]: https://github.com/ImL1s/oh-my-agy/releases/tag/v0.2.3
[0.2.2]: https://github.com/ImL1s/oh-my-agy/releases/tag/v0.2.2
[0.2.1]: https://github.com/ImL1s/oh-my-agy/releases/tag/v0.2.1
[0.2.0]: https://github.com/ImL1s/oh-my-agy/releases/tag/v0.2.0
