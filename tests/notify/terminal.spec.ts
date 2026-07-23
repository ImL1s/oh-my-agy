import { notifyTerminal } from '../../src/notify/terminal';
import { createNotificationEvent } from '../../src/notify/types';

const owner = { owner_id: 'owner', generation: 2, owner_nonce: '1234567890abcdef' };
const event = createNotificationEvent({
  ...owner, severity: 'info', title: 'Ready', message: 'Verification passed',
  created_at: '2026-07-22T00:00:00.000Z',
});
const identity = { pid: process.pid, start_marker: 'start-marker', tty: 'ttys999' };

describe('terminal notifications', () => {
  test('disabled adapter performs no identity probe or write', () => {
    const inspect = jest.fn();
    const write = jest.fn();
    const result = notifyTerminal(event, {
      adapter: 'terminal', enabled: false, ...owner, terminal: identity,
    }, { inspect, write });
    expect(result.status).toBe('skipped');
    expect(inspect).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  test('delivers only after exact current process, start marker, tty, and owner readback', () => {
    const writes: string[] = [];
    const result = notifyTerminal(event, {
      adapter: 'terminal', enabled: true, ...owner, terminal: identity,
    }, {
      inspect: () => ({ ...identity }),
      write: (line) => { writes.push(line); return true; },
    });
    expect(result).toEqual(expect.objectContaining({ status: 'delivered', code: 'TERMINAL_DELIVERED' }));
    expect(writes).toEqual(['[OMA INFO] Ready: Verification passed\n']);
  });

  test.each([
    [{ ...identity, start_marker: 'different' }, 'TERMINAL_IDENTITY_MISMATCH'],
    [{ ...identity, tty: 'ttys998' }, 'TERMINAL_IDENTITY_MISMATCH'],
  ] as const)('refuses mismatched identity %j', (observed, code) => {
    const write = jest.fn();
    const result = notifyTerminal(event, {
      adapter: 'terminal', enabled: true, ...owner, terminal: identity,
    }, { inspect: () => observed, write });
    expect(result.code).toBe(code);
    expect(write).not.toHaveBeenCalled();
  });

  test('refuses owner nonce mismatch without leaking it', () => {
    const result = notifyTerminal(event, {
      adapter: 'terminal', enabled: true, ...owner, owner_nonce: 'different-nonce-1234', terminal: identity,
    }, { inspect: () => identity, write: () => true });
    expect(result.code).toBe('TERMINAL_OWNER_MISMATCH');
    expect(JSON.stringify(result)).not.toContain('different-nonce-1234');
  });
});
