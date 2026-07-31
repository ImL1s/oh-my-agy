import { assertCanonicalUtcTimestamp } from '../../contracts/state-schemas';
import { redactDiagnostic } from '../../runtime/redaction';
import { CapabilityObservationV1, CapabilitySource } from '../capability-profile';
import { PASSIVE_PROBE_LIMITS_V1, PassiveProbeContextV1, ProbeResultV1 } from './types';
import { runBoundedProbe } from './runner';

function exactLongOption(name: string): RegExp {
  return new RegExp(`(?:^|\\s)--${name}(?:[\\s=,]|$)`, 'mu');
}

function exactHelpToken(token: string): RegExp {
  return new RegExp(`(?:^|[\\s,(|])${token}(?=$|[\\s,):|])`, 'imu');
}

const HELP_TOKENS: Readonly<Record<string, readonly RegExp[]>> = Object.freeze({
  'headless.print': [/(?:^|\s)-p(?:\s|,|$)/mu, exactLongOption('print')],
  'headless.json': [
    /(?:^|\s)--output-format(?:=|\s+)json(?=$|\s)/mu,
    /^[ \t]*--output-format(?=[ \t=,]|$)[^\r\n]*(?:[\s,(|])json(?=$|[\s,)|])/mu,
  ],
  'headless.stream_json': [exactHelpToken('(?:--)?stream-json')],
  'headless.json_schema': [exactLongOption('json-schema')],
  'conversation.continue': [exactLongOption('continue')],
  'conversation.exact': [exactLongOption('conversation'), exactLongOption('conversation-id')],
  'conversation.fork': [exactLongOption('fork')],
  'conversation.branch': [exactLongOption('branch')],
  'project.association': [exactLongOption('project')],
  'model.discovery': [exactLongOption('model')],
  'model.selection': [exactLongOption('model')],
  'effort.discovery': [exactLongOption('effort')],
  'effort.selection': [exactLongOption('effort')],
  'mcp.local_config': [exactHelpToken('mcp')],
  'mcp.remote_config': [exactHelpToken('mcp')],
});

export async function probeDocumentedHelp(
  executable: string,
  context: Readonly<PassiveProbeContextV1>,
  now?: () => string,
): Promise<ProbeResultV1> {
  const outcome = await (context.runner ?? runBoundedProbe)({
    command: executable,
    argv: ['--help'],
    timeoutMs: PASSIVE_PROBE_LIMITS_V1.timeoutMs,
    maximumOutputBytes: PASSIVE_PROBE_LIMITS_V1.maximumOutputBytes,
    maximumProcesses: PASSIVE_PROBE_LIMITS_V1.maximumProcesses,
  });
  const completedContext = now === undefined
    ? context
    : { ...context, evaluationTimestamp: now() };
  assertCanonicalUtcTimestamp(completedContext.evaluationTimestamp, 'help probe observedAt');
  if (outcome.timedOut || outcome.outputOverflow || outcome.processCountOverflow
    || outcome.error !== undefined || outcome.status !== 0) {
    const detailCode = outcome.timedOut ? 'HELP_TIMEOUT' : outcome.outputOverflow ? 'HELP_OVERFLOW'
      : outcome.processCountOverflow ? 'HELP_PROCESS_OVERFLOW' : 'HELP_UNAVAILABLE';
    return {
      observations: Object.keys(HELP_TOKENS).map((capability) => observation(
        capability, 'indeterminate', completedContext, detailCode,
        `${outcome.stderr}\n${outcome.error ?? ''}`,
      )),
      cacheable: false,
      detailCode,
    };
  }
  const help = `${outcome.stdout}\n${outcome.stderr}`;
  return {
    observations: Object.entries(HELP_TOKENS).map(([capability, patterns]) => observation(
      capability,
      patterns.some((pattern) => pattern.test(help)) ? 'positive' : 'negative',
      completedContext,
      patterns.some((pattern) => pattern.test(help)) ? 'HELP_ADVERTISED' : 'HELP_AFFIRMATIVE_ABSENCE',
      null,
    )),
    cacheable: true,
    detailCode: 'HELP_PARSED',
  };
}

function observation(
  capability: string,
  result: CapabilityObservationV1['result'],
  context: Readonly<PassiveProbeContextV1>,
  detailCode: string,
  diagnostic: string | null,
  source: CapabilitySource = 'help',
): CapabilityObservationV1 {
  return {
    capability,
    source,
    tier: 'observed',
    result,
    observedAt: context.evaluationTimestamp,
    identityDigest: context.identityDigest,
    detailCode,
    diagnostic: diagnostic === null ? null : redactDiagnostic(diagnostic, 4096),
  };
}
