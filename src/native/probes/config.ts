import * as fs from 'fs';
import * as path from 'path';
import { CapabilityObservationV1, HOST_CAPABILITY_POLICY_REGISTRY_V1 } from '../capability-profile';
import { PassiveProbeContextV1, ProbeResultV1 } from './types';

export interface ContainedJsonReadV1 {
  status: 'ok' | 'missing' | 'rejected' | 'malformed';
  value: Record<string, unknown> | null;
  detailCode: string;
  diagnostic: string | null;
}

export function probeConfigObject(
  value: Readonly<Record<string, unknown>>,
  context: Readonly<PassiveProbeContextV1>,
): ProbeResultV1 {
  const policies = HOST_CAPABILITY_POLICY_REGISTRY_V1.filter(({ sourceCeilings }) => sourceCeilings.config !== undefined);
  const observations = policies.map((policy): CapabilityObservationV1 => {
    const present = hasDottedPath(value, policy.key) || Object.prototype.hasOwnProperty.call(value, policy.key);
    return {
      capability: policy.key,
      source: 'config',
      tier: 'configured',
      result: present ? 'positive' : 'indeterminate',
      observedAt: context.evaluationTimestamp,
      identityDigest: context.identityDigest,
      detailCode: present ? 'CONFIG_FIELD_PRESENT' : 'CONFIG_FIELD_UNPROVEN',
      diagnostic: null,
    };
  });
  return { observations, cacheable: true, detailCode: 'CONFIG_INSPECTED' };
}

function hasDottedPath(value: Readonly<Record<string, unknown>>, dotted: string): boolean {
  let current: unknown = value;
  for (const part of dotted.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)
      || !Object.prototype.hasOwnProperty.call(current, part)) return false;
    current = (current as Record<string, unknown>)[part];
  }
  return true;
}

export function readContainedJson(root: string, candidate: string, maximumBytes = 256 * 1024): ContainedJsonReadV1 {
  try {
    const rootRealpath = fs.realpathSync(root);
    const lexical = path.resolve(rootRealpath, candidate);
    if (lexical !== rootRealpath && !lexical.startsWith(`${rootRealpath}${path.sep}`)) return rejected('CONFIG_PATH_ESCAPE');
    if (!fs.existsSync(lexical)) return { status: 'missing', value: null, detailCode: 'CONFIG_MISSING', diagnostic: null };
    if (fs.lstatSync(lexical).isSymbolicLink()) return rejected('CONFIG_SYMLINK_REJECTED');
    const realpath = fs.realpathSync(lexical);
    if (realpath !== rootRealpath && !realpath.startsWith(`${rootRealpath}${path.sep}`)) return rejected('CONFIG_REALPATH_ESCAPE');
    const stat = fs.statSync(realpath);
    if (!stat.isFile() || stat.size > maximumBytes) return rejected('CONFIG_INVALID_FILE');
    const source = fs.readFileSync(realpath, 'utf8');
    const value = JSON.parse(source) as unknown;
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return rejected('CONFIG_MALFORMED', 'CONFIG_MALFORMED', 'malformed');
    return { status: 'ok', value: value as Record<string, unknown>, detailCode: 'CONFIG_PARSED', diagnostic: null };
  } catch (_) {
    return rejected('CONFIG_READ_FAILED');
  }
}

function rejected(detailCode: string, diagnostic = detailCode, status: ContainedJsonReadV1['status'] = 'rejected'): ContainedJsonReadV1 {
  return { status, value: null, detailCode, diagnostic: diagnostic.slice(0, 256) };
}
