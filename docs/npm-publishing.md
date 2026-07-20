# npm / GitHub Packages publishing

Last verified: **2026-07-21** (OMA `v0.2.3`).

## What is published today

| Channel | Package identity | Status |
|---------|------------------|--------|
| **GitHub Release** | tarball asset e.g. `iml1s-oh-my-agy-0.2.3.tgz` | **Shipped** on tags `v*` |
| **GitHub Packages** | `@iml1s/oh-my-agy` | **Shipped** on tags `v*` via release workflow |
| **npmjs.org** | (not yet for this repo) | **Not published** — see blockers below |

Install without npmjs:

```bash
# Release tarball (no registry auth)
npm i -g https://github.com/ImL1s/oh-my-agy/releases/download/v0.2.3/iml1s-oh-my-agy-0.2.3.tgz

# GitHub Packages (needs PAT with read:packages)
echo "@iml1s:registry=https://npm.pkg.github.com" >> ~/.npmrc
# //npm.pkg.github.com/:_authToken=YOUR_GH_PAT
npm i -g @iml1s/oh-my-agy@0.2.3
```

After install, still run **`oma setup`** so:

- `agy` plugin (hooks + skills) is registered
- Claude / Grok slash surfaces install when CLIs are present

Primary session UX: **`/autopilot`** on agy · **`/oh-my-agy:autopilot`** on Claude/Grok.

Plugin id remains **`oh-my-agy`** (`plugin.json`) for `agy plugin enable oh-my-agy`.  
npm/package name is **`@iml1s/oh-my-agy`** (`package.json`).  
Claude Code marketplace manifest lives under **`.claude-plugin/`** (version must match package).

---

## Why npmjs.org is not live yet

### 1. No valid `NPM_TOKEN` in this environment

- Local `~/.npmrc` had an `//registry.npmjs.org/:_authToken=…` entry that returned **401 Unauthorized** (`npm whoami` / registry whoami).
- GitHub repo secrets: **`NPM_TOKEN` was not set** at release time.
- Release workflow treats npmjs as optional: if `NODE_AUTH_TOKEN` / `NPM_TOKEN` is empty it **skips** npmjs and still succeeds (GH Release + GitHub Packages).

Relevant step: `.github/workflows/release.yml` → `npmjs.org publish (optional)`.

### 2. Unscoped name `oh-my-agy` is already taken

On **npmjs.org**, `oh-my-agy@0.1.0` is owned by a **different** project:

- Maintainer: `shayne_snap`
- Repo metadata: `github.com/shayne-snap/oh-my-antigravity`
- Bin: `omagy` (not `oma` / `omy`)

This is **not** ImL1s/oh-my-agy. We must **not** try to publish over that name.

### 3. Scoped publish needs npm account rights for `@iml1s`

This repo’s package name is `@iml1s/oh-my-agy`. Publishing that scope to npmjs.org requires:

1. An npm account that **owns or is a member of** the `@iml1s` organization/user scope, **and**
2. An automation token with publish rights for that package/scope.

---

## Enabling npmjs later (checklist)

1. Create/claim npm scope **`@iml1s`** (or change package name to an available unscoped name such as `oh-my-agy-cli` — product decision).
2. Create an npm automation token with publish rights for that package/scope.
3. Add GitHub Actions secret on **ImL1s/oh-my-agy**:
   - `NPM_TOKEN` (or map into `NODE_AUTH_TOKEN` as the workflow expects)
4. Re-run a tag release (or `workflow_dispatch` with `publish_npm: true` if supported).
5. Verify:
   - `npm view @iml1s/oh-my-agy version` (after scope is live)
   - install smoke: `npm i -g @iml1s/oh-my-agy@latest && oma --help && oma setup`

---

## Release workflow (what a tag does)

On push of tag `v*` (must equal `package.json` / `plugin.json` / `.claude-plugin/plugin.json` version):

1. `npm ci` + `npm run build`
2. Unit + package + e2e tests
3. `npm pack` → assert hooks present in tarball
4. Smoke packed `oma --help` / `--version`
5. **GitHub Release** with tarball asset
6. **GitHub Packages** publish (`@iml1s/oh-my-agy`, auth = `GITHUB_TOKEN`)
7. Optional npmjs if token present

See also: [CHANGELOG.md](../CHANGELOG.md), [README.md](../README.md).
