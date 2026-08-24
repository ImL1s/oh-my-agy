import * as fs from 'fs';
import * as path from 'path';
import { SessionLocator } from '../../src/continuation/state';
import {
  buildManagedSkillInjectSteps,
  handlePreInvocation,
  MANAGED_SKILL_INJECT_MAX_CHARS_V1,
  MANAGED_SKILL_INJECT_TRUNCATION_MARKER_V1,
} from '../../src/hooks/pre-invocation';
import { currentProcessIdentity } from '../../src/runtime/process';
import { resolveWorkspaceIdentity } from '../../src/runtime/state-root';
import { createStateFixture } from '../helpers/state-fixture';

jest.mock('../../src/modes/skill-catalog', () => {
  const actual = jest.requireActual('../../src/modes/skill-catalog') as typeof import('../../src/modes/skill-catalog');
  return {
    ...actual,
    listPublicCatalogSkillNames: jest.fn(() => actual.listPublicCatalogSkillNames()),
  };
});

import {
  isInternalCatalogSkill,
  listCatalogSkillNames,
  listPublicCatalogSkillNames,
} from '../../src/modes/skill-catalog';

const actualCatalog = jest.requireActual(
  '../../src/modes/skill-catalog',
) as typeof import('../../src/modes/skill-catalog');

const mockedListPublic = listPublicCatalogSkillNames as jest.MockedFunction<
  typeof listPublicCatalogSkillNames
>;

const LEGACY_PIPE = 'ralph|ultrawork|search|autopilot|team|cancel|verify';
const LEGACY_SLASH = 'ralph/ultrawork/search/autopilot/team';

function restoreCatalogMock(): void {
  mockedListPublic.mockReset();
  mockedListPublic.mockImplementation(() => actualCatalog.listPublicCatalogSkillNames());
}

function textOf(steps: ReadonlyArray<Record<string, unknown>> | undefined): string {
  expect(Array.isArray(steps)).toBe(true);
  expect(steps).toHaveLength(1);
  const step = steps?.[0];
  expect(step?.type).toBe('text');
  expect(typeof step?.text).toBe('string');
  return String(step?.text);
}

function skillsFromHint(text: string, separator: '|' | '/'): string[] {
  const match = separator === '|'
    ? /skills\/ \(([^)]*)\)/.exec(text)
    : /managed skill protocols \(([^)]*)\)/.exec(text);
  expect(match).not.toBeNull();
  const inner = match?.[1] ?? '';
  return inner === '' ? [] : inner.split(separator);
}

async function withManagedPreInvocation(
  extraEnv: NodeJS.ProcessEnv,
  assert: (result: Awaited<ReturnType<typeof handlePreInvocation>>) => void | Promise<void>,
): Promise<void> {
  const fixture = createStateFixture('oma-skill-inject-');
  fs.chmodSync(fixture.root, 0o700);
  const previousCwd = process.cwd();
  try {
    const fakeHooksCwd = path.join(fixture.root, 'fake-hooks-cwd');
    fs.mkdirSync(fakeHooksCwd, { recursive: true });
    process.chdir(fakeHooksCwd);

    const workspace = resolveWorkspaceIdentity(fixture.root);
    expect(workspace.ok).toBe(true);
    if (!workspace.ok) return;

    const locator = new SessionLocator(fixture.root, workspace.value.workspaceKey, {
      processLiveness: () => 'alive',
      childSpawnWaitMs: 50,
      childSpawnPollMs: 5,
    });
    const created = await locator.createManagedLaunch({
      sessionId: 's-skill-inject',
      repoKey: workspace.value.repoKey,
      workspaceKey: workspace.value.workspaceKey,
      workspacePath: fixture.root,
      launchNonce: 'nonce-skill-inject',
      owner: currentProcessIdentity('owner'),
      ttlMs: 60_000,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.transaction.recordChildSpawned({
      pid: process.pid + 1,
      parentPid: process.pid,
      startMarker: 'child-fixture',
      ownerNonce: 'owner',
    }).ok).toBe(true);

    const env: NodeJS.ProcessEnv = {
      ...created.value.transaction.env,
      OMA_STATE_ROOT: fixture.root,
      OMA_WORKSPACE_PATH: fixture.root,
      OMA_PACKAGE_ROOT: fixture.root,
      OMA_MANAGED_MODE: 'ralph',
      ...extraEnv,
    };
    const result = await handlePreInvocation({
      conversationId: 'conv-skill-inject',
      workspacePaths: [fixture.root],
    }, env);
    await assert(result);
  } finally {
    process.chdir(previousCwd);
    fixture.cleanup();
  }
}

describe('PreInvocation catalog-derived skill inject (#52)', () => {
  // 設計概念映射：OMC scripts/skill-injector.mjs（UserPromptSubmit 遞迴發現 skill）
  beforeEach(() => {
    restoreCatalogMock();
  });

  afterEach(() => {
    restoreCatalogMock();
  });

  describe('buildManagedSkillInjectSteps', () => {
    test('lists every public catalog skill in catalog order and omits internals', () => {
      const text = textOf(buildManagedSkillInjectSteps({
        OMA_PACKAGE_ROOT: '/pkg/oh-my-agy',
        OMA_MANAGED_MODE: 'ultrawork',
      }, 'sess-public'));
      const listed = skillsFromHint(text, '|');
      const publicNames = actualCatalog.listPublicCatalogSkillNames();

      expect(listed).toEqual(publicNames);
      expect(listed.length).toBeGreaterThan(7);
      expect(listed).toEqual(expect.arrayContaining([
        'deep-interview', 'ralplan', 'ultragoal', 'code-review', 'ultraqa',
        'setup', 'workflow', 'ask', 'oma-runtime',
      ]));
      expect(text).not.toContain('discovery-proof');
      for (const name of listCatalogSkillNames().filter((entry) => isInternalCatalogSkill(entry))) {
        expect(listed).not.toContain(name);
      }
    });

    test('keeps sessionId / mode_hint / OMA_MANAGED_MODE / CLI-alone lines', () => {
      const text = textOf(buildManagedSkillInjectSteps({
        OMA_PACKAGE_ROOT: '/pkg/oh-my-agy',
        OMA_MANAGED_MODE: 'search',
      }, 'sess-lines'));
      const lines = text.split('\n');
      expect(lines[0]).toBe('[OMA SESSION SKILL]');
      expect(lines).toContain('sessionId=sess-lines');
      expect(lines).toContain('mode_hint=search');
      expect(lines).toContain('OMA_MANAGED_MODE=search');
      expect(text).toContain('CLI alone is not completion. Execute the skill checklist with fresh evidence.');
      expect(text).not.toContain(MANAGED_SKILL_INJECT_TRUNCATION_MARKER_V1);
      expect(text.length).toBeLessThanOrEqual(MANAGED_SKILL_INJECT_MAX_CHARS_V1);
    });

    test('defaults OMA_MANAGED_MODE / mode_hint to managed when unset', () => {
      const text = textOf(buildManagedSkillInjectSteps({
        OMA_PACKAGE_ROOT: '/pkg',
      }, 'sess-default-mode'));
      expect(text).toContain('mode_hint=managed');
      expect(text).toContain('OMA_MANAGED_MODE=managed');
    });

    test('without package root still lists every public skill', () => {
      const text = textOf(buildManagedSkillInjectSteps({
        OMA_MANAGED_MODE: 'ralph',
      }, 'sess-no-root'));
      expect(skillsFromHint(text, '/')).toEqual(actualCatalog.listPublicCatalogSkillNames());
      expect(text).toContain('sessionId=sess-no-root');
      expect(text).toContain('OMA_MANAGED_MODE=ralph');
      expect(text).not.toContain('discovery-proof');
    });

    test('never lists discovery-proof even if the public lister leaks internals', () => {
      mockedListPublic.mockImplementation(() => (
        ['ralph', 'discovery-proof', 'team'] as ReturnType<typeof listPublicCatalogSkillNames>
      ));
      const text = textOf(buildManagedSkillInjectSteps({
        OMA_PACKAGE_ROOT: '/pkg',
      }, 'sess-leak'));
      const listed = skillsFromHint(text, '|');
      expect(listed).toEqual(['ralph', 'team']);
      expect(text).not.toContain('discovery-proof');
    });

    test('caps inject text and appends a stable truncation marker when over budget', () => {
      const text = textOf(buildManagedSkillInjectSteps({
        OMA_PACKAGE_ROOT: `/pkg/${'a'.repeat(8_000)}`,
        OMA_MANAGED_MODE: 'ralph',
      }, 'sess-trunc'));
      expect(text.length).toBeLessThanOrEqual(MANAGED_SKILL_INJECT_MAX_CHARS_V1);
      expect(text.length).toBe(MANAGED_SKILL_INJECT_MAX_CHARS_V1);
      expect(text.endsWith(MANAGED_SKILL_INJECT_TRUNCATION_MARKER_V1)).toBe(true);
      expect(text).toContain('sessionId=sess-trunc');
      expect(text).toContain('mode_hint=ralph');
      expect(text).toContain('OMA_MANAGED_MODE=ralph');
    });

    test('catalog throw falls back to the legacy static skill hint', () => {
      mockedListPublic.mockImplementation(() => {
        throw new Error('catalog unavailable');
      });
      const withRoot = textOf(buildManagedSkillInjectSteps({
        OMA_PACKAGE_ROOT: '/pkg/oh-my-agy',
        OMA_MANAGED_MODE: 'ralph',
      }, 'sess-fallback'));
      expect(withRoot).toContain(`(${LEGACY_PIPE})`);
      expect(withRoot).toContain('sessionId=sess-fallback');
      expect(withRoot).toContain('mode_hint=ralph');
      expect(withRoot).toContain('OMA_MANAGED_MODE=ralph');
      expect(withRoot).toContain('CLI alone is not completion. Execute the skill checklist with fresh evidence.');
      expect(withRoot).not.toContain('deep-interview');
      expect(withRoot).not.toContain('ultraqa');

      const withoutRoot = textOf(buildManagedSkillInjectSteps({
        OMA_MANAGED_MODE: 'ralph',
      }, 'sess-fallback-noroot'));
      expect(withoutRoot).toContain(`(${LEGACY_SLASH})`);
      expect(withoutRoot).toContain('sessionId=sess-fallback-noroot');
    });
  });

  describe('handlePreInvocation wiring', () => {
    test('unmanaged session still returns empty injectSteps and allow', async () => {
      const result = await handlePreInvocation({
        conversationId: 'ordinary-conversation',
        workspacePaths: ['/tmp/does-not-matter'],
      }, {});
      expect(result).toEqual({ injectSteps: [], decision: 'allow', ok: false });
    });

    test('managed exact_env injects catalog-derived public skills', async () => {
      await withManagedPreInvocation({}, (result) => {
        expect(result.decision).toBe('allow');
        expect(result.ok).toBe(true);
        expect(result.bindingRoute).toBe('exact_env');
        expect(result.sessionId).toBe('s-skill-inject');
        const text = textOf(result.injectSteps);
        expect(skillsFromHint(text, '|')).toEqual(actualCatalog.listPublicCatalogSkillNames());
        expect(text).toContain('sessionId=s-skill-inject');
        expect(text).toContain('mode_hint=ralph');
        expect(text).toContain('OMA_MANAGED_MODE=ralph');
        expect(text).toContain('CLI alone is not completion. Execute the skill checklist with fresh evidence.');
        expect(text).not.toContain('discovery-proof');
      });
    });

    test('catalog module throw still returns decision allow with the static fallback', async () => {
      mockedListPublic.mockImplementation(() => {
        throw new Error('catalog module exploded');
      });
      await withManagedPreInvocation({ OMA_MANAGED_MODE: 'ultrawork' }, (result) => {
        expect(result.decision).toBe('allow');
        expect(result.ok).toBe(true);
        expect(result.bindingRoute).toBe('exact_env');
        const text = textOf(result.injectSteps);
        expect(text).toContain(`(${LEGACY_PIPE})`);
        expect(text).toContain('sessionId=s-skill-inject');
        expect(text).toContain('mode_hint=ultrawork');
        expect(text).toContain('OMA_MANAGED_MODE=ultrawork');
        expect(text).toContain('CLI alone is not completion');
        expect(text).not.toContain('deep-interview');
      });
    });
  });
});
