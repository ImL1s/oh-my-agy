import { RuntimeError, runtimeError } from '../../src/runtime/errors';
import { ProcessOutcome } from '../../src/runtime/process';
import { Result, err, ok } from '../../src/runtime/types';
import {
  ManagedInvocationService,
  ManagedLaunchTransaction,
  PreparedManagedInvocation,
  InteractiveRunner,
} from '../../src/cli/managed-invocation';

describe('managed invocation', () => {
  const prepared: PreparedManagedInvocation = {
    kind: 'launch',
    launchTransactionId: 'tx-1',
    sessionId: 'session-1',
    conversationId: null,
    launchNonce: 'nonce-1',
    invocationGeneration: 1,
    cwd: '/workspace',
    operationIdentity: { operationId: 'tx-1', ownerNonce: 'owner-1' },
  };

  function fixture(preflight: Result<unknown, RuntimeError> = ok({ active: true })) {
    const transaction: jest.Mocked<ManagedLaunchTransaction> = {
      prepareLaunch: jest.fn<
        ReturnType<ManagedLaunchTransaction['prepareLaunch']>,
        Parameters<ManagedLaunchTransaction['prepareLaunch']>
      >(async () => ok(prepared)),
      prepareResume: jest.fn<
        ReturnType<ManagedLaunchTransaction['prepareResume']>,
        Parameters<ManagedLaunchTransaction['prepareResume']>
      >(async () => ok({
        ...prepared,
        kind: 'resume' as const,
        conversationId: 'conversation-7',
        launchNonce: 'nonce-2',
        invocationGeneration: 2,
      })),
      recordChildSpawned: jest.fn<
        ReturnType<ManagedLaunchTransaction['recordChildSpawned']>,
        Parameters<ManagedLaunchTransaction['recordChildSpawned']>
      >(() => ok(undefined)),
      recordOutcome: jest.fn<
        ReturnType<ManagedLaunchTransaction['recordOutcome']>,
        Parameters<ManagedLaunchTransaction['recordOutcome']>
      >(async () => ok(undefined)),
    };
    const outcome: ProcessOutcome = {
      code: 0,
      signal: null,
      timedOut: false,
      stdout: '',
      stderr: '',
      processIdentity: { pid: 12, startMarker: 'start', parentPid: process.pid },
    };
    const runner: jest.Mocked<InteractiveRunner> = {
      foregroundInteractive: jest.fn<
        ReturnType<InteractiveRunner['foregroundInteractive']>,
        Parameters<InteractiveRunner['foregroundInteractive']>
      >(async (_command, _argv, _identity, policy) => {
        if (outcome.processIdentity !== null) policy?.onSpawn?.(outcome.processIdentity);
        return ok(outcome);
      }),
    };
    const service = new ManagedInvocationService({
      agyCommand: 'agy',
      environment: {
        PATH: '/bin',
        OMA_SESSION_ID: 'ambient-session',
        OMA_LAUNCH_NONCE: 'ambient-nonce',
        OMA_INVOCATION_GENERATION: '99',
      },
      packageRoot: '/pkg/oh-my-agy',
      workspacePath: '/workspace',
      stateRoot: '/state/oma',
      preflight: jest.fn(async () => preflight),
      transaction,
      runner,
      nonceFactory: () => '00112233445566778899aabbccddeeff',
    });
    return { service, transaction, runner, outcome };
  }

  test.each([
    ['ralph', ['-i']],
    ['ultrawork', ['-i']],
    ['search', ['--mode', 'plan', '--sandbox', '-i']],
  ] as const)('launches %s with a real directive and exact managed identity', async (mode, prefix) => {
    const { service, transaction, runner } = fixture();
    const result = await service.launchMode(mode, 'ship; $(touch /tmp/never)');
    expect(result.ok).toBe(true);
    expect(transaction.prepareLaunch).toHaveBeenCalledWith(expect.objectContaining({
      mode,
      taskDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(runner.foregroundInteractive).toHaveBeenCalledTimes(1);
    const [command, argv, identity, policy] = runner.foregroundInteractive.mock.calls[0];
    expect(command).toBe('agy');
    expect(argv.slice(0, -1)).toEqual(prefix);
    expect(argv.at(-1)).toContain(`OMA-DIRECTIVE oma.${mode}/v1`);
    expect(identity).toEqual(prepared.operationIdentity);
    expect(policy).toEqual(expect.objectContaining({
      cwd: '/workspace',
      env: expect.objectContaining({
        OMA_SESSION_ID: 'session-1',
        OMA_LAUNCH_NONCE: 'nonce-1',
        OMA_INVOCATION_GENERATION: '1',
        OMA_WORKSPACE_PATH: '/workspace',
        OMA_PACKAGE_ROOT: '/pkg/oh-my-agy',
        OMA_STATE_ROOT: '/state/oma',
      }),
    }));
    expect(transaction.recordOutcome).toHaveBeenCalledTimes(1);
    expect(transaction.recordChildSpawned).toHaveBeenCalledTimes(1);
  });

  test('uses precise --conversation resume and a fresh generation, never global -c', async () => {
    const { service, runner, transaction } = fixture();
    const result = await service.resumeConversation('session-1', 'conversation-7', 4);
    expect(result.ok).toBe(true);
    expect(transaction.prepareResume).toHaveBeenCalledWith({
      sessionId: 'session-1',
      conversationId: 'conversation-7',
      expectedRevision: 4,
    });
    const [, argv, , policy] = runner.foregroundInteractive.mock.calls[0];
    expect(argv).toEqual(['--conversation', 'conversation-7']);
    expect(argv).not.toContain('-c');
    expect(policy).toBeDefined();
    if (policy === undefined) return;
    expect(policy.env).toEqual(expect.objectContaining({
      OMA_LAUNCH_NONCE: 'nonce-2',
      OMA_INVOCATION_GENERATION: '2',
    }));
  });

  test('does not prepare or spawn when the plugin preflight is inactive', async () => {
    const { service, runner, transaction } = fixture(err(runtimeError(
      'E_PLUGIN_NOT_ACTIVE',
      'plugin inactive',
    )));
    const result = await service.launchMode('ralph', 'task');
    expect(result).toEqual(expect.objectContaining({ ok: false }));
    if (!result.ok) expect(result.error.code).toBe('E_PLUGIN_NOT_ACTIVE');
    expect(transaction.prepareLaunch).not.toHaveBeenCalled();
    expect(runner.foregroundInteractive).not.toHaveBeenCalled();
  });

  test('fails closed as managed when the durable child-spawn recorder rejects identity', async () => {
    const { service, transaction } = fixture();
    transaction.recordChildSpawned.mockReturnValue(err(runtimeError(
      'E_PROCESS_IDENTITY_UNPROVEN',
      'wrong child',
    )));
    const result = await service.launchMode('ralph', 'task');
    expect(result).toEqual(expect.objectContaining({ ok: false }));
    if (!result.ok) expect(result.error.code).toBe('E_PROCESS_IDENTITY_UNPROVEN');
    expect(transaction.recordOutcome).not.toHaveBeenCalled();
  });

  test('ordinary pass-through strips managed binding env and preserves exact argv', async () => {
    const { service, runner, transaction } = fixture();
    const result = await service.passThrough(['-p', ';', '|', '$()', 'line\nbreak']);
    expect(result.ok).toBe(true);
    const [, argv, , policy] = runner.foregroundInteractive.mock.calls[0];
    expect(argv).toEqual(['-p', ';', '|', '$()', 'line\nbreak']);
    expect(policy).toBeDefined();
    if (policy === undefined) return;
    expect(policy.env).not.toHaveProperty('OMA_SESSION_ID');
    expect(policy.env).not.toHaveProperty('OMA_LAUNCH_NONCE');
    expect(policy.env).not.toHaveProperty('OMA_INVOCATION_GENERATION');
    expect(transaction.prepareLaunch).not.toHaveBeenCalled();
    expect(transaction.prepareResume).not.toHaveBeenCalled();
  });
});
