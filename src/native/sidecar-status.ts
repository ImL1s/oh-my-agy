export interface PrivateSidecarStatusV1 {
  store_kind: 'oma_private_sidecar_status';
  schema_version: 1;
  repository_id: 'OMA';
  status: 'forbidden_unprobed';
  enabled: false;
  attempted: false;
  evidence_tier: 'T0';
  detail_code: 'PRIVATE_SIDECAR_FORBIDDEN';
}

/**
 * OMA never probes private Antigravity sidecars. The returned T0 record makes
 * that negative capability explicit without opening sockets or inspecting IDE
 * process state.
 */
export function inspectPrivateSidecarStatus(): PrivateSidecarStatusV1 {
  return {
    store_kind: 'oma_private_sidecar_status',
    schema_version: 1,
    repository_id: 'OMA',
    status: 'forbidden_unprobed',
    enabled: false,
    attempted: false,
    evidence_tier: 'T0',
    detail_code: 'PRIVATE_SIDECAR_FORBIDDEN',
  };
}
