import * as fs from 'fs';
import * as path from 'path';
import { GitFixture } from '../helpers/git-fixture';
import { validateTeamManifest } from '../../src/team/manifest';

function manifest(tasks: unknown[]) {
  return { schema: 'oma.team-manifest/v1', teamId: 'alpha', revision: 1, tasks };
}

function task(id: string, dependencies: string[], writeScope: unknown) {
  return {
    id,
    dependencies,
    write_scope: writeScope,
    mode: writeScope === 'none' ? 'read_only' : 'headless',
    verification: { version: 1, commands: [], requiredArtifacts: [] },
  };
}

describe('Team manifest contract', () => {
  let fixture: GitFixture;

  beforeEach(() => { fixture = GitFixture.create(); });
  afterEach(() => fixture.cleanup());

  test('TEAM-13A rejects wrong versions, traversal, missing dependencies, cycles, and symlink escape', () => {
    expect(validateTeamManifest({ ...manifest([]), schema: 'oma.team-manifest/v2' }, fixture.repo).ok).toBe(false);
    expect(validateTeamManifest(manifest([task('a', [], [{ kind: 'file', path: '../escape' }])]), fixture.repo).ok).toBe(false);
    expect(validateTeamManifest(manifest([task('a', ['missing'], 'none')]), fixture.repo).ok).toBe(false);
    expect(validateTeamManifest(manifest([task('a', ['b'], 'none'), task('b', ['a'], 'none')]), fixture.repo).ok).toBe(false);

    const outside = path.join(fixture.root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(fixture.repo, 'linked'));
    expect(validateTeamManifest(manifest([task('a', [], [{ kind: 'dir', path: 'linked' }])]), fixture.repo).ok).toBe(false);
  });

  test('TEAM-13B permits ordered overlap and rejects unordered overlap', () => {
    const unordered = validateTeamManifest(manifest([
      task('a', [], [{ kind: 'dir', path: 'src' }]),
      task('b', [], [{ kind: 'file', path: 'src/a.ts' }]),
    ]), fixture.repo);
    expect(unordered.ok).toBe(false);
    if (!unordered.ok) expect(unordered.error.code).toBe('E_TASK_SCOPE_OVERLAP');

    const ordered = validateTeamManifest(manifest([
      task('a', [], [{ kind: 'dir', path: 'src' }]),
      task('b', ['a'], [{ kind: 'file', path: 'src/a.ts' }]),
    ]), fixture.repo);
    expect(ordered.ok).toBe(true);
  });
});

