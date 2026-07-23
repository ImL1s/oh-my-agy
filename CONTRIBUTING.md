# Contributing

Thanks for your interest in **oh-my-agy** — an orchestration layer (plugin +
local `oma` CLI) for the Antigravity CLI (`agy`).

## Dev setup

```bash
git clone https://github.com/ImL1s/oh-my-agy.git
cd oh-my-agy
npm ci
npm run build
```

`agy` (Antigravity CLI) is required only for the live production gate and slash
surfaces; the unit/e2e/package suites run without it (e2e uses a mock agy).

## Tests and local gates

```bash
npm run build
npm run test:unit        # deterministic unit suite
npm run test:e2e         # end-to-end with a mock agy host
npm run test:package     # packaged-surface / release-readback checks
npm run smoke            # pack + install + readback smoke
npx tsx scripts/check-parity.ts
npx tsx scripts/check-traceability.ts
npx tsx scripts/check-writer-ownership.ts
```

`npm run test:production` is a **separate live gate** — it accepts only fresh,
schema-bound evidence tied to the exact candidate Git OID across seven live
seams and needs a real, authenticated `agy` (see [`docs/RELEASE.md`](docs/RELEASE.md)).

## Ground rules

- Keep the smallest reversible change with an evidence-backed stop condition.
- Do not weaken a fail-closed path to make a test pass; the security modules
  (worker envelopes, receipt authority, production-evidence gates) must never
  false-green. See [`docs/security.md`](docs/security.md) and [`SECURITY.md`](SECURITY.md).
- Redact secrets/tokens/credentials from logs, diagnostics, and handoffs.
- Version bumps must keep `package.json`, `plugin.json`, and
  `.claude-plugin/plugin.json` in sync (CI enforces this).
- Run the local gates above before opening a PR.

## Reporting security issues

See [`SECURITY.md`](SECURITY.md) — use a **private** advisory, not a public issue.
