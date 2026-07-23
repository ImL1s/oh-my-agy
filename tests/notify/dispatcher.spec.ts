import { dispatchNotifications } from '../../src/notify/dispatcher';
import { createNotificationEvent } from '../../src/notify/types';

const owner = { owner_id: 'owner', generation: 1, owner_nonce: 'owner-nonce-123456' };
const event = createNotificationEvent({
  ...owner, severity: 'info', title: 'State', message: 'Core remains available',
  created_at: '2026-07-22T00:00:00.000Z',
});

describe('notification dispatcher isolation', () => {
  test('disabled/unavailable adapters are outcomes, never core failures', async () => {
    const terminalWrite = jest.fn();
    const outcomes = await dispatchNotifications(event, [
      {
        adapter: 'terminal', enabled: false, ...owner,
        terminal: { pid: process.pid, start_marker: 's', tty: 't' },
      },
      {
        adapter: 'https', enabled: true, ...owner,
        url: 'https://hooks.acme.example.net/oma', allowed_hosts: ['hooks.acme.example.net'],
      },
    ], {
      terminal: { write: terminalWrite },
      https: {
        resolve: async () => { throw new Error('network unavailable'); },
      },
    });
    expect(outcomes.map((entry) => entry.status)).toEqual(['skipped', 'failed']);
    expect(outcomes[1].code).toBe('HTTPS_DNS_FAILED');
    expect(terminalWrite).not.toHaveBeenCalled();
  });

  test('does not expose an inbound reply or listener contract', async () => {
    const surface = await import('../../src/notify');
    expect(Object.keys(surface).some((name) => /listen|server|reply|inbound/iu.test(name))).toBe(false);
  });
});
