import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  HostIdentityV1,
  PluginIdentityV1,
  assembleHostCapabilityProfile,
  issueHostRouteReceipt,
  routeHostCapability,
} from '../../src/native/capability-profile';
import { sha256 } from '../../src/runtime/atomic';
import { CanonicalTeamTaskV1 } from '../../src/team/types';
import { buildWorkerEnvelope } from '../../src/team/worker-envelope';

const selectedAt = '2026-07-31T12:00:00.000Z';
const now = '2026-07-31T12:00:01.000Z';
const contextDigest = sha256('context');

function authority(generation = 2) {
  const host: HostIdentityV1 = {
    realpath: '/opt/agy', binarySha256: sha256('binary'), version: null,
    versionOutputSha256: sha256('version'), helpOutputSha256: sha256('help'),
    platform: 'darwin', arch: 'arm64',
  };
  const plugin: PluginIdentityV1 = {
    status: 'present', realpath: '/opt/plugin', packageDigest: sha256('plugin'),
    version: '1', readbackDigest: sha256('readback'), enabled: true,
  };
  const empty = assembleHostCapabilityProfile({ evaluationTimestamp: selectedAt, hostIdentityBefore: host, hostIdentityAfter: host, pluginIdentityBefore: plugin, pluginIdentityAfter: plugin, observations: [] });
  const profile = assembleHostCapabilityProfile({
    evaluationTimestamp: selectedAt, hostIdentityBefore: host, hostIdentityAfter: host,
    pluginIdentityBefore: plugin, pluginIdentityAfter: plugin,
    observations: [{ capability: 'headless.print', source: 'live_probe', tier: 'healthy', result: 'positive', observedAt: selectedAt, identityDigest: empty.identityDigest, detailCode: 'OK', diagnostic: null }],
  });
  const candidate = routeHostCapability(profile, {
    capability: 'headless.print', provider: 'agy_headless', requestMode: 'headless',
    generation, contextDigest, selectedAt, ttlMs: 60_000, fallbackPreconditionsSatisfied: true,
  });
  return { profile, receipt: issueHostRouteReceipt(candidate, '/opt/agy', 'agy_headless_v1') };
}

describe('complete WorkerEnvelopeV1 construction', () => {
  test('binds validated profile and receipt digests with task authority', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-worker-envelope-'));
    try {
      fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Guidance\n', 'utf8');
      const task: CanonicalTeamTaskV1 = {
        id: 'implement', dependencies: ['plan'], write_scope: [{ kind: 'dir', path: 'src/team' }], mode: 'headless',
        verification: { version: 1, commands: [{ command: 'npm', argv: ['test'], cwd: '.', deadlineMs: 30_000, expectedExit: 0 }], requiredArtifacts: ['src/team/result.ts'] },
      };
      const route = authority();
      const result = buildWorkerEnvelope({
        repositoryRoot: root, runId: 'run-1', teamId: 'team-1', task,
        taskText: 'Implement the complete owned team slice',
        dependencyResults: [{ task_id: 'plan', result_hash: sha256('plan'), artifact_roots: ['artifacts/plan'] }],
        artifactContract: { proposal_root: 'artifacts/team/implement', required_files: ['src/team/result.ts'], terminal_receipt_path: 'artifacts/team/implement/terminal.json' },
        contributorGuidancePaths: ['AGENTS.md'], mailboxCursor: 7, claimId: 'claim-2', generation: 2,
        stateEndpoint: 'oma://team/team-1/task/implement', cancellationTokenHash: sha256('cancel-token'),
        profile: route.profile, receipt: route.receipt,
        validation: { now, contextDigest, identityDigest: route.profile.identityDigest, fallbackPreconditionsSatisfied: true },
        nativeRole: 'oma-executor', deadlineMs: 300_000,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        provider: 'agy_headless', generation: 2,
        provider_profile_digest: route.profile.profileDigest,
        route_receipt_digest: route.receipt.receiptDigest,
      });
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  test('rejects legacy authority, tamper, and generation drift before envelope construction', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-worker-envelope-'));
    try {
      fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Guidance\n', 'utf8');
      const task: CanonicalTeamTaskV1 = { id: 'write', dependencies: [], mode: 'headless', write_scope: [{ kind: 'file', path: 'result.ts' }], verification: { version: 1, commands: [], requiredArtifacts: [] } };
      const route = authority();
      const base = {
        repositoryRoot: root, runId: 'run', teamId: 'team', task, taskText: 'Write result', dependencyResults: [],
        artifactContract: { proposal_root: 'artifacts/out', required_files: ['result.ts'], terminal_receipt_path: 'artifacts/out/terminal.json' },
        contributorGuidancePaths: ['AGENTS.md'], mailboxCursor: 0, claimId: 'claim', generation: 2,
        stateEndpoint: 'oma://state', cancellationTokenHash: sha256('cancel'), nativeRole: 'executor', deadlineMs: 1,
        profile: route.profile, receipt: route.receipt,
        validation: { now, contextDigest, identityDigest: route.profile.identityDigest, fallbackPreconditionsSatisfied: true },
      };
      expect(buildWorkerEnvelope({ ...base, receipt: { ...route.receipt, receiptDigest: sha256('tampered') } }).ok).toBe(false);
      expect(buildWorkerEnvelope({ ...base, generation: 3 }).ok).toBe(false);
      expect(buildWorkerEnvelope({ ...base, selection: { provider: 'agy_headless', evidenceHash: sha256('legacy') } } as never).ok).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
