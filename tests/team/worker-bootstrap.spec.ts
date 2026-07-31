import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawnSync } from 'child_process';
import { sha256 } from '../../src/runtime/atomic';
import {
  HostIdentityV1,
  PluginIdentityV1,
  assembleHostCapabilityProfile,
} from '../../src/native/capability-profile';
import { routeTeamWorkerProvider } from '../../src/team/provider';
import { createWorkerRouteAuthority, writeWorkerRouteAuthority } from '../../src/team/route-authority';

describe('worker-bootstrap', () => {
  test('writes marker, spawns mock agy with managed env, no claim plaintext in descriptor', () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'oma-wb-')));
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
      const selectedAt = new Date(Date.now() - 1_000).toISOString();
      const contextDigest = sha256('worker-bootstrap-context');
      const host: HostIdentityV1 = {
        realpath: fs.realpathSync(mockAgy),
        binarySha256: sha256(fs.readFileSync(mockAgy)),
        version: 'test',
        versionOutputSha256: sha256('test'),
        helpOutputSha256: sha256('test-help'),
        platform: process.platform,
        arch: process.arch,
      };
      const plugin: PluginIdentityV1 = {
        status: 'absent', realpath: null, packageDigest: null, version: null,
        readbackDigest: null, enabled: false,
      };
      const empty = assembleHostCapabilityProfile({
        evaluationTimestamp: selectedAt,
        hostIdentityBefore: host, hostIdentityAfter: host,
        pluginIdentityBefore: plugin, pluginIdentityAfter: plugin,
        observations: [],
      });
      const profile = assembleHostCapabilityProfile({
        evaluationTimestamp: selectedAt,
        hostIdentityBefore: host, hostIdentityAfter: host,
        pluginIdentityBefore: plugin, pluginIdentityAfter: plugin,
        observations: ['headless.print', 'headless.json'].map((capability) => ({
          capability, source: 'live_probe' as const, tier: 'healthy' as const,
          result: 'positive' as const, observedAt: selectedAt,
          identityDigest: empty.identityDigest, detailCode: 'BOOTSTRAP_TEST_VERIFIED', diagnostic: null,
        })),
      });
      const selected = routeTeamWorkerProvider({
        profile, launchMode: 'headless', now: selectedAt, generation: 1,
        contextDigest, resolvedExecutable: host.realpath,
      });
      expect(selected.ok).toBe(true);
      if (!selected.ok) return;
      const routeAuthority = createWorkerRouteAuthority({
        stateRoot: root, teamId: 't', taskId: 'a', generation: 1,
        contextDigest, profile, receipt: selected.value, now: selectedAt,
      });
      writeWorkerRouteAuthority(root, routeAuthority);
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
        agyCommand: host.realpath,
        taskPrompt: 'Execute mock task',
        provider: 'agy_headless',
        providerProfileDigest: profile.profileDigest,
        routeReceiptDigest: selected.value.receiptDigest,
        routeContextDigest: contextDigest,
        routeAuthorityDigest: routeAuthority.authorityDigest,
        capabilityMode: 'read-write',
        boundedDuration: '5m0s',
      };

      fs.writeFileSync(descriptorPath, JSON.stringify(desc), { mode: 0o600 });
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

      expect(result.stderr).toBe('');
      expect(result.status).toBe(0);
      expect(fs.existsSync(marker)).toBe(true);
      expect(fs.readFileSync(outFile, 'utf8')).toContain('sess-1');
      expect(fs.readFileSync(outFile, 'utf8')).toContain(sha256(claimToken));
      expect(fs.readFileSync(outFile, 'utf8')).toContain(claimToken);
      const recorded = fs.readFileSync(outFile, 'utf8').trim().split('\n');
      const argv = JSON.parse(recorded[3]) as string[];
      expect(argv).toEqual([
        '--model', 'gemini-3.6-flash-high', '--print', 'Execute mock task', '--print-timeout', '5m0s', '--mode', 'accept-edits',
      ]);
      expect(argv).not.toContain('--dangerously-skip-permissions');
      expect(argv.filter((entry) => entry === 'Execute mock task')).toHaveLength(1);
      // capability 應被 unlink
      expect(fs.existsSync(path.join(root, '.oma', 'worker-capability.json'))).toBe(false);
      expect(fs.existsSync(path.join(
        root,
        'team-route-authorities',
        sha256('t'),
        `${sha256('a')}-g1.json`,
      ))).toBe(false);

      fs.rmSync(marker, { force: true });
      fs.mkdirSync(path.join(root, '.oma'), { recursive: true });
      fs.writeFileSync(
        path.join(root, '.oma', 'worker-capability.json'),
        JSON.stringify({ claimToken }),
        { mode: 0o600 },
      );
      const replayed = spawnSync('npx', ['ts-node', bootstrapTs, marker, descriptorPath], {
        encoding: 'utf8',
        env: process.env,
      });
      expect(replayed.status).toBe(1);
      expect(replayed.stderr).toContain('already consumed');
      expect(fs.existsSync(marker)).toBe(false);

      writeWorkerRouteAuthority(root, routeAuthority);
      fs.writeFileSync(descriptorPath, JSON.stringify({
        ...desc,
        providerProfileDigest: undefined,
      }), { mode: 0o600 });
      const rejected = spawnSync('npx', ['ts-node', bootstrapTs, marker, descriptorPath], {
        encoding: 'utf8',
        env: process.env,
      });
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain('descriptor keys are invalid');
      expect(fs.existsSync(marker)).toBe(false);

      fs.writeFileSync(descriptorPath, JSON.stringify({
        ...desc,
        providerProfileDigest: sha256('fabricated-profile'),
        routeReceiptDigest: sha256('fabricated-receipt'),
        routeAuthorityDigest: sha256('fabricated-authority'),
      }), { mode: 0o600 });
      const fabricated = spawnSync('npx', ['ts-node', bootstrapTs, marker, descriptorPath], {
        encoding: 'utf8',
        env: process.env,
      });
      expect(fabricated.status).toBe(1);
      expect(fabricated.stderr).toContain('profile-backed route authority');
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 20000);
});
