import {
  CapabilityRecordV1,
  resolveCapabilityProviders,
  validateCapabilityRecord,
} from '../contracts/capability';
import { redactDiagnostic } from './redaction';

export interface CapabilityObservationInput {
  canonicalName: string;
  aliases: string[];
  origin: string;
  priority: number;
  version: string | null;
  digest: string | null;
  diagnostic: unknown;
  observedAt: string;
  configured: boolean;
  installed: boolean;
  enabled: boolean;
  loadable: boolean;
  observed: boolean;
  healthy: boolean;
  verified: boolean;
}

export interface CapabilityDiscoveryOptions {
  now?: Date;
  maxObservationAgeMs?: number;
  maximumRecords?: number;
}

/**
 * Normalize capability evidence without promoting any truth tier.  Discovery
 * can only downgrade stale/impossible evidence; it never infers a later tier
 * from an earlier one.
 */
export async function discoverCapabilities(
  inputs: readonly CapabilityObservationInput[],
  options: CapabilityDiscoveryOptions = {},
): Promise<CapabilityRecordV1[]> {
  const now = options.now ?? new Date();
  const maxAge = options.maxObservationAgeMs ?? 60_000;
  const maximum = options.maximumRecords ?? 128;
  if (inputs.length > maximum) throw new Error('E_CAPABILITY_UNPROVEN: capability input exceeds bound');
  const byName = new Map<string, CapabilityRecordV1[]>();
  for (const input of inputs) {
    const observedAt = new Date(input.observedAt);
    if (!Number.isFinite(observedAt.getTime()) || observedAt.toISOString() !== input.observedAt) {
      throw new Error('E_CAPABILITY_UNPROVEN: observation timestamp is invalid');
    }
    const fresh = now.getTime() - observedAt.getTime() >= 0
      && now.getTime() - observedAt.getTime() <= maxAge;
    const staleSuffix = fresh ? 'fresh-observation' : 'restart-required: stale observation';
    const record: CapabilityRecordV1 = {
      store_kind: 'capability_record',
      schema_version: 1,
      canonical_name: input.canonicalName,
      aliases: [...new Set(input.aliases)].sort(),
      origin: input.origin,
      resolution_priority: input.priority,
      version: input.version,
      digest: input.digest,
      probe_timestamp: input.observedAt,
      bounded_result: `bounded/${maximum}: ${staleSuffix}`,
      redacted_diagnostic: redactDiagnostic(input.diagnostic),
      configured: input.configured,
      installed: input.installed,
      enabled: input.enabled,
      loadable: input.loadable,
      observed: fresh && input.observed,
      healthy: fresh && input.healthy,
      verified: fresh && input.verified,
      shadowed_by: null,
    };
    validateCapabilityRecord(record);
    const group = byName.get(record.canonical_name) ?? [];
    group.push(record);
    byName.set(record.canonical_name, group);
  }
  const output: CapabilityRecordV1[] = [];
  for (const name of [...byName.keys()].sort()) {
    output.push(...resolveCapabilityProviders(byName.get(name) as CapabilityRecordV1[]));
  }
  return output;
}
