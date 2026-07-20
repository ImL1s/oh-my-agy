# Runtime rules

1. Never modify `AGENTS.md`.
2. Managed binding requires exact env: `OMA_SESSION_ID`, `OMA_LAUNCH_NONCE`, `OMA_INVOCATION_GENERATION`.
3. Circuit breaker must never run `git reset --hard` or `git clean -fd`.
4. Team recovery-fork resolution is leader-only and evidence-backed.
5. Prefer `spawn`/`spawnSync` with argv arrays; never shell `exec`.
