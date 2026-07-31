import { runBoundedProbe } from '../../../src/native/probes/runner';

describe('bounded probe runner', () => {
  it('uses one exact combined output ceiling without overflowing at equality', async () => {
    const exact = await runBoundedProbe({ command: process.execPath, argv: ['-e', "process.stdout.write('ab');process.stderr.write('cd')"], timeoutMs: 2_000, maximumOutputBytes: 4 });
    expect(exact).toMatchObject({ status: 0, timedOut: false, outputOverflow: false });
    const overflow = await runBoundedProbe({ command: process.execPath, argv: ['-e', "process.stdout.write('abc');process.stderr.write('def')"], timeoutMs: 2_000, maximumOutputBytes: 4 });
    expect(overflow.outputOverflow).toBe(true);
    expect(Buffer.byteLength(overflow.stdout) + Buffer.byteLength(overflow.stderr)).toBeLessThanOrEqual(4);
  });

  it('terminates a timed-out process group', async () => {
    const outcome = await runBoundedProbe({ command: process.execPath, argv: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 20, maximumOutputBytes: 64 });
    expect(outcome).toMatchObject({ timedOut: true, signal: 'SIGKILL' });
  });
});
