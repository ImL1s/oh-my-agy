import { spawnSync } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { ManagedInvocationService, PreparedManagedInvocation } from '../cli/managed-invocation';
import { sessionAggregatePath } from '../continuation/session-aggregate';
import { SessionLocator } from '../continuation/state';
import { handlePreInvocation } from '../hooks/pre-invocation';
import { handleStop } from '../hooks/stop';
import { canonicalJson, sha256 } from '../runtime/atomic';
import { currentProcessIdentity, ProcessRunner } from '../runtime/process';
import { resolveWorkspaceIdentity } from '../runtime/state-root';
import {
  ProductionEvidenceSeam, ProductionProbeContext, ProductionProbeResult,
  resolveProductionStateRoot, writeProductionEvidence,
} from './evidence';
import { TeamOrchestrator } from '../team/orchestrator';
import { TeamStateStore } from '../team/state';
import { resolveGitWorktreeIdentity } from '../team/worktree';
import {
  HostIdentityV1,
  PluginIdentityV1,
  assembleHostCapabilityProfile,
} from '../native/capability-profile';

export type RuntimeProductionSeam = Extract<ProductionEvidenceSeam, 'managed-lifecycle' | 'exact-resume' | 'worker-runtime'>;

export interface RuntimeProbeObservation {
  artifact: Record<string, unknown>;
  argv: readonly string[];
  stdout: string;
  stderr: string;
  producerIdentity: 'oma.production.runtime-probes/v1';
  toolIdentity: 'oma-runtime-probe';
}

interface LifecycleBinding {
  probeRoot: string;
  workspacePath: string;
  workspaceKey: string;
  sessionId: string;
  conversationId: string;
  generation: number;
  revision: number;
  childReceipt: Record<string, unknown>;
}

const PRODUCER = 'oma.production.runtime-probes/v1' as const;
const TOOL = 'oma-runtime-probe' as const;
const DEADLINE_MS = 10_000;

/**
 * Product-owned runtime probes. The caller supplies only immutable release
 * context; every claimed field below is reconstructed from OMA stores and
 * command outcomes created by this invocation.
 */
export async function runRuntimeProductionProbe(
  seam: RuntimeProductionSeam,
  context: Readonly<ProductionProbeContext>,
): Promise<ProductionProbeResult> {
  const observed = await runRuntimeProductionProbeRaw(seam, context);
  const artifact = evidenceArtifact(seam, observed.artifact);
  return writeProductionEvidence({
    context,
    seam,
    artifact,
    producerIdentity: 'oma-product-runtime-probe',
    toolIdentity: 'oma-runtime-probe-v1',
    argv: ['oma', 'production', 'probe', seam],
    stdout: observed.stdout,
    stderr: observed.stderr,
  });
}

export async function runRuntimeProductionProbeRaw(
  seam: RuntimeProductionSeam,
  context: Readonly<ProductionProbeContext>,
): Promise<RuntimeProbeObservation> {
  const roots = validateContext(context);
  const probeRoot = createProbeRoot(roots.stateRoot, context.runId, seam);
  try {
    if (seam === 'managed-lifecycle') return await runManagedLifecycle(context, probeRoot);
    if (seam === 'exact-resume') return await runExactResume(context, probeRoot);
    return await runWorkerRuntime(context, probeRoot);
  } finally {
    const candidateWorkspace = path.join(probeRoot, 'candidate-workspace');
    if (fs.existsSync(candidateWorkspace)) {
      removeCandidateWorkspace(context.repositoryRoot, candidateWorkspace);
    }
  }
}

function validateContext(context: Readonly<ProductionProbeContext>): {
  repositoryRoot: string; stateRoot: string;
} {
  if (!/^[a-f0-9]{40,64}$/.test(context.oid) || !/^[A-Za-z0-9._:-]+$/.test(context.runId)) {
    throw new Error('E_PRODUCTION_CONTEXT_INVALID: oid/runId is not canonical');
  }
  const repositoryRoot = fs.realpathSync(path.resolve(context.repositoryRoot));
  const configuredStateRoot = resolveProductionStateRoot({ stateRoot: context.stateRoot, environment: context.environment, create: true });
  const stateRoot = fs.realpathSync(path.resolve(configuredStateRoot));
  const head = git(repositoryRoot, ['rev-parse', 'HEAD']).stdout.trim();
  if (head !== context.oid) throw new Error('E_PRODUCTION_OID_MISMATCH: repository HEAD changed');
  return { repositoryRoot, stateRoot };
}

function createProbeRoot(stateRoot: string, runId: string, seam: string): string {
  const parent = path.resolve(stateRoot, 'runtime-probes', runId);
  const root = path.resolve(parent, `${seam}-${crypto.randomUUID()}`);
  if (!root.startsWith(`${stateRoot}${path.sep}`)) throw new Error('E_PATH_OUTSIDE_ROOT');
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.chmodSync(root, 0o700);
  return fs.realpathSync(root);
}

async function establishLifecycle(
  context: Readonly<ProductionProbeContext>,
  probeRoot: string,
): Promise<LifecycleBinding> {
  const isolatedWorkspace = createCandidateWorkspace(probeRoot, context.repositoryRoot, context.oid);
  const workspace = resolveWorkspaceIdentity(isolatedWorkspace);
  if (!workspace.ok) throw new Error(`${workspace.error.code}: ${workspace.error.message}`);
  const sessionId = `prod-${crypto.randomUUID()}`;
  const conversationId = `conversation-${crypto.randomUUID()}`;
  const ownerNonce = crypto.randomBytes(16).toString('hex');
  const locator = new SessionLocator(probeRoot, workspace.value.workspaceKey, {
    childSpawnWaitMs: 1_000,
    childSpawnPollMs: 10,
  });
  const created = await locator.createManagedLaunch({
    sessionId,
    repoKey: workspace.value.repoKey,
    workspaceKey: workspace.value.workspaceKey,
    workspacePath: workspace.value.workspacePath,
    launchNonce: crypto.randomBytes(32).toString('hex'),
    owner: currentProcessIdentity(ownerNonce),
    ttlMs: 30_000,
  });
  if (!created.ok) throw new Error(`${created.error.code}: ${created.error.message}`);

  const runner = new ProcessRunner();
  let spawnRecorded = false;
  const child = await runner.boundedHeadless(
    process.execPath,
    ['-e', "process.stdout.write('oma-child-ok\\n')"],
    {
      deadlineMs: DEADLINE_MS,
      terminationGraceMs: 250,
      maxOutputBytes: 4096,
      maxProcessCount: 1,
      cwd: workspace.value.workspacePath,
      env: { ...process.env, ...created.value.transaction.env },
      onSpawn: (identity) => {
        const recorded = created.value.transaction.recordChildSpawned(identity);
        spawnRecorded = recorded.ok;
        return recorded.ok ? { ok: true, value: undefined } : recorded;
      },
    },
    { operationId: `production:${sessionId}`, ownerNonce },
  );
  if (!child.ok) throw new Error(`${child.error.code}: ${child.error.message}`);
  if (!spawnRecorded || child.value.code !== 0 || child.value.timedOut) {
    throw new Error('E_PRODUCTION_CHILD_FAILED: bounded child did not exit cleanly');
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...created.value.transaction.env,
    OMA_STATE_ROOT: probeRoot,
    OMA_WORKSPACE_PATH: workspace.value.workspacePath,
    OMA_PACKAGE_ROOT: context.repositoryRoot,
  };
  const pre = await handlePreInvocation({
    conversationId,
    workspacePaths: [workspace.value.workspacePath],
    invocationNum: 1,
  }, env);
  if (pre.ok !== true || pre.bindingRoute !== 'exact_env' || pre.sessionId !== sessionId) {
    throw new Error('E_PRODUCTION_BIND_FAILED: PreInvocation did not establish exact binding');
  }

  const first = JSON.parse(await handleStop({
    conversationId,
    invocationGeneration: 1,
    executionNum: 0,
    workspacePaths: [workspace.value.workspacePath],
    fullyIdle: true,
    terminationReason: 'NO_TOOL_CALL',
  }, env)) as { decision?: string };
  const afterFirst = readJsonObject(sessionAggregatePath(
    probeRoot, workspace.value.workspaceKey, sessionId,
  ));
  const resumed = await locator.prepareResume(conversationId, requireInteger(afterFirst.revision));
  if (!resumed.ok) throw new Error(`${resumed.error.code}: ${resumed.error.message}`);
  if (child.value.processIdentity === null) throw new Error('E_PRODUCTION_CHILD_IDENTITY_MISSING');
  const resumedCapability = locator.managedLaunch(resumed.value);
  const sameChildRecorded = resumedCapability.recordChildSpawned(child.value.processIdentity);
  if (!sameChildRecorded.ok) {
    throw new Error(`${sameChildRecorded.error.code}: ${sameChildRecorded.error.message}`);
  }
  const resumedEnv: NodeJS.ProcessEnv = {
    ...env,
    ...resumedCapability.env,
  };
  const resumedPre = await handlePreInvocation({
    conversationId,
    workspacePaths: [workspace.value.workspacePath],
    invocationNum: 2,
  }, resumedEnv);
  if (resumedPre.ok !== true || resumedPre.bindingRoute !== 'exact_env') {
    throw new Error('E_PRODUCTION_RESUME_BIND_FAILED');
  }
  const final = JSON.parse(await handleStop({
    conversationId,
    invocationGeneration: 2,
    executionNum: 1,
    workspacePaths: [workspace.value.workspacePath],
    fullyIdle: true,
    terminationReason: 'NO_TOOL_CALL',
    hasInteractionBlocker: true,
  }, resumedEnv)) as { decision?: string };
  if (first.decision !== 'continue' || final.decision !== 'allow') {
    throw new Error('E_PRODUCTION_STOP_SEQUENCE: Stop decisions were not continue then allow');
  }
  const aggregatePath = sessionAggregatePath(probeRoot, workspace.value.workspaceKey, sessionId);
  const aggregate = readJsonObject(aggregatePath);
  const processed = Object.values(requireObject(aggregate.processedStops));
  if (processed.length !== 2) throw new Error('E_PRODUCTION_STOP_SEQUENCE: store lacks exact Stop receipts');
  return {
    probeRoot,
    workspacePath: workspace.value.workspacePath,
    workspaceKey: workspace.value.workspaceKey,
    sessionId,
    conversationId,
    generation: requireInteger(requireObject(aggregate.binding).activeInvocationGeneration),
    revision: requireInteger(aggregate.revision),
    childReceipt: {
      code: child.value.code,
      timed_out: child.value.timedOut,
      stdout_sha256: sha256(child.value.stdout),
      stderr_sha256: sha256(child.value.stderr),
      process_identity: child.value.processIdentity,
    },
  };
}

async function runManagedLifecycle(
  context: Readonly<ProductionProbeContext>,
  probeRoot: string,
): Promise<RuntimeProbeObservation> {
  const bound = await establishLifecycle(context, probeRoot);
  const aggregate = readJsonObject(sessionAggregatePath(
    bound.probeRoot, bound.workspaceKey, bound.sessionId,
  ));
  const binding = requireObject(aggregate.binding);
  const processed = Object.values(requireObject(aggregate.processedStops))
    .map((entry) => requireObject(entry));
  const decisions = processed
    .sort((a, b) => requireInteger(requireObject(a.identity).executionNum)
      - requireInteger(requireObject(b.identity).executionNum))
    .map((entry) => requireObject(JSON.parse(requireString(entry.decisionJson))).decision);
  const journalPath = path.join(probeRoot, 'lifecycle', 'hooks.jsonl');
  const journal = fs.readFileSync(journalPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  const artifact = {
    store_kind: 'oma_production_managed_lifecycle', schema_version: 1,
    repository_id: 'OMA', run_id: context.runId, candidate_oid: context.oid,
    session_id: bound.sessionId, conversation_id: bound.conversationId,
    pre_invocation_exact_bind: binding.bindingRoute === 'exact_env',
    generation_n: 1,
    active_generation: requireInteger(binding.activeInvocationGeneration),
    stop_n_continue: decisions[0] === 'continue',
    stop_n_plus_1_final_allow: decisions[1] === 'allow',
    second_launch_count: 0,
    child_exit_code: requireInteger(bound.childReceipt.code),
    child_receipt: bound.childReceipt,
    aggregate_revision: requireInteger(aggregate.revision),
    aggregate_sha256: sha256(canonicalJson(aggregate)),
    journal_event_types: journal.map((entry) => requireString(requireObject(entry).event_type ?? requireObject(entry).eventType)),
  };
  removeCandidateWorkspace(context.repositoryRoot, bound.workspacePath);
  return observation(artifact, ['node', 'oma-runtime-probe', 'managed-lifecycle'], 'managed lifecycle observed');
}

async function runExactResume(
  context: Readonly<ProductionProbeContext>,
  probeRoot: string,
): Promise<RuntimeProbeObservation> {
  const bound = await establishLifecycle(context, probeRoot);
  const before = readJsonObject(sessionAggregatePath(probeRoot, bound.workspaceKey, bound.sessionId));
  const beforeGeneration = requireInteger(requireObject(before.binding).activeInvocationGeneration);
  const beforeRevision = requireInteger(before.revision);
  const executable = path.join(probeRoot, 'controlled-agy.js');
  const receiptPath = path.join(probeRoot, 'resume-command.json');
  fs.writeFileSync(executable, [
    '#!/usr/bin/env node',
    "const fs=require('fs');",
    `fs.writeFileSync(${JSON.stringify(receiptPath)}, JSON.stringify({argv:process.argv.slice(2),session:process.env.OMA_SESSION_ID,generation:process.env.OMA_INVOCATION_GENERATION,nonce:process.env.OMA_LAUNCH_NONCE}));`,
    "process.stdout.write('resume-ok\\n');",
  ].join('\n'), { mode: 0o700 });
  fs.chmodSync(executable, 0o700);

  const resumeOwnerNonce = crypto.randomBytes(16).toString('hex');
  const locator = new SessionLocator(probeRoot, bound.workspaceKey, {
    resumeOwnerFactory: () => currentProcessIdentity(resumeOwnerNonce),
  });
  let active: { prepared: PreparedManagedInvocation; capability: ReturnType<SessionLocator['managedLaunch']> } | undefined;
  const transaction = {
    prepareLaunch: async () => ({ ok: false as const, error: {
      code: 'E_RETRYABLE_BLOCKER' as const, message: 'production resume probe does not launch',
    } }),
    prepareResume: async (input: { sessionId: string; conversationId: string; expectedRevision: number }) => {
      const resumed = await locator.prepareResume(input.conversationId, input.expectedRevision);
      if (!resumed.ok) return resumed;
      if (resumed.value.sessionId !== input.sessionId || resumed.value.owner.ownerNonce === undefined) {
        return { ok: false as const, error: {
          code: 'E_WORKSPACE_MISMATCH' as const, message: 'resume binding changed',
        } };
      }
      const operationId = `production-resume:${crypto.randomUUID()}`;
      const prepared: PreparedManagedInvocation = {
        kind: 'resume', launchTransactionId: operationId,
        sessionId: resumed.value.sessionId, conversationId: resumed.value.conversationId,
        launchNonce: resumed.value.launchNonce,
        invocationGeneration: resumed.value.invocationGeneration,
        cwd: bound.workspacePath,
        operationIdentity: { operationId, ownerNonce: resumed.value.owner.ownerNonce },
      };
      active = { prepared, capability: locator.managedLaunch(resumed.value) };
      return { ok: true as const, value: prepared };
    },
    recordChildSpawned: (prepared: PreparedManagedInvocation, identity: Parameters<ReturnType<SessionLocator['managedLaunch']>['recordChildSpawned']>[0]) => {
      if (active === undefined || active.prepared.launchTransactionId !== prepared.launchTransactionId) {
        return { ok: false as const, error: {
          code: 'E_STALE_ACTIVE_POINTER' as const, message: 'resume capability is stale',
        } };
      }
      const recorded = active.capability.recordChildSpawned(identity);
      return recorded.ok ? { ok: true as const, value: undefined } : recorded;
    },
    recordOutcome: async (prepared: PreparedManagedInvocation) => {
      if (active === undefined || active.prepared.launchTransactionId !== prepared.launchTransactionId) {
        return { ok: false as const, error: {
          code: 'E_STALE_ACTIVE_POINTER' as const, message: 'resume outcome is stale',
        } };
      }
      active = undefined;
      return { ok: true as const, value: undefined };
    },
  };
  const service = new ManagedInvocationService({
    agyCommand: executable,
    environment: { ...process.env },
    packageRoot: context.repositoryRoot,
    workspacePath: bound.workspacePath,
    stateRoot: probeRoot,
    preflight: async () => ({ ok: true, value: { active: true } }),
    transaction,
    runner: new ProcessRunner(),
  });
  const oldHeadless = process.env.OMA_MANAGED_HEADLESS;
  const oldTimeout = process.env.OMA_TIMEOUT_MS;
  process.env.OMA_MANAGED_HEADLESS = '1';
  process.env.OMA_TIMEOUT_MS = String(DEADLINE_MS);
  try {
    const resumed = await service.resumeConversation(bound.sessionId, bound.conversationId, beforeRevision);
    if (!resumed.ok) throw new Error(`${resumed.error.code}: ${resumed.error.message}`);
    if (resumed.value.code !== 0 || resumed.value.timedOut) throw new Error('E_PRODUCTION_RESUME_EXEC_FAILED');
  } finally {
    restoreEnv('OMA_MANAGED_HEADLESS', oldHeadless);
    restoreEnv('OMA_TIMEOUT_MS', oldTimeout);
  }
  const command = readJsonObject(receiptPath);
  const after = readJsonObject(sessionAggregatePath(probeRoot, bound.workspaceKey, bound.sessionId));
  const afterGeneration = requireInteger(requireObject(after.binding).activeInvocationGeneration);
  const argv = requireStringArray(command.argv);
  if (canonicalJson(argv) !== canonicalJson(['--conversation', bound.conversationId])) {
    throw new Error('E_PRODUCTION_RESUME_ARGV_MISMATCH');
  }
  if (afterGeneration !== beforeGeneration + 1 || Number(command.generation) !== afterGeneration) {
    throw new Error('E_PRODUCTION_RESUME_GENERATION_MISMATCH');
  }
  const artifact = {
    store_kind: 'oma_production_exact_resume', schema_version: 1,
    repository_id: 'OMA', run_id: context.runId, candidate_oid: context.oid,
    session_id: bound.sessionId, conversation_id: bound.conversationId,
    generation_before: beforeGeneration, generation_after: afterGeneration,
    exact_argv: [path.basename(executable), ...argv],
    semantic_argv: ['agy', ...argv],
    command_receipt_sha256: sha256(canonicalJson(command)),
    aggregate_revision: requireInteger(after.revision),
    aggregate_sha256: sha256(canonicalJson(after)),
    host_required: false,
  };
  removeCandidateWorkspace(context.repositoryRoot, bound.workspacePath);
  return observation(artifact, [executable, ...argv], 'exact resume executed');
}

async function runWorkerRuntime(
  context: Readonly<ProductionProbeContext>,
  probeRoot: string,
): Promise<RuntimeProbeObservation> {
  const tmuxVersion = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  if (tmuxVersion.status !== 0) throw new Error('E_HOST_REQUIRED: tmux is unavailable');
  const repo = path.join(probeRoot, 'worker-repo');
  const stateRoot = path.join(probeRoot, 'worker-state');
  const managedRoot = path.join(probeRoot, 'worktrees');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  fs.chmodSync(stateRoot, 0o700);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'oma-probe@example.invalid']);
  git(repo, ['config', 'user.name', 'OMA Production Probe']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'probe\n');
  git(repo, ['add', 'README.md']);
  git(repo, ['commit', '-q', '-m', 'probe base']);
  const identity = resolveGitWorktreeIdentity(repo);
  const teamId = `prod-${crypto.randomBytes(6).toString('hex')}`;
  const taskId = 'worker';
  const prefix = `oma-prod-${crypto.randomBytes(6).toString('hex')}`;
  const workerScript = path.join(probeRoot, 'worker.js');
  fs.writeFileSync(workerScript, [
    "const fs=require('fs');", "const p=process.argv[2];", "fs.writeFileSync(p,'ready\\n');",
    "process.on('SIGTERM',()=>process.exit(0));", 'setInterval(()=>{},250);',
  ].join('\n'));
  const manifestPath = path.join(probeRoot, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify({
    schema: 'oma.team-manifest/v1', teamId, revision: 1,
    tasks: [{ id: taskId, dependencies: [], write_scope: [{ kind: 'file', path: 'result.txt' }],
      mode: 'headless', verification: { version: 1, commands: [], requiredArtifacts: [] } }],
  }));
  const orchestrator = new TeamOrchestrator({
    stateRoot, workspaceRoot: repo, repoKey: identity.repoKey,
    workspaceKey: identity.workspaceKey, managedWorktreesRoot: managedRoot,
    sessionNamePrefix: prefix, workerExecutablePath: process.execPath,
    workerBootstrapArgv: [workerScript], leaseMs: 30_000,
    providerProfileFactory: ({ selectedAt }) => {
      // This controlled probe verifies the OMA Team launch harness only. Its
      // profile is bound to the exact Node executable used by the harness and
      // must not be reported as live Antigravity host parity.
      const hostIdentity: HostIdentityV1 = {
        realpath: fs.realpathSync(process.execPath),
        binarySha256: sha256(fs.readFileSync(process.execPath)),
        version: process.version,
        versionOutputSha256: sha256(process.version),
        helpOutputSha256: sha256('oma-production-team-harness'),
        platform: process.platform,
        arch: process.arch,
      };
      const pluginIdentity: PluginIdentityV1 = {
        status: 'absent', realpath: null, packageDigest: null, version: null,
        readbackDigest: null, enabled: false,
      };
      const empty = assembleHostCapabilityProfile({
        evaluationTimestamp: selectedAt,
        hostIdentityBefore: hostIdentity,
        hostIdentityAfter: hostIdentity,
        pluginIdentityBefore: pluginIdentity,
        pluginIdentityAfter: pluginIdentity,
        observations: [],
      });
      const profile = assembleHostCapabilityProfile({
        evaluationTimestamp: selectedAt,
        hostIdentityBefore: hostIdentity,
        hostIdentityAfter: hostIdentity,
        pluginIdentityBefore: pluginIdentity,
        pluginIdentityAfter: pluginIdentity,
        observations: ['headless.print', 'headless.json'].map((capability) => ({
          capability,
          source: 'live_probe' as const,
          tier: 'healthy' as const,
          result: 'positive' as const,
          observedAt: selectedAt,
          identityDigest: empty.identityDigest,
          detailCode: 'PRODUCTION_TEAM_HARNESS_VERIFIED',
          diagnostic: null,
        })),
      });
      return {
        ok: true,
        value: {
          profile,
          resolvedExecutable: hostIdentity.realpath,
        },
      };
    },
  });
  let sessionName: string | undefined;
  let worktreePath: string | undefined;
  try {
    const started = await orchestrator.startFromManifest(manifestPath, 'headless');
    if (!started.ok) throw new Error(`${started.error.code}: ${started.error.message}`);
    const worker = started.value.workers[0];
    sessionName = worker.sessionName;
    worktreePath = worker.worktreePath;
    const status = await orchestrator.status(teamId);
    if (!status.ok || status.value.tmux[worker.sessionName]?.alive !== true) {
      throw new Error('E_PRODUCTION_WORKER_NOT_LIVE');
    }
    const tty = spawnSync('tmux', ['display-message', '-p', '-t', worker.paneId, '#{pane_tty}'], { encoding: 'utf8' });
    if (tty.status !== 0 || tty.stdout.trim() === '') throw new Error('E_PRODUCTION_TMUX_TTY_UNOBSERVED');

    const store = new TeamStateStore(stateRoot, identity.repoKey, identity.workspaceKey, teamId);
    const launched = store.read();
    if (!launched.ok) throw new Error(`${launched.error.code}: ${launched.error.message}`);
    const heartbeat = launched.value.value.heartbeats[taskId];
    if (heartbeat === undefined) throw new Error('E_PRODUCTION_WORKER_HEARTBEAT_MISSING');
    const providerReceiptHash = worker.routeReceiptDigest;
    const boundAuthority = await store.bindWorkerAuthority(
      launched.value.revision,
      worker.claimToken,
      {
        schemaVersion: 1, taskId, claimTokenDigest: sha256(worker.claimToken),
        generation: worker.generation, provider: 'agy_headless',
        providerProfileDigest: worker.providerProfileDigest, providerReceiptHash,
        process: heartbeat.process,
        state: 'claimed', transitionSequence: 0, boundAtMs: Date.now(),
      },
    );
    if (!boundAuthority.ok) throw new Error(`${boundAuthority.error.code}: ${boundAuthority.error.message}`);
    const sent = await store.sendOrderedMailbox(boundAuthority.value.revision, taskId, worker.generation, {
      schemaVersion: 1, id: `message-${crypto.randomBytes(6).toString('hex')}`,
      sender: 'production-probe', bodyDigest: sha256('integrate result'), createdAtMs: Date.now(),
    });
    if (!sent.ok) throw new Error(`${sent.error.code}: ${sent.error.message}`);
    const batch = store.listOrderedMailbox({
      taskId, claimToken: worker.claimToken, generation: worker.generation, afterCursor: 0,
    });
    if (!batch.ok || batch.value.messages.length !== 1) throw new Error(`E_PRODUCTION_MAILBOX_READ_FAILED: ${batch.ok ? batch.value.messages.length : `${batch.error.code} ${batch.error.message}`}`);
    const acked = await store.acknowledgeOrderedMailbox({
      expectedRevision: sent.value.revision, taskId, claimToken: worker.claimToken,
      generation: worker.generation, expectedCursor: 0, nextCursor: 1,
      messageIds: [batch.value.messages[0].id], acknowledgedAtMs: Date.now(),
    });
    if (!acked.ok) throw new Error(`${acked.error.code}: ${acked.error.message}`);

    let deliveryRevision = acked.value.revision;
    const authoritySteps = [
      ['claimed', 'launched'], ['launched', 'running'],
      ['running', 'verifying'], ['verifying', 'delivery_ready'],
    ] as const;
    for (const [sequence, [expectedState, nextState]] of authoritySteps.entries()) {
      const moved = await store.transitionWorkerAuthority({
        expectedRevision: deliveryRevision, taskId, claimToken: worker.claimToken,
        generation: worker.generation, providerReceiptHash,
        expectedState, expectedSequence: sequence, nextState,
      });
      if (!moved.ok) throw new Error(`${moved.error.code}: ${moved.error.message}`);
      deliveryRevision = moved.value.revision;
    }
    fs.writeFileSync(path.join(worker.worktreePath, 'result.txt'), 'integrated\n');
    git(worker.worktreePath, ['add', 'result.txt']);
    git(worker.worktreePath, ['commit', '-q', '-m', 'probe delivery']);
    const delivered = await orchestrator.deliverTask({
      teamId, taskId, expectedRevision: deliveryRevision,
      claimToken: worker.claimToken, generation: worker.generation,
      worktreePath: worker.worktreePath,
    });
    if (!delivered.ok) throw new Error(`${delivered.error.code}: ${delivered.error.message}`);
    const terminal = store.read();
    if (!terminal.ok || terminal.value.value.tasks[taskId]?.status !== 'completed') {
      throw new Error('E_PRODUCTION_WORKER_NOT_INTEGRATED');
    }
    const aliveAfter = spawnSync('tmux', ['has-session', '-t', `=${worker.sessionName}`], { encoding: 'utf8' }).status === 0;
    if (aliveAfter) throw new Error('E_PRODUCTION_WORKER_ORPHAN');
    const cursor = terminal.value.value.mailboxCursors?.[taskId];
    const artifact = {
      store_kind: 'oma_production_worker_runtime', schema_version: 1,
      repository_id: 'OMA', run_id: context.runId, candidate_oid: context.oid,
      team_id: teamId, task_id: taskId, generation: worker.generation,
      tmux_version: tmuxVersion.stdout.trim(), interactive_tty_observed: true,
      pane_tty: tty.stdout.trim(), headless_exit_observed: !aliveAfter,
      mailbox_delivery_count: batch.value.messages.length,
      mailbox_cursor: cursor?.cursor ?? null,
      mailbox_acknowledged: cursor?.cursor === 1,
      delivery_status: delivered.value.status,
      integration_tip: delivered.value.integrationTip,
      integration_readback: fs.readFileSync(path.join(repo, 'result.txt'), 'utf8') === 'integrated\n',
      orphan_count: aliveAfter ? 1 : 0,
      aggregate_revision: terminal.value.revision,
      aggregate_sha256: sha256(canonicalJson(terminal.value.value)),
    };
    return observation(artifact, ['tmux', 'display-message', '-p', '-t', worker.paneId, '#{pane_tty}'], 'worker runtime observed');
  } finally {
    if (sessionName !== undefined) {
      try { await orchestrator.stop(teamId); } catch (_) { /* bounded cleanup below */ }
      spawnSync('tmux', ['kill-session', '-t', `=${sessionName}`], { encoding: 'utf8' });
    }
    if (worktreePath !== undefined && fs.existsSync(worktreePath)) {
      spawnSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repo, encoding: 'utf8' });
    }
    if (sessionName !== undefined
      && spawnSync('tmux', ['has-session', '-t', `=${sessionName}`], { encoding: 'utf8' }).status === 0) {
      throw new Error('E_PRODUCTION_WORKER_ORPHAN: cleanup failed');
    }
  }
}

function evidenceArtifact(
  seam: RuntimeProductionSeam,
  raw: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  if (seam === 'managed-lifecycle') {
    const child = requireObject(raw.child_receipt);
    return {
      wrapper_pid: process.pid,
      child_pid: requireInteger(requireObject(child.process_identity).pid),
      generation_n: requireInteger(raw.generation_n),
      generation_n_plus_1: requireInteger(raw.generation_n) + 1,
      pre_invocation_exact_bind: raw.pre_invocation_exact_bind === true,
      stop_n_continue: raw.stop_n_continue === true,
      second_launch_count: requireInteger(raw.second_launch_count),
      stop_n_plus_1_final_allow: raw.stop_n_plus_1_final_allow === true,
      child_exit_code: requireInteger(raw.child_exit_code),
    };
  }
  if (seam === 'exact-resume') {
    return {
      conversation_id: requireString(raw.conversation_id),
      argv: requireStringArray(raw.semantic_argv),
      generation: requireInteger(raw.generation_before),
      next_generation: requireInteger(raw.generation_after),
      verified: raw.host_required === false,
    };
  }
  return {
    interactive_tty_observed: raw.interactive_tty_observed === true,
    headless_exit_verified: raw.headless_exit_observed === true,
    mailbox_verified: raw.mailbox_acknowledged === true,
    delivery_verified: raw.delivery_status === 'completed' && raw.integration_readback === true,
    orphan_count: requireInteger(raw.orphan_count),
  };
}

function observation(
  artifact: Record<string, unknown>, argv: readonly string[], stdout: string,
): RuntimeProbeObservation {
  return { artifact, argv, stdout, stderr: '', producerIdentity: PRODUCER, toolIdentity: TOOL };
}

function createCandidateWorkspace(probeRoot: string, repositoryRoot: string, oid: string): string {
  const target = path.join(probeRoot, 'candidate-workspace');
  git(repositoryRoot, ['worktree', 'add', '--detach', target, oid]);
  const real = fs.realpathSync(target);
  const head = git(real, ['rev-parse', 'HEAD']).stdout.trim();
  if (head !== oid) {
    removeCandidateWorkspace(repositoryRoot, real);
    throw new Error('E_PRODUCTION_OID_MISMATCH: isolated worktree changed');
  }
  return real;
}

function removeCandidateWorkspace(repositoryRoot: string, workspacePath: string): void {
  const removed = spawnSync('git', ['worktree', 'remove', '--force', workspacePath], {
    cwd: repositoryRoot, encoding: 'utf8', timeout: DEADLINE_MS,
  });
  spawnSync('git', ['worktree', 'prune'], { cwd: repositoryRoot, encoding: 'utf8', timeout: DEADLINE_MS });
  if (removed.status !== 0 && fs.existsSync(workspacePath)) {
    throw new Error(`E_PRODUCTION_WORKSPACE_CLEANUP: ${removed.stderr}`);
  }
}

function git(cwd: string, argv: readonly string[]): { stdout: string; stderr: string } {
  const result = spawnSync('git', [...argv], { cwd, encoding: 'utf8', timeout: DEADLINE_MS });
  if (result.status !== 0) throw new Error(`git ${argv.join(' ')} failed: ${result.stderr}`);
  return { stdout: result.stdout, stderr: result.stderr };
}

function readJsonObject(file: string): Record<string, unknown> {
  return requireObject(JSON.parse(fs.readFileSync(file, 'utf8')));
}
function requireObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('E_PROBE_STATE_INVALID');
  return value as Record<string, unknown>;
}
function requireString(value: unknown): string {
  if (typeof value !== 'string') throw new Error('E_PROBE_STATE_INVALID');
  return value;
}
function requireInteger(value: unknown): number {
  if (!Number.isSafeInteger(value)) throw new Error('E_PROBE_STATE_INVALID');
  return value as number;
}
function requireStringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error('E_PROBE_STATE_INVALID');
  return value as string[];
}
function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
}
