import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createDefaultServices } from '../../src/cli/services';
import * as runManifest from '../../src/contracts/run-manifest';
import { canonicalBytesV1, sha256Hex } from '../../src/contracts';

describe('public composition CLI services', () => {
  const packageRoot = path.resolve(__dirname, '../..');

  test('workflow production CLI rejects custom state roots and an exact-output agy emulator', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-workflow-production-cli-'));
    const stateRoot = path.join(cwd, 'injected-state');
    const fakeBin = path.join(cwd, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(fakeBin, 'agy'), `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "1.1.6"
  exit 0
fi
echo "--conversation --mode --print --print-timeout --prompt-interactive --sandbox"
`, { mode: 0o700 });
    let stderr = '';
    const services = createDefaultServices({
      cwd,
      packageRoot,
      agyCommand: path.join(fakeBin, 'agy'),
      stateRoot,
      environment: { PATH: fakeBin, HOME: cwd },
      stdout: () => undefined,
      stderr: (value) => { stderr += value; },
    });
    const previousPath = process.env.PATH;
    const previousStateRoot = process.env.OMA_STATE_ROOT;
    const previousOmaConfigRoot = process.env.OMA_ANTIGRAVITY_CONFIG_ROOT;
    const previousConfigRoot = process.env.ANTIGRAVITY_CONFIG_ROOT;
    const previousProductionRunId = process.env.OMA_PRODUCTION_RUN_ID;
    try {
      process.env.OMA_STATE_ROOT = stateRoot;
      expect(await services.extendedCommand('production', ['probe', 'workflow'])).toBe(1);
      expect(stderr).toContain('rejects custom OMA_STATE_ROOT');
      delete process.env.OMA_STATE_ROOT;
      for (const name of [
        'OMA_ANTIGRAVITY_CONFIG_ROOT',
        'ANTIGRAVITY_CONFIG_ROOT',
        'OMA_PRODUCTION_RUN_ID',
      ] as const) {
        process.env[name] = path.join(cwd, name);
        stderr = '';
        expect(await services.extendedCommand('production', ['probe', 'workflow'])).toBe(1);
        expect(stderr).toContain(`rejects custom ${name}`);
        delete process.env[name];
      }
      process.env.PATH = fakeBin;
      stderr = '';
      expect(await services.extendedCommand('production', ['probe', 'workflow'])).toBe(1);
      expect(stderr).toMatch(
        /canonical agy executable is not installed|agy executable does not match the canonical installed path/u,
      );
      expect(fs.existsSync(stateRoot)).toBe(false);
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      if (previousStateRoot === undefined) delete process.env.OMA_STATE_ROOT;
      else process.env.OMA_STATE_ROOT = previousStateRoot;
      if (previousOmaConfigRoot === undefined) delete process.env.OMA_ANTIGRAVITY_CONFIG_ROOT;
      else process.env.OMA_ANTIGRAVITY_CONFIG_ROOT = previousOmaConfigRoot;
      if (previousConfigRoot === undefined) delete process.env.ANTIGRAVITY_CONFIG_ROOT;
      else process.env.ANTIGRAVITY_CONFIG_ROOT = previousConfigRoot;
      if (previousProductionRunId === undefined) delete process.env.OMA_PRODUCTION_RUN_ID;
      else process.env.OMA_PRODUCTION_RUN_ID = previousProductionRunId;
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('installs and lists the built-in workflow under repository runtime state', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-workflow-cli-'));
    let stdout = '';
    let stderr = '';
    const services = createDefaultServices({
      cwd,
      packageRoot,
      stateRoot: path.join(cwd, 'state'),
      environment: { PATH: process.env.PATH, HOME: cwd },
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    });
    expect(await services.extendedCommand('workflow', ['install'])).toBe(0);
    const installed = path.join(
      cwd,
      '.agy',
      'workflows',
      'production-safety-review-1.0.0.json',
    );
    expect(fs.existsSync(installed)).toBe(true);
    expect(await services.extendedCommand('workflow', ['list'])).toBe(0);
    expect(stdout).toContain('production-safety-review');
    expect(stderr).toBe('');
  });

  test('workflow authority rejects a configured state root inside the repository', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-workflow-state-root-cli-'));
    const git = require('child_process').spawnSync as typeof import('child_process').spawnSync;
    fs.writeFileSync(path.join(cwd, 'README.md'), 'candidate\n');
    expect(git('git', ['init', '-q'], { cwd }).status).toBe(0);
    expect(git('git', ['config', 'user.email', 'oma@example.invalid'], { cwd }).status).toBe(0);
    expect(git('git', ['config', 'user.name', 'OMA Test'], { cwd }).status).toBe(0);
    expect(git('git', ['add', 'README.md'], { cwd }).status).toBe(0);
    expect(git('git', ['commit', '-qm', 'candidate'], { cwd }).status).toBe(0);
    const oid = git('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
    const input = path.join(cwd, 'input.json');
    fs.writeFileSync(input, JSON.stringify({ candidate_commit: oid }));
    const stateRoot = path.join(cwd, 'state');
    let stderr = '';
    const services = createDefaultServices({
      cwd,
      packageRoot,
      stateRoot,
      environment: { PATH: process.env.PATH, HOME: cwd },
      stdout: () => undefined,
      stderr: (value) => { stderr += value; },
    });
    expect(await services.extendedCommand('workflow', ['install'])).toBe(0);
    expect(await services.extendedCommand(
      'workflow',
      ['run', 'production-safety-review', '--input', input],
    )).toBe(1);
    expect(stderr).toContain('workflow authority state root must be repository-external');
    expect(fs.existsSync(path.join(stateRoot, 'trust', 'workflow-v1.key'))).toBe(false);
    fs.rmSync(cwd, { recursive: true, force: true });
  });

  test('production verification fails closed when every live evidence seam is absent', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-production-cli-'));
    fs.writeFileSync(path.join(cwd, 'README.md'), '# candidate\n');
    const git = require('child_process').spawnSync as typeof import('child_process').spawnSync;
    expect(git('git', ['init', '-q'], { cwd }).status).toBe(0);
    expect(git('git', ['config', 'user.email', 'oma@example.invalid'], { cwd }).status).toBe(0);
    expect(git('git', ['config', 'user.name', 'OMA Test'], { cwd }).status).toBe(0);
    expect(git('git', ['add', 'README.md'], { cwd }).status).toBe(0);
    expect(git('git', ['commit', '-qm', 'test'], { cwd }).status).toBe(0);
    const fabricated = path.join(cwd, 'fabricated.json');
    fs.writeFileSync(fabricated, JSON.stringify({
      schema_version: 1,
      oid: git('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim(),
      observed_at: new Date().toISOString(),
      seam: 'managed-lifecycle',
      pre_invocation_exact_bind: true,
      stop_n_continue: true,
    }));
    let stdout = '';
    let stderr = '';
    const services = createDefaultServices({
      cwd,
      packageRoot,
      agyCommand: path.join(cwd, 'missing-agy'),
      stateRoot: path.join(cwd, 'state'),
      environment: {
        PATH: process.env.PATH,
        HOME: cwd,
        OMA_PRODUCTION_LIFECYCLE_EVIDENCE: fabricated,
      },
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    });
    expect(await services.extendedCommand('production', ['verify', '--run-id', 'missing-run'])).toBe(1);
    const report = JSON.parse(stdout) as { ok: boolean; seams: Array<{ passed: boolean }> };
    expect(report.ok).toBe(false);
    expect(report.seams).toHaveLength(7);
    expect(report.seams.every((seam) => seam.passed === false)).toBe(true);
    expect(stderr).toContain('E_PRODUCTION_EVIDENCE');
    expect(fs.existsSync(path.join(cwd, 'state'))).toBe(false);
  });

  test('production verification defaults run identity to the exact candidate OID', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-production-default-run-'));
    fs.writeFileSync(path.join(cwd, 'README.md'), '# candidate\n');
    const git = require('child_process').spawnSync as typeof import('child_process').spawnSync;
    expect(git('git', ['init', '-q'], { cwd }).status).toBe(0);
    expect(git('git', ['config', 'user.email', 'oma@example.invalid'], { cwd }).status).toBe(0);
    expect(git('git', ['config', 'user.name', 'OMA Test'], { cwd }).status).toBe(0);
    expect(git('git', ['add', 'README.md'], { cwd }).status).toBe(0);
    expect(git('git', ['commit', '-qm', 'test'], { cwd }).status).toBe(0);
    const oid = git('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).stdout.trim();
    let stdout = '';
    const services = createDefaultServices({
      cwd,
      packageRoot,
      stateRoot: path.join(cwd, 'missing-state'),
      environment: { PATH: process.env.PATH, HOME: cwd },
      stdout: (value) => { stdout += value; },
      stderr: () => undefined,
    });
    expect(await services.extendedCommand('production', ['verify'])).toBe(1);
    expect(JSON.parse(stdout)).toMatchObject({ run_id: oid, oid });
    expect(fs.existsSync(path.join(cwd, 'missing-state'))).toBe(false);
  });

  test('parity composition verifies the canonical revision-2 final aggregate', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-parity-cli-'));
    const runId = 'run-1';
    const aggregatePath = runManifest.expectedRepositoryAggregatePath(cwd, runId);
    fs.mkdirSync(path.dirname(aggregatePath), { recursive: true });
    const inputPayload = { store_kind: 'repo_aggregate_input_payload', run_id: runId };
    const finalPayload = {
      store_kind: 'repo_aggregate_final_payload',
      run_id: runId,
      run_manifest_revision: 4,
      lease_generation: 4,
    };
    const inputEnvelope = {
      payload: inputPayload,
      payload_hash: sha256Hex(canonicalBytesV1(inputPayload)),
      signer_id: 'OMA-W6-aggregate-signer',
      key_id: 'a'.repeat(64),
      phase: 'input',
      signature: 'b'.repeat(64),
    };
    const finalEnvelope = {
      payload: finalPayload,
      payload_hash: sha256Hex(canonicalBytesV1(finalPayload)),
      signer_id: 'OMA-W6-aggregate-signer',
      key_id: 'a'.repeat(64),
      phase: 'final',
      signature: 'c'.repeat(64),
    };
    fs.writeFileSync(aggregatePath, canonicalBytesV1({
      store_kind: 'repo_aggregate_handoff',
      schema_version: 1,
      repository_id: 'OMA',
      run_id: runId,
      revision: 2,
      previous_aggregate_hash: 'd'.repeat(64),
      input_envelope: inputEnvelope,
      final_envelope: finalEnvelope,
    }), { mode: 0o600 });
    const verifyAggregate = jest.spyOn(runManifest, 'verifyRepositoryAggregate')
      .mockImplementation(() => undefined);
    const verifyManifest = jest.spyOn(runManifest, 'verifyRunManifestAtPath')
      .mockReturnValue({
        run_id: runId,
        revision: 5,
        lease_generation: 5,
        state: 'signing_revoked',
      } as ReturnType<typeof runManifest.verifyRunManifestAtPath>);
    let stdout = '';
    let stderr = '';
    const services = createDefaultServices({
      cwd,
      packageRoot,
      stateRoot: path.join(cwd, 'state'),
      environment: { PATH: process.env.PATH, HOME: cwd },
      stdout: (value) => { stdout += value; },
      stderr: (value) => { stderr += value; },
    });
    try {
      expect(await services.extendedCommand('parity', [
        'verify-composition', '--workspace', cwd, '--run-id', runId,
        '--aggregate', aggregatePath,
      ])).toBe(0);
      expect(verifyAggregate).toHaveBeenCalledWith(expect.objectContaining({
        workspace_path: cwd,
        run_id: runId,
        phase: 'final',
        envelope: finalEnvelope,
      }));
      expect(verifyManifest).toHaveBeenCalledTimes(1);
      expect(JSON.parse(stdout)).toEqual(expect.objectContaining({
        ok: true,
        phase: 'final',
        aggregate_revision: 2,
        manifest_state: 'signing_revoked',
      }));
      const copiedPath = path.join(cwd, 'copied-aggregate.json');
      fs.copyFileSync(aggregatePath, copiedPath);
      expect(await services.extendedCommand('parity', [
        'verify-composition', '--workspace', cwd, '--run-id', runId,
        '--aggregate', copiedPath,
      ])).toBe(1);
      expect(stderr).toContain('exact canonical repository artifact');
    } finally {
      verifyAggregate.mockRestore();
      verifyManifest.mockRestore();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
