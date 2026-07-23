import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sha256 } from '../../src/runtime/atomic';
import { ProviderSelectionV1 } from '../../src/team/provider';
import { CanonicalTeamTaskV1 } from '../../src/team/types';
import { buildWorkerEnvelope } from '../../src/team/worker-envelope';

describe('complete WorkerEnvelopeV1 construction', () => {
  test('roundtrips task, dependency results, scope, verification, artifacts, guidance, cursor and authority', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-worker-envelope-'));
    try {
      fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Guidance\n', 'utf8');
      const task: CanonicalTeamTaskV1 = {
        id: 'implement',
        dependencies: ['plan'],
        write_scope: [{ kind: 'dir', path: 'src/team' }],
        mode: 'headless',
        verification: {
          version: 1,
          commands: [{ command: 'npm', argv: ['test'], cwd: '.', deadlineMs: 30_000, expectedExit: 0 }],
          requiredArtifacts: ['src/team/result.ts'],
        },
      };
      const selection: ProviderSelectionV1 = {
        schemaVersion: 1,
        provider: 'agy_headless',
        generation: 2,
        evidenceHash: sha256('provider'),
        observedAtMs: 10,
      };
      const result = buildWorkerEnvelope({
        repositoryRoot: root,
        runId: 'run-1',
        teamId: 'team-1',
        task,
        taskText: 'Implement the complete owned team slice',
        dependencyResults: [{ task_id: 'plan', result_hash: sha256('plan'), artifact_roots: ['artifacts/plan'] }],
        artifactContract: {
          proposal_root: 'artifacts/team/implement',
          required_files: ['src/team/result.ts'],
          terminal_receipt_path: 'artifacts/team/implement/terminal.json',
        },
        contributorGuidancePaths: ['AGENTS.md'],
        mailboxCursor: 7,
        claimId: 'claim-2',
        generation: 2,
        stateEndpoint: 'oma://team/team-1/task/implement',
        cancellationTokenHash: sha256('cancel-token'),
        selection,
        nativeRole: 'oma-executor',
        deadlineMs: 300_000,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toMatchObject({
        store_kind: 'oma_worker_envelope',
        repository_id: 'OMA',
        task_id: 'implement',
        task_text: 'Implement the complete owned team slice',
        write_scope: ['src/team'],
        verification_argv: [['npm', 'test']],
        mailbox_cursor: 7,
        claim_id: 'claim-2',
        generation: 2,
        provider: 'agy_headless',
        capability_mode: 'read-write',
      });
      expect(result.value.dependencies).toEqual([{
        task_id: 'plan', result_hash: sha256('plan'), artifact_roots: ['artifacts/plan'],
      }]);
      expect(result.value.contributor_guidance_hashes).toEqual([{
        path: 'AGENTS.md', sha256: sha256('# Guidance\n'),
      }]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('rejects reordered dependencies and provider generation drift', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-worker-envelope-'));
    try {
      fs.writeFileSync(path.join(root, 'AGENTS.md'), '# Guidance\n', 'utf8');
      const task: CanonicalTeamTaskV1 = {
        id: 'write', dependencies: ['a', 'b'], mode: 'headless',
        write_scope: [{ kind: 'file', path: 'result.ts' }],
        verification: { version: 1, commands: [], requiredArtifacts: [] },
      };
      const base = {
        repositoryRoot: root, runId: 'run', teamId: 'team', task, taskText: 'Write result',
        artifactContract: { proposal_root: 'artifacts/out', required_files: ['result.ts'], terminal_receipt_path: 'artifacts/out/terminal.json' },
        contributorGuidancePaths: ['AGENTS.md'], mailboxCursor: 0, claimId: 'claim', generation: 2,
        stateEndpoint: 'oma://state', cancellationTokenHash: sha256('cancel'), nativeRole: 'executor', deadlineMs: 1,
        selection: { schemaVersion: 1, provider: 'agy_headless', generation: 2, evidenceHash: sha256('provider'), observedAtMs: 1 } as ProviderSelectionV1,
      };
      expect(buildWorkerEnvelope({ ...base, dependencyResults: [
        { task_id: 'b', result_hash: sha256('b'), artifact_roots: [] },
        { task_id: 'a', result_hash: sha256('a'), artifact_roots: [] },
      ] }).ok).toBe(false);
      expect(buildWorkerEnvelope({
        ...base,
        dependencyResults: [
          { task_id: 'a', result_hash: sha256('a'), artifact_roots: [] },
          { task_id: 'b', result_hash: sha256('b'), artifact_roots: [] },
        ],
        selection: { ...base.selection, generation: 3 },
      }).ok).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
