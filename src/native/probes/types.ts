import { CapabilityObservationV1, HostIdentityV1, PluginIdentityV1 } from '../capability-profile';

export type ProbeModeV1 = 'passive' | 'live';

export interface BoundedProbeRequestV1 {
  command: string;
  argv: readonly string[];
  cwd?: string;
  environment?: NodeJS.ProcessEnv;
  timeoutMs: number;
  maximumOutputBytes: number;
}

export interface BoundedProbeOutcomeV1 {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputOverflow: boolean;
  error?: string;
}

export type BoundedProbeRunnerV1 = (
  request: Readonly<BoundedProbeRequestV1>,
) => Promise<BoundedProbeOutcomeV1>;

export interface PassiveProbeContextV1 {
  mode: 'passive';
  evaluationTimestamp: string;
  identityDigest: string;
  hostIdentity: HostIdentityV1;
  pluginIdentity: PluginIdentityV1;
  runner?: BoundedProbeRunnerV1;
}

export interface LiveProbeContextV1 extends Omit<PassiveProbeContextV1, 'mode'> {
  mode: 'live';
  liveOptIn: true;
}

export interface ProbeResultV1 {
  observations: CapabilityObservationV1[];
  cacheable: boolean;
  detailCode: string;
}

export const PASSIVE_PROBE_LIMITS_V1 = Object.freeze({
  timeoutMs: 5_000,
  maximumOutputBytes: 64 * 1024,
  maximumJsonBytes: 256 * 1024,
});
