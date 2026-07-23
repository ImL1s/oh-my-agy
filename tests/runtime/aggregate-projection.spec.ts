import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  createInitialSessionAggregate,
  readSessionProjection,
  writeSessionProjection,
} from '../../src/continuation/session-aggregate';

describe('platform aggregate and .agy projection authority', () => {
  test('projection is revision/hash-bound and stale/tampered projections fail', () => {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-projection-'));
    try {
      const aggregate = createInitialSessionAggregate({
        sessionId: 'session-1', repoKey: 'repo', workspaceKey: 'workspace',
        launchNonceDigest: 'a'.repeat(64), workspacePath: workspace,
      });
      const projectionPath = writeSessionProjection(workspace, aggregate);
      const read = readSessionProjection(projectionPath, aggregate);
      expect(read.ok).toBe(true);
      const tampered = JSON.parse(fs.readFileSync(projectionPath, 'utf8'));
      tampered.aggregate_revision = 99;
      fs.writeFileSync(projectionPath, JSON.stringify(tampered));
      const rejected = readSessionProjection(projectionPath, aggregate);
      expect(rejected.ok).toBe(false);
    } finally {
      fs.rmSync(workspace, { recursive: true, force: true });
    }
  });
});
