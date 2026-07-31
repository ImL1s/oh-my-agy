import { CapabilityObservationV1 } from '../capability-profile';
import { PASSIVE_PROBE_LIMITS_V1, PassiveProbeContextV1, ProbeResultV1 } from './types';

const PLUGIN_PATHS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'plugin.skills': ['skills'],
  'plugin.rules': ['rules'],
  'plugin.mcp_config': ['mcp_config', 'mcp_config.json', '.mcp.json'],
  'plugin.hooks_manifest': ['hooks.json'],
  'plugin.layout.workspace': ['workspace'],
  'plugin.layout.global': ['global'],
  'sidecar.layout.plugin': ['sidecars'],
  'sidecar.layout.global': ['globalSidecars'],
  'custom_agent.markdown': ['agent_markdown'],
  'custom_agent.main_agent': ['main_agent'],
  'custom_agent.subagent': ['subagent_markdown'],
  'custom_agent.hidden': ['hidden_agent_markdown'],
  'subagent.define': ['agent_markdown', 'subagent_markdown'],
  'mcp.local_config': ['mcp_config', 'mcp_config.json', '.mcp.json'],
});

const PUBLIC_HOOKS_V1: Readonly<Record<string, string>> = Object.freeze({
  'hook.pre_tool_use': 'PreToolUse',
  'hook.post_tool_use': 'PostToolUse',
  'hook.pre_invocation': 'PreInvocation',
  'hook.post_invocation': 'PostInvocation',
  'hook.stop': 'Stop',
});

export function parsePluginReadback(
  source: string,
  context: Readonly<PassiveProbeContextV1>,
): ProbeResultV1 {
  if (Buffer.byteLength(source) > PASSIVE_PROBE_LIMITS_V1.maximumJsonBytes) return failed('PLUGIN_READBACK_OVERFLOW', source, context);
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch (_) { return failed('PLUGIN_READBACK_MALFORMED', source, context); }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return failed('PLUGIN_READBACK_MALFORMED', source, context);
  const object = parsed as Record<string, unknown>;
  const observations = Object.entries(PLUGIN_PATHS).map(([capability, aliases]): CapabilityObservationV1 => ({
    capability,
    source: 'plugin_readback',
    tier: 'loadable',
    result: aliases.some((alias) => Object.prototype.hasOwnProperty.call(object, alias)) ? 'positive' : 'negative',
    observedAt: context.evaluationTimestamp,
    identityDigest: context.identityDigest,
    detailCode: aliases.some((alias) => Object.prototype.hasOwnProperty.call(object, alias)) ? 'PLUGIN_READBACK_PRESENT' : 'PLUGIN_READBACK_ABSENT',
    diagnostic: null,
  }));
  return { observations, cacheable: true, detailCode: 'PLUGIN_READBACK_PARSED' };
}

/** Exact installed hooks.json readback; missing registrations stay unknown. */
export function parseHookManifestReadback(
  source: string | null,
  context: Readonly<PassiveProbeContextV1>,
): ProbeResultV1 {
  if (source === null) return hookResult(new Set(), context, true, 'HOOK_MANIFEST_MISSING');
  if (Buffer.byteLength(source) > PASSIVE_PROBE_LIMITS_V1.maximumJsonBytes) {
    return hookResult(new Set(), context, false, 'HOOK_MANIFEST_OVERFLOW');
  }
  let parsed: unknown;
  try { parsed = JSON.parse(source); } catch (_) {
    return hookResult(new Set(), context, false, 'HOOK_MANIFEST_MALFORMED');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return hookResult(new Set(), context, false, 'HOOK_MANIFEST_MALFORMED');
  }
  const registrations = new Set<string>();
  for (const namespace of Object.values(parsed as Record<string, unknown>)) {
    if (typeof namespace !== 'object' || namespace === null || Array.isArray(namespace)) continue;
    for (const hookName of Object.values(PUBLIC_HOOKS_V1)) {
      const entry = (namespace as Record<string, unknown>)[hookName];
      if (Array.isArray(entry) && entry.length > 0) registrations.add(hookName);
    }
  }
  return hookResult(registrations, context, true, 'HOOK_MANIFEST_PARSED');
}

function hookResult(
  registrations: ReadonlySet<string>,
  context: Readonly<PassiveProbeContextV1>,
  cacheable: boolean,
  detailCode: string,
): ProbeResultV1 {
  return {
    observations: Object.entries(PUBLIC_HOOKS_V1).map(([capability, hookName]) => ({
      capability,
      source: 'plugin_readback' as const,
      tier: registrations.has(hookName) ? 'loadable' as const : 'configured' as const,
      result: registrations.has(hookName) ? 'positive' as const : 'indeterminate' as const,
      observedAt: context.evaluationTimestamp,
      identityDigest: context.identityDigest,
      detailCode: registrations.has(hookName) ? 'HOOK_REGISTERED' : detailCode,
      diagnostic: null,
    })),
    cacheable,
    detailCode,
  };
}

function failed(detailCode: string, _source: string, context: Readonly<PassiveProbeContextV1>): ProbeResultV1 {
  return {
    observations: Object.keys(PLUGIN_PATHS).map((capability) => ({
      capability,
      source: 'plugin_readback',
      tier: 'configured',
      result: 'indeterminate',
      observedAt: context.evaluationTimestamp,
      identityDigest: context.identityDigest,
      detailCode,
      diagnostic: null,
    })),
    cacheable: false,
    detailCode,
  };
}
