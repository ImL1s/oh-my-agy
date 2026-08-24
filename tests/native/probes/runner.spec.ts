import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { runBoundedProbe } from '../../../src/native/probes/runner';

describe('bounded probe runner', () => {
  it('uses one exact combined output ceiling without overflowing at equality', async () => {
    const exact = await runBoundedProbe({ command: process.execPath, argv: ['-e', "process.stdout.write('ab');process.stderr.write('cd')"], timeoutMs: 2_000, maximumOutputBytes: 4, maximumProcesses: 8 });
    expect(exact).toMatchObject({ status: 0, timedOut: false, outputOverflow: false });
    const overflow = await runBoundedProbe({ command: process.execPath, argv: ['-e', "process.stdout.write('abc');process.stderr.write('def')"], timeoutMs: 2_000, maximumOutputBytes: 4, maximumProcesses: 8 });
    expect(overflow.outputOverflow).toBe(true);
    expect(Buffer.byteLength(overflow.stdout) + Buffer.byteLength(overflow.stderr)).toBeLessThanOrEqual(4);
  });

  it('terminates a timed-out process group', async () => {
    const outcome = await runBoundedProbe(
      { command: process.execPath, argv: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 100, maximumOutputBytes: 64, maximumProcesses: 8 },
      { countProcesses: async () => 1 },
    );
    expect(outcome).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
  });

  it('keeps the wall-clock deadline independent from a stalled process scan', async () => {
    const started = Date.now();
    const outcome = await runBoundedProbe(
      {
        command: process.execPath,
        argv: ['-e', 'setInterval(() => {}, 1000)'],
        timeoutMs: 50,
        maximumOutputBytes: 64,
        maximumProcesses: 8,
      },
      { countProcesses: async () => new Promise<number | null>(() => {}) },
    );
    expect(outcome).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it('waits for the active process scan before accepting a successful exit', async () => {
    let finishScan: ((count: number | null) => void) | undefined;
    let markScanStarted: (() => void) | undefined;
    const scanStarted = new Promise<void>((resolve) => { markScanStarted = resolve; });
    const outcomePromise = runBoundedProbe(
      {
        command: process.execPath,
        argv: ['-e', "process.stdout.write('ok')"],
        timeoutMs: 2_000,
        maximumOutputBytes: 64,
        maximumProcesses: 1,
      },
      {
        countProcesses: async () => {
          markScanStarted?.();
          return new Promise<number | null>((resolve) => { finishScan = resolve; });
        },
      },
    );
    await scanStarted;
    const early = await Promise.race([
      outcomePromise.then(() => 'settled' as const),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 250)),
    ]);
    expect(early).toBe('pending');
    expect(finishScan).toBeDefined();
    finishScan!(2);

    await expect(outcomePromise).resolves.toMatchObject({
      status: null,
      signal: 'SIGKILL',
      timedOut: false,
      processCountOverflow: true,
    });
  });

  it('force-settles when a detached descendant keeps inherited pipes open', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-probe-force-settle-'));
    const pidPath = path.join(root, 'grandchild.pid');
    const script = [
      "const fs=require('fs');",
      "const {spawn}=require('child_process');",
      `const child=spawn(process.execPath,['-e','setInterval(()=>{},60000)'],{detached:true,stdio:['ignore','inherit','inherit']});`,
      `fs.writeFileSync(${JSON.stringify(pidPath)},String(child.pid));`,
      'child.unref();',
      'setInterval(()=>{},60000);',
    ].join('');
    const started = Date.now();
    try {
      const outcome = await runBoundedProbe({
        command: process.execPath,
        argv: ['-e', script],
        timeoutMs: 500,
        maximumOutputBytes: 64,
        maximumProcesses: 8,
      });
      expect(outcome).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally {
      try { await killAndWait([Number(fs.readFileSync(pidPath, 'utf8'))]); } catch (_) { /* 已結束 */ }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);

  it('kills the probe tree when the process-count budget is exceeded', async () => {
    const script = [
      "const {spawn}=require('child_process');",
      "spawn(process.execPath,['-e','setInterval(()=>{},60000)'],{stdio:'ignore'});",
      'setInterval(()=>{},60000);',
    ].join('');
    const outcome = await runBoundedProbe({
      command: process.execPath,
      argv: ['-e', script],
      timeoutMs: 5_000,
      maximumOutputBytes: 64,
      maximumProcesses: 1,
    });
    expect(outcome).toMatchObject({
      timedOut: false,
      processCountOverflow: true,
      signal: 'SIGKILL',
    });
  }, 10_000);

  it('does not count unrelated post-baseline processes outside the probe lineage', async () => {
    if (process.platform === 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-probe-lineage-scope-'));
    const markerPath = path.join(root, 'started');
    const unrelatedPids: number[] = [];
    const script = [
      "const fs=require('fs');",
      `fs.writeFileSync(${JSON.stringify(markerPath)},'started');`,
      "setTimeout(()=>process.stdout.write('ok'),750);",
    ].join('');
    try {
      const outcomePromise = runBoundedProbe(
        {
          command: process.execPath,
          argv: ['-e', script],
          timeoutMs: 5_000,
          maximumOutputBytes: 64,
          maximumProcesses: 1,
        },
        {
          afterBaselineCaptured: async () => {
            await spawnUnrelatedPid1Orphans(unrelatedPids, 9);
          },
        },
      );
      const markerDeadline = Date.now() + 2_000;
      while (!fs.existsSync(markerPath) && Date.now() < markerDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(fs.existsSync(markerPath)).toBe(true);
      for (let index = 0; index < 9; index += 1) {
        const unrelated = spawn(
          process.execPath,
          ['-e', 'setInterval(()=>{},60000)'],
          { detached: true, stdio: 'ignore' },
        );
        if (unrelated.pid !== undefined) unrelatedPids.push(unrelated.pid);
        unrelated.unref();
      }
      await expect(outcomePromise).resolves.toMatchObject({
        status: 0,
        timedOut: false,
        processCountOverflow: false,
      });
    } finally {
      await killAndWait(unrelatedPids);
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  it('never accepts success after detached descendants escape a dead root parent', async () => {
    if (process.platform === 'win32') return;
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oma-probe-detached-count-'));
    const pidPath = path.join(root, 'children.json');
    const script = [
      "const fs=require('fs');",
      "const {spawn}=require('child_process');",
      'const pids=[];',
      'for(let index=0;index<9;index+=1){',
      "const child=spawn(process.execPath,['-e','setInterval(()=>{},60000)'],{detached:true,stdio:'ignore'});",
      'pids.push(child.pid);child.unref();',
      '}',
      `fs.writeFileSync(${JSON.stringify(pidPath)},JSON.stringify(pids));`,
      'setTimeout(()=>{},750);',
    ].join('');
    try {
      const outcome = await runBoundedProbe({
        command: process.execPath,
        argv: ['-e', script],
        timeoutMs: 5_000,
        maximumOutputBytes: 64,
        maximumProcesses: 8,
      });
      expect(outcome.status).not.toBe(0);
      expect(outcome.processCountOverflow || outcome.error === 'E_PROBE_PROCESS_COUNT_UNAVAILABLE').toBe(true);
    } finally {
      try {
        const pids = JSON.parse(fs.readFileSync(pidPath, 'utf8')) as number[];
        await killAndWait(pids);
      } catch (_) { /* root 未完成 pid 紀錄 */ }
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 10_000);
});

/** 雙重 fork 後讓無關程序 reparent 到 PID 1，重現首次 snapshot 的高負載誤收。 */
async function spawnUnrelatedPid1Orphans(pids: number[], count: number): Promise<void> {
  const started = await Promise.all(Array.from({ length: count }, () => spawnPid1Orphan()));
  pids.push(...started);
}

function spawnPid1Orphan(): Promise<number> {
  return new Promise((resolve, reject) => {
    const starter = spawn(
      process.execPath,
      [
        '-e',
        [
          "const {spawn}=require('child_process');",
          "const child=spawn(process.execPath,['-e','setInterval(()=>{},60000)'],{detached:true,stdio:'ignore'});",
          'if (child.pid === undefined) process.exit(1);',
          'process.stdout.write(String(child.pid));',
          'child.unref();',
        ].join(''),
      ],
      { stdio: ['ignore', 'pipe', 'ignore'] },
    );
    if (starter.stdout === null) {
      reject(new Error('failed to spawn unrelated PID-1 orphan'));
      return;
    }
    let output = '';
    starter.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8');
    });
    starter.once('error', reject);
    starter.once('close', (status) => {
      const pid = Number(output.trim());
      if (status !== 0 || !Number.isSafeInteger(pid) || pid <= 0) {
        reject(new Error('failed to spawn unrelated PID-1 orphan'));
        return;
      }
      resolve(pid);
    });
  });
}

async function killAndWait(pids: readonly number[]): Promise<void> {
  for (const pid of pids) {
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    try { process.kill(pid, 'SIGKILL'); } catch (_) { /* 已結束 */ }
  }
  const cleanupDeadline = Date.now() + 2_000;
  while (Date.now() < cleanupDeadline) {
    const remaining = pids.some((pid) => {
      if (!Number.isSafeInteger(pid) || pid <= 0) return false;
      try { process.kill(pid, 0); return true; } catch (_) { return false; }
    });
    if (!remaining) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
