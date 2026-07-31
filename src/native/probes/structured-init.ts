import {
  CapabilityObservationV1,
  HOST_CAPABILITY_POLICY_REGISTRY_V1,
} from '../capability-profile';
import { LiveProbeContextV1, ProbeResultV1 } from './types';

const STRUCTURED_ALIASES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'conversation.exact': ['conversation_id'],
  'conversation.continue': ['continued_conversation_id'],
  'conversation.fork': ['fork_id'],
  'conversation.branch': ['branch_id'],
  'project.association': ['project', 'project_id'],
  'permission.policy': ['permission_policy'],
  'permission.sandbox': ['sandbox'],
  'model.discovery': ['model'],
  'model.selection': ['model'],
  'effort.discovery': ['effort'],
  'effort.selection': ['effort'],
  'custom_agent.markdown': ['agent', 'agent_type'],
  'custom_agent.main_agent': ['agent', 'agent_type'],
  'custom_agent.subagent': ['subagents'],
  'custom_agent.hidden': ['hidden_agents'],
  'custom_agent.inherit_mcp': ['agent_mcp'],
  'custom_agent.command_execution_policy': ['agent_command_policy'],
  'custom_agent.model': ['agent_model'],
  'subagent.define': ['subagents'],
  'mcp.local_config': ['mcp'],
  'mcp.remote_config': ['remote_mcp'],
});

/** Parse only the documented terminal JSON object; never retain response text. */
export function probeStructuredInitOutput(
  source: string,
  context: Readonly<LiveProbeContextV1>,
  coveredCapabilities: ReadonlySet<string> = new Set(),
): ProbeResultV1 {
  if (Buffer.byteLength(source) > 64 * 1024) {
    return { observations: [], cacheable: false, detailCode: 'STRUCTURED_INIT_OVERFLOW' };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch (_) {
    return { observations: [], cacheable: false, detailCode: 'STRUCTURED_INIT_MALFORMED' };
  }
  if (!isObject(parsed)) {
    return { observations: [], cacheable: false, detailCode: 'STRUCTURED_INIT_MALFORMED' };
  }
  const policies = HOST_CAPABILITY_POLICY_REGISTRY_V1.filter((policy) =>
    policy.sourceCeilings.structured_init !== undefined
      && !coveredCapabilities.has(policy.key)
      && !policy.key.startsWith('headless.'));
  const observations = policies.map((policy): CapabilityObservationV1 => {
    const aliases = STRUCTURED_ALIASES[policy.key] ?? [policy.key];
    const present = aliases.some((alias) => hasNonEmptyValue(parsed, alias));
    return {
      capability: policy.key,
      source: 'structured_init',
      tier: 'observed',
      result: present ? 'positive' : 'indeterminate',
      observedAt: context.evaluationTimestamp,
      identityDigest: context.identityDigest,
      detailCode: present ? 'STRUCTURED_INIT_FIELD_OBSERVED' : 'STRUCTURED_INIT_FIELD_UNAVAILABLE',
      diagnostic: null,
    };
  });
  return { observations, cacheable: true, detailCode: 'STRUCTURED_INIT_PARSED' };
}

function hasNonEmptyValue(value: Readonly<Record<string, unknown>>, alias: string): boolean {
  const direct = value[alias];
  if (direct !== undefined && direct !== null && direct !== '' && direct !== false) return true;
  let current: unknown = value;
  for (const part of alias.split('.')) {
    if (!isObject(current) || !Object.prototype.hasOwnProperty.call(current, part)) return false;
    current = current[part];
  }
  return current !== undefined && current !== null && current !== '' && current !== false;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
