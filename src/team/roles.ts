/**
 * 設計概念映射：OMG `omg_cli/team/roles.py` — posture 由 role 推導、永不作為輸入；
 * 未知角色 fail-closed；orchestrator 不得作為 child。
 * OMC `agents/*.md` 的 `disallowedTools: Write, Edit` 對應 capabilityFloor `read-only`。
 * OMX architect/critic/verifier 唯讀工具集同此下限。
 */

export type OmaCapabilityModeV1 = 'read-only' | 'read-write';

export interface OmaRolePolicyV1 {
  capabilityFloor: OmaCapabilityModeV1;
  writeScopeAllowed: boolean;
  childAllowed: boolean;
}

const READ_ONLY_CHILD: OmaRolePolicyV1 = Object.freeze({
  capabilityFloor: 'read-only',
  writeScopeAllowed: false,
  childAllowed: true,
});

const READ_WRITE_CHILD: OmaRolePolicyV1 = Object.freeze({
  capabilityFloor: 'read-write',
  writeScopeAllowed: true,
  childAllowed: true,
});

const ORCHESTRATOR: OmaRolePolicyV1 = Object.freeze({
  capabilityFloor: 'read-write',
  writeScopeAllowed: true,
  childAllowed: false,
});

/**
 * 凍結的 OMA v1 角色表。capability_mode 只能等於或嚴於 floor，不能上修。
 * 含既有 production-safety-review fixture 的 native_role，避免合法定義被未知角色拒。
 */
export const OMA_ROLES_V1 = Object.freeze({
  reviewer: READ_ONLY_CHILD,
  'code-reviewer': READ_ONLY_CHILD,
  critic: READ_ONLY_CHILD,
  verifier: READ_ONLY_CHILD,
  'security-reviewer': READ_ONLY_CHILD,
  analyst: READ_ONLY_CHILD,
  architect: READ_ONLY_CHILD,
  planner: READ_ONLY_CHILD,
  skeptic: READ_ONLY_CHILD,
  'deployment-reviewer': READ_ONLY_CHILD,
  'operations-reviewer': READ_ONLY_CHILD,
  'docs-reviewer': READ_ONLY_CHILD,
  'release-decider': READ_ONLY_CHILD,
  executor: READ_WRITE_CHILD,
  debugger: READ_WRITE_CHILD,
  designer: READ_WRITE_CHILD,
  writer: READ_WRITE_CHILD,
  'test-engineer': READ_WRITE_CHILD,
  'qa-tester': READ_WRITE_CHILD,
  orchestrator: ORCHESTRATOR,
});

export type OmaRoleV1 = keyof typeof OMA_ROLES_V1;

export const OMA_ROLE_NAMES_V1: readonly OmaRoleV1[] = Object.freeze(
  (Object.keys(OMA_ROLES_V1) as OmaRoleV1[]).sort((left, right) => left.localeCompare(right, 'en')),
);

export type OmaRolePostureCodeV1 =
  | 'unknown-role'
  | 'child-forbidden'
  | 'capability-floor'
  | 'write-scope';

export interface OmaRolePostureInputV1 {
  role: unknown;
  capabilityMode: OmaCapabilityModeV1;
  writeScopeNone: boolean;
  asChild: boolean;
}

export type OmaRolePostureResultV1 =
  | { ok: true; role: OmaRoleV1; policy: OmaRolePolicyV1 }
  | {
    ok: false;
    code: OmaRolePostureCodeV1;
    message: string;
    details: Readonly<Record<string, unknown>>;
  };

export function isOmaRole(value: unknown): value is OmaRoleV1 {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(OMA_ROLES_V1, value);
}

export function unknownOmaRoleMessage(role: unknown): string {
  return `unknown team role ${JSON.stringify(role)}; expected one of: ${OMA_ROLE_NAMES_V1.join(', ')}`;
}

export function omaRolePolicy(role: OmaRoleV1): OmaRolePolicyV1 {
  return OMA_ROLES_V1[role];
}

/**
 * 單一姿勢評估：workflow stage、team task、worker envelope 共用。
 * asChild=true 時 orchestrator 一律拒絕（對應 OMG `native_subagent_type`）。
 */
export function inspectOmaRolePosture(input: OmaRolePostureInputV1): OmaRolePostureResultV1 {
  if (!isOmaRole(input.role)) {
    return {
      ok: false,
      code: 'unknown-role',
      message: unknownOmaRoleMessage(input.role),
      details: { role: input.role, legal_roles: OMA_ROLE_NAMES_V1 },
    };
  }
  const policy = OMA_ROLES_V1[input.role];
  if (input.asChild && !policy.childAllowed) {
    return {
      ok: false,
      code: 'child-forbidden',
      message: `role ${input.role} is leader-only and cannot be assigned to a child task or workflow stage; use a worker role such as executor`,
      details: { role: input.role, childAllowed: false },
    };
  }
  if (policy.capabilityFloor === 'read-only' && input.capabilityMode === 'read-write') {
    return {
      ok: false,
      code: 'capability-floor',
      message: `native_role ${input.role} capability_mode 'read-write' violates the read-only role floor; set capability_mode to 'read-only' and write_paths/write_scope to none/[]`,
      details: {
        role: input.role,
        capability_mode: input.capabilityMode,
        capabilityFloor: policy.capabilityFloor,
      },
    };
  }
  if (!policy.writeScopeAllowed && !input.writeScopeNone) {
    return {
      ok: false,
      code: 'write-scope',
      message: `role ${input.role} requires write_scope none / empty write_paths; a writable scope violates the role floor`,
      details: { role: input.role, writeScopeAllowed: false },
    };
  }
  return { ok: true, role: input.role, policy };
}
