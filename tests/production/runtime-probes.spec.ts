import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ProductionProbeContext, verifyProductionEvidence } from '../../src/production/evidence';
import { runRuntimeProductionProbe } from '../../src/production/runtime-probes';
import { PluginCommandAdapter } from '../../src/setup/plugin';

const tmuxAvailable = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;
const maybeTmux = tmuxAvailable ? test : test.skip;

function fixture(label: string): { context: ProductionProbeContext; cleanup: () => void } {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), label));
  fs.chmodSync(stateRoot, 0o700);
  const repositoryRoot = fs.realpathSync(path.resolve(__dirname, '../..'));
  const oid = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: repositoryRoot, encoding: 'utf8', shell: false,
  }).stdout.trim();
  const runId = `runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const pluginAdapter: PluginCommandAdapter = {
    run: async (argv) => ({ argv, code: 0, stdout: '', stderr: '' }),
  };
  return {
    context: {
      packageRoot: repositoryRoot,
      repositoryRoot,
      stateRoot,
      runId,
      oid,
      agyCommand: 'agy',
      packageVersion: '0.3.0',
      environment: { ...process.env, OMA_STATE_ROOT: stateRoot },
      pluginAdapter,
    },
    cleanup: () => fs.rmSync(stateRoot, { recursive: true, force: true }),
  };
}

function readArtifact(file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
}

describe('product-owned production runtime probes', () => {
  test('managed lifecycle evidence is reconstructed from hooks, aggregate, and child outcome', async () => {
    const { context, cleanup } = fixture('oma-production-lifecycle-');
    try {
      // An untrusted caller cannot inject the acceptance booleans: this field is ignored.
      (context as ProductionProbeContext & { artifact: unknown }).artifact = {
        pre_invocation_exact_bind: false,
        child_exit_code: 99,
      };
      const result = await runRuntimeProductionProbe('managed-lifecycle', context);
      const artifact = readArtifact(result.artifactPath);
      expect(artifact).toMatchObject({
        seam: 'managed-lifecycle', oid: context.oid,
        pre_invocation_exact_bind: true,
        stop_n_continue: true,
        stop_n_plus_1_final_allow: true,
        second_launch_count: 0,
        child_exit_code: 0,
      });
      expect(Number(artifact.child_pid)).toBeGreaterThan(0);
      expect(verifyProductionEvidence({
        stateRoot: context.stateRoot!, runId: context.runId, oid: context.oid,
        seam: 'managed-lifecycle',
      })).not.toBeNull();
      expect(spawnSync('git', ['status', '--porcelain=v1'], {
        cwd: context.repositoryRoot, encoding: 'utf8',
      }).stdout).not.toContain('.agy/projections/sessions');
    } finally { cleanup(); }
  }, 30_000);

  test('exact resume executes literal conversation argv with a generation-fenced capability', async () => {
    const { context, cleanup } = fixture('oma-production-resume-');
    try {
      const result = await runRuntimeProductionProbe('exact-resume', context);
      const artifact = readArtifact(result.artifactPath);
      expect(artifact.argv).toEqual(['agy', '--conversation', artifact.conversation_id]);
      expect(artifact.next_generation).toBe(Number(artifact.generation) + 1);
      expect(artifact.verified).toBe(true);
      expect(verifyProductionEvidence({
        stateRoot: context.stateRoot!, runId: context.runId, oid: context.oid,
        seam: 'exact-resume',
      })).not.toBeNull();
    } finally { cleanup(); }
  }, 30_000);

  maybeTmux('worker runtime observes tmux TTY, ordered mailbox, delivery, and zero orphan', async () => {
    const { context, cleanup } = fixture('oma-production-worker-');
    try {
      const result = await runRuntimeProductionProbe('worker-runtime', context);
      expect(readArtifact(result.artifactPath)).toMatchObject({
        interactive_tty_observed: true,
        headless_exit_verified: true,
        mailbox_verified: true,
        delivery_verified: true,
        orphan_count: 0,
      });
      expect(verifyProductionEvidence({
        stateRoot: context.stateRoot!, runId: context.runId, oid: context.oid,
        seam: 'worker-runtime',
      })).not.toBeNull();
    } finally { cleanup(); }
  }, 45_000);

  test('unsafe state-root symlink is rejected before a probe can write', async () => {
    const { context, cleanup } = fixture('oma-production-escape-');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-production-outside-'));
    fs.chmodSync(outside, 0o700);
    const link = `${context.stateRoot}-link`;
    fs.symlinkSync(outside, link);
    try {
      await expect(runRuntimeProductionProbe('managed-lifecycle', {
        ...context, stateRoot: link, environment: { ...context.environment, OMA_STATE_ROOT: link },
      })).rejects.toThrow(/unsafe production|safe directory|symbolic|state/i);
      expect(fs.readdirSync(outside)).toEqual([]);
    } finally {
      fs.unlinkSync(link);
      fs.rmSync(outside, { recursive: true, force: true });
      cleanup();
    }
  });
});
