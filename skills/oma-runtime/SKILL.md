# oma-runtime

Antigravity plugin skill surface for oh-my-agy.

- Managed modes: `ralph`, `ultrawork`, `search`
- Team runtime: `oma team start|status|resolve-fork`
- Autopilot: `oma autopilot ...`
- Setup: `oma setup` (transactional plugin install/enable/readback)

Authoritative hooks are only PreInvocation and Stop. Ordinary pass-through invocations must fail open without managed binding env.
