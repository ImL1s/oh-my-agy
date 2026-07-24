# Release and Installation

English | [简体中文](./RELEASE.zh.md) | [繁體中文](./RELEASE.zh-TW.md)

## Current channel policy

OMA `0.3.0` treats a GitHub Release tarball plus `SHA256SUMS` as the only
installable release channel. The repository does **not** currently publish to
npmjs.org or GitHub Packages. `@iml1s/oh-my-agy` is the package identity inside
the tarball, not proof that a registry entry exists.

`.github/workflows/release.yml` is deliberately verification-only. It has
read-only permissions and cannot create a tag, GitHub Release, asset, or package.

## Install

The source checkout is the always-available path:

```bash
git clone https://github.com/ImL1s/oh-my-agy.git
cd oh-my-agy
./scripts/install.sh
oma doctor --no-strict-plugin
```

After a GitHub Release is published, use the standalone verified bootstrap:

```bash
curl -fsSLo /tmp/oma-install.sh \
  https://raw.githubusercontent.com/ImL1s/oh-my-agy/main/scripts/install.sh
bash /tmp/oma-install.sh --github --tag vX.Y.Z
```

For offline installation, supply the exact tarball and checksum manifest:

```bash
bash /tmp/oma-install.sh \
  --asset ./iml1s-oh-my-agy-X.Y.Z.tgz \
  --checksums ./SHA256SUMS
```

The offline mode performs no network, dependency-install, or build step.

## Candidate verification

Run from a clean candidate commit:

```bash
npm ci
npm run build
npm run test:unit
npm run test:e2e
npm run test:package
npm run smoke
npm pack --dry-run
```

`npm run test:production` is a separate live gate. It accepts only fresh
(within 24 hours), schema-v1 evidence bound to the exact candidate Git OID for:

- installed plugin discovery;
- managed PreInvocation/Stop lifecycle;
- exact conversation resume;
- interactive and headless worker cleanup/delivery;
- MCP visibility and public LSP status;
- workflow DAG, replay, skeptic, verifier, and ship decision;
- independent code review and UltraQA.

Evidence is produced only by the product-owned probe/capture commands:

```bash
# Omit --run-id to use OMA_PRODUCTION_RUN_ID, then the exact candidate OID.
oma production probe plugin-discovery --run-id "$RUN_ID"
oma production probe managed-lifecycle --run-id "$RUN_ID"
oma production probe exact-resume --run-id "$RUN_ID"
oma production probe worker-runtime --run-id "$RUN_ID"
oma production probe mcp-lsp --run-id "$RUN_ID"
oma production probe workflow --run-id "$RUN_ID"

# These execute an actual allowlisted independent CLI. The command output must
# contain exactly VERDICT: APPROVE or ULTRAQA: PASS, respectively.
oma production capture review --run-id "$RUN_ID" -- codex <review-args>
oma production capture ultraqa --run-id "$RUN_ID" -- claude <qa-args>
oma production verify --run-id "$RUN_ID"
```

Receipts, canonical artifacts, and bounded transcripts are written beneath the
platform state root at `production-evidence/<run-id>/`. The verifier accepts no
caller-selected evidence path or claim JSON. It validates canonical bytes,
owner-only modes, hashes, argv, exact candidate OID, freshness, and distinct
review/UltraQA tool identities. Missing, stale, skipped, or mismatched evidence
returns `E_PRODUCTION_EVIDENCE` and exits nonzero. Verification is read-only:
missing evidence does not create the state root or run directory.

## Publication boundary

Only after deterministic checks, live evidence, independent review, and
UltraQA pass may a privileged release operator push/read back the branch and
tag, create a prerelease, upload the frozen tarball and `SHA256SUMS`, attest the
bytes, promote it, and verify a fresh install. Any timeout is `unknown`, not
success. Do not rebuild after freezing the bundle.

`oma update --release` activates an already verified immutable package root.
`oma uninstall --receipt <path>` removes only receipt-owned inventory; `--purge`
also requires the exact project-state path.
