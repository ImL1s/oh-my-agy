# npm / GitHub Packages publishing

Last verified: **2026-07-21** (OMA `v0.2.1`).

## What is published today

| Channel | Package identity | Status |
|---------|------------------|--------|
| **GitHub Release** | tarball asset e.g. `iml1s-oh-my-agy-0.2.1.tgz` | **Shipped** on tags `v*` |
| **GitHub Packages** | `@iml1s/oh-my-agy` | **Shipped** on tags `v*` via release workflow |
| **npmjs.org** | (not yet for this repo) | **Not published** — see blockers below |

Install without npmjs:

```bash
# Release tarball (no registry auth)
npm i -g https://github.com/ImL1s/oh-my-agy/releases/download/v0.2.1/iml1s-oh-my-agy-0.2.1.tgz

# GitHub Packages (needs PAT with read:packages)
echo "@iml1s:registry=https://npm.pkg.github.com" >> ~/.npmrc
# //npm.pkg.github.com/:_authToken=YOUR_GH_PAT
npm i -g @iml1s/oh-my-agy@0.2.1
```

Plugin id remains **`oh-my-agy`** (`plugin.json`) for `agy plugin enable oh-my-agy`.  
npm/package name is **`@iml1s/oh-my-agy`** (`package.json`).

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
2. A classic or granular token with **publish** permission, stored as repo secret `NPM_TOKEN`.

Until both are true, CI will not successfully publish to npmjs.org even if the workflow is triggered.

---

## How to enable npmjs.org later

1. Create/claim npm scope **`@iml1s`** (or change package name to an available unscoped name such as `oh-my-agy-cli` — product decision).
2. Create an npm automation token with publish rights for that package/scope.
3. Add GitHub Actions secret on **ImL1s/oh-my-agy**:
   - Name: `NPM_TOKEN`
   - Value: the token
4. Bump `package.json` + `plugin.json` versions in lockstep (release workflow asserts tag == both).
5. Tag and push:

```bash
# after main is green
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

6. Confirm:
   - Actions → **release** workflow green
   - `npm view @iml1s/oh-my-agy version` (after scope is live)
   - GH Release asset + GitHub Packages version still present

Optional: workflow_dispatch with `publish_npm=true` once `NPM_TOKEN` exists (see `release.yml` inputs).

### Local publish (emergency only)

Prefer CI. If you must publish from a laptop:

```bash
npm pack
# use a valid token in env, never commit it
export NODE_AUTH_TOKEN=…   # npmjs automation token
npm publish ./iml1s-oh-my-agy-X.Y.Z.tgz --access public --registry https://registry.npmjs.org
```

Do **not** publish as unscoped `oh-my-agy`.

---

## Release workflow behavior (summary)

On `push` tags `v*`:

1. `npm ci` + build
2. Assert tag version == `package.json` == `plugin.json`
3. unit + package + e2e
4. `npm pack` + packed CLI smoke
5. **GitHub Release** (tarball asset)
6. **GitHub Packages** publish (`@iml1s/oh-my-agy`, auth = `GITHUB_TOKEN`)
7. **npmjs.org** publish **only if** `NPM_TOKEN` secret is set (and not skipped by dispatch flag)

---

## Related docs

- Install paths: [README.md](../README.md) — “Install from release”
- Design scope: [DESIGN.md](../DESIGN.md)
- Session skills vs CLI: `skills/oma-runtime/SKILL.md`
