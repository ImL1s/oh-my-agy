# Runtime rules

1. Never modify `AGENTS.md` unless the user explicitly requests a merge-policy change.
2. Managed binding requires exact env: `OMA_SESSION_ID`, `OMA_LAUNCH_NONCE`, `OMA_INVOCATION_GENERATION`.
3. Circuit breaker must never run `git reset --hard` or `git clean -fd`.
4. Team recovery-fork resolution is leader-only and evidence-backed.
5. Prefer `spawn`/`spawnSync` with argv arrays; never shell `exec`.
6. **Session skills are authoritative for in-session behavior.** CLI launches managed modes; skills under `skills/` (autopilot, ralph, ultrawork, search, team, cancel, verify, setup) define how the agent works until verified complete. When `<<<OMA_SKILL_PROTOCOL` is present in the prompt, follow it.
7. Do not claim completion without fresh verification evidence (`skills/verify`).
