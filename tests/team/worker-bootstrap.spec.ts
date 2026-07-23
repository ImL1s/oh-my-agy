import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { sha256 } from '../../src/runtime/atomic';

describe('worker-bootstrap', () => {
  test('writes marker, spawns mock agy with managed env, no claim plaintext in descriptor', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-wb-'));
    try {
      const marker = path.join(root, 'ready');
      const descriptorPath = path.join(root, 'desc.json');
      const outFile = path.join(root, 'out.txt');
      const mockAgy = path.join(root, 'mock-agy.js');
      fs.writeFileSync(mockAgy, [
        '#!/usr/bin/env node',
        "const fs=require('fs');",
        `fs.writeFileSync(${JSON.stringify(outFile)}, [`,
        "  process.env.OMA_SESSION_ID,",
        "  process.env.OMA_CLAIM_TOKEN_DIGEST,",
        "  process.env.OMA_CLAIM_TOKEN,",
        "  JSON.stringify(process.argv.slice(2)),",
        "].join('\\n'));",
        'process.exit(0);',
        '',
      ].join('\n'));
      fs.chmodSync(mockAgy, 0o755);

      const claimToken = 'secret-claim-token';
      const desc = {
        schemaVersion: 1,
        teamId: 't',
        taskId: 'a',
        workerId: 'a',
        generation: 1,
        workerMode: 'headless',
        claimTokenDigest: sha256(claimToken),
        worktreePath: root,
        stateRoot: root,
        sessionId: 'sess-1',
        launchNonce: 'nonce-1',
        invocationGeneration: 1,
        agyCommand: mockAgy,
        taskPrompt: 'Execute mock task',
        provider: 'agy_headless',
        capabilityMode: 'read-write',
        boundedDuration: '5m0s',
      };

      fs.writeFileSync(descriptorPath, JSON.stringify(desc));
      expect(JSON.stringify(desc)).not.toContain(claimToken);

      fs.mkdirSync(path.join(root, '.oma'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.oma', 'worker-capability.json'),
        JSON.stringify({ claimToken }),
        { mode: 0o600 },
      );

      const bootstrapTs = path.resolve(__dirname, '../../src/team/worker-bootstrap.ts');
      const result = spawnSync('npx', ['ts-node', bootstrapTs, marker, descriptorPath], {
        encoding: 'utf8',
        env: process.env,
      });

      expect(result.status).toBe(0);
      expect(fs.existsSync(marker)).toBe(true);
      expect(fs.readFileSync(outFile, 'utf8')).toContain('sess-1');
      expect(fs.readFileSync(outFile, 'utf8')).toContain(sha256(claimToken));
      expect(fs.readFileSync(outFile, 'utf8')).toContain(claimToken);
      const recorded = fs.readFileSync(outFile, 'utf8').trim().split('\n');
      const argv = JSON.parse(recorded[3]) as string[];
      expect(argv).toEqual([
        '--print', '--print-timeout', '5m0s', '--mode', 'accept-edits', 'Execute mock task',
      ]);
      expect(argv).not.toContain('--dangerously-skip-permissions');
      expect(argv.filter((entry) => entry === 'Execute mock task')).toHaveLength(1);
      // capability 應被 unlink
      expect(fs.existsSync(path.join(root, '.oma', 'worker-capability.json'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});
