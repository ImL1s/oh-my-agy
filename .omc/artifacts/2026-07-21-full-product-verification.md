# Full product verification evidence (2026-07-21)

## Tip
- Branch: `feat/team-orchestrator-v1`
- Tip after deliver race fix: `9b22bc2` fix: stop worker before deliver clean proof
- Prior tip: `c86753f` feat: first-drive exact_env bind and full product smoke

## GHA CI
- Prior (c86753f): https://github.com/ImL1s/oh-my-agy/actions/runs/29760709115 — **success**
- Tip (9b22bc2): https://github.com/ImL1s/oh-my-agy/actions/runs/29761406485 — **success**
- PR: https://github.com/ImL1s/oh-my-agy/pull/1 — **MERGED** into main as `b7bf611`

## Local verification (post deliver-race fix)
- `npm run build` — pass
- `npm run test:unit` — **149** passed
- `npx jest e2e/structured-cli.spec.ts --runInBand` — **6** passed (incl. TC-S-03c drive)
- `npx ts-node --transpile-only scripts/smoke-full-product.ts` — **ALL_SMOKE_OK**
  - Log: `/tmp/oma-full-product-smoke.log`
  - drive: first-bind exact_env → mock agy exit 0
  - team: start → deliver → tick starts `b` after `a` completed → TEAM_SMOKE_OK

## Bug fixed during verification
- **Symptom**: smoke team deliver flaky/`E_DELIVERY_UNINTEGRATED` "Worker worktree clean proof does not match"
- **Root cause**: race — deliver cleaned `.oma-worker-ready` then hold process rewrote it before createDeliveryEvidence porcelain snapshot
- **Fix**: `deliverTask` kills owned tmux worker session first, then `ensureWorkerWorktreeCleanForDelivery` retries clean until porcelain empty

## Scope deferred (explicit, not blocking this PR)
- Full Conflict Saga multi-worker CLI walkthrough (unit lease coverage exists)
- npm publish / new tag beyond existing public v0.1.0 (unless requested)
