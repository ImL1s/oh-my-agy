# Native capability negotiation

OMA uses one versioned `HostCapabilityProfile` as the authority for
Antigravity-native and fallback routing. Host versions are identity metadata;
they do not enable behavior by themselves.

## Commands

```bash
oma native capabilities
oma native capabilities --json
oma native probe --live
oma doctor --native
```

- `native capabilities` assembles or reads a passive profile. It may inspect
  public help, the verified public plugin registry/inventory projection,
  installed plugin assets, and OMA's identity-bound cache. It does not create a
  conversation, invoke a model or agent, fire a hook smoke test, or change host
  configuration. A failed plugin readback is `unknown`, not evidence that the
  plugin is absent.
- `native probe --live` is the only command that opts into a live probe. The v1
  executor runs one bounded public headless print canary, using structured JSON
  when the passive profile advertises it and exact text otherwise. It parses
  only documented terminal fields and retains no response text. The policy's
  wall-clock, combined-output, and process-count ceilings are all enforced;
  process-tree overflow or an unavailable process counter leaves evidence
  indeterminate. Timeout/overflow termination includes the Windows descendant
  tree, and a fixed force-settle backstop prevents inherited pipes from hanging
  beyond the outer bound. Every other
  side-effect domain receives an explicit `live_probe`/`indeterminate`
  observation with a domain-specific unavailable code until a bounded public
  executor exists. It never inspects private sidecar/brain internals.
- `doctor --native` adds passive profile, identity, and cache diagnostics.
  Ordinary `doctor` keeps its existing output and behavior.

Offline fixtures, help text, documentation, and a passing build prove the OMA
implementation only. They do not prove live host parity. A `verified` native
claim requires a successful opt-in live probe bound to the current host and
plugin identity.

## Evidence model

Each canonical capability has one assessment:

- `outcome`: `supported`, `unsupported`, or `unknown`;
- `supported`: compatibility projection of `outcome === 'supported'`, never a
  routing input by itself;
- `tier`: `configured`, `installed`, `enabled`, `loadable`, `observed`,
  `healthy`, or `verified`;
- `source`: `help`, `config`, `plugin_readback`, `structured_init`, or
  `live_probe`;
- explicit `fallback` and fallback preconditions;
- bounded observations and redacted diagnostics.

Timeouts, parse failures, contradictory evidence, stale evidence, and identity
drift produce `unknown`. They are not converted to unsupported or success.
Source-specific ceilings prevent, for example, a help flag from becoming
`healthy` or `verified` evidence.

The v1 registry covers public plugin layout and assets, all five documented
hooks, custom agents and subagents, structured headless modes, documented
sidecars/`agentapi`, statusline/title, conversations/projects,
permissions/sandbox/artifact review, model/effort, and local/remote MCP
lifecycle.

## Identity and cache

Profiles bind:

- canonical `agy` realpath, binary SHA-256, version metadata, and help/version
  output digests;
- installed plugin realpath, package digest, version, registry/readback digest,
  and enabled state;
- profile schema, capability policy version, and probe-set version.

Any identity change invalidates the cache. Identity sampled before and after a
probe must match; otherwise the profile is non-cacheable and routing fails
closed. Cache reads additionally enforce each capability policy's freshness
window; a structurally valid but stale profile is not returned. Passive
commands may write only OMA's owner-safe capability cache, not host or user
configuration. A failed opt-in live probe invalidates an older cached success
for the same identity instead of leaving stale execution authority behind.

## Routing contract

Routers require a supported assessment at the policy's minimum tier. A route
candidate binds the profile, policy, probe set, identity, capability, provider,
fallback, generation, context, and expiry. A route receipt additionally binds
the resolved executable and adapter. Tampered, expired, stale-generation, or
identity-mismatched candidates and receipts are rejected.

`routeTeamWorkerProvider` is the only Team provider selector. It evaluates the
native contract first, then evaluates the declared headless or tmux fallback
only when native authority is unproven. Issue #3 does not add an Antigravity
native worker adapter. If its full native contract is proven, OMA fails with
`E_NATIVE_ADAPTER_UNAVAILABLE` before bootstrap rather than silently falling
back.

For an implemented fallback, the leader persists an owner-only, external
single-use worker authority containing the complete profile and route receipt.
Bootstrap validates that authority, generation, context, provider, mode,
executable realpath, and executable SHA-256 before spawning the worker; digest
strings in the worktree descriptor are not authority by themselves.

Team and production-workflow execution require a fresh cached live profile and
a valid route receipt. Passive observations can describe capabilities, but they
cannot authorize those product execution paths.

Production workflows re-read the exact executable identity before every ready
batch. A profile is reused only while it can cover the 30-second route receipt
plus five seconds of headroom; otherwise OMA performs a bounded live refresh.
The route timestamp is sampled after that inspection completes, so newly
generated evidence is never rejected as future-dated merely because the probe
was slow.

The public Team CLI therefore defaults `team start` to `--worker-mode
headless`. The interactive tmux route is explicit and fails closed unless the
composition layer supplies a fresh bounded `TmuxReadinessReceiptV1`; Issue #3
does not manufacture that receipt from tmux presence alone.

## Compatibility

`oma native-status`, `oma lsp-status`, and `oma sidecar-status` remain available
for one compatibility cycle as projections. New code must consume
`HostCapabilityProfile`; it must not create independent native/fallback truth.

The frozen Antigravity 1.1.6 help/argv grammar in `src/team/agy-argv.ts` and
`probeAgy115` is compatibility metadata for the existing fallback adapter. It
does not select a provider and is never a native capability authority. See the
[authority ledger](./native-capability-authority-ledger.md) for the complete
classification.
