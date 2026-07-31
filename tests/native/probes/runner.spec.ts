import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
    const outcome = await runBoundedProbe({ command: process.execPath, argv: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 20, maximumOutputBytes: 64, maximumProcesses: 8 });
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
      try { process.kill(Number(fs.readFileSync(pidPath, 'utf8')), 'SIGKILL'); } catch (_) { /* 已結束 */ }
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
});
