/**
 * CLI 使用者可見的 `E_*` 說明目錄（非全部內部契約代碼）。
 * 設計概念映射：OMG 錯誤 envelope 的 `next_action`、OMX doctor 的
 * `<code>: <message>` 加摘要；OMA 只文件化 CLI 印出的子集，未收錄代碼
 * fail-open 維持現行 `CODE: message`（不得因此吞錯）。
 */
export const CLI_ERROR_CODES_DOC_RELATIVE_PATH = 'docs/error-codes.md';

/** `oma explain` 接受的代碼形狀；非此形狀一律 `E_VALIDATOR_REJECTED`。 */
export const CLI_ERROR_CODE_PATTERN = /^E_[A-Z][A-Z0-9_]*$/;

/** 縮排的下一步提示前綴；cataloged CLI 錯誤在 `CODE: message` 下方多印一行。 */
export const CLI_ERROR_NEXT_LINE_PREFIX = '  next: ';

export interface CliErrorCatalogEntry {
  readonly summary: string;
  readonly likelyCause: string;
  readonly nextAction: string;
  readonly docsAnchor: string;
}

function entry(
  summary: string,
  likelyCause: string,
  nextAction: string,
  docsAnchor: string,
): CliErrorCatalogEntry {
  return Object.freeze({ summary, likelyCause, nextAction, docsAnchor });
}

function docsAnchorFor(code: string): string {
  return code.toLowerCase().replace(/_/g, '-');
}

function describe(
  summary: string,
  likelyCause: string,
  nextAction: string,
): (code: string) => readonly [string, CliErrorCatalogEntry] {
  return (code) => [code, entry(summary, likelyCause, nextAction, docsAnchorFor(code))];
}

const CLI_ERROR_CATALOG_ENTRIES: ReadonlyArray<readonly [string, CliErrorCatalogEntry]> = [
  describe(
    'The oh-my-agy plugin is missing, disabled, or does not match installed bytes.',
    'Managed launch and setup preflight require an enabled plugin whose registry readback matches this package.',
    'Run `oma setup` to install and enable the plugin, then `oma doctor` until plugin_active passes.',
  )('E_PLUGIN_NOT_ACTIVE'),
  describe(
    'Production live-evidence verification failed closed.',
    'One or more of the seven Git-OID-bound live seams is missing, stale, skipped, or invalid. That is expected without fresh captures.',
    'Capture each required seam with `oma production capture` / `oma production probe`, then re-run `oma production verify` on the same OID.',
  )('E_PRODUCTION_EVIDENCE'),
  describe(
    'Refusing to reuse or kill a tmux session owned by someone else.',
    'The target tmux session exists but its owner nonce does not match this team worker.',
    'Attach with the matching owner nonce, or pick a fresh tmux session name. Do not kill a foreign session.',
  )('E_TMUX_OWNER_MISMATCH'),
  describe(
    'Worker reclaim lacked dead-pane and dead-process proof.',
    'Reclaim is fail-closed unless both pane and process are proven dead; alive/unknown is not enough.',
    'Re-run `oma team reclaim` only with `--pane dead --process dead` after you can prove both are gone.',
  )('E_RECLAIM_IDENTITY_UNPROVEN'),
  describe(
    'Durable OMA state could not be parsed or failed an integrity check.',
    'A revisioned JSON record, receipt, or git identity blob is truncated, mutated, or the wrong shape.',
    'Inspect the cited `.agy` / state-root file, restore a known-good copy, and retry. Never `git reset --hard` to "fix" it.',
  )('E_CORRUPT_STATE'),
  describe(
    'A managed-mode directive was rejected before launch.',
    'The parser requires `oma <mode> -- <non-empty task>` with no tokens between the mode and `--`.',
    'Rerun as `oma ralph -- <task>` (or ultrawork/search) with a non-empty task after `--`.',
  )('E_DIRECTIVE_INVALID'),
  describe(
    'An argument, flag, or value failed validation.',
    'The owning command rejected argv (range, duplicate flags, dangerous-launch policy, or schema).',
    'Read the rejection message, fix that exact argument, and see `oma --help` for usage of the owning command.',
  )('E_VALIDATOR_REJECTED'),
  describe(
    'CLI usage for this subcommand is invalid.',
    'A required option is missing, duplicated, or an unexpected token was supplied.',
    'Correct argv using the subcommand usage line (or `oma --help`) and retry without extra tokens.',
  )('E_CLI_USAGE'),
  describe(
    'An extended CLI command failed after usage checks passed.',
    'The subcommand threw (workflow digest, host spawn, or an internal Error wrapped by the CLI).',
    'Read the wrapped message after `E_COMMAND_FAILED:` -- it usually embeds the underlying `E_*` code -- and fix that cause.',
  )('E_COMMAND_FAILED'),
  describe(
    'The requested object does not exist.',
    'A skill name, mailbox target, or state key is not in the inventory.',
    'List the valid names first (`oma skill list`, `oma session list`, or the owning status command) and retry with an exact id.',
  )('E_NOT_FOUND'),
  describe(
    'The child process identity could not be proven.',
    'Managed spawn did not record a matching pid/owner-nonce, or the wrapper nonce is missing.',
    'Retry the managed launch (`oma ralph|ultrawork|search -- ...`). If it persists, check that the host binary actually spawned.',
  )('E_PROCESS_IDENTITY_UNPROVEN'),
  describe(
    'Resume generation does not match the bound conversation.',
    'The resume transaction did not return the exact conversation id and next invocation generation.',
    'Use `oma resume --session <id> --conversation <id> --expected-revision <n>` with the values from `oma session list`.',
  )('E_INVOCATION_GENERATION_MISMATCH'),
  describe(
    'A retryable launch or sandbox blocker stopped the process.',
    'Sandbox is required but unavailable, git identity is missing, or the host process failed to spawn.',
    'Install `bwrap`/`sandbox-exec` or git as the message says, unset `OMA_REQUIRE_SANDBOX` only if you intend an unsandboxed search, then retry.',
  )('E_RETRYABLE_BLOCKER'),
  describe(
    'Managed binding environment variables are missing.',
    'Hooks and resume expect `OMA_SESSION_ID` / `OMA_LAUNCH_NONCE` / `OMA_INVOCATION_GENERATION` from an exact-env launch.',
    'Relaunch through `oma ralph|ultrawork|search -- <task>` so binding env is injected; do not call `agy` directly for managed work.',
  )('E_BINDING_ENV_MISSING'),
  describe(
    'The conversation is already bound to a different launch.',
    'A second managed launch tried to arm a session that already has an exact conversation binding.',
    'Resume the existing conversation instead of starting a parallel launch (`oma autopilot drive` / `oma resume`).',
  )('E_BINDING_CONFLICT'),
  describe(
    'No conversation is bound to this session yet.',
    'Resume/drive ran before the first managed spawn wrote the conversation binding.',
    'Run a first managed launch for the session, then resume with the conversation id it recorded.',
  )('E_CONVERSATION_UNBOUND'),
  describe(
    'A pending managed launch is still recorded.',
    'Prepare-launch refuses a second in-flight launch for the same session.',
    'Wait for the pending child to finish or inspect the session aggregate before starting another launch.',
  )('E_PENDING_LAUNCH_EXISTS'),
  describe(
    'The active managed-launch pointer is absent or stale.',
    'Resume/capability lookup found no live pointer, or the recorded outcome has no live capability.',
    'Start a fresh managed launch rather than reusing the stale pointer; then resume from the new conversation id.',
  )('E_STALE_ACTIVE_POINTER'),
  describe(
    'This conversation is bound to a different workspace.',
    'The session workspace key does not match the cwd / `--workspace-key` you passed.',
    'Run from the bound workspace, or pass the exact `--workspace-key` from `oma session list`.',
  )('E_WORKSPACE_MISMATCH'),
  describe(
    'The event matched more than one workspace.',
    'Continuation identity could not resolve a single workspace for the stop/lifecycle event.',
    'Set a unique workspace identity (run from the repo root, or pass `--workspace-key`) so the event matches exactly one store.',
  )('E_WORKSPACE_AMBIGUOUS'),
  describe(
    'CAS expected-revision does not match durable state.',
    'Another writer advanced the aggregate; `--expected-revision` is stale.',
    'Re-read status, then retry with the current `--expected-revision` from that snapshot.',
  )('E_REVISION_CONFLICT'),
  describe(
    'State was written by a newer schema than this CLI understands.',
    'The on-disk schema_version is ahead of this package; downgrading bytes is unsafe.',
    'Upgrade `oma` to a version that understands the newer schema. Do not hand-edit or downgrade the state files.',
  )('E_FUTURE_SCHEMA'),
  describe(
    'The state root sits inside a git worktree and is not ignored.',
    'OMA refuses to keep capability material in a tracked tree (or a temp integration root inside the leader worktree).',
    'Point `OMA_STATE_ROOT` outside the repo, or ignore `.agy/` / the state path, then retry.',
  )('E_STATE_ROOT_TRACKED'),
  describe(
    'A path escaped its allowed root or the state root is unsafe.',
    'The target is a symlink, world-readable, owned by another uid, or a relative path escaped the root.',
    'Keep paths inside the workspace/state root, fix ownership/mode (owner-only), and do not point `OMA_STATE_ROOT` at a symlink.',
  )('E_PATH_OUTSIDE_ROOT'),
  describe(
    'A git identity is required but unavailable.',
    'The command needs a repository (rev-parse / common-dir) and git is missing or cwd is not a repo.',
    'Install git and rerun from inside the target repository.',
  )('E_GIT_REQUIRED'),
  describe(
    'Timed out waiting for an owner-safe lock.',
    'Another live owner still holds the lock; contenders must not delete it.',
    'Wait for the lock holder to finish. Do not delete a live lock file.',
  )('E_LOCK_TIMEOUT'),
  describe(
    'This process is not the lock owner.',
    'Release/reclaim was attempted by a pid/nonce that does not own the lock.',
    'Let the owning process release the lock, or prove the owner is dead before reclaiming via the lock helper.',
  )('E_LOCK_NOT_OWNER'),
  describe(
    'The host capability profile could not be proven.',
    'agy identity, live probe, or workflow route refresh did not yield an exact profile.',
    'Install `agy` on PATH and run `oma native probe --live` / `oma doctor --native` until the profile is proven.',
  )('E_CAPABILITY_UNPROVEN'),
  describe(
    'The Antigravity host (`agy`) is unavailable.',
    'The configured `agy` executable is missing, not executable, or version/help probes failed closed.',
    'Install `agy`, set `OMA_AGY_BIN` if it is not on PATH, then retry `oma native capabilities` / `oma doctor`.',
  )('E_CAPABILITY_HOST_UNAVAILABLE'),
  describe(
    'An explicit live native probe failed.',
    '`oma native probe --live` did not observe the required canary/profile evidence.',
    'Fix the host (install/upgrade agy, check plugin enablement) and rerun `oma native probe --live --json`.',
  )('E_LIVE_PROBE_FAILED'),
  describe(
    'The assembled host capability profile is invalid.',
    'Identity, digest, or capability rows failed the frozen profile contract.',
    'Delete the stale capability cache under the state root and rebuild with `oma native capabilities --json`.',
  )('E_CAPABILITY_PROFILE_INVALID'),
  describe(
    'The Antigravity native worker adapter is not available.',
    'This host build does not implement the native worker adapter OMA would need for that path.',
    'Use headless/tmux team workers (`oma team start`) instead of assuming a native subagent adapter exists.',
  )('E_NATIVE_ADAPTER_UNAVAILABLE'),
  describe(
    'The team manifest failed the frozen v1 contract.',
    'Schema, task ids, or write_scope bytes are missing/invalid.',
    'Fix the manifest against `oma.team-manifest/v1` and retry `oma team start --manifest <file>`.',
  )('E_MANIFEST_INVALID'),
  describe(
    'Only the team leader may perform this mutation.',
    'Fork resolution and other leader-only ops reject non-leader actors.',
    'Run the command as the leader (same workspace/state root that started the team), not from a worker hold.',
  )('E_TEAM_LEADER_REQUIRED'),
  describe(
    'Task write scopes overlap.',
    'Two tasks would write the same path, so parallel workers are unsafe.',
    'Make `write_scope` disjoint in the manifest, or leave overlapping tasks to serialize under max_parallel.',
  )('E_TASK_SCOPE_OVERLAP'),
  describe(
    'A worker wrote outside its claimed write_scope.',
    'Delivery compared the worktree diff against the task scope and found an escape.',
    'Revert the out-of-scope files in the worker worktree and deliver only scope-bounded changes.',
  )('E_DELIVERY_SCOPE_VIOLATION'),
  describe(
    'A recovery fork is still unresolved.',
    'Supervise/tick/delivery cannot continue while a fenced recovery fork is open.',
    'Choose a winner with `oma team resolve-fork --team <id> --fork <id> --winner-generation <n> --expected-revision <n> --evidence <file>`.',
  )('E_RECOVERY_FORK_UNRESOLVED'),
  describe(
    'That recovery fork was already resolved.',
    'A second resolve-fork hit an aggregate that already records a winner.',
    'Read `oma team status` and continue from the recorded winner; do not re-resolve the same fork id.',
  )('E_RECOVERY_FORK_ALREADY_RESOLVED'),
  describe(
    'The session is already terminal.',
    'Autopilot/team mutation ran against a completed, cancelled, or fenced session.',
    'Start a new session (`oma autopilot start -- <goal>`) instead of advancing a terminal one.',
  )('E_TERMINAL_STATE'),
  describe(
    'No resume source matched the selector.',
    'The session/conversation id is unknown in the continuation inventory.',
    'Run `oma session list` / `oma resume --list` and pass an exact `--session` and `--conversation`.',
  )('E_RESUME_NOT_FOUND'),
  describe(
    'Resume matched more than one conversation.',
    'The selector was not exact enough to pick a single bound conversation.',
    'Pass the exact `--conversation` id from `oma session list` instead of a partial selector.',
  )('E_RESUME_AMBIGUOUS'),
];

export const CLI_ERROR_CATALOG: Readonly<Record<string, CliErrorCatalogEntry>> = Object.freeze(
  Object.fromEntries(CLI_ERROR_CATALOG_ENTRIES),
);

export function isCliErrorCode(value: string): boolean {
  return CLI_ERROR_CODE_PATTERN.test(value);
}

export function lookupCliErrorCatalog(code: string): CliErrorCatalogEntry | undefined {
  if (!Object.prototype.hasOwnProperty.call(CLI_ERROR_CATALOG, code)) return undefined;
  return CLI_ERROR_CATALOG[code];
}

/**
 * CLI `CODE: message` 列印。目錄命中時縮排多印 `next:`；未收錄維持一行（fail-open）。
 */
export function formatCliError(code: string, message: string): string {
  const lines = [`${code}: ${message}`];
  const cataloged = lookupCliErrorCatalog(code);
  if (cataloged !== undefined) {
    lines.push(`${CLI_ERROR_NEXT_LINE_PREFIX}${cataloged.nextAction}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderCliErrorCatalogMarkdown(): string {
  const codes = Object.keys(CLI_ERROR_CATALOG).sort((left, right) => {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
  });
  const sections = codes.map((code) => {
    const item = CLI_ERROR_CATALOG[code];
    return [
      `<a id="${item.docsAnchor}"></a>`,
      '',
      `## \`${code}\``,
      '',
      `- **Summary:** ${item.summary}`,
      `- **Likely cause:** ${item.likelyCause}`,
      `- **Next action:** ${item.nextAction}`,
    ].join('\n');
  });
  return [
    '# CLI-visible error codes',
    '',
    'This document lists **only the CLI-visible subset** of OMA `E_*` codes --',
    'those printed to users by the `oma` CLI (`src/cli/application.ts` and other',
    'CLI stderr printers that emit `CODE: message`). Internal contract codes',
    '(hundreds of `E_*` values used only inside hooks, state machines, and tests)',
    'are **intentionally omitted**. `oma explain` for an uncataloged `E_*` code',
    'exits non-zero with `E_NOT_IN_CATALOG` rather than inventing a template.',
    '',
    'Source of truth: [`src/runtime/error-catalog.ts`](../src/runtime/error-catalog.ts).',
    'Unit tests fail if this file drifts from the catalog map.',
    '',
    'Look up a code: `oma explain <E_CODE>` or `oma explain <E_CODE> --json`.',
    '',
    sections.join('\n\n'),
    '',
  ].join('\n');
}
