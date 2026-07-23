import { notifyTmux, TmuxNotificationRunnerV1 } from '../../src/notify/tmux';
import { createNotificationEvent } from '../../src/notify/types';

const owner = { owner_id: 'owner', generation: 1, owner_nonce: 'owner-nonce-123456' };
const workerNonce = 'worker-nonce-12345';
const event = createNotificationEvent({
  ...owner, severity: 'success', title: 'Done', message: 'All gates passed',
  created_at: '2026-07-22T00:00:00.000Z',
});

function runner(overrides: Partial<Record<number, string>> = {}): { run: TmuxNotificationRunnerV1; calls: string[][] } {
  const calls: string[][] = [];
  const stdout = ['team\t%9', owner.owner_nonce, workerNonce, ''];
  return {
    calls,
    run: (argv) => {
      const index = calls.length;
      calls.push([...argv]);
      return { status: 0, stdout: overrides[index] ?? stdout[index], stderr: '' };
    },
  };
}

describe('tmux notifications', () => {
  const target = {
    adapter: 'tmux' as const, enabled: true, ...owner,
    session_name: 'team', pane_id: '%9', worker_nonce: workerNonce,
  };

  test('reads exact session/pane ownership before bounded display-message delivery', () => {
    const mock = runner();
    const result = notifyTmux(event, target, { run: mock.run });
    expect(result).toEqual(expect.objectContaining({ status: 'delivered', code: 'TMUX_DELIVERED' }));
    expect(mock.calls).toEqual([
      ['display-message', '-p', '-t', '%9', '#{session_name}\t#{pane_id}'],
      ['show-options', '-v', '-t', 'team', '@oma_owner_nonce'],
      ['show-options', '-p', '-v', '-t', '%9', '@oma_worker_nonce'],
      ['display-message', '-t', '%9', '--', '[OMA SUCCESS] Done: All gates passed'],
    ]);
  });

  test.each([[0, 'other\t%9'], [1, 'wrong-owner'], [2, 'wrong-worker']] as const)(
    'refuses readback mismatch at call %i', (index, value) => {
      const mock = runner({ [index]: value });
      const result = notifyTmux(event, target, { run: mock.run });
      expect(result.code).toBe('TMUX_IDENTITY_MISMATCH');
      expect(mock.calls).toHaveLength(3);
    },
  );

  test('disabled adapter invokes no tmux command', () => {
    const run = jest.fn();
    const result = notifyTmux(event, { ...target, enabled: false }, { run });
    expect(result.status).toBe('skipped');
    expect(run).not.toHaveBeenCalled();
  });
});
