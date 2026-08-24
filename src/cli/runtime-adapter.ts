import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { canonicalBytesV1 } from '../contracts/state-schemas';
import {
  RepositoryWorkflowV1,
  validateRepositoryWorkflow,
} from '../contracts/repository-workflow';
import { AggregateEnvelopeV1, sha256Hex } from '../contracts/writer-chain';
import { resolveCanonicalAgyIdentity } from '../native/antigravity-status';
import {
  HostCapabilityProfileV1,
  HostRouteReceiptV1,
  assembleHostCapabilityProfile,
  createHostCapabilityCacheKey,
  issueHostRouteReceipt,
  routeHostCapability,
  validateHostRouteReceipt,
} from '../native/capability-profile';
import {
  HostCapabilityProfileCacheV1,
  LIVE_MODEL_CANARY_OUTER_TIMEOUT_MS,
  LIVE_MODEL_CANARY_PRINT_TIMEOUT_MS,
  BoundedProbeOutcomeV1,
  PASSIVE_PROBE_LIMITS_V1,
  assemblePassiveHostCapabilityProfile,
  absentPluginIdentity,
  completeLiveCapabilityProbeCoverage,
  completePassiveObservationCoverage,
  inspectExecutableIdentity,
  isHostCapabilityProfileFresh,
  parseHookManifestReadback,
  parsePluginReadback,
  probeConfigObject,
  probeDocumentedHelp,
  runBoundedProbe,
  runExplicitLiveProbe,
  unknownPluginIdentity,
} from '../native/probes';
import {
  ManagedLaunchTransaction as RuntimeManagedLaunchTransaction,
  SessionLocator,
} from '../continuation/state';
import { formatCliError } from '../runtime/error-catalog';
import { RuntimeError, runtimeError } from '../runtime/errors';
import { currentProcessIdentity, ProcessRunner } from '../runtime/process';
import {
  StateRootOptions,
  WorkspaceIdentityV1,
  resolveStateRoot,
  resolveWorkspaceIdentity,
} from '../runtime/state-root';
import { ProcessIdentity, Result, err, ok } from '../runtime/types';
import { PluginCommandAdapter, verifyPluginActive } from '../setup/plugin';
import { AGY_WORKER_MODEL, buildAgy115Argv } from '../team/agy-argv';
import { validateProviderRoutePreconditions } from '../team/provider';
import {
  assertRepositoryExternalAuthorityRoot,
  workflowAuthorityDigest,
  workflowVerdictOutputSchema,
} from '../workflows/authority';
import {
  WorkflowPermissionContextV1,
  compileWorkflowPermissions,
} from '../workflows/permissions';
import { readyWorkflowTasks } from '../workflows/planner';
import {
  appendWorkflowJournalEvent,
  readWorkflowJournal,
  replayWorkflowEvents,
} from '../workflows/replay';
import { evaluateWorkflowReview } from '../workflows/review';
import {
  WorkflowDispatchAdapterV1,
  WorkflowDispatchInputV1,
  WorkflowPlanV1,
  WorkflowProductAuthorityV1,
  WorkflowRunSnapshotV1,
  WorkflowTaskReceiptV1,
  dependencyResultsFromReceipts,
  workflowPlanDigest,
} from '../workflows/schema';
import {
  ManagedInvocationService,
  ManagedLaunchTransaction,
  PrepareManagedLaunchInput,
  PrepareManagedResumeInput,
  PreparedManagedInvocation,
  ordinaryEnvironment,
} from './managed-invocation';
import { runCancelCommand } from './cancel-command';
import { ExtendedCliCommand, NativeCliCommand } from './parser';
import { runSessionListCommand } from './session-commands';
import { runHooksCommand } from './hooks-commands';

export interface RuntimeManagedTransactionOptions {
  readonly cwd?: string;
  readonly stateRoot?: StateRootOptions;
  readonly launchTtlMs?: number;
  readonly sessionIdFactory?: () => string;
  readonly launchNonceFactory?: () => string;
  readonly ownerNonceFactory?: () => string;
  readonly operationIdFactory?: () => string;
}

interface ActiveCapability {
  readonly prepared: PreparedManagedInvocation;
  readonly capability: RuntimeManagedLaunchTransaction;
}

export class RuntimeManagedTransactionAdapter implements ManagedLaunchTransaction {
  readonly stateRoot: string;
  readonly workspace: WorkspaceIdentityV1;
  private readonly locator: SessionLocator;
  private readonly launchTtlMs: number;
  private readonly sessionIdFactory: () => string;
  private readonly launchNonceFactory: () => string;
  private readonly ownerNonceFactory: () => string;
  private readonly operationIdFactory: () => string;
  private readonly active = new Map<string, ActiveCapability>();

  static create(
    options: Readonly<RuntimeManagedTransactionOptions> = {},
  ): Result<RuntimeManagedTransactionAdapter, RuntimeError> {
    const stateRoot = resolveStateRoot(options.stateRoot);
    if (!stateRoot.ok) return stateRoot;
    const workspace = resolveWorkspaceIdentity(options.cwd ?? process.cwd());
    if (!workspace.ok) return workspace;
    return ok(new RuntimeManagedTransactionAdapter(stateRoot.value.path, workspace.value, options));
  }

  private constructor(
    stateRoot: string,
    workspace: WorkspaceIdentityV1,
    options: Readonly<RuntimeManagedTransactionOptions>,
  ) {
    this.stateRoot = stateRoot;
    this.workspace = workspace;
    this.launchTtlMs = options.launchTtlMs ?? 30_000;
    this.sessionIdFactory = options.sessionIdFactory ?? (() => crypto.randomUUID());
    this.launchNonceFactory = options.launchNonceFactory
      ?? (() => crypto.randomBytes(32).toString('hex'));
    this.ownerNonceFactory = options.ownerNonceFactory
      ?? (() => crypto.randomBytes(16).toString('hex'));
    this.operationIdFactory = options.operationIdFactory ?? (() => crypto.randomUUID());
    this.locator = new SessionLocator(this.stateRoot, this.workspace.workspaceKey, {
      nonceFactory: this.launchNonceFactory,
      resumeOwnerFactory: () => currentProcessIdentity(this.ownerNonceFactory()),
    });
  }

  async prepareLaunch(
    _input: Readonly<PrepareManagedLaunchInput>,
  ): Promise<Result<PreparedManagedInvocation, RuntimeError>> {
    const ownerNonce = this.ownerNonceFactory();
    const created = await this.locator.createManagedLaunch({
      sessionId: this.sessionIdFactory(),
      repoKey: this.workspace.repoKey,
      workspaceKey: this.workspace.workspaceKey,
      workspacePath: this.workspace.workspacePath,
      launchNonce: this.launchNonceFactory(),
      owner: currentProcessIdentity(ownerNonce),
      ttlMs: this.launchTtlMs,
    });
    if (!created.ok) return created;
    return this.activate(created.value.session, created.value.transaction);
  }

  async prepareResume(
    input: Readonly<PrepareManagedResumeInput>,
  ): Promise<Result<PreparedManagedInvocation, RuntimeError>> {
    const resumed = await this.locator.prepareResume(input.conversationId, input.expectedRevision);
    if (!resumed.ok) return resumed;
    if (resumed.value.sessionId !== input.sessionId) {
      return err(runtimeError('E_WORKSPACE_MISMATCH', 'Conversation is not bound to the requested session', {
        requestedSessionId: input.sessionId,
      }));
    }
    return this.activate(resumed.value, this.locator.managedLaunch(resumed.value));
  }

  recordChildSpawned(
    prepared: Readonly<PreparedManagedInvocation>,
    identity: Readonly<ProcessIdentity>,
  ): Result<void, RuntimeError> {
    const active = this.active.get(prepared.operationIdentity.operationId);
    if (active === undefined || !samePreparedIdentity(active.prepared, prepared)) {
      return err(runtimeError('E_STALE_ACTIVE_POINTER', 'Managed launch capability is absent or stale'));
    }
    const recorded = active.capability.recordChildSpawned(identity);
    return recorded.ok ? ok(undefined) : recorded;
  }

  async recordOutcome(
    prepared: Readonly<PreparedManagedInvocation>,
  ): Promise<Result<void, RuntimeError>> {
    const active = this.active.get(prepared.operationIdentity.operationId);
    if (active === undefined || !samePreparedIdentity(active.prepared, prepared)) {
      return err(runtimeError('E_STALE_ACTIVE_POINTER', 'Managed launch outcome has no live capability'));
    }
    this.active.delete(prepared.operationIdentity.operationId);
    return ok(undefined);
  }

  private activate(
    session: Readonly<{
      state: 'launch_pending' | 'resume_pending' | 'bound' | 'idle';
      sessionId: string;
      conversationId: string | null;
      launchNonce: string;
      invocationGeneration: number;
      owner: ProcessIdentity;
    }>,
    capability: RuntimeManagedLaunchTransaction,
  ): Result<PreparedManagedInvocation, RuntimeError> {
    if (!['launch_pending', 'resume_pending'].includes(session.state)) {
      return err(runtimeError('E_REVISION_CONFLICT', 'Managed launch is not pending'));
    }
    const ownerNonce = session.owner.ownerNonce;
    if (ownerNonce === undefined || ownerNonce === '') {
      return err(runtimeError('E_PROCESS_IDENTITY_UNPROVEN', 'Wrapper owner nonce is missing'));
    }
    const operationId = this.operationIdFactory();
    const prepared: PreparedManagedInvocation = {
      kind: session.state === 'launch_pending' ? 'launch' : 'resume',
      launchTransactionId: operationId,
      sessionId: session.sessionId,
      conversationId: session.conversationId,
      launchNonce: session.launchNonce,
      invocationGeneration: session.invocationGeneration,
      cwd: this.workspace.workspacePath,
      operationIdentity: { operationId, ownerNonce },
    };
    this.active.set(operationId, { prepared, capability });
    return ok(prepared);
  }
}

function samePreparedIdentity(
  left: Readonly<PreparedManagedInvocation>,
  right: Readonly<PreparedManagedInvocation>,
): boolean {
  return left.launchTransactionId === right.launchTransactionId
    && left.sessionId === right.sessionId
    && left.conversationId === right.conversationId
    && left.launchNonce === right.launchNonce
    && left.invocationGeneration === right.invocationGeneration
    && left.cwd === right.cwd
    && left.operationIdentity.operationId === right.operationIdentity.operationId
    && left.operationIdentity.ownerNonce === right.operationIdentity.ownerNonce;
}

export interface ExtendedCommandContext {
  packageRoot: string;
  cwd: string;
  agyCommand: string;
  stateRoot?: string;
  pluginAdapter: PluginCommandAdapter;
  managedService(): Result<ManagedInvocationService, RuntimeError>;
  version: string;
  stdout(value: string): void;
  stderr(value: string): void;
  environment: NodeJS.ProcessEnv;
  runner: ProcessRunner;
}

class ExtendedCliUsageError extends Error {}

export interface NativeCapabilityInspectionV1 {
  readonly kind: 'profile';
  readonly profile: HostCapabilityProfileV1;
  readonly cacheStatus: 'hit' | 'miss' | 'rebuilt' | 'non_cacheable';
  readonly diagnostics: readonly { code: string; message: string }[];
  readonly liveSucceeded: boolean | null;
  readonly publicCliStatus: 'unavailable' | 'public_cli_partial' | 'public_cli_observed';
}

export interface NativeCapabilityUnavailableV1 {
  readonly kind: 'host_absent';
  readonly diagnostics: readonly { code: string; message: string }[];
}

export type NativeCapabilityInspectionResultV1 = NativeCapabilityInspectionV1 | NativeCapabilityUnavailableV1;

export async function runNativeCommand(
  command: NativeCliCommand,
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): Promise<number> {
  const asJson = argv.includes('--json');
  try {
    validateNativeOptions(command, argv);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return writeNativeFailure(command, asJson, 2, 'usage_error', {
      code: 'E_CLI_USAGE',
      message,
    }, context);
  }

  try {
    const inspection = await inspectNativeCapabilities(context, command === 'probe');
    if (inspection.kind === 'host_absent') {
      if (command === 'probe') {
        return writeNativeFailure(command, asJson, 1, 'live_probe_failed', {
          code: inspection.diagnostics[0]?.code ?? 'E_CAPABILITY_HOST_UNAVAILABLE',
          message: inspection.diagnostics[0]?.message ?? 'agy host is unavailable',
        }, context);
      }
      const result = {
        diagnostics: inspection.diagnostics,
        host: 'absent',
      };
      writeNativeSuccess(command, asJson, 'unknown', result, context);
      return 0;
    }
    const outcome = capabilityProfileOutcome(inspection.profile);
    if (command === 'probe' && inspection.liveSucceeded !== true) {
      return writeNativeFailure(command, asJson, 1, 'live_probe_failed', {
        code: inspection.diagnostics[0]?.code ?? 'E_LIVE_PROBE_FAILED',
        message: inspection.diagnostics[0]?.message ?? 'required live probe failed',
      }, context, inspection.profile);
    }
    writeNativeSuccess(command, asJson, outcome, inspection.profile, context, inspection.cacheStatus);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const live = command === 'probe';
    return writeNativeFailure(command, asJson, live ? 1 : 2, live ? 'live_probe_failed' : 'invalid_state', {
      code: live ? 'E_LIVE_PROBE_FAILED' : 'E_CAPABILITY_PROFILE_INVALID',
      message,
    }, context);
  }
}

export async function inspectNativeCapabilities(
  context: Pick<
    ExtendedCommandContext,
    'agyCommand' | 'stateRoot' | 'environment' | 'packageRoot' | 'pluginAdapter' | 'cwd'
  >,
  live: boolean,
): Promise<NativeCapabilityInspectionResultV1> {
  const first = await readNativeHostSurface(context.agyCommand, context.environment);
  if (first === null) {
    return {
      kind: 'host_absent',
      diagnostics: [{ code: 'E_CAPABILITY_HOST_UNAVAILABLE', message: 'agy host is unavailable' }],
    };
  }
  const hostIdentityBefore = inspectExecutableIdentity({
    executable: context.agyCommand,
    version: first.version,
    versionOutput: first.versionOutput,
    helpOutput: first.helpOutput,
    pathEnvironment: context.environment.PATH,
  });
  const publicCliStatusBefore = classifyNativePublicCliStatus(first);
  const pluginBefore = await inspectNativePlugin(context);
  const pluginIdentity = pluginBefore.identity;
  const diagnostics: Array<{ code: string; message: string }> = [...pluginBefore.diagnostics];
  const identityDigest = crypto.createHash('sha256').update(canonicalBytesV1({
    hostIdentity: hostIdentityBefore,
    pluginIdentity,
  })).digest('hex');
  const expectedCacheKey = createHostCapabilityCacheKey({
    hostIdentity: hostIdentityBefore,
    pluginIdentity,
  });
  const stateRoot = nativeStateRoot(context.stateRoot, context.environment);
  const cache = stateRoot === null ? null : new HostCapabilityProfileCacheV1(stateRoot);
  const cacheReadAt = new Date().toISOString();
  const cacheSnapshotBefore = cache?.readSnapshot(expectedCacheKey) ?? null;
  if (!live) {
    if (cacheSnapshotBefore !== null
      && isHostCapabilityProfileFresh(cacheSnapshotBefore.profile, cacheReadAt)) {
      return {
        kind: 'profile', profile: cacheSnapshotBefore.profile, cacheStatus: 'hit', diagnostics: [],
        liveSucceeded: null, publicCliStatus: publicCliStatusBefore,
      };
    }
  }
  const probeContext = {
    mode: 'passive',
    evaluationTimestamp: cacheReadAt,
    identityDigest,
    hostIdentity: hostIdentityBefore,
    pluginIdentity,
    runner: async () => first.helpOutcome,
  } as const;
  const passive = await probeDocumentedHelp(
    hostIdentityBefore.realpath,
    probeContext,
    () => new Date().toISOString(),
  );
  const passiveObservedAt = passive.observations[0]?.observedAt;
  if (passiveObservedAt === undefined) throw new Error('passive help probe returned no capability observation');
  const readbackContext = { ...probeContext, evaluationTimestamp: passiveObservedAt } as const;
  const observations = [...passive.observations];
  const configReadback = probeConfigObject(pluginBefore.configProjection, readbackContext);
  observations.push(...configReadback.observations);
  const pluginReadback = pluginIdentity.status === 'present'
    ? parsePluginReadback(pluginBefore.readback, readbackContext)
    : pluginIdentity.status === 'absent'
      ? { observations: [], cacheable: true, detailCode: 'PLUGIN_ABSENT' }
      : { observations: [], cacheable: false, detailCode: 'PLUGIN_READBACK_UNKNOWN' };
  observations.push(...pluginReadback.observations);
  const hookReadback = parseHookManifestReadback(pluginBefore.hookManifestSource, readbackContext);
  observations.push(...hookReadback.observations);
  let liveSucceeded: boolean | null = null;
  if (live) {
    const liveContext = {
      mode: 'live',
      liveOptIn: true,
      evaluationTimestamp: passiveObservedAt,
      identityDigest,
      hostIdentity: hostIdentityBefore,
      pluginIdentity,
    } as const;
    const jsonAdvertised = passive.observations.some(({ capability, result }) =>
      capability === 'headless.json' && result === 'positive');
    let completedAt = passiveObservedAt;
    if (jsonAdvertised) {
      const jsonToken = `oma-native-live-${crypto.randomBytes(12).toString('hex')}`;
      const jsonResult = await runExplicitLiveProbe({
        live: true,
        executable: hostIdentityBefore.realpath,
        argv: [
          '--model', AGY_WORKER_MODEL,
          '--output-format', 'json',
          '--print', `Reply with exactly this token and nothing else: ${jsonToken}`,
          '--print-timeout', `${LIVE_MODEL_CANARY_PRINT_TIMEOUT_MS / 1_000}s`,
          '--mode', 'plan',
          '--sandbox',
        ],
        capability: 'headless.json',
        expectedToken: jsonToken,
        outputContract: 'agy_json',
        timeoutMs: LIVE_MODEL_CANARY_OUTER_TIMEOUT_MS,
        environment: context.environment,
        context: { ...liveContext, evaluationTimestamp: completedAt },
      });
      observations.push(...jsonResult.observations);
      completedAt = jsonResult.observations[0]?.observedAt;
      if (completedAt === undefined) throw new Error('JSON live probe returned no capability observation');
      if (jsonResult.detailCode !== 'LIVE_VERIFIED') {
        diagnostics.push({ code: jsonResult.detailCode, message: 'optional JSON live probe did not verify' });
      }
    }
    const writeWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-native-write-'));
    fs.chmodSync(writeWorkspace, 0o700);
    const writeToken = `oma-native-live-${crypto.randomBytes(12).toString('hex')}`;
    let writeResult: Awaited<ReturnType<typeof runExplicitLiveProbe>>;
    try {
      const writeArgv = buildAgy115Argv({
        launchMode: 'headless',
        capabilityMode: 'read-write',
        prompt: `Reply with exactly this token and nothing else: ${writeToken}`,
        boundedDuration: `${LIVE_MODEL_CANARY_PRINT_TIMEOUT_MS / 1_000}s`,
        workspaceDirectories: [writeWorkspace],
        model: AGY_WORKER_MODEL,
      });
      if (!writeArgv.ok) throw new Error(`read-write live probe argv is invalid: ${writeArgv.error.message}`);
      writeResult = await runExplicitLiveProbe({
        live: true,
        executable: hostIdentityBefore.realpath,
        argv: writeArgv.value,
        capability: 'headless.print',
        expectedToken: writeToken,
        outputContract: 'exact_text',
        timeoutMs: LIVE_MODEL_CANARY_OUTER_TIMEOUT_MS,
        environment: context.environment,
        context: { ...liveContext, evaluationTimestamp: completedAt },
      });
    } finally {
      fs.rmSync(writeWorkspace, { recursive: true, force: true });
    }
    completedAt = writeResult.observations[0]?.observedAt;
    if (completedAt === undefined) throw new Error('read-write live probe returned no capability observation');
    if (writeResult.detailCode !== 'LIVE_VERIFIED') {
      observations.push(...writeResult.observations);
      liveSucceeded = false;
      diagnostics.push({
        code: writeResult.detailCode,
        message: 'required read-write exact-text live probe did not verify',
      });
    } else {
      const textToken = `oma-native-live-${crypto.randomBytes(12).toString('hex')}`;
      const textArgv = buildAgy115Argv({
        launchMode: 'headless',
        capabilityMode: 'read-only',
        prompt: `Reply with exactly this token and nothing else: ${textToken}`,
        boundedDuration: `${LIVE_MODEL_CANARY_PRINT_TIMEOUT_MS / 1_000}s`,
        workspaceDirectories: [fs.realpathSync(context.cwd)],
        model: AGY_WORKER_MODEL,
      });
      if (!textArgv.ok) throw new Error(`read-only live probe argv is invalid: ${textArgv.error.message}`);
      const textResult = await runExplicitLiveProbe({
        live: true,
        executable: hostIdentityBefore.realpath,
        argv: textArgv.value,
        capability: 'headless.print',
        expectedToken: textToken,
        outputContract: 'exact_text',
        timeoutMs: LIVE_MODEL_CANARY_OUTER_TIMEOUT_MS,
        environment: context.environment,
        context: { ...liveContext, evaluationTimestamp: completedAt },
      });
      observations.push(...textResult.observations);
      completedAt = textResult.observations[0]?.observedAt;
      if (completedAt === undefined) throw new Error('read-only live probe returned no capability observation');
      liveSucceeded = textResult.detailCode === 'LIVE_VERIFIED';
      if (!liveSucceeded) {
        diagnostics.push({
          code: textResult.detailCode,
          message: 'required read-only exact-text live probe did not verify',
        });
      }
    }
    const completedLiveContext = { ...liveContext, evaluationTimestamp: completedAt } as const;
    observations.splice(
      0,
      observations.length,
      ...completeLiveCapabilityProbeCoverage(observations, completedLiveContext),
    );
  }
  const second = await readNativeHostSurface(hostIdentityBefore.realpath, context.environment);
  if (second === null) throw new Error('agy host disappeared during capability inspection');
  const hostIdentityAfter = inspectExecutableIdentity({
    executable: hostIdentityBefore.realpath,
    version: second.version,
    versionOutput: second.versionOutput,
    helpOutput: second.helpOutput,
    pathEnvironment: context.environment.PATH,
  });
  const publicCliStatus = combineNativePublicCliStatus(
    publicCliStatusBefore,
    classifyNativePublicCliStatus(second),
  );
  const pluginAfter = await inspectNativePlugin(context);
  diagnostics.push(...pluginAfter.diagnostics);
  const evaluationTimestamp = new Date().toISOString();
  const profile = live
    ? assembleHostCapabilityProfile({
      evaluationTimestamp,
      hostIdentityBefore,
      hostIdentityAfter,
      pluginIdentityBefore: pluginIdentity,
      pluginIdentityAfter: pluginAfter.identity,
      observations: completePassiveObservationCoverage(observations, evaluationTimestamp, identityDigest),
      cacheable: passive.cacheable && configReadback.cacheable && pluginReadback.cacheable && hookReadback.cacheable
        && liveSucceeded === true,
    })
    : assemblePassiveHostCapabilityProfile({
      evaluationTimestamp,
      hostIdentityBefore,
      hostIdentityAfter,
      pluginIdentityBefore: pluginIdentity,
      pluginIdentityAfter: pluginAfter.identity,
      probeResults: [passive, configReadback, pluginReadback, hookReadback],
    });
  let cacheStatus: NativeCapabilityInspectionV1['cacheStatus'] = 'non_cacheable';
  if (live && liveSucceeded !== true && cache !== null) {
    await cache.invalidate(expectedCacheKey, cacheSnapshotBefore);
  } else if (cache !== null && passive.cacheable && configReadback.cacheable && pluginReadback.cacheable && hookReadback.cacheable
    && profile.cacheable
    && (!live || liveSucceeded === true)) {
    const committed = await cache.commit(profile);
    cacheStatus = committed === 'conflict' ? 'non_cacheable' : committed === 'unchanged' ? 'hit' : 'rebuilt';
  } else if (!live && cache === null) {
    cacheStatus = 'miss';
  }
  return { kind: 'profile', profile, cacheStatus, diagnostics, liveSucceeded, publicCliStatus };
}

async function inspectNativePlugin(
  context: Pick<ExtendedCommandContext, 'packageRoot' | 'pluginAdapter' | 'environment'>,
): Promise<{
  identity: import('../native/capability-profile').PluginIdentityV1;
  readback: string;
  hookManifestSource: string | null;
  configProjection: Record<string, unknown>;
  diagnostics: Array<{ code: string; message: string }>;
}> {
  const active = await verifyPluginActive({
    packageRoot: context.packageRoot,
    adapter: context.pluginAdapter,
    homeDir: context.environment.HOME,
    antigravityConfigRoot: context.environment.OMA_ANTIGRAVITY_CONFIG_ROOT
      ?? context.environment.ANTIGRAVITY_CONFIG_ROOT,
  });
  if (!active.ok) {
    const affirmativelyAbsent = active.error.details?.reason === 'registry_absent';
    return {
      identity: affirmativelyAbsent ? absentPluginIdentity() : unknownPluginIdentity(),
      readback: '{}',
      hookManifestSource: null,
      configProjection: {},
      diagnostics: affirmativelyAbsent ? [] : [{ code: active.error.code, message: active.error.message }],
    };
  }
  const inventory = active.value.identity.inventory.map(({ path: relative }) => relative);
  const surface: Record<string, true> = {};
  if (inventory.some((relative) => relative.startsWith('skills/'))) surface.skills = true;
  if (inventory.some((relative) => relative.startsWith('rules/'))) surface.rules = true;
  if (inventory.includes('.mcp.json') || inventory.includes('mcp_config.json')) surface.mcp_config = true;
  if (inventory.includes('hooks.json')) surface['hooks.json'] = true;
  if (inventory.some((relative) => relative.startsWith('sidecars/'))) surface.sidecars = true;
  const agentMarkdown = inventory.filter((relative) => /^agents\/.+\.md$/u.test(relative));
  if (agentMarkdown.length > 0) surface.agent_markdown = true;
  if (agentMarkdown.some((relative) => /(?:^|\/)main\.md$/u.test(relative))) surface.main_agent = true;
  if (agentMarkdown.some((relative) => /subagent/iu.test(relative))) surface.subagent_markdown = true;
  if (agentMarkdown.some((relative) => /(?:^|\/)\.[^/]+\.md$/u.test(relative))) surface.hidden_agent_markdown = true;
  if (active.value.components.includes('workspace')) surface.workspace = true;
  if (active.value.components.includes('global')) surface.global = true;
  const configProjection: Record<string, unknown> = {};
  if (surface.skills) configProjection['plugin.skills'] = true;
  if (surface.rules) configProjection['plugin.rules'] = true;
  if (surface.mcp_config) {
    configProjection['plugin.mcp_config'] = true;
    configProjection['mcp.local_config'] = true;
  }
  if (surface['hooks.json']) configProjection['plugin.hooks_manifest'] = true;
  if (surface.workspace) configProjection['plugin.layout.workspace'] = true;
  if (surface.global) configProjection['plugin.layout.global'] = true;
  if (surface.sidecars) configProjection['sidecar.layout.plugin'] = true;
  if (surface.agent_markdown) {
    configProjection['custom_agent.markdown'] = true;
    configProjection['subagent.define'] = true;
  }
  if (surface.main_agent) configProjection['custom_agent.main_agent'] = true;
  if (surface.subagent_markdown) configProjection['custom_agent.subagent'] = true;
  if (surface.hidden_agent_markdown) configProjection['custom_agent.hidden'] = true;
  return {
    identity: {
      status: 'present',
      realpath: active.value.installPath,
      packageDigest: active.value.installedDigest,
      version: active.value.version,
      readbackDigest: active.value.listStdoutSha256,
      enabled: true,
    },
    readback: JSON.stringify(surface),
    hookManifestSource: inventory.includes('hooks.json')
      ? readInstalledHookManifest(active.value.installPath)
      : null,
    configProjection,
    diagnostics: [],
  };
}

function readInstalledHookManifest(pluginRoot: string): string {
  try {
    const root = fs.realpathSync(pluginRoot);
    const target = path.join(root, 'hooks.json');
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) return '';
    const realpath = fs.realpathSync(target);
    if (!realpath.startsWith(`${root}${path.sep}`)) return '';
    return fs.readFileSync(realpath, 'utf8');
  } catch (_) {
    return '';
  }
}

function validateNativeOptions(command: NativeCliCommand, argv: readonly string[]): void {
  const allowed = command === 'capabilities' ? new Set(['--json']) : new Set(['--live', '--json']);
  const seen = new Set<string>();
  for (const arg of argv) {
    if (!allowed.has(arg)) throw new ExtendedCliUsageError(`native ${command}: unexpected argument ${JSON.stringify(arg)}`);
    if (seen.has(arg)) throw new ExtendedCliUsageError(`native ${command}: duplicate option ${arg}`);
    seen.add(arg);
  }
  if (command === 'probe' && !seen.has('--live')) {
    throw new ExtendedCliUsageError('native probe requires literal --live');
  }
}

async function readNativeHostSurface(
  executable: string,
  environment: NodeJS.ProcessEnv,
): Promise<{
  version: string | null;
  versionOutput: string;
  helpOutput: string;
  versionOutcome: BoundedProbeOutcomeV1;
  helpOutcome: BoundedProbeOutcomeV1;
} | null> {
  const limits = {
    timeoutMs: PASSIVE_PROBE_LIMITS_V1.timeoutMs,
    maximumOutputBytes: PASSIVE_PROBE_LIMITS_V1.maximumOutputBytes,
    maximumProcesses: PASSIVE_PROBE_LIMITS_V1.maximumProcesses,
  } as const;
  const versionOutcome = await runBoundedProbe({
    command: executable,
    argv: ['--version'],
    environment,
    ...limits,
  });
  const helpOutcome = await runBoundedProbe({
    command: executable,
    argv: ['--help'],
    environment,
    ...limits,
  });
  if (isExecutableMissing(versionOutcome) || isExecutableMissing(helpOutcome)) return null;
  const versionOutput = `${versionOutcome.stdout}${versionOutcome.stderr}`;
  const helpOutput = `${helpOutcome.stdout}${helpOutcome.stderr}`;
  const parsed = versionOutcome.status === 0 && !versionOutcome.timedOut
    && !versionOutcome.outputOverflow && !versionOutcome.processCountOverflow
    && versionOutcome.error === undefined
    ? versionOutput.match(/(?:^|\s)(\d+\.\d+\.\d+)(?:\s|$)/u)?.[1] ?? null
    : null;
  return { version: parsed, versionOutput, helpOutput, versionOutcome, helpOutcome };
}

function classifyNativePublicCliStatus(surface: Readonly<{
  versionOutcome: BoundedProbeOutcomeV1;
  helpOutcome: BoundedProbeOutcomeV1;
}>): NativeCapabilityInspectionV1['publicCliStatus'] {
  const versionObserved = boundedProbeSucceeded(surface.versionOutcome);
  const helpObserved = boundedProbeSucceeded(surface.helpOutcome);
  return versionObserved && helpObserved
    ? 'public_cli_observed'
    : versionObserved || helpObserved ? 'public_cli_partial' : 'unavailable';
}

function combineNativePublicCliStatus(
  before: NativeCapabilityInspectionV1['publicCliStatus'],
  after: NativeCapabilityInspectionV1['publicCliStatus'],
): NativeCapabilityInspectionV1['publicCliStatus'] {
  if (before === 'public_cli_observed' && after === 'public_cli_observed') return 'public_cli_observed';
  return before === 'unavailable' && after === 'unavailable' ? 'unavailable' : 'public_cli_partial';
}

function boundedProbeSucceeded(outcome: Readonly<BoundedProbeOutcomeV1>): boolean {
  return outcome.status === 0 && !outcome.timedOut && !outcome.outputOverflow
    && !outcome.processCountOverflow && outcome.error === undefined;
}

function isExecutableMissing(result: Readonly<BoundedProbeOutcomeV1>): boolean {
  return result.status === null && /\b(?:ENOENT|EACCES)\b/u.test(result.error ?? '');
}

function nativeStateRoot(configured: string | undefined, environment: NodeJS.ProcessEnv): string | null {
  const resolved = resolveStateRoot({
    create: true,
    env: { ...environment, ...(configured === undefined ? {} : { OMA_STATE_ROOT: configured }) },
    homeDirectory: environment.HOME ?? os.homedir(),
  });
  return resolved.ok ? resolved.value.path : null;
}

function capabilityProfileOutcome(profile: HostCapabilityProfileV1): 'supported' | 'unsupported' | 'unknown' | 'mixed' {
  const outcomes = new Set(profile.capabilities.map(({ outcome }) => outcome));
  return outcomes.size === 1 ? [...outcomes][0]! : 'mixed';
}

function writeNativeSuccess(
  command: NativeCliCommand,
  asJson: boolean,
  outcome: 'supported' | 'unsupported' | 'unknown' | 'mixed',
  result: unknown,
  context: Pick<ExtendedCommandContext, 'stdout'>,
  cacheStatus?: NativeCapabilityInspectionV1['cacheStatus'],
): void {
  if (asJson) {
    context.stdout(`${canonicalBytesV1({
      command: `native ${command}`,
      exitCode: 0,
      ok: true,
      outcome,
      ...(result !== null && typeof result === 'object' && 'schema' in result ? { profile: result } : { result }),
      ...(cacheStatus === undefined ? {} : { cacheStatus }),
      schema: 'oma.native-command-result/v1',
    }).toString('utf8')}\n`);
    return;
  }
  if (result !== null && typeof result === 'object' && 'capabilities' in result) {
    const profile = result as HostCapabilityProfileV1;
    context.stdout(`native ${command}: ${outcome} (${profile.profileDigest})\n`);
    for (const capability of profile.capabilities) {
      context.stdout(`${capability.key}: ${capability.outcome}; tier=${capability.tier ?? 'null'}; source=${capability.source ?? 'null'}; fallback=${capability.fallback}\n`);
    }
  } else {
    context.stdout(`native ${command}: ${outcome}\n`);
  }
}

function writeNativeFailure(
  command: NativeCliCommand,
  asJson: boolean,
  exitCode: 1 | 2,
  outcome: 'usage_error' | 'invalid_state' | 'live_probe_failed',
  error: { code: string; message: string },
  context: Pick<ExtendedCommandContext, 'stdout' | 'stderr'>,
  profile?: HostCapabilityProfileV1,
): number {
  if (asJson) {
    context.stdout(`${canonicalBytesV1({
      command: `native ${command}`,
      error,
      exitCode,
      ok: false,
      outcome,
      ...(profile === undefined ? {} : { profile }),
      schema: 'oma.native-command-result/v1',
    }).toString('utf8')}\n`);
  } else {
    context.stderr(formatCliError(error.code, error.message));
  }
  return exitCode;
}

export async function runExtendedCommand(
  command: ExtendedCliCommand,
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): Promise<number> {
  try {
    switch (command) {
      case 'workflow':
        return await runWorkflowCommand(argv, context);
      case 'mcp-server':
        return await runMcpServerCommand(argv, context);
      case 'wiki':
        return runWikiCommand(argv, context);
      case 'hud':
        return await runHudCommand(argv, context);
      case 'hooks':
        return runHooksCommand(argv, context);
      case 'session':
        return runSessionListCommand(argv, context);
      case 'cancel':
        return await runCancelCommand(argv, context);
      case 'native-status':
        return await runNativeStatusCommand(argv, context);
      case 'lsp-status':
        return await runLspStatusCommand(argv, context);
      case 'sidecar-status':
        return await runSidecarStatusCommand(argv, context);
      case 'notify':
        return await runNotifyCommand(argv, context);
      case 'resume':
        return await runResumeCommand(argv, context);
      case 'recovery':
        return runRecoveryCommand(argv, context);
      case 'update':
        return await runUpdateCommand(argv, context);
      case 'uninstall':
        return await runUninstallCommand(argv, context);
      case 'parity':
        return await runParityCommand(argv, context);
      case 'production':
        return await runProductionCommand(argv, context);
      case 'explain': {
        const { runExplainCommand } = await import('./explain-command');
        return runExplainCommand(argv, context);
      }
      case 'ask': {
        const { runAskCommand } = await import('./ask-command');
        return runAskCommand(argv, context);
      }
    }
  } catch (error) {
    const usage = error instanceof ExtendedCliUsageError;
    const message = error instanceof Error ? error.message : String(error);
    context.stderr(formatCliError(usage ? 'E_CLI_USAGE' : 'E_COMMAND_FAILED', message));
    return usage ? 2 : 1;
  }
}

async function runWorkflowCommand(
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === 'install') return workflowInstall(rest, context);
  if (subcommand === 'list') return workflowList(rest, context);
  if (subcommand === 'run') return await workflowRun(rest, context);
  if (subcommand === 'status') return workflowReadRun(rest, context, false);
  if (subcommand === 'replay') return workflowReadRun(rest, context, true);
  if (subcommand === 'native-status') return workflowNativeStatus(rest, context);
  throw new ExtendedCliUsageError(
    'workflow requires install|list|run|status|replay|native-status',
  );
}

function workflowInstall(
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): number {
  const source = optionValue(argv, '--source')
    ?? path.join(context.packageRoot, 'tests', 'fixtures', 'workflow', 'production-safety-review-v1.json');
  assertOnlyOptions(argv, ['--source']);
  const raw = readBoundedRegularJson(source, 1_048_576);
  const { RepositoryWorkflowRegistryV1 } = require('../workflows/registry') as typeof import('../workflows/registry');
  const registry = new RepositoryWorkflowRegistryV1();
  const definition = registry.register(raw);
  const directory = ensureRepositoryRuntimeDirectory(context.cwd, '.agy/workflows');
  const target = path.join(directory, `${definition.name}-${definition.workflow_version}.json`);
  writeStableCanonicalFile(target, definition, 0o600);
  context.stdout(`${JSON.stringify({
    ok: true,
    installed: path.relative(context.cwd, target).split(path.sep).join('/'),
    name: definition.name,
    version: definition.workflow_version,
    definition_digest: definition.definition_digest,
    authority: 'repository-workflow/v1',
  }, null, 2)}\n`);
  return 0;
}

function workflowList(
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): number {
  if (argv.length > 0) throw new ExtendedCliUsageError('workflow list accepts no arguments');
  const directory = ensureRepositoryRuntimeDirectory(context.cwd, '.agy/workflows');
  const { loadWorkflowRegistryFromDirectory } = require('../workflows/registry') as typeof import('../workflows/registry');
  const { ANTIGRAVITY_WORKFLOW_SURFACES_V1 } = require('../workflows/antigravity-adapter') as typeof import('../workflows/antigravity-adapter');
  const registry = loadWorkflowRegistryFromDirectory(directory);
  context.stdout(`${JSON.stringify({
    workflows: registry.list(),
    registry: path.relative(context.cwd, directory).split(path.sep).join('/'),
    native_surfaces: ANTIGRAVITY_WORKFLOW_SURFACES_V1,
  }, null, 2)}\n`);
  return 0;
}

async function workflowRun(
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): Promise<number> {
  const name = positionalValue(argv, 0, 'workflow run requires a workflow name');
  const inputPath = requiredOption(argv, '--input');
  const version = optionValue(argv, '--version');
  const generation = integerOption(argv, '--generation', 1, 1, Number.MAX_SAFE_INTEGER);
  assertOnlyOptions(argv.slice(1), ['--input', '--version', '--generation']);
  const registryDirectory = ensureRepositoryRuntimeDirectory(context.cwd, '.agy/workflows');
  const { loadWorkflowRegistryFromDirectory } = await import('../workflows/registry');
  const { planRepositoryWorkflow } = await import('../workflows/planner');
  const registry = loadWorkflowRegistryFromDirectory(registryDirectory);
  const definition = registry.get(name, version);
  const input = readBoundedRegularJson(inputPath, 262_144);
  if (!plainObject(input)) throw new ExtendedCliUsageError('workflow input must be a JSON object');
  const candidateOid = typeof input.candidate_oid === 'string'
    ? input.candidate_oid : input.candidate_commit;
  const head = spawnSync('git', ['-C', context.cwd, 'rev-parse', 'HEAD^{commit}'], {
    encoding: 'utf8',
    timeout: 5_000,
    shell: false,
  });
  if (head.status !== 0 || candidateOid !== `${head.stdout ?? ''}`.trim()) {
    throw new Error('E_WORKFLOW_CANDIDATE_OID: workflow input must bind exact repository HEAD');
  }
  const inputDigest = sha256Hex(canonicalBytesV1(input));
  const runId = sha256Hex(canonicalBytesV1([
    'oma-workflow-run-v1',
    definition.name,
    definition.workflow_version,
    definition.definition_digest,
    inputDigest,
    generation,
  ]));
  const plan = planRepositoryWorkflow({
    definition,
    run_id: runId,
    input_digest: inputDigest,
    generation,
  });
  const runDirectory = ensureRepositoryRuntimeDirectory(
    context.cwd,
    `.agy/state/workflows/${runId}`,
  );
  writeStableCanonicalFile(path.join(runDirectory, 'definition.json'), definition, 0o600);
  writeStableCanonicalFile(path.join(runDirectory, 'input.json'), input, 0o600);
  writeStableCanonicalFile(path.join(runDirectory, 'plan.json'), plan, 0o600);

  const journalPath = path.join(runDirectory, 'journal.jsonl');
  const authorityStateRoot = commandStateRoot(context);
  assertRepositoryExternalAuthorityRoot(authorityStateRoot, context.cwd);
  const snapshot = await executeCanonicalProductWorkflow({
    definition,
    plan,
    journal_path: journalPath,
    workflow_input: input,
    mode: 'cli',
  }, context);
  context.stdout(`${JSON.stringify({
    ok: snapshot.terminal === 'ship',
    code: snapshot.terminal === 'no_ship'
      ? 'E_WORKFLOW_PRODUCT_AUTHORITY_UNAVAILABLE' : null,
    run_id: runId,
    terminal: snapshot.terminal,
    revision: snapshot.revision,
    journal_head: snapshot.journal_head,
    warnings: snapshot.warnings,
  }, null, 2)}\n`);
  return snapshot.terminal === 'ship' ? 0 : 1;
}

interface CanonicalProductWorkflowExecutionInputV1 {
  readonly definition: RepositoryWorkflowV1;
  readonly plan: WorkflowPlanV1;
  readonly journal_path: string;
  readonly workflow_input: Readonly<Record<string, unknown>>;
  readonly mode: 'cli' | 'production';
}

interface ProductWorkflowExecutionContextV1 {
  readonly repository_root: string;
  readonly agy_command: string;
  readonly agy_executable_sha256: string;
  readonly agy_executable_byte_length: number;
  readonly environment: NodeJS.ProcessEnv;
  readonly workflow_input: Readonly<Record<string, unknown>>;
  readonly state_root: string;
  capability_profile: HostCapabilityProfileV1;
  readonly route_authorities: Map<string, ProductWorkflowRouteAuthorityV1>;
}

interface ProductWorkflowRouteAuthorityV1 {
  readonly contextDigest: string;
  readonly receipt: HostRouteReceiptV1;
}

interface ProductWorkflowVerdictV1 {
  readonly decision: WorkflowProductAuthorityV1['verdict']['decision'];
  readonly findings: WorkflowProductAuthorityV1['verdict']['findings'];
}

const PRODUCT_WORKFLOW_ROUTE_TTL_MS = 30_000;
const PRODUCT_WORKFLOW_ROUTE_REFRESH_HEADROOM_MS = 5_000;

export interface ProductWorkflowCapabilityRefreshInputV1 {
  readonly expected_realpath: string;
  readonly expected_binary_sha256: string;
  readonly now: () => string;
  inspect(live: boolean): Promise<NativeCapabilityInspectionResultV1>;
}

/** 每批重讀精確 host 身分；只有 route freshness 不足時才更新 live evidence。 */
export async function refreshProductWorkflowCapabilityProfile(
  input: Readonly<ProductWorkflowCapabilityRefreshInputV1>,
): Promise<HostCapabilityProfileV1> {
  const passive = await input.inspect(false);
  const passiveProfile = exactProductWorkflowHostProfile(passive, input);
  if (productWorkflowProfileCanRoute(passiveProfile, input.now())) return passiveProfile;

  const live = await input.inspect(true);
  const liveProfile = exactProductWorkflowHostProfile(live, input);
  if (live.kind !== 'profile' || live.liveSucceeded !== true
    || !productWorkflowProfileCanRoute(liveProfile, input.now())) {
    throw new Error('E_CAPABILITY_UNPROVEN: workflow host profile could not be refreshed');
  }
  return liveProfile;
}

function exactProductWorkflowHostProfile(
  inspected: NativeCapabilityInspectionResultV1,
  expected: Pick<
    ProductWorkflowCapabilityRefreshInputV1,
    'expected_realpath' | 'expected_binary_sha256'
  >,
): HostCapabilityProfileV1 {
  if (inspected.kind !== 'profile'
    || inspected.profile.hostIdentity.realpath !== expected.expected_realpath
    || inspected.profile.hostIdentity.binarySha256 !== expected.expected_binary_sha256) {
    throw new Error('E_CAPABILITY_UNPROVEN: workflow host identity lacks an exact capability profile');
  }
  return inspected.profile;
}

function productWorkflowProfileCanRoute(
  profile: HostCapabilityProfileV1,
  selectedAt: string,
): boolean {
  const preconditions = validateProviderRoutePreconditions(profile, 'headless', selectedAt);
  if (!preconditions.ok) return false;
  try {
    routeHostCapability(profile, {
      capability: 'headless.print',
      provider: 'agy_headless',
      requestMode: 'headless',
      generation: 0,
      contextDigest: sha256Hex(canonicalBytesV1(['oma-product-workflow-refresh/v1'])),
      selectedAt,
      ttlMs: PRODUCT_WORKFLOW_ROUTE_TTL_MS + PRODUCT_WORKFLOW_ROUTE_REFRESH_HEADROOM_MS,
      fallbackPreconditionsSatisfied: preconditions.value,
    });
    return true;
  } catch (_) {
    return false;
  }
}

async function executeCanonicalProductWorkflow(
  input: Readonly<CanonicalProductWorkflowExecutionInputV1>,
  nativeContext: Pick<
    ExtendedCommandContext,
    'agyCommand' | 'stateRoot' | 'environment' | 'packageRoot' | 'pluginAdapter' | 'cwd'
  >,
): Promise<WorkflowRunSnapshotV1> {
  const repositoryRoot = fs.realpathSync(process.cwd());
  validateCanonicalProductRun(input, repositoryRoot);
  const agy = resolveCanonicalAgyIdentity();
  const capabilityContext = {
    ...nativeContext,
    agyCommand: agy.realpath,
    cwd: repositoryRoot,
    environment: process.env,
  };
  const refreshCapabilityProfile = async () => refreshProductWorkflowCapabilityProfile({
    expected_realpath: agy.realpath,
    expected_binary_sha256: agy.sha256,
    now: () => new Date().toISOString(),
    inspect: async (live) => inspectNativeCapabilities(capabilityContext, live),
  });
  const initialProfile = await refreshCapabilityProfile();
  const resolved = resolveStateRoot({
    env: process.env,
    homeDirectory: os.homedir(),
    create: true,
  });
  if (!resolved.ok) throw new Error(`${resolved.error.code}: ${resolved.error.message}`);
  const stateRoot = fs.realpathSync(resolved.value.path);
  assertRepositoryExternalAuthorityRoot(stateRoot, repositoryRoot);
  const context: ProductWorkflowExecutionContextV1 = {
    repository_root: repositoryRoot,
    agy_command: agy.realpath,
    agy_executable_sha256: agy.sha256,
    agy_executable_byte_length: agy.byte_length,
    environment: process.env,
    workflow_input: input.workflow_input,
    state_root: stateRoot,
    capability_profile: initialProfile,
    route_authorities: new Map(),
  };
  const adapter: WorkflowDispatchAdapterV1 = {
    dispatch: (dispatchInput) => dispatchProductWorkflowTask(dispatchInput, context),
  };
  return executePrivateProductRepositoryWorkflow({
    definition: input.definition,
    plan: input.plan,
    journal_path: input.journal_path,
    adapter,
    authority_state_root: stateRoot,
    repository_root: repositoryRoot,
    refresh_capability_profile: async () => {
      context.capability_profile = await refreshCapabilityProfile();
    },
    permission_context: (taskId, attempt) => {
      const task = input.plan.tasks.find((entry) => entry.task_id === taskId);
      if (task === undefined) throw new Error('E_CAPABILITY_UNPROVEN: workflow task route is unbound');
      const authority = issueProductWorkflowRoute(
        context,
        input.plan.run_id,
        taskId,
        attempt,
        task.generation,
      );
      return {
        run_id: input.plan.run_id,
        team_id: `workflow-${input.plan.run_id}`,
        claim_id: `${taskId}:${attempt}`,
        state_endpoint: canonicalProductStateEndpoint(repositoryRoot, input),
        cancellation_token_hash: sha256Hex(canonicalBytesV1([
          'workflow-cancel',
          input.plan.run_id,
          input.plan.generation,
        ])),
        provider: authority.receipt.provider as 'agy_headless',
        provider_profile_digest: authority.receipt.profileDigest,
        route_receipt_digest: authority.receipt.receiptDigest,
        mailbox_cursor: 0,
        contributor_guidance_hashes: productContributorGuidanceHashes(repositoryRoot),
      };
    },
  });
}

function issueProductWorkflowRoute(
  context: ProductWorkflowExecutionContextV1,
  runId: string,
  taskId: string,
  attempt: number,
  generation: number,
): ProductWorkflowRouteAuthorityV1 {
  const selectedAt = new Date().toISOString();
  const preconditions = validateProviderRoutePreconditions(
    context.capability_profile,
    'headless',
    selectedAt,
  );
  if (!preconditions.ok) {
    throw new Error(`${preconditions.error.code}: ${preconditions.error.message}`);
  }
  const contextDigest = sha256Hex(canonicalBytesV1([
    'oma-product-workflow-route/v1',
    runId,
    taskId,
    attempt,
    generation,
    context.capability_profile.profileDigest,
  ]));
  const candidate = routeHostCapability(context.capability_profile, {
    capability: 'headless.print',
    provider: 'agy_headless',
    requestMode: 'headless',
    generation,
    contextDigest,
    selectedAt,
    ttlMs: PRODUCT_WORKFLOW_ROUTE_TTL_MS,
    fallbackPreconditionsSatisfied: preconditions.value,
  });
  const receipt = issueHostRouteReceipt(candidate, context.agy_command, 'agy_headless_v1');
  validateHostRouteReceipt(receipt, context.capability_profile, {
    now: selectedAt,
    generation,
    contextDigest,
    identityDigest: context.capability_profile.identityDigest,
    fallbackPreconditionsSatisfied: preconditions.value,
    provider: 'agy_headless',
    requestMode: 'headless',
  });
  const authority = { contextDigest, receipt };
  context.route_authorities.set(productWorkflowRouteKey(taskId, attempt), authority);
  return authority;
}

function productWorkflowRouteKey(taskId: string, attempt: number): string {
  return `${taskId}\0${attempt}`;
}

export interface PrivateProductRepositoryWorkflowInputV1 {
  readonly definition: RepositoryWorkflowV1;
  readonly plan: WorkflowPlanV1;
  readonly journal_path: string;
  readonly adapter: WorkflowDispatchAdapterV1;
  readonly authority_state_root: string;
  readonly repository_root: string;
  refresh_capability_profile(): Promise<void>;
  permission_context(taskId: string, attempt: number): WorkflowPermissionContextV1;
}

export async function executePrivateProductRepositoryWorkflow(
  input: PrivateProductRepositoryWorkflowInputV1,
): Promise<WorkflowRunSnapshotV1> {
  const definition = validateRepositoryWorkflow(input.definition);
  if (input.plan.definition_digest !== definition.definition_digest
    || input.plan.workflow_name !== definition.name
    || input.plan.workflow_version !== definition.workflow_version) {
    throw new Error('E_WORKFLOW_RUN: plan does not bind the supplied definition');
  }
  assertRepositoryExternalAuthorityRoot(input.authority_state_root, input.repository_root);
  const journalPath = path.resolve(input.journal_path);
  let events = readWorkflowJournal(journalPath);
  if (events.length === 0) {
    appendWorkflowJournalEvent({
      journal_path: journalPath,
      run_id: input.plan.run_id,
      kind: 'run_started',
      task_id: null,
      payload: { plan_digest: input.plan.plan_digest },
    });
    events = readWorkflowJournal(journalPath);
  }
  let snapshot = replayWorkflowEvents(input.plan, events, { allow_reconciliation: true });
  if (snapshot.terminal !== null) return snapshot;
  await reconcilePrivateProductInterrupted(input, snapshot);
  snapshot = replayWorkflowEvents(input.plan, readWorkflowJournal(journalPath));
  if (snapshot.terminal !== null) return snapshot;
  requeuePrivateProductFailures(input, snapshot, journalPath);
  snapshot = replayWorkflowEvents(input.plan, readWorkflowJournal(journalPath));

  while (true) {
    const ready = selectPrivateProductReadyBatch(definition, input.plan, snapshot);
    if (ready.length === 0) break;
    let routeProfileReady = true;
    try {
      await input.refresh_capability_profile();
    } catch (_) {
      routeProfileReady = false;
    }
    const dispatches = ready.map((task) => {
      const runtime = snapshot.tasks[task.task_id];
      const attempt = runtime.attempts + 1;
      const stage = definition.stages.find((entry) => entry.stage_id === task.stage_id)!;
      try {
        if (!routeProfileReady) {
          throw new Error('E_CAPABILITY_UNPROVEN: workflow route profile refresh failed');
        }
        const dependencyResults = dependencyResultsFromReceipts(task, snapshot.tasks);
        const permission = compileWorkflowPermissions({
          definition,
          stage,
          task,
          dependency_results: dependencyResults,
          context: input.permission_context(task.task_id, attempt),
        });
        appendWorkflowJournalEvent({
          journal_path: journalPath,
          run_id: input.plan.run_id,
          kind: 'task_dispatched',
          task_id: task.task_id,
          payload: {
            attempt,
            envelope_digest: permission.envelope_digest,
            external_effect_types: [...stage.external_effect_types],
          },
        });
        return { task, stage, attempt, dependencyResults, permission };
      } catch {
        return { task, stage, attempt, dependencyResults: [], permission: null };
      }
    });
    for (const failed of dispatches.filter((entry) => entry.permission === null)) {
      appendWorkflowJournalEvent({
        journal_path: journalPath,
        run_id: input.plan.run_id,
        kind: 'task_dispatched',
        task_id: failed.task.task_id,
        payload: {
          attempt: failed.attempt,
          envelope_digest: '0'.repeat(64),
          external_effect_types: [],
        },
      });
      appendPrivateProductReceipt(journalPath, input.plan.run_id, {
        task_id: failed.task.task_id,
        attempt: failed.attempt,
        status: 'blocked',
        result_hash: null,
        artifact_roots: [],
        approval: null,
        ship_proof_digest: null,
        external_effect_types: [],
        effect_receipt_digests: [],
        permission_denied: true,
      });
    }
    const valid = dispatches.filter((entry): entry is typeof entry & {
      permission: NonNullable<typeof entry.permission>;
    } => entry.permission !== null);
    const receipts = await Promise.all(valid.map(async (entry) => {
      try {
        return normalizePrivateProductReceipt(
          await input.adapter.dispatch({
            definition,
            plan_digest: input.plan.plan_digest,
            stage: entry.stage,
            task: entry.task,
            permission: entry.permission,
            dependency_results: entry.dependencyResults,
            attempt: entry.attempt,
          }),
          entry.task.task_id,
          entry.attempt,
          entry.stage.external_effect_types,
        );
      } catch {
        return privateProductFailureReceipt(
          entry.task.task_id,
          entry.attempt,
          entry.stage.external_effect_types,
        );
      }
    }));
    for (const receipt of receipts) {
      appendPrivateProductReceipt(journalPath, input.plan.run_id, receipt);
    }
    snapshot = replayWorkflowEvents(input.plan, readWorkflowJournal(journalPath));
    if (snapshot.terminal !== null) return snapshot;
    requeuePrivateProductFailures(input, snapshot, journalPath);
    snapshot = replayWorkflowEvents(input.plan, readWorkflowJournal(journalPath));
  }

  for (const runtime of Object.values(snapshot.tasks)
    .filter((entry) => entry.status === 'pending')) {
    const attempt = runtime.attempts + 1;
    appendWorkflowJournalEvent({
      journal_path: journalPath,
      run_id: input.plan.run_id,
      kind: 'task_dispatched',
      task_id: runtime.task.task_id,
      payload: { attempt, envelope_digest: '0'.repeat(64), external_effect_types: [] },
    });
    appendPrivateProductReceipt(journalPath, input.plan.run_id, {
      task_id: runtime.task.task_id,
      attempt,
      status: 'skipped',
      result_hash: null,
      artifact_roots: [],
      approval: null,
      ship_proof_digest: null,
      external_effect_types: [],
      effect_receipt_digests: [],
      permission_denied: false,
    });
  }
  snapshot = replayWorkflowEvents(input.plan, readWorkflowJournal(journalPath));
  const decision = evaluateWorkflowReview({
    definition,
    plan: input.plan,
    tasks: snapshot.tasks,
    authority_state_root: input.authority_state_root,
    repository_root: input.repository_root,
  });
  appendWorkflowJournalEvent({
    journal_path: journalPath,
    run_id: input.plan.run_id,
    kind: 'run_terminal',
    task_id: null,
    payload: { terminal: decision.terminal, evidence: decision.evidence },
  });
  return replayWorkflowEvents(input.plan, readWorkflowJournal(journalPath), {
    allow_product_ship: decision.terminal === 'ship',
  });
}

function selectPrivateProductReadyBatch(
  definition: RepositoryWorkflowV1,
  plan: WorkflowPlanV1,
  snapshot: WorkflowRunSnapshotV1,
) {
  const selected: ReturnType<typeof readyWorkflowTasks> = [];
  const stageCounts = new Map<string, number>();
  for (const task of readyWorkflowTasks(plan, snapshot.tasks)) {
    if (selected.length >= definition.max_parallel) break;
    const stage = definition.stages.find((entry) => entry.stage_id === task.stage_id)!;
    const count = stageCounts.get(task.stage_id) ?? 0;
    if (count >= stage.max_parallel) continue;
    selected.push(task);
    stageCounts.set(task.stage_id, count + 1);
  }
  return selected;
}

async function reconcilePrivateProductInterrupted(
  input: PrivateProductRepositoryWorkflowInputV1,
  snapshot: WorkflowRunSnapshotV1,
): Promise<void> {
  const interrupted = Object.values(snapshot.tasks)
    .filter((entry) => entry.status === 'dispatched');
  let routeProfileReady = true;
  if (interrupted.length > 0) {
    try {
      await input.refresh_capability_profile();
    } catch (_) {
      routeProfileReady = false;
    }
  }
  for (const runtime of interrupted) {
    const stage = input.definition.stages.find(
      (entry) => entry.stage_id === runtime.task.stage_id,
    )!;
    try {
      if (!routeProfileReady) {
        throw new Error('E_CAPABILITY_UNPROVEN: workflow route profile refresh failed');
      }
      const dependencyResults = dependencyResultsFromReceipts(runtime.task, snapshot.tasks);
      const permission = compileWorkflowPermissions({
        definition: input.definition,
        stage,
        task: runtime.task,
        dependency_results: dependencyResults,
        context: input.permission_context(runtime.task.task_id, runtime.attempts),
      });
      let receipt: WorkflowTaskReceiptV1 | null = null;
      if (input.adapter.reconcile !== undefined) {
        try {
          receipt = await input.adapter.reconcile({
            definition: input.definition,
            plan_digest: input.plan.plan_digest,
            stage,
            task: runtime.task,
            permission,
            dependency_results: dependencyResults,
            attempt: runtime.attempts,
          });
        } catch {
          receipt = null;
        }
      }
      appendPrivateProductReceipt(input.journal_path, input.plan.run_id, receipt === null
        ? privateProductFailureReceipt(
          runtime.task.task_id,
          runtime.attempts,
          stage.external_effect_types,
        )
        : normalizePrivateProductReceipt(
          receipt,
          runtime.task.task_id,
          runtime.attempts,
          stage.external_effect_types,
        ));
    } catch {
      appendPrivateProductReceipt(input.journal_path, input.plan.run_id, {
        task_id: runtime.task.task_id,
        attempt: runtime.attempts,
        status: 'blocked',
        result_hash: null,
        artifact_roots: [],
        approval: null,
        ship_proof_digest: null,
        external_effect_types: [...stage.external_effect_types],
        effect_receipt_digests: [],
        permission_denied: true,
      });
    }
  }
}

function requeuePrivateProductFailures(
  input: PrivateProductRepositoryWorkflowInputV1,
  snapshot: WorkflowRunSnapshotV1,
  journalPath: string,
): void {
  for (const runtime of Object.values(snapshot.tasks)) {
    const stage = input.definition.stages.find(
      (entry) => entry.stage_id === runtime.task.stage_id,
    )!;
    if (runtime.status !== 'failed' || runtime.attempts > stage.retry_budget) continue;
    appendWorkflowJournalEvent({
      journal_path: journalPath,
      run_id: input.plan.run_id,
      kind: 'task_requeued',
      task_id: runtime.task.task_id,
      payload: { after_attempt: runtime.attempts },
    });
  }
}

function normalizePrivateProductReceipt(
  receipt: WorkflowTaskReceiptV1,
  taskId: string,
  attempt: number,
  declaredEffects: readonly string[],
): WorkflowTaskReceiptV1 {
  const effectsMatch = receipt.external_effect_types.length === declaredEffects.length
    && receipt.external_effect_types.every(
      (effect, index) => effect === declaredEffects[index],
    );
  const effectReceiptsValid = receipt.effect_receipt_digests.length === declaredEffects.length
    && receipt.effect_receipt_digests.every((digest) => /^[a-f0-9]{64}$/u.test(digest));
  if (receipt.task_id !== taskId || receipt.attempt !== attempt || !effectsMatch) {
    return privateProductFailureReceipt(taskId, attempt, declaredEffects);
  }
  if (declaredEffects.length > 0 && !effectReceiptsValid) {
    return { ...receipt, status: 'effect_unknown', result_hash: null };
  }
  return JSON.parse(JSON.stringify(receipt)) as WorkflowTaskReceiptV1;
}

function privateProductFailureReceipt(
  taskId: string,
  attempt: number,
  externalEffects: readonly string[],
): WorkflowTaskReceiptV1 {
  return {
    task_id: taskId,
    attempt,
    status: externalEffects.length > 0 ? 'effect_unknown' : 'failed',
    result_hash: null,
    artifact_roots: [],
    approval: null,
    ship_proof_digest: null,
    external_effect_types: [...externalEffects],
    effect_receipt_digests: [],
    permission_denied: false,
  };
}

function appendPrivateProductReceipt(
  journalPath: string,
  runId: string,
  receipt: WorkflowTaskReceiptV1,
): void {
  appendWorkflowJournalEvent({
    journal_path: journalPath,
    run_id: runId,
    kind: 'task_receipt',
    task_id: receipt.task_id,
    payload: { receipt },
  });
}

function validateCanonicalProductRun(
  input: Readonly<CanonicalProductWorkflowExecutionInputV1>,
  repositoryRoot: string,
): void {
  const { plan_digest: ignored, ...planMaterial } = input.plan;
  void ignored;
  if (workflowPlanDigest(planMaterial) !== input.plan.plan_digest) {
    throw new Error('E_WORKFLOW_PLAN_DIGEST: product workflow plan digest mismatch');
  }
  if (sha256Hex(canonicalBytesV1(input.workflow_input)) !== input.plan.input_digest) {
    throw new Error('E_WORKFLOW_INPUT_DIGEST: product workflow input does not bind plan');
  }
  if (input.plan.definition_digest !== input.definition.definition_digest) {
    throw new Error('E_WORKFLOW_DEFINITION_DIGEST: product workflow definition does not bind plan');
  }
  const candidate = typeof input.workflow_input.candidate_oid === 'string'
    ? input.workflow_input.candidate_oid : input.workflow_input.candidate_commit;
  const head = spawnSync('git', ['-C', repositoryRoot, 'rev-parse', 'HEAD^{commit}'], {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 8_192,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (head.status !== 0 || candidate !== `${head.stdout ?? ''}`.trim()) {
    throw new Error('E_WORKFLOW_CANDIDATE_OID: product workflow input must bind exact repository HEAD');
  }
  const journalPath = path.resolve(input.journal_path);
  if (input.mode === 'cli') {
    const expectedRunId = sha256Hex(canonicalBytesV1([
      'oma-workflow-run-v1',
      input.definition.name,
      input.definition.workflow_version,
      input.definition.definition_digest,
      input.plan.input_digest,
      input.plan.generation,
    ]));
    const expectedJournal = path.join(
      repositoryRoot, '.agy', 'state', 'workflows', expectedRunId, 'journal.jsonl',
    );
    if (input.plan.run_id !== expectedRunId || journalPath !== expectedJournal) {
      throw new Error('E_WORKFLOW_RUN_ID: CLI product workflow identity is not canonical');
    }
  } else {
    const relativeToTmp = path.relative(fs.realpathSync(os.tmpdir()), journalPath);
    if (!/^production-[a-f0-9]{32}$/u.test(input.plan.run_id)
      || relativeToTmp === '' || relativeToTmp === '..'
      || relativeToTmp.startsWith(`..${path.sep}`)
      || !path.basename(path.dirname(journalPath)).startsWith('oma-product-workflow-')) {
      throw new Error('E_WORKFLOW_RUN_ID: production workflow challenge identity is not canonical');
    }
  }
}

function canonicalProductStateEndpoint(
  repositoryRoot: string,
  input: Readonly<CanonicalProductWorkflowExecutionInputV1>,
): string {
  if (input.mode === 'production') return `production-evidence/${input.plan.run_id}`;
  return path.relative(repositoryRoot, path.dirname(input.journal_path)).split(path.sep).join('/');
}

function productContributorGuidanceHashes(
  repositoryRoot: string,
): Array<{ path: string; sha256: string }> {
  const target = path.join(repositoryRoot, 'AGENTS.md');
  if (!fs.existsSync(target)) return [];
  const stat = fs.lstatSync(target);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_048_576) {
    throw new Error('repository contributor guidance is unsafe');
  }
  return [{ path: 'AGENTS.md', sha256: sha256Hex(fs.readFileSync(target)) }];
}

function productWorkflowAuthorityKey(stateRootInput: string, create: boolean): Buffer {
  const stateRoot = path.resolve(stateRootInput);
  const target = path.join(stateRoot, 'trust', 'workflow-v1.key');
  const trustDirectory = path.dirname(target);
  assertProductOwnerOnlyDirectory(stateRoot);
  if (!fs.existsSync(trustDirectory)) {
    if (!create) throw new Error('workflow authority trust root is missing');
    fs.mkdirSync(trustDirectory, { mode: 0o700 });
  }
  assertProductOwnerOnlyDirectory(trustDirectory);
  if (!fs.existsSync(target)) {
    if (!create) throw new Error('workflow authority key is missing');
    const descriptor = fs.openSync(target, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, crypto.randomBytes(32));
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
  }
  const key = readProductOwnerOnlyRegular(target, 32);
  if (key.length !== 32) throw new Error('workflow authority trust root is unsafe');
  return key;
}

async function dispatchProductWorkflowTask(
  input: Readonly<WorkflowDispatchInputV1>,
  context: Readonly<ProductWorkflowExecutionContextV1>,
): Promise<WorkflowTaskReceiptV1> {
  assertRepositoryExternalAuthorityRoot(context.state_root, context.repository_root);
  const route = context.route_authorities.get(productWorkflowRouteKey(input.task.task_id, input.attempt));
  if (route === undefined
    || input.permission.envelope.provider !== 'agy_headless'
    || input.permission.envelope.provider_profile_digest !== route.receipt.profileDigest
    || input.permission.envelope.route_receipt_digest !== route.receipt.receiptDigest
    || context.agy_command !== route.receipt.resolvedExecutable) {
    return productFailure(input, 'blocked', true);
  }
  try {
    validateHostRouteReceipt(route.receipt, context.capability_profile, {
      now: new Date().toISOString(),
      generation: input.task.generation,
      contextDigest: route.contextDigest,
      identityDigest: context.capability_profile.identityDigest,
      fallbackPreconditionsSatisfied: route.receipt.fallbackPreconditionsSatisfied,
      provider: 'agy_headless',
      requestMode: 'headless',
    });
  } catch (_) {
    return productFailure(input, 'blocked', true);
  }
  const runner = new ProcessRunner();
  if (input.stage.external_effect_types.length > 0) {
    return productFailure(input, 'effect_unknown');
  }
  if (!canonicalBytesV1(input.stage.output_schema)
    .equals(canonicalBytesV1(workflowVerdictOutputSchema(input.stage.kind)))) {
    return productFailure(input, 'blocked', true);
  }
  // Clear the proposal root before EVERY attempt, not just retries: the root
  // is a deterministic path inside the repository, so a stale proposal left by
  // a crashed or earlier run would make the exclusive-create write below fail
  // with EEXIST on attempt 1 and spuriously fail the task. Cleaning first makes
  // each dispatch idempotent.
  try {
    removeProductOwnedTree(productConfinedPath(
      context.repository_root,
      input.permission.envelope.artifact_contract.proposal_root,
    ));
  } catch {
    return productFailure(input, 'blocked', true);
  }
  const expected = [...input.permission.envelope.artifact_contract.required_files];
  const prompt = [
    'You are one bounded OMA repository-workflow worker. Do not launch subagents or a supervisor.',
    'Follow the exact permission envelope. Never write repository files or perform external effects.',
    'Return one JSON object only, as plain text on stdout: no markdown code fences, no commentary, no repeated keys.',
    'Schema: {"artifacts":{path:object},"verdict":{"decision":string,"findings":[{"code":string,"severity":"info"|"warning"|"error","message":string}]}}.',
    'Allowed positive decision is exact by stage kind: author/check=pass, skeptic=approve, verifier=pass, ship_gate=ship.',
    'Negative decisions are reject, no_ship, or failed and must include at least one finding.',
    'Approval, status, verification, and ship proof are computed only by the OMA parent from this exact verdict plus real verification exits.',
    `Stage kind: ${input.stage.kind}`,
    `Repository root (mounted in your workspace): ${context.repository_root}`,
    `Permission envelope: ${canonicalBytesV1(input.permission.envelope).toString('utf8')}`,
    `Workflow input: ${canonicalBytesV1(context.workflow_input).toString('utf8')}`,
  ].join('\n');
  const argv = buildAgy115Argv({
    launchMode: 'headless',
    capabilityMode: input.permission.envelope.capability_mode,
    prompt,
    boundedDuration: `${Math.max(1, Math.ceil(input.stage.timeout_ms / 1000))}s`,
    workspaceDirectories: [context.repository_root],
  });
  if (!argv.ok) return productFailure(input, 'blocked', true);
  const launchOperation = `workflow:${input.task.task_id}:${input.attempt}`;
  const launch = await runner.boundedHeadless(
    context.agy_command,
    argv.value,
    productBoundedPolicy(input.stage.timeout_ms, context),
    productOperation(launchOperation, input.permission.envelope_digest),
  );
  if (process.env.OMA_WORKER_DEBUG === '1') {
    try {
      fs.writeFileSync(
        path.join(os.tmpdir(), `oma-worker-debug-${input.task.task_id.slice(0, 8)}-${input.attempt}.json`),
        JSON.stringify({
          ok: launch.ok,
          code: launch.ok ? launch.value.code : null,
          error: launch.ok ? null : launch.error,
          timedOut: launch.ok ? launch.value.timedOut : null,
          outputOverflow: launch.ok ? launch.value.outputOverflow : null,
          processCountOverflow: launch.ok ? launch.value.processCountOverflow : null,
          identity: launch.ok ? launch.value.processIdentity !== null : null,
          stdout: launch.ok ? launch.value.stdout.slice(0, 4096) : null,
          stderr: launch.ok ? launch.value.stderr.slice(0, 4096) : null,
        }),
        { mode: 0o600 },
      );
    } catch { /* diagnostics never block the dispatch */ }
  }
  if (!launch.ok || !successfulProductProcess(launch.value)
    || launch.value.processIdentity === null) {
    return productFailure(input, 'failed');
  }
  const parsed = parseProductWorkerResult(launch.value.stdout, expected, input.stage.kind);
  if (parsed === null) return productFailure(input, 'failed');
  const proposalRoot = secureProductDirectory(
    context.repository_root,
    input.permission.envelope.artifact_contract.proposal_root,
  );
  const artifacts = [];
  try {
    for (const relative of expected) {
      const target = productConfinedPath(context.repository_root, relative);
      if (!target.startsWith(`${proposalRoot}${path.sep}`)) {
        throw new Error('artifact escapes proposal root');
      }
      secureProductDirectory(context.repository_root, path.dirname(relative));
      const bytes = canonicalBytesV1(parsed.artifacts[relative]);
      writeNewProductOwnerOnly(target, bytes);
      const reread = readProductOwnerOnlyRegular(target, 524_288);
      const value = JSON.parse(reread.toString('utf8')) as unknown;
      if (!plainObject(value) || !canonicalBytesV1(value).equals(reread)) {
        throw new Error('artifact schema');
      }
      artifacts.push({ path: relative, byte_length: reread.length, sha256: sha256Hex(reread) });
    }
  } catch {
    return productFailure(input, 'failed');
  }
  const verifications: WorkflowProductAuthorityV1['verifications'] = [];
  for (const [index, exactArgv] of input.stage.verification_argv.entries()) {
    const operationId = `workflow-verify:${input.task.task_id}:${input.attempt}:${index}`;
    const outcome = await runner.boundedHeadless(
      exactArgv[0],
      exactArgv.slice(1),
      productBoundedPolicy(input.stage.timeout_ms, context),
      productOperation(operationId, input.permission.envelope_digest),
    );
    if (!outcome.ok || outcome.value.processIdentity === null) {
      return productFailure(input, 'failed');
    }
    const transcriptRoot = secureProductDirectory(
      context.repository_root,
      `${input.permission.envelope.artifact_contract.proposal_root}/.authority`,
    );
    const stdoutRelative = `${input.permission.envelope.artifact_contract.proposal_root}/.authority/verification-${index}.stdout`;
    const stderrRelative = `${input.permission.envelope.artifact_contract.proposal_root}/.authority/verification-${index}.stderr`;
    const stdoutTarget = productConfinedPath(context.repository_root, stdoutRelative);
    const stderrTarget = productConfinedPath(context.repository_root, stderrRelative);
    if (!stdoutTarget.startsWith(`${transcriptRoot}${path.sep}`)
      || !stderrTarget.startsWith(`${transcriptRoot}${path.sep}`)) {
      return productFailure(input, 'failed');
    }
    try {
      writeNewProductOwnerOnly(stdoutTarget, Buffer.from(outcome.value.stdout, 'utf8'));
      writeNewProductOwnerOnly(stderrTarget, Buffer.from(outcome.value.stderr, 'utf8'));
    } catch {
      return productFailure(input, 'failed');
    }
    verifications.push({
      pid: outcome.value.processIdentity.pid,
      start_marker: outcome.value.processIdentity.startMarker,
      operation_id: operationId,
      argv: [...exactArgv],
      argv_sha256: sha256Hex(canonicalBytesV1(exactArgv)),
      exit_code: outcome.value.code,
      stdout_sha256: sha256Hex(readProductOwnerOnlyRegular(stdoutTarget, 1_048_576)),
      stderr_sha256: sha256Hex(readProductOwnerOnlyRegular(stderrTarget, 1_048_576)),
      stdout_path: stdoutRelative,
      stderr_path: stderrRelative,
    });
    if (!successfulProductProcess(outcome.value)) return productFailure(input, 'failed');
  }
  const candidate = typeof context.workflow_input.candidate_oid === 'string'
    ? context.workflow_input.candidate_oid : context.workflow_input.candidate_commit;
  if (typeof candidate !== 'string' || !/^[a-f0-9]{40,64}$/u.test(candidate)) {
    return productFailure(input, 'blocked', true);
  }
  const launchArgv = [context.agy_command, ...argv.value];
  const positive = positiveProductVerdict(input.stage.kind, parsed.verdict);
  const taskStatus = productDecisionStatus(input.stage.kind, parsed.verdict);
  const resultHash = taskStatus === 'passed'
    ? sha256Hex(canonicalBytesV1({ artifacts, verdict: parsed.verdict })) : null;
  const approval = input.stage.kind === 'skeptic' || input.stage.kind === 'verifier'
    ? positive : null;
  const shipProof = input.stage.kind === 'ship_gate' && positive && resultHash !== null
    ? sha256Hex(canonicalBytesV1([
      'oma-product-ship', candidate, input.plan_digest, resultHash,
    ])) : null;
  const authorityMaterial: Omit<WorkflowProductAuthorityV1, 'authority_digest' | 'authority_mac'> = {
    authority_kind: 'oma_product_executor_v1',
    agy_executable_realpath: context.agy_command,
    agy_executable_sha256: context.agy_executable_sha256,
    agy_executable_byte_length: context.agy_executable_byte_length,
    candidate_oid: candidate,
    definition_digest: input.definition.definition_digest,
    plan_digest: input.plan_digest,
    envelope_digest: input.permission.envelope_digest,
    task_id: input.task.task_id,
    stage_id: input.stage.stage_id,
    attempt: input.attempt,
    generation: input.task.generation,
    decision_status: taskStatus,
    verdict: parsed.verdict,
    result_hash: resultHash,
    approval,
    ship_proof_digest: shipProof,
    launch: {
      pid: launch.value.processIdentity.pid,
      start_marker: launch.value.processIdentity.startMarker,
      operation_id: launchOperation,
      argv: launchArgv,
      argv_sha256: sha256Hex(canonicalBytesV1(launchArgv)),
    },
    verifications,
    artifacts,
  };
  return {
    task_id: input.task.task_id,
    attempt: input.attempt,
    status: taskStatus,
    result_hash: resultHash,
    artifact_roots: [input.permission.envelope.artifact_contract.proposal_root],
    approval,
    ship_proof_digest: shipProof,
    external_effect_types: [],
    effect_receipt_digests: [],
    permission_denied: false,
    product_authority: signProductWorkflowAuthority(
      authorityMaterial,
      productWorkflowAuthorityKey(context.state_root, true),
    ),
  };
}

function signProductWorkflowAuthority(
  material: Omit<WorkflowProductAuthorityV1, 'authority_digest' | 'authority_mac'>,
  key: Buffer,
): WorkflowProductAuthorityV1 {
  const authority_digest = workflowAuthorityDigest(material);
  const authority_mac = crypto.createHmac('sha256', key)
    .update(canonicalBytesV1({ ...material, authority_digest })).digest('hex');
  return { ...material, authority_digest, authority_mac };
}

function productBoundedPolicy(
  timeout: number,
  context: Readonly<ProductWorkflowExecutionContextV1>,
) {
  return {
    deadlineMs: timeout,
    terminationGraceMs: 1_000,
    maxOutputBytes: 1_048_576,
    maxProcessCount: 16,
    cwd: context.repository_root,
    env: productOrdinaryEnvironment(context.environment),
  };
}

function productOperation(operationId: string, digest: string) {
  return {
    operationId,
    ownerNonce: sha256Hex(canonicalBytesV1([operationId, digest])).slice(0, 32),
  };
}

function successfulProductProcess(value: {
  code: number;
  timedOut: boolean;
  outputOverflow?: boolean;
  processCountOverflow?: boolean;
}): boolean {
  return value.code === 0 && !value.timedOut && !value.outputOverflow
    && !value.processCountOverflow;
}

function productFailure(
  input: Readonly<WorkflowDispatchInputV1>,
  status: 'failed' | 'blocked' | 'effect_unknown',
  denied = false,
): WorkflowTaskReceiptV1 {
  return {
    task_id: input.task.task_id,
    attempt: input.attempt,
    status,
    result_hash: null,
    artifact_roots: [],
    approval: null,
    ship_proof_digest: null,
    external_effect_types: [...input.stage.external_effect_types],
    effect_receipt_digests: [],
    permission_denied: denied,
  };
}

/** Last balanced top-level {...} in the text (string/escape aware), or null. */
function extractLastJsonObject(text: string): string | null {
  let end = -1;
  let depth = 0;
  let start = -1;
  let inString = false;
  for (let index = text.length - 1; index >= 0; index -= 1) {
    const character = text[index];
    if (end === -1) {
      if (character === '}') { end = index; depth = 1; }
      continue;
    }
    if (character === '"' && text[index - 1] !== '\\') inString = !inString;
    if (inString) continue;
    if (character === '}') depth += 1;
    else if (character === '{') {
      depth -= 1;
      if (depth === 0) { start = index; break; }
    }
  }
  if (end === -1 || start === -1) return null;
  return text.slice(start, end + 1);
}

function stripSingleJsonFence(text: string): string {
  const match = /^```(?:json)?\r?\n([\s\S]*?)\r?\n```$/u.exec(text);
  return match === null ? text : match[1].trim();
}

/** Reject ambiguous JSON: any object with a repeated key anywhere in the text. */
function jsonTextHasDuplicateKeys(text: string): boolean {
  const keyStack: Array<Set<string> | null> = [];
  let index = 0;
  const length = text.length;
  const skipString = (): string | null => {
    const start = index;
    index += 1;
    while (index < length) {
      const character = text[index];
      if (character === '\\') { index += 2; continue; }
      if (character === '"') {
        index += 1;
        try {
          return JSON.parse(text.slice(start, index)) as string;
        } catch {
          return null;
        }
      }
      index += 1;
    }
    return null;
  };
  let expectKey = false;
  while (index < length) {
    const character = text[index];
    if (character === '"') {
      const literal = skipString();
      if (literal === null) return true;
      if (expectKey) {
        const keys = keyStack[keyStack.length - 1];
        if (keys !== null && keys !== undefined) {
          if (keys.has(literal)) return true;
          keys.add(literal);
        }
        expectKey = false;
      }
      continue;
    }
    if (character === '{') { keyStack.push(new Set()); expectKey = true; }
    else if (character === '}') { keyStack.pop(); expectKey = false; }
    else if (character === '[') { keyStack.push(null); }
    else if (character === ']') { keyStack.pop(); }
    else if (character === ',') {
      expectKey = keyStack[keyStack.length - 1] instanceof Set;
    } else if (character === ':') { expectKey = false; }
    index += 1;
  }
  return false;
}

function parseProductWorkerResult(
  stdout: string,
  expected: readonly string[],
  stageKind: WorkflowDispatchInputV1['stage']['kind'],
): {
  artifacts: Record<string, Readonly<Record<string, unknown>>>;
  verdict: ProductWorkflowVerdictV1;
} | null {
  if (Buffer.byteLength(stdout, 'utf8') > 1_048_576) return null;
  // Live workers narrate progress on stdout before the final answer and
  // cannot guarantee byte-canonical JSON; the verdict is the LAST balanced
  // top-level JSON object. Unambiguity is kept by rejecting duplicate keys
  // outright, and every accepted object is re-serialized canonically before
  // hashing or storage.
  const extracted = extractLastJsonObject(stripSingleJsonFence(stdout.trim()));
  if (extracted === null) return null;
  const trimmed = extracted;
  if (jsonTextHasDuplicateKeys(trimmed)) return null;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!plainObject(value)
    || !exactProductKeys(value, ['artifacts', 'verdict'])
    || !plainObject(value.artifacts)
    || !validProductVerdict(value.verdict)) return null;
  if (!canonicalBytesV1(Object.keys(value.artifacts).sort())
    .equals(canonicalBytesV1([...expected].sort()))) return null;
  const result: Record<string, Readonly<Record<string, unknown>>> = {};
  let total = 0;
  for (const key of expected) {
    const artifact = value.artifacts[key];
    if (!plainObject(artifact)) return null;
    total += canonicalBytesV1(artifact).length;
    if (total > 524_288) return null;
    result[key] = artifact;
  }
  if (!allowedProductVerdict(stageKind, value.verdict.decision)) return null;
  if (!positiveProductVerdict(stageKind, value.verdict)
    && value.verdict.findings.length === 0) return null;
  return { artifacts: result, verdict: value.verdict };
}

function secureProductDirectory(root: string, relative: string): string {
  const absoluteRoot = path.resolve(root);
  const target = productConfinedPath(root, relative);
  const rel = path.relative(absoluteRoot, target);
  let current = absoluteRoot;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (fs.existsSync(current)) {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe directory');
    } else {
      fs.mkdirSync(current, { mode: 0o700 });
    }
  }
  return target;
}

function removeProductOwnedTree(target: string): void {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error('owned tree contains symlink');
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(target)) removeProductOwnedTree(path.join(target, entry));
    fs.rmdirSync(target);
    return;
  }
  if (!stat.isFile()) throw new Error('owned tree contains special file');
  fs.unlinkSync(target);
}

function assertProductOwnerOnlyDirectory(target: string): void {
  if (!fs.existsSync(target)) throw new Error('workflow authority parent state root is missing');
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) {
    throw new Error('workflow authority directory chain is unsafe');
  }
}

function productConfinedPath(root: string, relative: string): string {
  const absoluteRoot = path.resolve(root);
  const target = path.resolve(absoluteRoot, relative);
  if (target === absoluteRoot || !target.startsWith(`${absoluteRoot}${path.sep}`)) {
    throw new Error('path escape');
  }
  return target;
}

function writeNewProductOwnerOnly(target: string, bytes: Buffer): void {
  const descriptor = fs.openSync(target, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function readProductOwnerOnlyRegular(target: string, max: number): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > max) {
      throw new Error('unsafe artifact');
    }
    const bytes = fs.readFileSync(descriptor);
    const finalStat = fs.fstatSync(descriptor);
    if (finalStat.dev !== stat.dev || finalStat.ino !== stat.ino
      || finalStat.size !== bytes.length) {
      throw new Error('artifact changed during read');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function productOrdinaryEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...environment };
  for (const key of Object.keys(copy)) {
    if (/TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE_KEY/u.test(key)) delete copy[key];
  }
  return copy;
}

function validProductVerdict(value: unknown): value is ProductWorkflowVerdictV1 {
  return plainObject(value)
    && exactProductKeys(value, ['decision', 'findings'])
    && ['pass', 'approve', 'ship', 'reject', 'no_ship', 'failed'].includes(String(value.decision))
    && Array.isArray(value.findings)
    && value.findings.length <= 128
    && value.findings.every((finding) => plainObject(finding)
      && exactProductKeys(finding, ['code', 'severity', 'message'])
      && typeof finding.code === 'string'
      && /^[A-Z][A-Z0-9_.-]{0,63}$/u.test(finding.code)
      && ['info', 'warning', 'error'].includes(String(finding.severity))
      && typeof finding.message === 'string'
      && finding.message.length > 0
      && Buffer.byteLength(finding.message, 'utf8') <= 4096);
}

function allowedProductVerdict(
  kind: WorkflowDispatchInputV1['stage']['kind'],
  decision: ProductWorkflowVerdictV1['decision'],
): boolean {
  if (['reject', 'no_ship', 'failed'].includes(decision)) return true;
  return kind === 'author' || kind === 'check' || kind === 'verifier'
    ? decision === 'pass'
    : kind === 'skeptic' ? decision === 'approve' : decision === 'ship';
}

function positiveProductVerdict(
  kind: WorkflowDispatchInputV1['stage']['kind'],
  verdict: ProductWorkflowVerdictV1,
): boolean {
  if (verdict.findings.some((finding) => finding.severity === 'error')) return false;
  const decision = verdict.decision;
  return kind === 'author' || kind === 'check' ? decision === 'pass'
    : kind === 'skeptic' ? decision === 'approve'
      : kind === 'verifier' ? decision === 'pass'
        : kind === 'ship_gate' && decision === 'ship';
}

function productDecisionStatus(
  kind: WorkflowDispatchInputV1['stage']['kind'],
  verdict: ProductWorkflowVerdictV1,
): 'passed' | 'failed' {
  if (positiveProductVerdict(kind, verdict)) return 'passed';
  if ((kind === 'skeptic' || kind === 'verifier' || kind === 'ship_gate')
    && (verdict.decision === 'reject' || verdict.decision === 'no_ship')) return 'passed';
  return 'failed';
}

function exactProductKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((entry, index) => entry === wanted[index]);
}

function workflowReadRun(
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
  includeEvents: boolean,
): number {
  const runId = requiredOption(argv, '--run');
  assertSafeIdentifier(runId, 'workflow run ID');
  assertOnlyOptions(argv, ['--run']);
  const runDirectory = repositoryRuntimePath(context.cwd, `.agy/state/workflows/${runId}`);
  const definition = readBoundedRegularJson(path.join(runDirectory, 'definition.json'), 1_048_576) as RepositoryWorkflowV1;
  const workflowInput = readBoundedRegularJson(path.join(runDirectory, 'input.json'), 1_048_576);
  const plan = readBoundedRegularJson(path.join(runDirectory, 'plan.json'), 4_194_304) as import('../workflows/schema').WorkflowPlanV1;
  const { validateRepositoryWorkflow } = require('../contracts/repository-workflow') as typeof import('../contracts/repository-workflow');
  const { readWorkflowJournal, replayWorkflowEvents } = require('../workflows/replay') as typeof import('../workflows/replay');
  const { evaluateWorkflowReview } = require('../workflows/review') as typeof import('../workflows/review');
  validateRepositoryWorkflow(definition);
  const { workflowPlanDigest } = require('../workflows/schema') as typeof import('../workflows/schema');
  const { plan_digest: ignoredPlanDigest, ...planMaterial } = plan;
  void ignoredPlanDigest;
  const candidate = plainObject(workflowInput) && typeof workflowInput.candidate_oid === 'string'
    ? workflowInput.candidate_oid
    : plainObject(workflowInput) ? workflowInput.candidate_commit : null;
  const head = spawnSync('git', ['-C', context.cwd, 'rev-parse', 'HEAD^{commit}'], {
    encoding: 'utf8', timeout: 5_000, shell: false,
  });
  if (definition.definition_digest !== plan.definition_digest || plan.run_id !== runId
    || workflowPlanDigest(planMaterial) !== plan.plan_digest
    || plan.input_digest !== sha256Hex(canonicalBytesV1(workflowInput))
    || head.status !== 0 || candidate !== `${head.stdout ?? ''}`.trim()) {
    throw new Error('workflow run artifacts do not bind the requested run');
  }
  const events = readWorkflowJournal(path.join(runDirectory, 'journal.jsonl'));
  const snapshot = replayWorkflowEvents(plan, events, { allow_product_ship: true });
  if (snapshot.terminal === 'ship') {
    const review = evaluateWorkflowReview({
      definition,
      plan,
      tasks: snapshot.tasks,
      authority_state_root: commandStateRoot(context),
      repository_root: context.cwd,
    });
    if (review.terminal !== 'ship') {
      snapshot.terminal = review.terminal;
      snapshot.warnings.push('E_WORKFLOW_PRODUCT_AUTHORITY_INVALID');
    }
  }
  context.stdout(`${JSON.stringify(includeEvents ? { snapshot, events } : snapshot, null, 2)}\n`);
  return snapshot.terminal === 'effect_unknown' ? 1 : 0;
}

function workflowNativeStatus(
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): number {
  if (argv.length > 0) throw new ExtendedCliUsageError('workflow native-status accepts no arguments');
  const {
    ANTIGRAVITY_WORKFLOW_SURFACES_V1,
    assertAntigravitySavedWorkflowIsThin,
  } = require('../workflows/antigravity-adapter') as typeof import('../workflows/antigravity-adapter');
  const promptPath = path.join(context.packageRoot, '.agents', 'workflows', 'production-safety-review.md');
  let savedPrompt: Record<string, unknown> = {
    configured: false,
    discovered_in_fresh_session: false,
    evidence_tier: 'T0',
  };
  if (fs.existsSync(promptPath)) {
    const bytes = readBoundedRegularFile(promptPath, 32_768);
    assertAntigravitySavedWorkflowIsThin(bytes.toString('utf8'), 'production-safety-review');
    savedPrompt = {
      configured: true,
      sha256: sha256Hex(bytes),
      discovered_in_fresh_session: false,
      evidence_tier: 'T1',
    };
  }
  context.stdout(`${JSON.stringify({
    authority: 'repository-workflow/v1',
    saved_prompt: savedPrompt,
    surfaces: ANTIGRAVITY_WORKFLOW_SURFACES_V1,
    honesty: 'native runtime/team/agents remain unclaimed until fresh public observation',
  }, null, 2)}\n`);
  return 0;
}

async function runMcpServerCommand(
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): Promise<number> {
  if (argv.length > 0) throw new ExtendedCliUsageError('mcp-server accepts no arguments');
  const { startMcpNdjsonServer } = await import('../mcp/server');
  const stateRoot = commandStateRoot(context);
  startMcpNdjsonServer({ repositoryRoot: context.cwd, stateRoot });
  if (process.stdin.readableEnded) return 0;
  await new Promise<void>((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    process.stdin.once('end', done);
    process.stdin.once('close', done);
  });
  return 0;
}

function runWikiCommand(
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): number {
  const [subcommand, ...rest] = argv;
  const { indexRepositoryWiki, searchWikiIndex } = require('../wiki') as typeof import('../wiki');
  const index = indexRepositoryWiki({ repositoryRoot: context.cwd });
  if (subcommand === 'index') {
    if (rest.length > 0) throw new ExtendedCliUsageError('wiki index accepts no arguments');
    context.stdout(`${JSON.stringify({
      index_digest: index.index_digest,
      record_count: index.records.length,
      sources: index.records.map((record) => ({
        path: record.path,
        kind: record.kind,
        content_sha256: record.content_sha256,
      })),
    }, null, 2)}\n`);
    return 0;
  }
  if (subcommand === 'list') {
    if (rest.length > 0) throw new ExtendedCliUsageError('wiki list accepts no arguments');
    context.stdout(`${JSON.stringify({
      index_digest: index.index_digest,
      records: index.records.map((record) => ({
        record_id: record.record_id,
        kind: record.kind,
        decision_id: record.decision_id,
        path: record.path,
        title: record.title,
        provenance: record.provenance,
      })),
    }, null, 2)}\n`);
    return 0;
  }
  if (subcommand === 'search') {
    const limit = integerOption(rest, '--limit', 20, 1, 50);
    const queryParts = valuesBeforeOptions(rest);
    if (queryParts.length === 0) throw new ExtendedCliUsageError('wiki search requires a query');
    assertOnlyOptions(rest.slice(queryParts.length), ['--limit']);
    context.stdout(`${JSON.stringify(searchWikiIndex(index, queryParts.join(' '), limit), null, 2)}\n`);
    return 0;
  }
  throw new ExtendedCliUsageError('wiki requires index|list|search');
}

async function runHudCommand(
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): Promise<number> {
  const allowed = [
    '--json', '--watch', '--interval', '--iterations', '--session', '--team',
    '--workspace-key', '--repo-key', '--preset',
  ];
  assertOnlyOptions(argv, allowed);
  const stateRoot = commandStateRoot(context);
  const query: import('../hud').HudQueryV1 = {
    state_root: stateRoot,
    adapters: collectHudAdapters(context),
  };
  const sessionId = optionValue(argv, '--session');
  const teamId = optionValue(argv, '--team');
  const workspaceKey = optionValue(argv, '--workspace-key');
  if (sessionId !== undefined) {
    query.session = {
      session_id: sessionId,
      workspace_key: resolveHudWorkspaceKey(workspaceKey, context.cwd),
    };
  }
  if (teamId !== undefined) {
    if (workspaceKey === undefined) throw new ExtendedCliUsageError('--team requires --workspace-key');
    query.team = {
      team_id: teamId,
      workspace_key: workspaceKey,
      repo_key: optionValue(argv, '--repo-key') ?? null,
    };
  }
  const format = argv.includes('--json') ? 'json' : 'text';
  const {
    collectHudSnapshot, renderHud, watchHud, DEFAULT_HUD_PRESET, HUD_PRESETS, isHudPreset,
  } = await import('../hud');
  // 設計概念映射：OMX `omx hud --preset=minimal|focused|full` 的三段呈現密度。
  // 未指定時維持 focused，輸出與導入 preset 之前逐字相同。
  const requestedPreset = optionValue(argv, '--preset');
  if (requestedPreset !== undefined && !isHudPreset(requestedPreset)) {
    throw new ExtendedCliUsageError(
      `hud --preset must be one of ${HUD_PRESETS.join('|')}`,
    );
  }
  const preset = requestedPreset ?? DEFAULT_HUD_PRESET;
  if (!argv.includes('--watch')) {
    const snapshot = collectHudSnapshot(query);
    if (!snapshot.ok) throw new Error(`${snapshot.error.code}: ${snapshot.error.message}`);
    context.stdout(`${renderHud(snapshot.value, format, preset)}\n`);
    return 0;
  }
  const watched = await watchHud(query, {
    interval_ms: integerOption(argv, '--interval', 1_000, 50, 60_000),
    max_iterations: integerOption(argv, '--iterations', 10_000, 1, 10_000),
    on_snapshot: (snapshot) => { context.stdout(`${renderHud(snapshot, format, preset)}\n`); },
  });
  if (!watched.ok) throw new Error(`${watched.error.code}: ${watched.error.message}`);
  return 0;
}

async function runNativeStatusCommand(
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): Promise<number> {
  if (argv.length > 0) throw new ExtendedCliUsageError('native-status accepts no arguments');
  const inspected = await inspectNativeCapabilities(context, false);
  if (inspected.kind === 'host_absent') {
    context.stdout(`${JSON.stringify({
      store_kind: 'oma_antigravity_public_status',
      schema_version: 1,
      repository_id: 'OMA',
      status: 'unavailable',
      executable: context.agyCommand,
      version: null,
      version_sha256: null,
      public_subcommands: [],
      capabilities: [
        legacyNativeCapability('public_cli', false),
        legacyNativeCapability('plugins', false),
        legacyNativeCapability('plugin_fresh_session_discovery', false),
        legacyNativeCapability('native_status', false),
        legacyNativeCapability('native_lsp', false),
        legacyNativeCapability('native_team', false),
        legacyNativeCapability('native_workflows', false),
      ],
      detail_code: 'PROFILE_HOST_ABSENT',
      diagnostic: inspected.diagnostics[0]?.message ?? 'agy host unavailable',
      profile_digest: null,
    }, null, 2)}\n`);
    return 0;
  }
  const profile = inspected.profile;
  const publicCliObserved = inspected.publicCliStatus !== 'unavailable';
  const projected = (key: string) => profile.capabilities.find((entry) => entry.key === key)?.outcome === 'supported';
  context.stdout(`${JSON.stringify({
    store_kind: 'oma_antigravity_public_status',
    schema_version: 1,
    repository_id: 'OMA',
    status: inspected.publicCliStatus,
    executable: profile.hostIdentity.realpath,
    version: profile.hostIdentity.version,
    version_sha256: profile.hostIdentity.version === null
      ? null : sha256Hex(profile.hostIdentity.version),
    public_subcommands: [],
    capabilities: [
      legacyNativeCapability('public_cli', publicCliObserved),
      legacyNativeCapability('plugins', projected('plugin.skills')),
      legacyNativeCapability('plugin_fresh_session_discovery', false),
      legacyNativeCapability('native_status', projected('ui.statusline')),
      legacyNativeCapability('native_lsp', projected('mcp.local_config')),
      legacyNativeCapability('native_team', projected('subagent.manage')),
      legacyNativeCapability('native_workflows', projected('custom_agent.markdown')),
    ],
    detail_code: publicCliObserved
      ? 'HOST_CAPABILITY_PROFILE_PROJECTION'
      : 'HOST_CAPABILITY_PUBLIC_CLI_UNAVAILABLE',
    diagnostic: publicCliObserved ? null : 'bounded version/help probes were unavailable',
    profile_digest: profile.profileDigest,
  }, null, 2)}\n`);
  return 0;
}

function legacyNativeCapability(capability: string, observed: boolean): {
  capability: string; status: 'observed' | 'unobserved'; evidence_tier: 'T0' | 'T1';
} {
  return { capability, status: observed ? 'observed' : 'unobserved', evidence_tier: observed ? 'T1' : 'T0' };
}

async function runLspStatusCommand(
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): Promise<number> {
  assertOnlyOptions(argv, ['--registration']);
  const { inspectHostLspStatus } = require('../native/lsp-status') as typeof import('../native/lsp-status');
  const native = await inspectNativeCapabilities(context, false);
  const status = inspectHostLspStatus({
    plugin_root: context.packageRoot,
    registration_relative_path: optionValue(argv, '--registration'),
  });
  context.stdout(`${JSON.stringify({
    ...status,
    profile_digest: native.kind === 'profile' ? native.profile.profileDigest : null,
    capability_outcome: native.kind === 'profile'
      ? native.profile.capabilities.find(({ key }) => key === 'mcp.local_config')?.outcome ?? 'unknown'
      : 'unknown',
  }, null, 2)}\n`);
  return 0;
}

async function runSidecarStatusCommand(
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): Promise<number> {
  if (argv.length > 0) throw new ExtendedCliUsageError('sidecar-status accepts no arguments');
  const { inspectPrivateSidecarStatus } = require('../native/sidecar-status') as typeof import('../native/sidecar-status');
  const native = await inspectNativeCapabilities(context, false);
  const status = inspectPrivateSidecarStatus();
  context.stdout(`${JSON.stringify({
    ...status,
    profile_digest: native.kind === 'profile' ? native.profile.profileDigest : null,
    capability_outcome: native.kind === 'profile'
      ? native.profile.capabilities.find(({ key }) => key === 'sidecar.agentapi')?.outcome ?? 'unknown'
      : 'unknown',
  }, null, 2)}\n`);
  return 0;
}


/**
 * `oma hud --session` 未給 `--workspace-key` 時，以 cwd 經 resolveWorkspaceIdentity
 * 自動解析。解析失敗仍回既有錯誤字串，避免改動呼叫端契約。
 */
function resolveHudWorkspaceKey(workspaceKey: string | undefined, cwd: string): string {
  if (workspaceKey !== undefined) return workspaceKey;
  const identity = resolveWorkspaceIdentity(cwd);
  if (!identity.ok) {
    throw new ExtendedCliUsageError('--session requires --workspace-key');
  }
  return identity.value.workspaceKey;
}

function collectHudAdapters(
  context: Readonly<ExtendedCommandContext>,
): import('../hud').HudAdapterViewV1[] {
  const { inspectAntigravityPublicStatus } = require('../native/antigravity-status') as typeof import('../native/antigravity-status');
  const { inspectHostLspStatus } = require('../native/lsp-status') as typeof import('../native/lsp-status');
  const { inspectPrivateSidecarStatus } = require('../native/sidecar-status') as typeof import('../native/sidecar-status');
  const native = inspectAntigravityPublicStatus({ executable: context.agyCommand });
  const lsp = inspectHostLspStatus({ plugin_root: context.packageRoot });
  const sidecar = inspectPrivateSidecarStatus();
  const notify = notificationStatus(context.environment);
  return [
    {
      adapter: 'antigravity_public',
      status: native.status,
      observed: native.status !== 'unavailable',
      enabled: true,
      detail_code: native.detail_code,
    },
    {
      adapter: 'host_lsp',
      status: lsp.status,
      observed: false,
      enabled: lsp.status !== 'unavailable',
      detail_code: lsp.detail_code,
    },
    {
      adapter: 'private_sidecar',
      status: sidecar.status,
      observed: false,
      enabled: false,
      detail_code: sidecar.detail_code,
    },
    {
      adapter: 'notifications',
      status: notify.any_configured ? 'configured' : 'disabled',
      observed: false,
      enabled: notify.any_configured,
      detail_code: notify.any_configured ? 'NOTIFICATION_TARGET_CONFIGURED' : 'NOTIFICATION_DISABLED',
    },
  ];
}

async function runNotifyCommand(
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === 'status') {
    if (rest.length > 0) throw new ExtendedCliUsageError('notify status accepts no arguments');
    context.stdout(`${JSON.stringify(notificationStatus(context.environment), null, 2)}\n`);
    return 0;
  }
  if (subcommand !== 'test') throw new ExtendedCliUsageError('notify requires status|test');
  assertOnlyOptions(rest, ['--severity', '--title', '--message']);
  const environment = context.environment;
  const ownerId = environment.OMA_NOTIFY_OWNER_ID;
  const ownerNonce = environment.OMA_NOTIFY_OWNER_NONCE;
  const generation = Number(environment.OMA_NOTIFY_GENERATION);
  if (ownerId === undefined || ownerNonce === undefined
    || !Number.isSafeInteger(generation) || generation < 1) {
    throw new ExtendedCliUsageError(
      'notify test requires OMA_NOTIFY_OWNER_ID, OMA_NOTIFY_OWNER_NONCE, and OMA_NOTIFY_GENERATION',
    );
  }
  const { createNotificationEvent } = await import('../notify/types');
  const { dispatchNotifications } = await import('../notify/dispatcher');
  const { inspectCurrentTerminal } = await import('../notify/terminal');
  const severity = optionValue(rest, '--severity') ?? 'info';
  if (!['info', 'success', 'warning', 'error'].includes(severity)) {
    throw new ExtendedCliUsageError('--severity must be info|success|warning|error');
  }
  const event = createNotificationEvent({
    severity: severity as 'info' | 'success' | 'warning' | 'error',
    title: optionValue(rest, '--title') ?? 'OMA notification test',
    message: optionValue(rest, '--message') ?? 'Notification adapter verification',
    owner_id: ownerId,
    owner_nonce: ownerNonce,
    generation,
  });
  const targets: import('../notify/dispatcher').NotificationTargetV1[] = [];
  if (environment.OMA_NOTIFY_TERMINAL === '1') {
    const terminal = inspectCurrentTerminal(process.pid);
    if (terminal !== null) {
      targets.push({
        adapter: 'terminal',
        enabled: true,
        owner_id: ownerId,
        owner_nonce: ownerNonce,
        generation,
        terminal,
      });
    }
  }
  const tmuxSession = environment.OMA_NOTIFY_TMUX_SESSION;
  const tmuxPane = environment.OMA_NOTIFY_TMUX_PANE;
  const workerNonce = environment.OMA_NOTIFY_WORKER_NONCE;
  if (tmuxSession !== undefined && tmuxPane !== undefined && workerNonce !== undefined) {
    targets.push({
      adapter: 'tmux',
      enabled: true,
      owner_id: ownerId,
      owner_nonce: ownerNonce,
      generation,
      session_name: tmuxSession,
      pane_id: tmuxPane,
      worker_nonce: workerNonce,
    });
  }
  const httpsUrl = environment.OMA_NOTIFY_HTTPS_URL;
  const allowedHosts = environment.OMA_NOTIFY_HTTPS_ALLOWED_HOSTS;
  if (httpsUrl !== undefined && allowedHosts !== undefined) {
    targets.push({
      adapter: 'https',
      enabled: true,
      owner_id: ownerId,
      owner_nonce: ownerNonce,
      generation,
      url: httpsUrl,
      allowed_hosts: allowedHosts.split(',').map((entry) => entry.trim()).filter(Boolean),
    });
  }
  if (targets.length === 0) throw new Error('no usable notification target is configured');
  const outcomes = await dispatchNotifications(event, targets);
  context.stdout(`${JSON.stringify({ event_id: event.event_id, outcomes }, null, 2)}\n`);
  return outcomes.some((outcome) => outcome.status === 'delivered') ? 0 : 1;
}

function notificationStatus(environment: NodeJS.ProcessEnv): {
  terminal: { configured: boolean; available: boolean };
  tmux: { configured: boolean };
  https: { configured: boolean; allowed_host_count: number };
  owner_configured: boolean;
  any_configured: boolean;
} {
  const terminalConfigured = environment.OMA_NOTIFY_TERMINAL === '1';
  const tmuxConfigured = [
    environment.OMA_NOTIFY_TMUX_SESSION,
    environment.OMA_NOTIFY_TMUX_PANE,
    environment.OMA_NOTIFY_WORKER_NONCE,
  ].every((entry) => entry !== undefined && entry !== '');
  const allowedHostCount = environment.OMA_NOTIFY_HTTPS_ALLOWED_HOSTS
    ?.split(',').map((entry) => entry.trim()).filter(Boolean).length ?? 0;
  const httpsConfigured = environment.OMA_NOTIFY_HTTPS_URL !== undefined && allowedHostCount > 0;
  return {
    terminal: { configured: terminalConfigured, available: terminalConfigured && process.stderr.isTTY === true },
    tmux: { configured: tmuxConfigured },
    https: { configured: httpsConfigured, allowed_host_count: allowedHostCount },
    owner_configured: [
      environment.OMA_NOTIFY_OWNER_ID,
      environment.OMA_NOTIFY_OWNER_NONCE,
      environment.OMA_NOTIFY_GENERATION,
    ].every((entry) => entry !== undefined && entry !== ''),
    any_configured: terminalConfigured || tmuxConfigured || httpsConfigured,
  };
}

async function runResumeCommand(
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): Promise<number> {
  if (argv.includes('--list')) {
    return runSessionListCommand(argv, context);
  }
  assertOnlyOptions(argv, ['--session', '--conversation', '--expected-revision']);
  const sessionId = requiredOption(argv, '--session');
  const conversationId = requiredOption(argv, '--conversation');
  const expectedRevision = integerOption(
    argv,
    '--expected-revision',
    undefined,
    0,
    Number.MAX_SAFE_INTEGER,
  );
  const managed = context.managedService();
  if (!managed.ok) throw new Error(`${managed.error.code}: ${managed.error.message}`);
  const outcome = await managed.value.resumeConversation(sessionId, conversationId, expectedRevision);
  if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
  context.stdout(`${JSON.stringify({
    ok: outcome.value.code === 0,
    selector: 'exact_conversation_id',
    argv: ['agy', '--conversation', conversationId],
    process: {
      code: outcome.value.code,
      signal: outcome.value.signal,
      timed_out: outcome.value.timedOut,
    },
  }, null, 2)}\n`);
  return outcome.value.code === 0 ? 0 : 1;
}

function runRecoveryCommand(
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): number {
  assertOnlyOptions(argv, ['--source', '--recovery-root', '--include-prompt']);
  const source = requiredOption(argv, '--source');
  const canonicalRecoveryRoot = repositoryRuntimePath(context.cwd, '.agy/recovery');
  const requestedRoot = path.resolve(optionValue(argv, '--recovery-root') ?? canonicalRecoveryRoot);
  if (requestedRoot !== canonicalRecoveryRoot) {
    throw new ExtendedCliUsageError('--recovery-root must resolve to this repository .agy/recovery');
  }
  ensureRepositoryRuntimeDirectory(context.cwd, '.agy/recovery');
  const { recoverTranscript } = require('../continuation/recovery') as typeof import('../continuation/recovery');
  const result = recoverTranscript({ sourcePath: source, recoveryRoot: canonicalRecoveryRoot });
  const manifestPath = path.join(
    canonicalRecoveryRoot,
    `${result.manifest.immutable_copy_sha256}.manifest.json`,
  );
  writeStableCanonicalFile(manifestPath, result.manifest, 0o400);
  const output: Record<string, unknown> = {
    ok: result.errors.length === 0,
    partial_recovery: true,
    manifest_path: path.relative(context.cwd, manifestPath).split(path.sep).join('/'),
    immutable_copy_path: result.manifest.immutable_copy_path,
    immutable_copy_sha256: result.manifest.immutable_copy_sha256,
    complete_turns_retained: result.manifest.counters.complete_turns_retained,
    warnings: result.manifest.warnings,
    unknown_type_names: result.manifest.unknown_type_names,
    errors: result.errors,
    prompt_sha256: result.promptBytes === null ? null : sha256Hex(result.promptBytes),
    prompt_bytes: result.promptBytes?.length ?? 0,
  };
  if (argv.includes('--include-prompt')) output.prompt = result.prompt;
  context.stdout(`${JSON.stringify(output, null, 2)}\n`);
  return result.errors.length === 0 ? 0 : 1;
}

async function runUpdateCommand(
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): Promise<number> {
  assertOnlyOptions(argv, [
    '--release', '--bin-dir', '--package-root', '--asset-sha256', '--package-digest',
    '--source-uri', '--source-tag', '--peeled-commit', '--config-root', '--home',
    '--check',
  ]);
  const homeDir = path.resolve(optionValue(argv, '--home') ?? os.homedir());
  const checkOnly = argv.includes('--check');
  const stateRoot = commandStateRoot(context, homeDir, !checkOnly);
  const {
    ImmutableInstallUpdater,
    renderUpdateCheck,
    updateCheckExitCode,
  } = await import('../setup/update');
  const updater = new ImmutableInstallUpdater({
    packageRoot: path.resolve(optionValue(argv, '--package-root') ?? context.packageRoot),
    stateRoot,
    homeDir,
    antigravityConfigRoot: optionValue(argv, '--config-root'),
    binDir: path.resolve(optionValue(argv, '--bin-dir') ?? path.join(homeDir, '.local', 'bin')),
    adapter: context.pluginAdapter,
    mode: argv.includes('--release') ? 'release' : 'development',
    expectedPackageDigest: optionValue(argv, '--package-digest'),
    assetSha256: optionValue(argv, '--asset-sha256'),
    sourceUri: optionValue(argv, '--source-uri'),
    sourceTag: optionValue(argv, '--source-tag'),
    peeledCommit: optionValue(argv, '--peeled-commit'),
    agyCommand: context.agyCommand,
  });
  // 設計概念映射：OMC `update --check` — 印 identity/digest 與 preflight 後返回，不置換。
  if (checkOnly) {
    const report = updater.check();
    context.stdout(renderUpdateCheck(report));
    return updateCheckExitCode(report);
  }
  const result = await updater.run();
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  context.stdout(`${JSON.stringify({ ok: true, ...result.value }, null, 2)}\n`);
  // Soft doctor warnings (doctorExitCode 2) are advisory after a written receipt.
  // Hard doctor failures never reach this path (updater rolls back / returns err).
  return 0;
}

async function runUninstallCommand(
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): Promise<number> {
  assertOnlyOptions(argv, ['--receipt', '--project-state', '--purge']);
  const receiptPath = requiredOption(argv, '--receipt');
  const projectState = optionValue(argv, '--project-state');
  if (argv.includes('--purge') && projectState === undefined) {
    throw new ExtendedCliUsageError('--purge requires the exact --project-state <.agy> path');
  }
  const { uninstallOwnedInstallation } = await import('../setup/uninstall');
  const result = await uninstallOwnedInstallation({
    receiptPath,
    adapter: context.pluginAdapter,
    projectStatePath: projectState,
    purge: argv.includes('--purge'),
  });
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  context.stdout(`${JSON.stringify({ ok: result.value.collisions.length === 0, ...result.value }, null, 2)}\n`);
  return result.value.collisions.length === 0 ? 0 : 1;
}

async function runParityCommand(
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): Promise<number> {
  const [subcommand, ...rest] = argv;
  if (subcommand === 'verify-composition') {
    return verifyParityComposition(rest, context);
  }
  if (!['verify', 'verify-handoff'].includes(subcommand ?? '')) {
    throw new ExtendedCliUsageError(
      'parity exposes only verify, verify-handoff, or verify-composition; signing and state transitions stay fenced',
    );
  }
  if (rest[0] !== '--') {
    throw new ExtendedCliUsageError('parity verify routes require -- before run-manifest arguments');
  }
  const script = path.join(context.packageRoot, 'dist', 'src', 'contracts', 'run-manifest.js');
  readBoundedRegularFile(script, 4_194_304);
  const outcome = await context.runner.foregroundInteractive(
    process.execPath,
    [script, subcommand as string, ...rest.slice(1)],
    { operationId: `parity-${subcommand}`, ownerNonce: 'parity-read-only' },
    { cwd: context.cwd, env: ordinaryEnvironment(context.environment) },
  );
  if (!outcome.ok) throw new Error(`${outcome.error.code}: ${outcome.error.message}`);
  return outcome.value.code;
}

function verifyParityComposition(
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): number {
  assertOnlyOptions(argv, ['--workspace', '--run-id', '--aggregate']);
  const workspace = path.resolve(optionValue(argv, '--workspace') ?? context.cwd);
  const runId = requiredOption(argv, '--run-id');
  const aggregatePath = path.resolve(requiredOption(argv, '--aggregate'));
  const wrapper = readBoundedRegularJson(aggregatePath, 16_777_216);
  if (!plainObject(wrapper) || wrapper.store_kind !== 'repo_aggregate_handoff'
    || wrapper.schema_version !== 1 || wrapper.repository_id !== 'OMA'
    || wrapper.run_id !== runId || !plainObject(wrapper.input_envelope)
    || (wrapper.revision !== 1 && wrapper.revision !== 2)) {
    throw new Error('aggregate handoff schema is invalid');
  }
  const {
    expectedRepositoryAggregatePath,
    locateRunManifest,
    verifyRepositoryAggregate,
    verifyRunManifestAtPath,
  } = require('../contracts/run-manifest') as typeof import('../contracts/run-manifest');
  const canonicalPath = expectedRepositoryAggregatePath(workspace, runId);
  if (fs.realpathSync(aggregatePath) !== fs.realpathSync(canonicalPath)) {
    throw new Error('aggregate handoff must be the exact canonical repository artifact');
  }
  const phase = wrapper.revision === 2 ? 'final' : 'input';
  if ((phase === 'input' && wrapper.final_envelope !== null)
    || (phase === 'final' && !plainObject(wrapper.final_envelope))) {
    throw new Error('aggregate handoff revision/envelope state is invalid');
  }
  const selectedEnvelope = phase === 'final' ? wrapper.final_envelope : wrapper.input_envelope;
  const envelope = selectedEnvelope as unknown as AggregateEnvelopeV1<Record<string, unknown>>;
  verifyRepositoryAggregate({ workspace_path: workspace, run_id: runId, phase, envelope });
  const location = locateRunManifest(workspace, runId);
  const manifest = verifyRunManifestAtPath(location.manifest_path);
  const payload = envelope.payload;
  const payloadHash = sha256Hex(canonicalBytesV1(payload));
  if (envelope.payload_hash !== payloadHash) {
    throw new Error('aggregate payload hash is invalid');
  }
  context.stdout(`${JSON.stringify({
    ok: true,
    repository_id: 'OMA',
    run_id: manifest.run_id,
    phase,
    aggregate_revision: wrapper.revision,
    payload_hash: payloadHash,
    payload_manifest_revision: payload.run_manifest_revision,
    payload_lease_generation: payload.lease_generation,
    manifest_revision: manifest.revision,
    manifest_lease_generation: manifest.lease_generation,
    manifest_state: manifest.state,
  }, null, 2)}\n`);
  return 0;
}

async function runProductionCommand(
  argv: readonly string[],
  context: Readonly<ExtendedCommandContext>,
): Promise<number> {
  const [subcommand, ...rest] = argv;
  const evidence = await import('../production/evidence');

  if (subcommand === 'verify') {
    const oid = evidence.productionCandidateOid(context.cwd);
    assertOnlyOptions(rest, ['--run-id']);
    const runId = evidence.resolveProductionRunId(
      context.environment,
      optionValue(rest, '--run-id'),
      oid,
    );
    const stateRoot = evidence.resolveProductionStateRoot({
      stateRoot: context.stateRoot,
      environment: context.environment,
      create: false,
    });
    const result = evidence.verifyAllProductionEvidence({ stateRoot, runId, oid });
    context.stdout(`${JSON.stringify({
      ok: result.ok,
      repository_id: 'OMA',
      run_id: runId,
      oid,
      fail_closed: true,
      seams: result.seams,
    }, null, 2)}\n`);
    if (!result.ok) {
      context.stderr(formatCliError(
        'E_PRODUCTION_EVIDENCE',
        'one or more live seams are missing, stale, skipped, or invalid',
      ));
    }
    return result.ok ? 0 : 1;
  }

  if (subcommand === 'probe') {
    const seam = rest[0];
    if (!['plugin-discovery', 'managed-lifecycle', 'exact-resume', 'worker-runtime', 'mcp-lsp', 'workflow']
      .includes(seam ?? '')) {
      throw new ExtendedCliUsageError(
        'production probe requires plugin-discovery|managed-lifecycle|exact-resume|worker-runtime|mcp-lsp|workflow',
      );
    }
    assertOnlyOptions(rest.slice(1), ['--run-id']);
    if (seam === 'workflow') {
      const prepared = await evidence.prepareWorkflowProductionProbeFromCli(
        optionValue(rest.slice(1), '--run-id'),
      );
      const snapshot = await executeCanonicalProductWorkflow(prepared.execution, context);
      const result = evidence.recordPreparedWorkflowProductionProbe(prepared, snapshot);
      context.stdout(`${JSON.stringify({
        ok: true,
        run_id: prepared.runId,
        oid: prepared.oid,
        ...result,
      }, null, 2)}\n`);
      return 0;
    }
    const oid = evidence.productionCandidateOid(context.cwd);
    const runId = evidence.resolveProductionRunId(
      context.environment,
      optionValue(rest.slice(1), '--run-id'),
      oid,
    );
    const stateRoot = evidence.resolveProductionStateRoot({
      stateRoot: context.stateRoot,
      environment: context.environment,
      create: true,
    });
    const probeContext: import('../production/evidence').ProductionProbeContext = {
      packageRoot: context.packageRoot,
      repositoryRoot: context.cwd,
      stateRoot,
      runId,
      oid,
      agyCommand: context.agyCommand,
      packageVersion: context.version,
      environment: context.environment,
      pluginAdapter: context.pluginAdapter,
    };
    let result: import('../production/evidence').ProductionProbeResult;
    if (['plugin-discovery', 'mcp-lsp'].includes(seam as string)) {
      result = await evidence.runCoreProductionProbe(
        seam as import('../production/evidence').CoreProductionProbeSeam,
        probeContext,
      );
    } else {
      const runtime = require('../production/runtime-probes') as {
        runRuntimeProductionProbe(
          seam: 'managed-lifecycle' | 'exact-resume' | 'worker-runtime',
          context: import('../production/evidence').ProductionProbeContext,
        ): Promise<import('../production/evidence').ProductionProbeResult>;
      };
      result = await runtime.runRuntimeProductionProbe(
        seam as 'managed-lifecycle' | 'exact-resume' | 'worker-runtime',
        probeContext,
      );
    }
    context.stdout(`${JSON.stringify({ ok: true, run_id: runId, oid, ...result }, null, 2)}\n`);
    return 0;
  }

  if (subcommand === 'capture') {
    const oid = evidence.productionCandidateOid(context.cwd);
    const kind = rest[0];
    if (kind !== 'review' && kind !== 'ultraqa') {
      throw new ExtendedCliUsageError('production capture requires review|ultraqa');
    }
    const delimiter = rest.indexOf('--', 1);
    if (delimiter < 0 || delimiter === rest.length - 1) {
      throw new ExtendedCliUsageError('production capture requires -- before an allowlisted CLI command');
    }
    const options = rest.slice(1, delimiter);
    assertOnlyOptions(options, ['--run-id']);
    const runId = evidence.resolveProductionRunId(
      context.environment,
      optionValue(options, '--run-id'),
      oid,
    );
    const stateRoot = evidence.resolveProductionStateRoot({
      stateRoot: context.stateRoot,
      environment: context.environment,
      create: true,
    });
    const result = evidence.captureProductionReview(kind, rest.slice(delimiter + 1), {
      packageRoot: context.packageRoot,
      repositoryRoot: context.cwd,
      stateRoot,
      runId,
      oid,
      agyCommand: context.agyCommand,
      packageVersion: context.version,
      environment: context.environment,
      pluginAdapter: context.pluginAdapter,
    });
    context.stdout(`${JSON.stringify({ ok: true, run_id: runId, oid, ...result }, null, 2)}\n`);
    return 0;
  }

  throw new ExtendedCliUsageError('production requires verify|probe|capture');
}

const BOOLEAN_OPTIONS = new Set([
  '--json',
  '--watch',
  '--include-prompt',
  '--release',
  '--purge',
  '--check',
]);

function optionValue(argv: readonly string[], name: string): string | undefined {
  const indexes = argv.flatMap((value, index) => value === name ? [index] : []);
  if (indexes.length > 1) throw new ExtendedCliUsageError(`${name} may appear only once`);
  const index = indexes[0];
  if (index === undefined) return undefined;
  if (BOOLEAN_OPTIONS.has(name)) return 'true';
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--') || value.includes('\0')) {
    throw new ExtendedCliUsageError(`${name} requires one value`);
  }
  return value;
}

function requiredOption(argv: readonly string[], name: string): string {
  const value = optionValue(argv, name);
  if (value === undefined) throw new ExtendedCliUsageError(`missing ${name}`);
  return value;
}

function integerOption(
  argv: readonly string[],
  name: string,
  fallback: number | undefined,
  minimum: number,
  maximum: number,
): number {
  const raw = optionValue(argv, name);
  if (raw === undefined && fallback === undefined) {
    throw new ExtendedCliUsageError(`missing ${name}`);
  }
  const value = raw === undefined ? fallback as number : Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ExtendedCliUsageError(`${name} must be an integer in ${minimum}..${maximum}`);
  }
  return value;
}

function assertOnlyOptions(argv: readonly string[], allowed: readonly string[]): void {
  const allow = new Set(allowed);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--') || !allow.has(token)) {
      throw new ExtendedCliUsageError(`unexpected argument: ${token}`);
    }
    if (!BOOLEAN_OPTIONS.has(token)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new ExtendedCliUsageError(`${token} requires one value`);
      }
      index += 1;
    }
  }
}

function positionalValue(
  argv: readonly string[],
  index: number,
  message: string,
): string {
  const value = argv[index];
  if (value === undefined || value.startsWith('--') || value.includes('\0')) {
    throw new ExtendedCliUsageError(message);
  }
  return value;
}

function valuesBeforeOptions(argv: readonly string[]): string[] {
  const values: string[] = [];
  for (const value of argv) {
    if (value.startsWith('--')) break;
    if (value.includes('\0')) throw new ExtendedCliUsageError('argument contains a NUL byte');
    values.push(value);
  }
  return values;
}

function readBoundedRegularFile(targetPath: string, maximumBytes: number): Buffer {
  const target = path.resolve(targetPath);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > maximumBytes) {
      throw new Error(`bounded regular file required: ${target}`);
    }
    return fs.readFileSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function readBoundedRegularJson(targetPath: string, maximumBytes: number): unknown {
  const bytes = readBoundedRegularFile(targetPath, maximumBytes);
  const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
  return parsed;
}

function repositoryRuntimePath(repositoryRoot: string, relativePath: string): string {
  if (relativePath === '' || relativePath.includes('\0') || path.isAbsolute(relativePath)) {
    throw new Error('repository runtime path must be a confined relative path');
  }
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const target = path.resolve(root, relativePath);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new Error('repository runtime path escapes the repository');
  }
  return target;
}

function ensureRepositoryRuntimeDirectory(repositoryRoot: string, relativePath: string): string {
  const root = fs.realpathSync(path.resolve(repositoryRoot));
  const target = repositoryRuntimePath(root, relativePath);
  const relative = path.relative(root, target);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (!fs.existsSync(current)) fs.mkdirSync(current, { mode: 0o700 });
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`runtime directory is unsafe: ${current}`);
    }
  }
  return fs.realpathSync(target);
}

function writeStableCanonicalFile(targetPath: string, value: unknown, mode: number): void {
  writeStableBytes(targetPath, canonicalBytesV1(value), mode);
}

function writeStableBytes(targetPath: string, bytes: Buffer, mode: number): void {
  const target = path.resolve(targetPath);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  if (fs.existsSync(target)) {
    const existing = readBoundedRegularFile(target, Math.max(bytes.length, 1) + 1);
    if (!existing.equals(bytes)) throw new Error(`immutable runtime artifact differs: ${target}`);
    return;
  }
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(target, 'wx', mode);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, mode);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactObjectKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort(compareUtf8);
  const expected = [...keys].sort(compareUtf8);
  return actual.length === expected.length && actual.every((entry, index) => entry === expected[index]);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!/^[A-Za-z0-9._:-]{1,512}$/u.test(value) || value.includes('/') || value.includes('\\')) {
    throw new ExtendedCliUsageError(`${label} is invalid`);
  }
}

function commandProbeOptions(
  environment: NodeJS.ProcessEnv,
): import('child_process').SpawnSyncOptionsWithStringEncoding {
  return {
    encoding: 'utf8',
    timeout: 5_000,
    maxBuffer: 1_048_576,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: ordinaryEnvironment(environment),
  };
}

function commandStateRoot(
  context: Readonly<ExtendedCommandContext>,
  homeDirectory = os.homedir(),
  create = true,
): string {
  if (context.stateRoot !== undefined) {
    const target = path.resolve(context.stateRoot);
    if (!create) return target;
    fs.mkdirSync(target, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('state root is unsafe');
    return fs.realpathSync(target);
  }
  const resolved = resolveStateRoot({
    env: context.environment,
    homeDirectory,
    create,
  });
  if (!resolved.ok) throw new Error(`${resolved.error.code}: ${resolved.error.message}`);
  return resolved.value.path;
}
