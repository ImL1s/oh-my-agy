# Security Policy

## Isolation model

Canonical detail: [`docs/security.md`](docs/security.md).

Short version:

- OMA orchestrates the **Antigravity CLI (`agy`)**; it is an orchestration layer,
  not an execution sandbox. Worker isolation is **integration isolation**
  (owner-only state, revision/generation fences, receipt-bound authority), not an
  OS sandbox boundary.
- Authoritative state lives under a per-user external state root; repository-local
  `.agy/` holds only plans, workflow definitions/runs, recovery copies, and
  proposal artifacts. Stale owners cannot overwrite newer state.
- Workflow tasks receive a frozen `oma_worker_envelope`; nested supervisors and
  undeclared paths/tools are rejected. A worker cannot self-authorize `ship` —
  skeptic/verifier approval plus the parent's real verification exits are
  required, and generic injected adapters never receive product authority.
- `oma production verify` accepts only fresh (≤24h), schema-bound evidence tied
  to the exact candidate Git OID across seven live seams and fails closed with
  `E_PRODUCTION_EVIDENCE`.
- Diagnostics redact secrets/tokens/credentials before logging; the worker
  environment strips `TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY` keys.

## Reporting a vulnerability

Please open a **private** security advisory on GitHub if available, or contact
the maintainer via the GitHub profile linked from this repository.

Do **not** file public issues for unpatched code-execution or secret-exfiltration
paths until a fix or a coordinated-disclosure window exists.

## Scope

In scope: the `oma` CLI, plugin hooks/skills/agents, repository workflow engine,
production-evidence gates, session recovery, and the install/update/uninstall
lifecycle.

Out of scope: the host Antigravity runtime itself (report to Google), third-party
agent CLIs invoked by users, and internal planning notes under
`docs/superpowers/` that are not product surface.
