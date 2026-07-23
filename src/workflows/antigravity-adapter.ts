import { RepositoryWorkflowV1, validateRepositoryWorkflow } from '../contracts/repository-workflow';

export const ANTIGRAVITY_WORKFLOW_SURFACES_V1 = Object.freeze([
  {
    surface: 'saved_workflow_prompt',
    classification: 'faithful',
    maximum_claimed_tier: 'T1',
    observed: true,
    implementation: 'generated_cli_delegate',
  },
  {
    surface: 'native_workflow_runtime',
    classification: 'optional_unclaimed',
    maximum_claimed_tier: 'T0',
    observed: false,
    implementation: null,
  },
  {
    surface: 'native_team',
    classification: 'optional_unclaimed',
    maximum_claimed_tier: 'T0',
    observed: false,
    implementation: null,
  },
  {
    surface: 'native_agents_and_commands',
    classification: 'optional_unclaimed',
    maximum_claimed_tier: 'T0',
    observed: false,
    implementation: null,
  },
  {
    surface: 'semantic_lsp',
    classification: 'optional_unclaimed',
    maximum_claimed_tier: 'T0',
    observed: false,
    implementation: null,
  },
  {
    surface: 'private_memory_sidecar',
    classification: 'optional_unclaimed',
    maximum_claimed_tier: 'T0',
    observed: false,
    implementation: null,
  },
] as const);

/**
 * Antigravity saved workflows are only T1 prompts.  They never embed the DAG,
 * permissions, fan-out, verifier, or ship decision; the authoritative CLI
 * runner owns all of those semantics.
 */
export function renderAntigravitySavedWorkflow(definition: RepositoryWorkflowV1): string {
  const workflow = validateRepositoryWorkflow(definition);
  return [
    '---',
    `description: "Run the ${workflow.name} repository workflow through OMA"`,
    '---',
    '<!-- Generated OMA T1 saved-prompt projection; do not add orchestration logic here. -->',
    '',
    `Delegate to the authoritative repository-workflow/v1 runner:`,
    '',
    `\`oma workflow run ${workflow.name} --input "$ARGUMENTS"\``,
    '',
    'Return the CLI terminal and evidence. Do not spawn agents or decide ship/no-ship in this prompt.',
    '',
  ].join('\n');
}

export function assertAntigravitySavedWorkflowIsThin(markdown: string, workflowName: string): void {
  const lines = markdown.trimEnd().split('\n');
  if (lines.length > 14
    || !markdown.includes(`oma workflow run ${workflowName}`)
    || /spawn_subagent|native[_ -]team|capability_mode\s*[:=]/i.test(markdown)) {
    throw new Error('E_WORKFLOW_NATIVE_UNSUPPORTED: saved workflow exceeded the T1 CLI-delegation ceiling');
  }
}
