import { wrapWithReadOnlySandbox, sandboxAvailable } from '../../src/runtime/sandbox';

describe('planning sandbox (ADR-0001)', () => {
  const prev = process.env.OMA_REQUIRE_SANDBOX;

  afterEach(() => {
    if (prev === undefined) delete process.env.OMA_REQUIRE_SANDBOX;
    else process.env.OMA_REQUIRE_SANDBOX = prev;
  });

  test('when sandbox not required and tool missing, launches without sandbox', () => {
    delete process.env.OMA_REQUIRE_SANDBOX;
    const result = wrapWithReadOnlySandbox({
      command: 'agy',
      argv: ['-p', 'q'],
      cwd: process.cwd(),
      writablePaths: ['/tmp'],
      requireSandbox: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (sandboxAvailable() === null) {
      expect(result.value.sandbox).toBe('none');
      expect(result.value.command).toBe('agy');
    }
  });

  test('when sandbox required and tool missing, fails closed', () => {
    // Force require; if tools exist this still returns ok with bwrap — both are valid
    const result = wrapWithReadOnlySandbox({
      command: 'agy',
      argv: ['-p', 'q'],
      cwd: process.cwd(),
      writablePaths: [process.cwd()],
      requireSandbox: true,
    });
    if (sandboxAvailable() === null) {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('E_RETRYABLE_BLOCKER');
    } else if (sandboxAvailable() === 'bwrap') {
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.command).toBe('bwrap');
        expect(result.value.argv).toContain('--ro-bind');
      }
    } else {
      // sandbox-exec path without profile under require → fail closed
      expect(result.ok).toBe(false);
    }
  });

  test('an unverified or foreign capability receipt cannot authorize a sandbox', () => {
    const available = sandboxAvailable();
    const capability = {
      store_kind: 'capability_record' as const,
      schema_version: 1 as const,
      canonical_name: available ?? 'bwrap', aliases: [], origin: 'foreign-provider',
      resolution_priority: 0, version: '1', digest: 'a'.repeat(64),
      probe_timestamp: '2026-07-22T00:00:00.000Z', bounded_result: 'bounded probe',
      redacted_diagnostic: '', configured: true, installed: true, enabled: true,
      loadable: true, observed: true, healthy: true, verified: false, shadowed_by: null,
    };
    const result = wrapWithReadOnlySandbox({
      command: 'agy', argv: ['-p', 'q'], cwd: process.cwd(), writablePaths: [],
      capability, requiredCapabilityTier: 'verified', expectedCapabilityOrigin: 'oma-owned',
    });
    expect(result).toEqual(expect.objectContaining({
      ok: false, error: expect.objectContaining({ code: 'E_CAPABILITY_UNPROVEN' }),
    }));
  });
});
