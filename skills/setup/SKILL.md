---
name: setup
description: "In-session OMA setup check — invoke /oh-my-agy:setup; verify install/hooks HERE (CLI install optional appendix)"
---

# setup (OMA / in-session)

## You are already in the agent session

When invoked via **`/oh-my-agy:setup`** or this **setup** skill, check whether OMA is usable **HERE** and guide the user through gaps.

- Do **not** require a terminal first if you can already run `oma doctor` / inspect the workspace from this session.
- Canonical slash: **`/oh-my-agy:setup`**.
- Full CLI install steps live only in the [Appendix](#appendix-optional-oma-cli-install) — use them when hooks/CLI are missing, not as a gate to start diagnosing.

## Purpose

Make OMA actually active: CLI on PATH + plugin hooks enabled + skills discoverable. Sibling of OMC setup; workspace state under **`.agy/`**.

## Use when

- User invokes `/oh-my-agy:setup` or says setup OMA / enable hooks / doctor / install plugin
- Fresh clone or global install and workflows are not firing

## Do not use when

- User only wants a workflow skill (`autopilot`, `ralph`, …) and setup already works
- Pure research → `search`

## Steps (in-session)

1. **Probe** — run or request `oma doctor` (or `oma doctor --no-strict-plugin` if plugin registry is flaky). Summarize: Node ≥20, dist hooks, package/plugin version sync, `agy` on PATH, state root, plugin registry.
2. **Gaps** — if doctor fails, list concrete fixes (PATH, rebuild, `oma setup`, plugin enable). Prefer the smallest fix.
3. **Skills surface** — confirm plugin `skills/` is visible (`oma skill list` when CLI available, or host skill list). Managed launches inject `<<<OMA_SKILL_PROTOCOL>>>` when configured.
4. **Confirm** — doctor clean (or residual blockers explicit). Tell user they can invoke `/oh-my-agy:autopilot` etc. without further install.

## Expectations

- `npm i -g` alone does **not** enable hooks — always run `oma setup` (or `agy plugin install/enable`) when hooks are missing.
- After setup, workflow skills (`autopilot`, `ralph`, …) are the primary UX via **session slash**.

## Final checklist

- [ ] Doctor (or equivalent) run with outcome recorded
- [ ] Hooks enabled if this host uses the agy plugin surface
- [ ] User knows canonical slash form `/oh-my-agy:<skill>`

---

## Appendix: optional `oma` CLI install

Use when CLI/hooks are not yet installed:

```bash
# from clone
./scripts/install.sh
# or
npm ci && npm run build
oma setup
oma doctor
```

`oma doctor` is the durable health gate; re-run after install changes.

## Troubleshooting

The `oma hooks status` verb is not shipped — do not tell the user to run it. Use `oma doctor` and `oma skill list`. See:

- [Troubleshooting (English)](../../README.md#troubleshooting)
- [故障排除](../../docs/readme/README.zh.md#故障排除)
- [疑難排解](../../docs/readme/README.zh-TW.md#疑難排解)
