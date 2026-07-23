# Repository Workflows

OMA workflows preserve a reviewed multi-agent process as a versioned
`repository-workflow/v1` definition. The definition fixes the DAG, bounded
fan-out, role, capability mode, MCP allowlist, write scope, artifact contract,
retry budget, verification command, and ship predicate. The public CLI provides
T4 product-owned authority: OMA launches each worker and verification process,
authenticates receipts with a repository-external trust root, and computes the
decision itself. This is product-authenticated, not a host-signed identity claim.

## Quick start

Install the packaged production safety review into repository runtime state:

```bash
oma workflow install
oma workflow list
printf '{"candidate_commit":"%s"}\n' "$(git rev-parse HEAD)" > /tmp/oma-input.json
oma workflow run production-safety-review --input /tmp/oma-input.json
```

Use `--source <definition.json>` to install another validated definition.
Definitions are stored under `.agy/workflows/`; run state and the immutable
journal live under `.agy/state/workflows/<run-id>/`.

Generic library adapters exit with terminal `no_ship` and
`E_WORKFLOW_PRODUCT_AUTHORITY_UNAVAILABLE`. Only the closed public CLI executor
can reach `ship`. Worker JSON must match the stage's exact
`{artifacts, verdict}` schema. A verdict may report `pass`, `approve`, `ship`,
`reject`, `no_ship`, or `failed`; negative verdicts require findings, and any
`error` finding prevents a positive decision. Workers cannot supply approval,
status, verification receipts, MACs, or ship-proof fields.

Inspect or replay a run without redispatching workers:

```bash
oma workflow status --run <run-id>
oma workflow replay --run <run-id>
```

## Production safety review

The packaged definition describes four read-only reviews in parallel: secrets,
deployment gates, cron/R2 operations, and API/operations documentation. An
independent skeptic checks their findings, an independent verifier checks the
candidate, and only then would a read-only ship gate decide `ship` or `no_ship`
with authenticated product-owned receipts.
The maximum parallelism is four and the maximum agent count is seven.

## Execution and failure semantics

1. OMA loads one exact name/version/digest and validates its DAG.
2. Each task receives a frozen `oma_worker_envelope`; nested supervisors and
   undeclared paths/tools are rejected.
3. The CLI parent records distinct process/start identities, rereads confined
   owner-only artifacts and command transcripts, then authenticates the bound
   receipt with its repository-external trust root.
4. The parent accepts a positive verdict only when its exact stage schema
   permits that value, no error finding exists, and every exact verification
   argv exits zero.
5. Retry is bounded by the definition. An unreconciled external effect becomes
   `effect_unknown` and fails closed.
6. Skeptic and verifier approval remain necessary but are not sufficient for
   `ship`; authenticated product-owned authority is also required. Generic
   injected adapters never receive that authority.

The current packaged review is read-only. Worker output is strict JSON; OMA
persists declared artifacts as proposal bytes rather than granting repository
write authority. Production evidence captures the canonical definition, input,
plan, journal, artifacts, and verification transcripts. Aggregate verification
rereads those bytes, recomputes digests, replays the journal, and performs keyed
review again; deletion or tampering fails closed.

`oma production probe workflow` is the only supported production-evidence
entrypoint. It resolves the literal `agy` executable from the active `PATH`,
requires its realpath to be the canonical owner-installed
`~/.local/bin/agy`, hashes the executable bytes through one stable file
descriptor, validates the supported 1.1.5 public contract and the exact
installed OMA plugin identity, derives the candidate from the current
repository, and writes only to a repository-external platform state root. It
rejects `OMA_STATE_ROOT`, plugin-config root overrides, and
`OMA_PRODUCTION_RUN_ID`; callers cannot inject an executable, adapter,
candidate, package identity, or evidence root. Internal runner exports expose
no product executor or dispatcher, product authority exposes no adapter factory,
and the executor remains a non-exported CLI closure. Package regression tests
lock an exact allowlist for every emitted workflow module in addition to
blocking package deep imports. Production evidence exposes only data
preparation/recording steps backed by a process-private prepared-handle identity;
it accepts no executor callback. The generic importable runner is advisory and
always performs zero dispatches, so the disk HMAC protects receipt integrity but
never grants in-process execution privilege.

## Live worker contract (Antigravity 1.1.5)

Each workflow task is one fresh headless `agy` session. The launch grammar is
frozen and validated (`src/team/agy-argv.ts`); the details below are load-bearing
and only surface against a real host, not a mocked CLI:

- **Model is pinned** to a current `agy models` id (`gemini-3.6-flash-high`). agy's
  ambient default can be retired out from under it (an absent default such as
  `gemini-2.5-pro` makes every worker fail with the generic *"Agent execution
  terminated due to error"*, which is easily mistaken for quota exhaustion).
- **The repository is mounted with `--add-dir`.** Headless agy binds its own
  workspace, not the process cwd, so a worker cannot see the candidate commit
  unless the repository root is added explicitly (and named in the prompt).
- **The prompt is the immediate value of `--print`.** A trailing prompt makes agy
  1.1.5 swallow the following flags into the prompt text.
- **Worker stdout is the last balanced top-level JSON object.** Live sessions
  narrate progress before the final answer and never emit byte-canonical JSON, so
  the parser extracts the last object and rejects duplicate keys, then
  re-serializes canonically before hashing.
- **Stages budget 300s** (headless print caps at 5m) and carry a retry budget, so
  a single transient agy error does not fail the whole DAG. The per-task proposal
  root is cleaned before every attempt, making each dispatch idempotent against a
  stale proposal from a crashed or repeated run.

The fresh-session plugin-discovery canary is likewise pinned and tolerates agy
1.1.5's trailing double newline, canonicalizing the stored evidence bytes.

## Antigravity saved prompt

`.agents/workflows/production-safety-review.md` is intentionally a thin saved
prompt that delegates to the CLI. It is a T1 source projection, not a duplicate
or native workflow engine. Check current truth with:

```bash
oma workflow native-status
```

Fresh native workflow/team discovery remains unclaimed. The enforced gate is
OMA product authority and does not imply a native Antigravity workflow runtime.
