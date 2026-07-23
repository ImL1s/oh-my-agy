import { assertRedacted, redactDiagnostic, redactValue } from '../../src/runtime/redaction';
import { runtimeError } from '../../src/runtime/errors';

describe('central recursive redaction', () => {
  test('redacts frozen secret classes recursively and in URLs/headers', () => {
    const value = redactValue({
      authorization: 'Bearer abc',
      headers: { Cookie: 'sid=abc' },
      url: 'https://example.invalid/?token=abc&safe=ok',
      env: { API_TOKEN: 'abc', SAFE: 'ok' },
      nested: [{ account: 'acct-1', model: 'secret-model', quota: 42 }],
      prompt: 'private prompt',
      command: 'deploy --token abc',
    });
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain('abc');
    expect(serialized).not.toContain('acct-1');
    expect(serialized).not.toContain('secret-model');
    expect(serialized).not.toContain('private prompt');
    expect(serialized).toContain('<redacted>');
    expect(() => assertRedacted(value)).not.toThrow();
  });

  test('bounds diagnostics and removes bearer/assignment values', () => {
    const diagnostic = redactDiagnostic(`Authorization: Bearer abc token=def prompt=private command=deploy ${'x'.repeat(6000)}`);
    expect(Buffer.byteLength(diagnostic)).toBeLessThanOrEqual(4096);
    expect(diagnostic).not.toContain('abc');
    expect(diagnostic).not.toContain('def');
    expect(diagnostic).not.toContain('private');
    expect(diagnostic).not.toContain('deploy');
  });

  test('typed runtime error details pass through the same central redactor', () => {
    const error = runtimeError('E_RETRYABLE_BLOCKER', 'blocked', {
      authorization: 'Bearer secret', command: 'deploy --token secret', safe: 1,
    });
    expect(JSON.stringify(error)).not.toContain('secret');
    expect(error.details).toEqual(expect.objectContaining({
      authorization: '<redacted>', command: '<redacted>', safe: 1,
    }));
  });

  test('redacts JSON stringified secrets in raw strings and enforces assertion', () => {
    expect(redactDiagnostic('{"password":"secret-value","user":"ok"}')).toBe('{"password":"<redacted>","user":"ok"}');
    expect(redactDiagnostic('{"api_key" : "abc"}')).toBe('{"api_key" : "<redacted>"}');
    expect(() => assertRedacted('{"token":"raw-secret"}')).toThrow();
    const safeJson = '{"user":"ok","status":"active"}';
    expect(redactDiagnostic(safeJson)).toBe(safeJson);
    expect(() => assertRedacted(safeJson)).not.toThrow();
  });
});
