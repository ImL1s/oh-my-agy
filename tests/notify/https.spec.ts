import { HttpsResolverV1, HttpsTransportV1, notifyHttps, publicAddress } from '../../src/notify/https';
import { createNotificationEvent } from '../../src/notify/types';

const owner = { owner_id: 'owner', generation: 1, owner_nonce: 'owner-nonce-123456' };
const event = createNotificationEvent({
  ...owner, severity: 'warning', title: 'Gate', message: 'Review required token=private',
  created_at: '2026-07-22T00:00:00.000Z',
});
const target = {
  adapter: 'https' as const,
  enabled: true,
  ...owner,
  url: 'https://hooks.acme.example.net/oma',
  allowed_hosts: ['hooks.acme.example.net'],
};

describe('HTTPS notifications', () => {
  test('is opt-in and disabled mode performs no DNS or request', async () => {
    const resolve = jest.fn();
    const request = jest.fn();
    const result = await notifyHttps(event, { ...target, enabled: false }, { resolve, request });
    expect(result.status).toBe('skipped');
    expect(resolve).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  test('revalidates DNS, pins the public address, and sends a bounded redacted payload', async () => {
    const resolve: jest.MockedFunction<HttpsResolverV1> = jest.fn(
      async (_hostname: string) => [{ address: '93.184.216.34', family: 4 as const }],
    );
    const request: jest.MockedFunction<HttpsTransportV1> = jest.fn(
      async (_input) => ({ status_code: 204, response_bytes: 0 }),
    );
    const result = await notifyHttps(event, target, { resolve, request });
    expect(result).toEqual(expect.objectContaining({ status: 'delivered', code: 'HTTPS_DELIVERED' }));
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(request).toHaveBeenCalledTimes(1);
    const input = request.mock.calls[0][0];
    expect(input.address).toEqual({ address: '93.184.216.34', family: 4 });
    expect(input.url.hostname).toBe('hooks.acme.example.net');
    expect(input.payload).not.toContain(owner.owner_nonce);
    expect(input.payload).not.toContain('private');
    expect(JSON.stringify(result)).not.toContain(target.url);
  });

  test.each([
    [[{ address: '127.0.0.1', family: 4 as const }], 'private IPv4'],
    [[{ address: '::1', family: 6 as const }], 'loopback IPv6'],
    [[{ address: 'fc00::1', family: 6 as const }], 'ULA IPv6'],
    [[{ address: '::ffff:10.0.0.1', family: 6 as const }], 'mapped private IPv4'],
    [[{ address: '::10.0.0.1', family: 6 as const }], 'compatible private IPv4'],
    [[{ address: '64:ff9b::7f00:1', family: 6 as const }], 'NAT64 loopback mapping'],
  ])('rejects %s (%s)', async (addresses, _label) => {
    const request = jest.fn();
    const result = await notifyHttps(event, target, { resolve: async () => addresses, request });
    expect(result.code).toBe('HTTPS_DNS_REVALIDATION_REJECTED');
    expect(request).not.toHaveBeenCalled();
  });

  test('fails closed on DNS rebinding', async () => {
    let call = 0;
    const result = await notifyHttps(event, target, {
      resolve: async () => [{ address: call++ === 0 ? '93.184.216.34' : '8.8.8.8', family: 4 }],
      request: async () => ({ status_code: 204, response_bytes: 0 }),
    });
    expect(result.code).toBe('HTTPS_DNS_REVALIDATION_REJECTED');
  });

  test.each([
    'http://hooks.acme.example.net/oma',
    'https://127.0.0.1/oma',
    'https://localhost/oma',
    'https://hooks.acme.example.net:444/oma',
    'https://hooks.acme.example.net/oma?token=secret',
    'https://other.example.net/oma',
  ])('rejects unsafe endpoint %s before DNS', async (url) => {
    const resolve = jest.fn();
    const result = await notifyHttps(event, { ...target, url }, { resolve });
    expect(result.code).toBe('HTTPS_ENDPOINT_REJECTED');
    expect(resolve).not.toHaveBeenCalled();
  });

  test('classifies representative public and reserved addresses', () => {
    expect(publicAddress('8.8.8.8', 4)).toBe(true);
    expect(publicAddress('198.51.100.1', 4)).toBe(false);
    expect(publicAddress('2606:4700:4700::1111', 6)).toBe(true);
    expect(publicAddress('2001:db8::1', 6)).toBe(false);
  });
});
