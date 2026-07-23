# Verification Checklist

Use this checklist for the `0.3.0` candidate. Read actual command output; do not
reuse an old pass count or treat a skipped live seam as success.

## Deterministic gate

- [ ] `npm ci`
- [ ] `npm run build`
- [ ] `npm run test:unit`
- [ ] `npm run test:e2e`
- [ ] `npm run test:package`
- [ ] `npm run smoke`
- [ ] `npm pack --dry-run` contains the CLI, hooks, `.mcp.json`, installer,
      workflow skill, saved prompt, and workflow fixture
- [ ] `package.json`, `plugin.json`, and `.claude-plugin/plugin.json` versions match
- [ ] `git diff --check` passes

This gate covers managed/ordinary CLI routing, exact-env binding, hooks,
state/lock/lease safety, Autopilot, team/tmux/worktree lifecycle, delivery,
setup/update/uninstall, recovery, workflow replay and review, MCP/wiki/HUD,
notifications, capability honesty, and package readback.

## Expected fail-closed check

- [ ] With no product-owned live receipts, `npm run test:production` exits 1 and
      prints `E_PRODUCTION_EVIDENCE`.

This is a required negative test, not a failed deterministic build.

## Live production gate

- [ ] Installed package/plugin is discovered in a fresh session
- [ ] PreInvocation → Stop continuation → final Stop lifecycle is exact and
      generation-bound, with no duplicate launch
- [ ] Exact conversation resume uses literal argv and increments generation
- [ ] Interactive and headless workers, mailbox, delivery, and orphan cleanup pass
- [ ] MCP tools are visible; public LSP status is honest; no private sidecar claim
- [ ] Production workflow reaches `ship` after journal replay, skeptic, and verifier
- [ ] Independent code review approves the exact candidate
- [ ] Independent UltraQA passes the exact candidate
- [ ] `npm run test:production` exits 0 with all seven seams true

Every evidence document must be schema v1, no older than 24 hours, and bound to
the exact candidate Git OID. Generate it with `oma production probe <seam>` or
`oma production capture <review|ultraqa> -- <allowlisted-cli> ...`; external
JSON files and `OMA_PRODUCTION_*_EVIDENCE` path variables are not accepted.
The `plugin-discovery` probe requires exact registry/install identity plus a new
isolated `agy -p /oh-my-agy:discovery-proof` process returning the packaged
high-entropy token exactly. Near misses, reused-conversation flags, identity
drift, timeouts, and output overflow remain `unobserved` at T0. This makes the
plugin seam independently attainable without weakening the still-blocked
workflow ship-authority seam.

## Release boundary

- [ ] Freeze one tarball and `SHA256SUMS`; do not rebuild after freeze
- [ ] Push/read back branch and tag from the exact candidate
- [ ] Create/upload/promote the GitHub Release using a privileged external lane
- [ ] Verify remote asset bytes and a fresh install/readback
- [ ] Confirm no npm registry channel is claimed

See `docs/RELEASE.md` for the authority and failure semantics.
