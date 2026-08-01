# Registry Publishing Policy

Last reviewed for the OMA `0.5.1` candidate.

## Current truth

No npm-compatible registry channel is configured for this repository.

| Channel | Identity | Current status |
|---|---|---|
| GitHub Release | `iml1s-oh-my-agy-X.Y.Z.tgz` + `SHA256SUMS` | Intended install channel; publication is a separate privileged operation |
| GitHub Packages | `@iml1s/oh-my-agy` | Not published or claimed |
| npmjs.org | `@iml1s/oh-my-agy` | Not published or claimed |

The package name in `package.json` identifies tarball contents. It does not prove
registry availability. The unscoped npmjs.org package `oh-my-agy` belongs to a
different project; do not install or publish over it.

`.github/workflows/release.yml` has only `contents: read` and `packages: read`.
It builds, tests, checks versions, inspects `npm pack`, and proves the production
gate fails closed without live evidence. It does **not** publish a package or
create a GitHub Release.

## Supported installation

Use a source checkout now:

```bash
git clone https://github.com/ImL1s/oh-my-agy.git
cd oh-my-agy
./scripts/install.sh
```

After a GitHub Release asset exists, the verified installer accepts a pinned
release or an offline tarball plus checksum:

```bash
bash install.sh --github --tag vX.Y.Z
bash install.sh --asset ./iml1s-oh-my-agy-X.Y.Z.tgz --checksums ./SHA256SUMS
```

## Enabling a registry later

Treat registry enablement as a new release-policy change, not a token-only
switch. It requires:

1. an approved package/scope owner and explicit registry allowlist;
2. credential and readback preflight without logging secrets;
3. immutable tarball, integrity, provenance, and staging-tag bindings;
4. idempotent publish and version/dist-tag readback;
5. timeout/unknown reconciliation and withdrawal/fix-forward procedures;
6. CI permissions and documentation reviewed before activation.

Until those controls and live readbacks pass, documentation and release notes
must continue to say “no registry channel.” See [RELEASE.md](RELEASE.md).
