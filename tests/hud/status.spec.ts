import * as fs from 'fs';
import * as path from 'path';
import { createDefaultServices } from '../../src/cli/services';
import { createInitialSessionAggregate, SessionAggregateStore, sessionAggregateRelativePath } from '../../src/continuation/session-aggregate';
import { collectHudSnapshot } from '../../src/hud/status';
import { renderHud } from '../../src/hud/render';
import { watchHud } from '../../src/hud/watch';
import { sha256 } from '../../src/runtime/atomic';
import { resolveWorkspaceIdentity } from '../../src/runtime/state-root';
import { TeamStateStore } from '../../src/team/state';
import { CanonicalTeamManifestV1 } from '../../src/team/types';
import { createStateFixture } from '../helpers/state-fixture';

const packageRoot = path.resolve(__dirname, '../..');

const manifest: CanonicalTeamManifestV1 = {
  schema: 'oma.team-manifest/v1',
  teamId: 'hud-team',
  revision: 1,
  repoRoot: '/tmp',
  tasks: [{
    id: 'inspect', dependencies: [], mode: 'headless', write_scope: 'none',
    verification: { version: 1, commands: [], requiredArtifacts: [] },
  }],
};

async function seededState() {
  const fixture = createStateFixture('oma-hud-');
  const sessionPath = fixture.path(sessionAggregateRelativePath('workspace', 'session-secret'));
  const session = new SessionAggregateStore(sessionPath);
  await session.initialize(createInitialSessionAggregate({
    sessionId: 'session-secret', repoKey: 'repo', workspaceKey: 'workspace',
    launchNonceDigest: sha256('launch-secret'),
  }));
  const team = new TeamStateStore(fixture.root, 'repo', 'workspace', manifest.teamId);
  const created = await team.create(manifest, 'owner-secret');
  if (!created.ok) throw new Error(created.error.message);
  return { fixture, sessionPath, team };
}

describe('read-only OMA HUD', () => {
  test('aggregates authoritative session and team state without raw ownership secrets', async () => {
    const { fixture } = await seededState();
    try {
      const result = collectHudSnapshot({
        state_root: fixture.root,
        session: { workspace_key: 'workspace', session_id: 'session-secret' },
        team: { repo_key: 'repo', workspace_key: 'workspace', team_id: 'hud-team' },
        adapters: [{
          adapter: 'private_sidecar', enabled: false, observed: false,
          status: 'forbidden_unprobed', detail_code: 'PRIVATE_SIDECAR_FORBIDDEN',
        }],
        collected_at: '2026-07-22T00:00:00.000Z',
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.core_available).toBe(true);
      expect(result.value.session).toEqual(expect.objectContaining({
        status: 'available', session_id_sha256: sha256('session-secret'), revision: 0,
      }));
      expect(result.value.team).toEqual(expect.objectContaining({
        status: 'available', task_count: 1, completed_count: 0, blockers: [], blocker_count: 0,
      }));
      const serialized = JSON.stringify(result.value);
      expect(serialized).not.toContain('owner-secret');
      expect(serialized).not.toContain('launch-secret');
      expect(serialized).not.toContain('session-secret');
      expect(renderHud(result.value, 'json')).toBe(renderHud(result.value, 'json'));
      expect(renderHud(result.value, 'text')).toContain('oma-hud session=');
    } finally { fixture.cleanup(); }
  });

  test('disabled or unavailable adapters never make the core unavailable', async () => {
    const { fixture } = await seededState();
    try {
      const result = collectHudSnapshot({
        state_root: fixture.root,
        session: { workspace_key: 'workspace', session_id: 'session-secret' },
        adapters: [
          { adapter: 'notifications', enabled: false, observed: false, status: 'disabled', detail_code: 'DISABLED' },
          { adapter: 'antigravity_public', enabled: true, observed: false, status: 'unavailable', detail_code: 'NO_CLI' },
        ],
        collected_at: '2026-07-22T00:00:00.000Z',
      });
      expect(result).toEqual(expect.objectContaining({ ok: true, value: expect.objectContaining({ core_available: true }) }));
    } finally { fixture.cleanup(); }
  });

  test('watch is bounded and does not mutate authoritative state', async () => {
    const { fixture, sessionPath } = await seededState();
    try {
      const before = fs.readFileSync(sessionPath);
      const snapshots: string[] = [];
      const result = await watchHud({
        state_root: fixture.root,
        session: { workspace_key: 'workspace', session_id: 'session-secret' },
      }, {
        max_iterations: 3,
        interval_ms: 50,
        now: () => '2026-07-22T00:00:00.000Z',
        sleep: async () => undefined,
        on_snapshot: (snapshot) => { snapshots.push(renderHud(snapshot, 'json')); },
      });
      expect(result).toEqual({ ok: true, value: { iterations: 3, stopped_by: 'max_iterations' } });
      expect(new Set(snapshots).size).toBe(1);
      expect(fs.readFileSync(sessionPath)).toEqual(before);
    } finally { fixture.cleanup(); }
  });

  test('rejects path-like identifiers and reports absent aggregates without writes', () => {
    const fixture = createStateFixture('oma-hud-invalid-');
    try {
      const unsafe = collectHudSnapshot({
        state_root: fixture.root,
        session: { workspace_key: '../escape', session_id: 'session' },
        collected_at: '2026-07-22T00:00:00.000Z',
      });
      expect(unsafe).toEqual(expect.objectContaining({
        ok: true,
        value: expect.objectContaining({
          core_available: false,
          session: expect.objectContaining({ status: 'corrupt', code: 'E_UNSAFE_IDENTIFIER' }),
        }),
      }));
    } finally { fixture.cleanup(); }
  });

  test('CLI --session without --workspace-key resolves cwd identity; explicit key is unchanged', async () => {
    const fixture = createStateFixture('oma-hud-cli-session-');
    try {
      const identity = resolveWorkspaceIdentity(fixture.root);
      expect(identity.ok).toBe(true);
      if (!identity.ok) return;
      const sessionPath = fixture.path(sessionAggregateRelativePath(identity.value.workspaceKey, 'hud-auto-session'));
      const store = new SessionAggregateStore(sessionPath);
      const seeded = await store.initialize(createInitialSessionAggregate({
        sessionId: 'hud-auto-session',
        repoKey: identity.value.repoKey,
        workspaceKey: identity.value.workspaceKey,
        launchNonceDigest: sha256('hud-auto-launch'),
      }));
      expect(seeded.ok).toBe(true);
      const pluginAdapter = {
        run: async (argv: readonly string[]) => ({ argv: [...argv], code: 1, stdout: '', stderr: '' }),
      };
      const runHud = async (argv: readonly string[], cwd = fixture.root) => {
        let stdout = '';
        let stderr = '';
        const services = createDefaultServices({
          packageRoot,
          cwd,
          stateRoot: fixture.root,
          agyCommand: path.join(fixture.root, 'missing-agy'),
          pluginAdapter,
          environment: { PATH: fixture.root, HOME: fixture.root, OMA_STATE_ROOT: fixture.root },
          stdout: (value) => { stdout += value; },
          stderr: (value) => { stderr += value; },
        });
        const code = await services.extendedCommand('hud', argv);
        return { code, stdout, stderr };
      };

      const auto = await runHud(['--json', '--session', 'hud-auto-session']);
      expect(auto.code).toBe(0);
      expect(auto.stderr).toBe('');
      const autoBody = JSON.parse(auto.stdout) as { session: { status: string; phase: string } };
      expect(autoBody.session).toEqual(expect.objectContaining({
        status: 'available',
        phase: 'deep-interview',
      }));

      const explicit = await runHud([
        '--json', '--session', 'hud-auto-session', '--workspace-key', identity.value.workspaceKey,
      ]);
      expect(explicit.code).toBe(0);
      expect(JSON.parse(explicit.stdout).session).toEqual(autoBody.session);

      const missingCwd = await runHud(
        ['--json', '--session', 'hud-auto-session'],
        path.join(fixture.root, 'does-not-exist'),
      );
      expect(missingCwd.code).toBe(2);
      expect(missingCwd.stderr).toContain('E_CLI_USAGE: --session requires --workspace-key');
    } finally {
      fixture.cleanup();
    }
  });
});
