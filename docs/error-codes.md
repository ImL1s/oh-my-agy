# CLI-visible error codes

This document lists **only the CLI-visible subset** of OMA `E_*` codes --
those printed to users by the `oma` CLI (`src/cli/application.ts` and other
CLI stderr printers that emit `CODE: message`). Internal contract codes
(hundreds of `E_*` values used only inside hooks, state machines, and tests)
are **intentionally omitted**. `oma explain` for an uncataloged `E_*` code
exits non-zero with `E_NOT_IN_CATALOG` rather than inventing a template.

Source of truth: [`src/runtime/error-catalog.ts`](../src/runtime/error-catalog.ts).
Unit tests fail if this file drifts from the catalog map.

Look up a code: `oma explain <E_CODE>` or `oma explain <E_CODE> --json`.

<a id="e-binding-conflict"></a>

## `E_BINDING_CONFLICT`

- **Summary:** The conversation is already bound to a different launch.
- **Likely cause:** A second managed launch tried to arm a session that already has an exact conversation binding.
- **Next action:** Resume the existing conversation instead of starting a parallel launch (`oma autopilot drive` / `oma resume`).

<a id="e-binding-env-missing"></a>

## `E_BINDING_ENV_MISSING`

- **Summary:** Managed binding environment variables are missing.
- **Likely cause:** Hooks and resume expect `OMA_SESSION_ID` / `OMA_LAUNCH_NONCE` / `OMA_INVOCATION_GENERATION` from an exact-env launch.
- **Next action:** Relaunch through `oma ralph|ultrawork|search -- <task>` so binding env is injected; do not call `agy` directly for managed work.

<a id="e-capability-host-unavailable"></a>

## `E_CAPABILITY_HOST_UNAVAILABLE`

- **Summary:** The Antigravity host (`agy`) is unavailable.
- **Likely cause:** The configured `agy` executable is missing, not executable, or version/help probes failed closed.
- **Next action:** Install `agy`, set `OMA_AGY_BIN` if it is not on PATH, then retry `oma native capabilities` / `oma doctor`.

<a id="e-capability-profile-invalid"></a>

## `E_CAPABILITY_PROFILE_INVALID`

- **Summary:** The assembled host capability profile is invalid.
- **Likely cause:** Identity, digest, or capability rows failed the frozen profile contract.
- **Next action:** Delete the stale capability cache under the state root and rebuild with `oma native capabilities --json`.

<a id="e-capability-unproven"></a>

## `E_CAPABILITY_UNPROVEN`

- **Summary:** The host capability profile could not be proven.
- **Likely cause:** agy identity, live probe, or workflow route refresh did not yield an exact profile.
- **Next action:** Install `agy` on PATH and run `oma native probe --live` / `oma doctor --native` until the profile is proven.

<a id="e-cli-usage"></a>

## `E_CLI_USAGE`

- **Summary:** CLI usage for this subcommand is invalid.
- **Likely cause:** A required option is missing, duplicated, or an unexpected token was supplied.
- **Next action:** Correct argv using the subcommand usage line (or `oma --help`) and retry without extra tokens.

<a id="e-command-failed"></a>

## `E_COMMAND_FAILED`

- **Summary:** An extended CLI command failed after usage checks passed.
- **Likely cause:** The subcommand threw (workflow digest, host spawn, or an internal Error wrapped by the CLI).
- **Next action:** Read the wrapped message after `E_COMMAND_FAILED:` -- it usually embeds the underlying `E_*` code -- and fix that cause.

<a id="e-conversation-unbound"></a>

## `E_CONVERSATION_UNBOUND`

- **Summary:** No conversation is bound to this session yet.
- **Likely cause:** Resume/drive ran before the first managed spawn wrote the conversation binding.
- **Next action:** Run a first managed launch for the session, then resume with the conversation id it recorded.

<a id="e-corrupt-state"></a>

## `E_CORRUPT_STATE`

- **Summary:** Durable OMA state could not be parsed or failed an integrity check.
- **Likely cause:** A revisioned JSON record, receipt, or git identity blob is truncated, mutated, or the wrong shape.
- **Next action:** Inspect the cited `.agy` / state-root file, restore a known-good copy, and retry. Never `git reset --hard` to "fix" it.

<a id="e-delivery-scope-violation"></a>

## `E_DELIVERY_SCOPE_VIOLATION`

- **Summary:** A worker wrote outside its claimed write_scope.
- **Likely cause:** Delivery compared the worktree diff against the task scope and found an escape.
- **Next action:** Revert the out-of-scope files in the worker worktree and deliver only scope-bounded changes.

<a id="e-directive-invalid"></a>

## `E_DIRECTIVE_INVALID`

- **Summary:** A managed-mode directive was rejected before launch.
- **Likely cause:** The parser requires `oma <mode> -- <non-empty task>` with no tokens between the mode and `--`.
- **Next action:** Rerun as `oma ralph -- <task>` (or ultrawork/search) with a non-empty task after `--`.

<a id="e-future-schema"></a>

## `E_FUTURE_SCHEMA`

- **Summary:** State was written by a newer schema than this CLI understands.
- **Likely cause:** The on-disk schema_version is ahead of this package; downgrading bytes is unsafe.
- **Next action:** Upgrade `oma` to a version that understands the newer schema. Do not hand-edit or downgrade the state files.

<a id="e-git-required"></a>

## `E_GIT_REQUIRED`

- **Summary:** A git identity is required but unavailable.
- **Likely cause:** The command needs a repository (rev-parse / common-dir) and git is missing or cwd is not a repo.
- **Next action:** Install git and rerun from inside the target repository.

<a id="e-invocation-generation-mismatch"></a>

## `E_INVOCATION_GENERATION_MISMATCH`

- **Summary:** Resume generation does not match the bound conversation.
- **Likely cause:** The resume transaction did not return the exact conversation id and next invocation generation.
- **Next action:** Use `oma resume --session <id> --conversation <id> --expected-revision <n>` with the values from `oma session list`.

<a id="e-live-probe-failed"></a>

## `E_LIVE_PROBE_FAILED`

- **Summary:** An explicit live native probe failed.
- **Likely cause:** `oma native probe --live` did not observe the required canary/profile evidence.
- **Next action:** Fix the host (install/upgrade agy, check plugin enablement) and rerun `oma native probe --live --json`.

<a id="e-lock-not-owner"></a>

## `E_LOCK_NOT_OWNER`

- **Summary:** This process is not the lock owner.
- **Likely cause:** Release/reclaim was attempted by a pid/nonce that does not own the lock.
- **Next action:** Let the owning process release the lock, or prove the owner is dead before reclaiming via the lock helper.

<a id="e-lock-timeout"></a>

## `E_LOCK_TIMEOUT`

- **Summary:** Timed out waiting for an owner-safe lock.
- **Likely cause:** Another live owner still holds the lock; contenders must not delete it.
- **Next action:** Wait for the lock holder to finish. Do not delete a live lock file.

<a id="e-manifest-invalid"></a>

## `E_MANIFEST_INVALID`

- **Summary:** The team manifest failed the frozen v1 contract.
- **Likely cause:** Schema, task ids, or write_scope bytes are missing/invalid.
- **Next action:** Fix the manifest against `oma.team-manifest/v1` and retry `oma team start --manifest <file>`.

<a id="e-native-adapter-unavailable"></a>

## `E_NATIVE_ADAPTER_UNAVAILABLE`

- **Summary:** The Antigravity native worker adapter is not available.
- **Likely cause:** This host build does not implement the native worker adapter OMA would need for that path.
- **Next action:** Use headless/tmux team workers (`oma team start`) instead of assuming a native subagent adapter exists.

<a id="e-not-found"></a>

## `E_NOT_FOUND`

- **Summary:** The requested object does not exist.
- **Likely cause:** A skill name, mailbox target, or state key is not in the inventory.
- **Next action:** List the valid names first (`oma skill list`, `oma session list`, or the owning status command) and retry with an exact id.

<a id="e-path-outside-root"></a>

## `E_PATH_OUTSIDE_ROOT`

- **Summary:** A path escaped its allowed root or the state root is unsafe.
- **Likely cause:** The target is a symlink, world-readable, owned by another uid, or a relative path escaped the root.
- **Next action:** Keep paths inside the workspace/state root, fix ownership/mode (owner-only), and do not point `OMA_STATE_ROOT` at a symlink.

<a id="e-pending-launch-exists"></a>

## `E_PENDING_LAUNCH_EXISTS`

- **Summary:** A pending managed launch is still recorded.
- **Likely cause:** Prepare-launch refuses a second in-flight launch for the same session.
- **Next action:** Wait for the pending child to finish or inspect the session aggregate before starting another launch.

<a id="e-plugin-not-active"></a>

## `E_PLUGIN_NOT_ACTIVE`

- **Summary:** The oh-my-agy plugin is missing, disabled, or does not match installed bytes.
- **Likely cause:** Managed launch and setup preflight require an enabled plugin whose registry readback matches this package.
- **Next action:** Run `oma setup` to install and enable the plugin, then `oma doctor` until plugin_active passes.

<a id="e-process-identity-unproven"></a>

## `E_PROCESS_IDENTITY_UNPROVEN`

- **Summary:** The child process identity could not be proven.
- **Likely cause:** Managed spawn did not record a matching pid/owner-nonce, or the wrapper nonce is missing.
- **Next action:** Retry the managed launch (`oma ralph|ultrawork|search -- ...`). If it persists, check that the host binary actually spawned.

<a id="e-production-evidence"></a>

## `E_PRODUCTION_EVIDENCE`

- **Summary:** Production live-evidence verification failed closed.
- **Likely cause:** One or more of the seven Git-OID-bound live seams is missing, stale, skipped, or invalid. That is expected without fresh captures.
- **Next action:** Capture each required seam with `oma production capture` / `oma production probe`, then re-run `oma production verify` on the same OID.

<a id="e-reclaim-identity-unproven"></a>

## `E_RECLAIM_IDENTITY_UNPROVEN`

- **Summary:** Worker reclaim lacked dead-pane and dead-process proof.
- **Likely cause:** Reclaim is fail-closed unless both pane and process are proven dead; alive/unknown is not enough.
- **Next action:** Re-run `oma team reclaim` only with `--pane dead --process dead` after you can prove both are gone.

<a id="e-recovery-fork-already-resolved"></a>

## `E_RECOVERY_FORK_ALREADY_RESOLVED`

- **Summary:** That recovery fork was already resolved.
- **Likely cause:** A second resolve-fork hit an aggregate that already records a winner.
- **Next action:** Read `oma team status` and continue from the recorded winner; do not re-resolve the same fork id.

<a id="e-recovery-fork-unresolved"></a>

## `E_RECOVERY_FORK_UNRESOLVED`

- **Summary:** A recovery fork is still unresolved.
- **Likely cause:** Supervise/tick/delivery cannot continue while a fenced recovery fork is open.
- **Next action:** Choose a winner with `oma team resolve-fork --team <id> --fork <id> --winner-generation <n> --expected-revision <n> --evidence <file>`.

<a id="e-resume-ambiguous"></a>

## `E_RESUME_AMBIGUOUS`

- **Summary:** Resume matched more than one conversation.
- **Likely cause:** The selector was not exact enough to pick a single bound conversation.
- **Next action:** Pass the exact `--conversation` id from `oma session list` instead of a partial selector.

<a id="e-resume-not-found"></a>

## `E_RESUME_NOT_FOUND`

- **Summary:** No resume source matched the selector.
- **Likely cause:** The session/conversation id is unknown in the continuation inventory.
- **Next action:** Run `oma session list` / `oma resume --list` and pass an exact `--session` and `--conversation`.

<a id="e-retryable-blocker"></a>

## `E_RETRYABLE_BLOCKER`

- **Summary:** A retryable launch or sandbox blocker stopped the process.
- **Likely cause:** Sandbox is required but unavailable, git identity is missing, or the host process failed to spawn.
- **Next action:** Install `bwrap`/`sandbox-exec` or git as the message says, unset `OMA_REQUIRE_SANDBOX` only if you intend an unsandboxed search, then retry.

<a id="e-revision-conflict"></a>

## `E_REVISION_CONFLICT`

- **Summary:** CAS expected-revision does not match durable state.
- **Likely cause:** Another writer advanced the aggregate; `--expected-revision` is stale.
- **Next action:** Re-read status, then retry with the current `--expected-revision` from that snapshot.

<a id="e-stale-active-pointer"></a>

## `E_STALE_ACTIVE_POINTER`

- **Summary:** The active managed-launch pointer is absent or stale.
- **Likely cause:** Resume/capability lookup found no live pointer, or the recorded outcome has no live capability.
- **Next action:** Start a fresh managed launch rather than reusing the stale pointer; then resume from the new conversation id.

<a id="e-state-root-tracked"></a>

## `E_STATE_ROOT_TRACKED`

- **Summary:** The state root sits inside a git worktree and is not ignored.
- **Likely cause:** OMA refuses to keep capability material in a tracked tree (or a temp integration root inside the leader worktree).
- **Next action:** Point `OMA_STATE_ROOT` outside the repo, or ignore `.agy/` / the state path, then retry.

<a id="e-task-scope-overlap"></a>

## `E_TASK_SCOPE_OVERLAP`

- **Summary:** Task write scopes overlap.
- **Likely cause:** Two tasks would write the same path, so parallel workers are unsafe.
- **Next action:** Make `write_scope` disjoint in the manifest, or leave overlapping tasks to serialize under max_parallel.

<a id="e-team-leader-required"></a>

## `E_TEAM_LEADER_REQUIRED`

- **Summary:** Only the team leader may perform this mutation.
- **Likely cause:** Fork resolution and other leader-only ops reject non-leader actors.
- **Next action:** Run the command as the leader (same workspace/state root that started the team), not from a worker hold.

<a id="e-terminal-state"></a>

## `E_TERMINAL_STATE`

- **Summary:** The session is already terminal.
- **Likely cause:** Autopilot/team mutation ran against a completed, cancelled, or fenced session.
- **Next action:** Start a new session (`oma autopilot start -- <goal>`) instead of advancing a terminal one.

<a id="e-tmux-owner-mismatch"></a>

## `E_TMUX_OWNER_MISMATCH`

- **Summary:** Refusing to reuse or kill a tmux session owned by someone else.
- **Likely cause:** The target tmux session exists but its owner nonce does not match this team worker.
- **Next action:** Attach with the matching owner nonce, or pick a fresh tmux session name. Do not kill a foreign session.

<a id="e-validator-rejected"></a>

## `E_VALIDATOR_REJECTED`

- **Summary:** An argument, flag, or value failed validation.
- **Likely cause:** The owning command rejected argv (range, duplicate flags, dangerous-launch policy, or schema).
- **Next action:** Read the rejection message, fix that exact argument, and see `oma --help` for usage of the owning command.

<a id="e-workspace-ambiguous"></a>

## `E_WORKSPACE_AMBIGUOUS`

- **Summary:** The event matched more than one workspace.
- **Likely cause:** Continuation identity could not resolve a single workspace for the stop/lifecycle event.
- **Next action:** Set a unique workspace identity (run from the repo root, or pass `--workspace-key`) so the event matches exactly one store.

<a id="e-workspace-mismatch"></a>

## `E_WORKSPACE_MISMATCH`

- **Summary:** This conversation is bound to a different workspace.
- **Likely cause:** The session workspace key does not match the cwd / `--workspace-key` you passed.
- **Next action:** Run from the bound workspace, or pass the exact `--workspace-key` from `oma session list`.
