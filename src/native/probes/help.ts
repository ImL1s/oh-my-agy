import { assertCanonicalUtcTimestamp } from '../../contracts/state-schemas';
import { redactDiagnostic } from '../../runtime/redaction';
import { CapabilityObservationV1, CapabilitySource } from '../capability-profile';
import { PASSIVE_PROBE_LIMITS_V1, PassiveProbeContextV1, ProbeResultV1 } from './types';
import { runBoundedProbe } from './runner';

const HELP_TOKENS: Readonly<Record<string, readonly RegExp[]>> = Object.freeze({
  'headless.print': [/(?:^|\s)-p(?:\s|,|$)/mu, /(?:^|\s)--print(?:[\s=,]|$)/mu],
  'headless.json': [
    /(?:^|\s)--output-format(?:=|\s+)json(?=$|\s)/mu,
    /^[ \t]*--output-format\b[^\r\n]*(?:[\s,(|])json(?=$|[\s,)|])/mu,
  ],
  'headless.stream_json': [/stream-json\b/mu],
  'headless.json_schema': [/--json-schema\b/mu],
  'conversation.continue': [/--continue\b/mu],
  'conversation.exact': [/--conversation(?:-id)?\b/mu],
  'conversation.fork': [/--fork\b/mu],
  'conversation.branch': [/--branch\b/mu],
  'project.association': [/--project\b/mu],
  'model.discovery': [/--model\b/mu],
  'model.selection': [/--model\b/mu],
  'effort.discovery': [/--effort\b/mu],
  'effort.selection': [/--effort\b/mu],
  'mcp.local_config': [/\bmcp\b/imu],
  'mcp.remote_config': [/\bmcp\b/imu],
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
