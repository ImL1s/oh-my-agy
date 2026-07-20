import * as crypto from 'crypto';
import { ProcessRunner, currentProcessIdentity } from '../../src/runtime/process';

describe('ProcessRunner contract', () => {
  test('boundedHeadless uses argv and preserves exit/stdout/stderr', async () => {
    const runner = new ProcessRunner();
    const result = await runner.boundedHeadless(
      process.execPath,
      ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exit(7)'],
      { deadlineMs: 5_000 },
      { operationId: 'fixture', ownerNonce: crypto.randomBytes(16).toString('hex') },
    );

    expect(result).toEqual(expect.objectContaining({
      ok: true,
      value: expect.objectContaining({ code: 7, stdout: 'out', stderr: 'err', timedOut: false }),
    }));
  });

  test('exposes reproducible wrapper identity and child spawn lifecycle', async () => {
    const wrapper = currentProcessIdentity('owner');
    expect(wrapper).toEqual(expect.objectContaining({
      pid: process.pid,
      ownerNonce: 'owner',
      startMarker: expect.any(String),
    }));
    const spawned: number[] = [];
    const runner = new ProcessRunner();
    const result = await runner.boundedHeadless(
      process.execPath,
      ['-e', 'process.exit(0)'],
      { deadlineMs: 5_000, onSpawn: (identity) => { spawned.push(identity.pid); } },
      { operationId: 'spawn-hook', ownerNonce: 'owner' },
    );
    expect(result.ok).toBe(true);
    expect(spawned).toHaveLength(1);
    if (result.ok) expect(spawned[0]).toBe(result.value.processIdentity?.pid);
  });

  test('a throwing spawn recorder becomes a typed failure and the owned child is reaped', async () => {
    const runner = new ProcessRunner();
    const startedAt = Date.now();
    const result = await runner.boundedHeadless(
      process.execPath,
      ['-e', 'setInterval(() => {}, 1000)'],
      {
        deadlineMs: 5_000,
        terminationGraceMs: 50,
        onSpawn: () => { throw new Error('durability failed'); },
      },
      { operationId: 'spawn-failure', ownerNonce: 'owner' },
    );
    expect(result).toEqual(expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'E_RETRYABLE_BLOCKER' }),
    }));
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  test('maxOutputBytes overflow kills the child (not only truncate)', async () => {
    const runner = new ProcessRunner();
    const result = await runner.boundedHeadless(
      process.execPath,
      ['-e', 'setInterval(() => process.stdout.write("x".repeat(4096)), 10)'],
      {
        deadlineMs: 5_000,
        terminationGraceMs: 50,
        maxOutputBytes: 2048,
      },
      { operationId: 'overflow', ownerNonce: crypto.randomBytes(16).toString('hex') },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.outputOverflow).toBe(true);
    expect(result.value.stdout.length).toBeLessThanOrEqual(2048);
    // killed rather than natural exit 0
    expect(result.value.code === 0 && result.value.signal === null).toBe(false);
  }, 10000);

  test('maxProcessCount can be configured (count includes root)', async () => {
    const runner = new ProcessRunner();
    const result = await runner.boundedHeadless(
      process.execPath,
      ['-e', 'setTimeout(() => process.exit(0), 200)'],
      {
        deadlineMs: 5_000,
        maxProcessCount: 100,
      },
      { operationId: 'proc-count', ownerNonce: crypto.randomBytes(16).toString('hex') },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.processCountOverflow).not.toBe(true);
    expect(result.value.code).toBe(0);
  });
});
