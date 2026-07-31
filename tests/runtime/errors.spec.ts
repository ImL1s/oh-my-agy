import { RUNTIME_ERROR_CODES, runtimeError } from '../../src/runtime/errors';

describe('runtime error catalog', () => {
  test('includes the exact native adapter unavailable contract', () => {
    expect(RUNTIME_ERROR_CODES).toContain('E_NATIVE_ADAPTER_UNAVAILABLE');
    expect(runtimeError(
      'E_NATIVE_ADAPTER_UNAVAILABLE',
      'Antigravity native worker adapter is unavailable',
      { provider: 'antigravity_native', adapterImplemented: false },
    )).toEqual({
      code: 'E_NATIVE_ADAPTER_UNAVAILABLE',
      message: 'Antigravity native worker adapter is unavailable',
      details: { provider: 'antigravity_native', adapterImplemented: false },
    });
  });
});
