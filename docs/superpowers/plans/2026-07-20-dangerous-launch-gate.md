# Dangerous Launch Gate (madmax/yolo) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect `--madmax` / `--yolo` on every path that can spawn `agy`, require TTY confirmation (or explicit override), and fix managed-mode silent drop of tokens before `--`.

**Architecture:** Single module `src/cli/dangerous-launch.ts` used by both structured `passThrough` / managed launch and legacy `bin/oma.ts`. Detection is exact argv token match only. Confirmation never runs after spawn.

**Tech Stack:** TypeScript, Jest unit tests, Node `readline` for TTY; no new deps.

**Index:** See `2026-07-20-oma-completeness-MASTER.md` (S1). This plan’s **boundary** (not product exclusion): does not implement Team/Autopilot/sandbox.

---

## File map

| Path | Role |
|------|------|
| `src/cli/dangerous-launch.ts` | **Create** — detect + confirm |
| `src/cli/parser.ts` | **Modify** — reject tokens between mode and `--` |
| `src/cli/services.ts` | **Modify** — gate before passThrough / launchMode |
| `bin/oma.ts` | **Modify** — gate before every legacy spawn of agy |
| `tests/cli/dangerous-launch.spec.ts` | **Create** |
| `tests/cli/parser.spec.ts` | **Modify** |
| `DESIGN.md` / `README.md` | **Modify** — honest gate docs |

---

### Task 1: detectDangerousLaunchFlags pure function

**Files:**
- Create: `src/cli/dangerous-launch.ts`
- Create: `tests/cli/dangerous-launch.spec.ts`

- [ ] **Step 1: Write failing test**

```typescript
import { detectDangerousLaunchFlags, DANGEROUS_LAUNCH_FLAGS } from '../../src/cli/dangerous-launch';

describe('detectDangerousLaunchFlags', () => {
  test('detects madmax and yolo as exact tokens', () => {
    expect(detectDangerousLaunchFlags(['--madmax', 'x'])).toEqual(['--madmax']);
    expect(detectDangerousLaunchFlags(['a', '--yolo'])).toEqual(['--yolo']);
    expect(detectDangerousLaunchFlags(['--madmax', '--yolo'])).toEqual(['--madmax', '--yolo']);
  });

  test('ignores substring and prompt text', () => {
    expect(detectDangerousLaunchFlags(['--not-madmax'])).toEqual([]);
    expect(detectDangerousLaunchFlags(['-p', 'please use --madmax carefully'])).toEqual([]);
  });

  test('DANGEROUS_LAUNCH_FLAGS is frozen list', () => {
    expect([...DANGEROUS_LAUNCH_FLAGS].sort()).toEqual(['--madmax', '--yolo']);
  });
});
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
npx jest --config jest.unit.config.js tests/cli/dangerous-launch.spec.ts --runInBand
```

Expected: Cannot find module.

- [ ] **Step 3: Minimal implementation**

```typescript
/**
 * 設計概念映射：confirmDangerousLaunch 旗標偵測，對齊 oh-my-codex VSCode 高危 launch 確認概念（research_report）。
 * 僅 exact argv token；不掃 prompt 字串。
 */
export const DANGEROUS_LAUNCH_FLAGS = Object.freeze(['--madmax', '--yolo'] as const);
export type DangerousLaunchFlag = (typeof DANGEROUS_LAUNCH_FLAGS)[number];

export function detectDangerousLaunchFlags(argv: readonly string[]): DangerousLaunchFlag[] {
  const found: DangerousLaunchFlag[] = [];
  for (const flag of DANGEROUS_LAUNCH_FLAGS) {
    if (argv.includes(flag)) found.push(flag);
  }
  return found;
}
```

- [ ] **Step 4: Tests PASS**

- [ ] **Step 5: Commit**

```bash
git add src/cli/dangerous-launch.ts tests/cli/dangerous-launch.spec.ts
git commit -m "feat(cli): detect --madmax and --yolo dangerous launch flags"
```

---

### Task 2: confirmDangerousLaunch (TTY / non-TTY)

**Files:**
- Modify: `src/cli/dangerous-launch.ts`
- Modify: `tests/cli/dangerous-launch.spec.ts`

- [ ] **Step 1: Failing tests**

```typescript
import { confirmDangerousLaunch } from '../../src/cli/dangerous-launch';

test('non-TTY without override rejects', async () => {
  const result = await confirmDangerousLaunch(['--madmax'], {
    isTTY: false,
    argv: ['--madmax', 'run'],
  });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.code).toBe('E_VALIDATOR_REJECTED');
});

test('non-TTY with --i-understand-dangerous-launch allows', async () => {
  const result = await confirmDangerousLaunch(['--yolo'], {
    isTTY: false,
    argv: ['--yolo', '--i-understand-dangerous-launch'],
  });
  expect(result.ok).toBe(true);
});

test('TTY yes confirms', async () => {
  const result = await confirmDangerousLaunch(['--madmax'], {
    isTTY: true,
    argv: ['--madmax'],
    ask: async () => 'yes',
  });
  expect(result.ok).toBe(true);
});

test('TTY no rejects', async () => {
  const result = await confirmDangerousLaunch(['--madmax'], {
    isTTY: true,
    argv: ['--madmax'],
    ask: async () => 'no',
  });
  expect(result.ok).toBe(false);
});
```

- [ ] **Step 2: Run — FAIL (function missing)**

- [ ] **Step 3: Implement**

```typescript
import { Result, err, ok } from '../runtime/types';
import { RuntimeError, runtimeError } from '../runtime/errors';
import * as readline from 'readline';

export const DANGEROUS_OVERRIDE_FLAG = '--i-understand-dangerous-launch';

export interface ConfirmDangerousLaunchOptions {
  isTTY: boolean;
  argv: readonly string[];
  ask?: () => Promise<string>;
  stderr?: (line: string) => void;
}

export async function confirmDangerousLaunch(
  flags: readonly DangerousLaunchFlag[],
  options: Readonly<ConfirmDangerousLaunchOptions>,
): Promise<Result<void, RuntimeError>> {
  if (flags.length === 0) return ok(undefined);
  if (options.argv.includes(DANGEROUS_OVERRIDE_FLAG)) return ok(undefined);
  const list = flags.join(', ');
  const stderr = options.stderr ?? ((line) => process.stderr.write(line));
  if (!options.isTTY) {
    return err(runtimeError(
      'E_VALIDATOR_REJECTED',
      `Dangerous flags ${list} require a TTY confirmation or ${DANGEROUS_OVERRIDE_FLAG}`,
    ));
  }
  stderr(`WARNING: dangerous launch flags detected: ${list}\nType 'yes' to continue: `);
  const answer = options.ask
    ? await options.ask()
    : await defaultAsk();
  if (answer.trim().toLowerCase() !== 'yes') {
    return err(runtimeError('E_VALIDATOR_REJECTED', 'Dangerous launch cancelled by operator'));
  }
  return ok(undefined);
}

function defaultAsk(): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise((resolve) => {
    rl.question('', (line) => {
      rl.close();
      resolve(line);
    });
  });
}

/** Strip override flag before forwarding to agy (keep madmax/yolo). */
export function stripDangerousOverride(argv: readonly string[]): string[] {
  return argv.filter((a) => a !== DANGEROUS_OVERRIDE_FLAG);
}
```

- [ ] **Step 4: PASS + commit**

```bash
git commit -m "feat(cli): confirmDangerousLaunch TTY gate with non-TTY fail-closed"
```

---

### Task 3: Fix parser silent-drop before `--`

**Files:**
- Modify: `src/cli/parser.ts`
- Modify: `tests/cli/parser.spec.ts` (create if missing)

- [ ] **Step 1: Failing test**

```typescript
import { parseCliArguments } from '../../src/cli/parser';

test('rejects tokens between mode and --', () => {
  const r = parseCliArguments(['ralph', '--madmax', '--', 'ship']);
  expect(r.kind).toBe('invalid');
  if (r.kind === 'invalid') {
    expect(r.code).toBe('E_DIRECTIVE_INVALID');
    expect(r.message).toMatch(/unknown|between|--/i);
  }
});

test('allows clean managed form', () => {
  expect(parseCliArguments(['ralph', '--', 'ship'])).toEqual({
    kind: 'mode', mode: 'ralph', task: 'ship',
  });
});
```

- [ ] **Step 2: FAIL (currently returns mode silently)**

- [ ] **Step 3: Fix parser**

In `parseCliArguments` managed branch:

```typescript
  if (isManagedMode(first)) {
    const delimiter = argv.indexOf('--', 1);
    if (delimiter >= 0) {
      const between = argv.slice(1, delimiter);
      if (between.length > 0) {
        return {
          kind: 'invalid',
          code: 'E_DIRECTIVE_INVALID',
          message: `${first}: unexpected token(s) before --: ${between.join(' ')}`,
        };
      }
      const task = argv.slice(delimiter + 1).join(' ');
      if (task.trim() === '') {
        return {
          kind: 'invalid',
          code: 'E_DIRECTIVE_INVALID',
          message: `${first} requires a non-empty task after --`,
        };
      }
      return { kind: 'mode', mode: first, task };
    }
    // no -- : not structured managed form; fall through? 
    // Current design: if no --, shouldUseStructuredCli is false and legacy handles magic.
    // parseCliArguments is only called when structured — still return mode from remaining args for safety.
    const task = argv.slice(1).join(' ');
    if (task.trim() === '') {
      return {
        kind: 'invalid',
        code: 'E_DIRECTIVE_INVALID',
        message: `${first} requires a non-empty task after --`,
      };
    }
    return { kind: 'mode', mode: first, task };
  }
```

Note: when structured path requires `--` (see `bin/oma.ts shouldUseStructuredCli`), the no-`--` branch is rare; keep behavior consistent with existing tests.

- [ ] **Step 4: PASS + commit**

```bash
git commit -m "fix(cli): reject unknown tokens between managed mode and --"
```

---

### Task 4: Wire gate on all spawn paths

**Files:**
- Modify: `src/cli/services.ts`
- Modify: `bin/oma.ts`
- Modify: `tests/cli/*` as needed

- [ ] **Step 1: Helper used before spawn**

```typescript
// src/cli/dangerous-launch.ts
export async function guardDangerousArgv(
  argv: readonly string[],
  options: { isTTY?: boolean; ask?: () => Promise<string>; stderr?: (s: string) => void },
): Promise<Result<readonly string[], RuntimeError>> {
  const flags = detectDangerousLaunchFlags(argv);
  const confirmed = await confirmDangerousLaunch(flags, {
    isTTY: options.isTTY ?? Boolean(process.stdin.isTTY),
    argv,
    ask: options.ask,
    stderr: options.stderr,
  });
  if (!confirmed.ok) return confirmed;
  return ok(stripDangerousOverride(argv));
}
```

- [ ] **Step 2: In `createDefaultServices` passThrough and launchMode**

Before runner call:

```typescript
const guarded = await guardDangerousArgv(argv, { stderr });
if (!guarded.ok) {
  stderr(`${guarded.error.code}: ${guarded.error.message}\n`);
  return /* Result error for passThrough; or map to ProcessOutcome fail */;
}
// use guarded.value as argv
```

For `launchMode`, scan task string? **No** — only argv tokens. Managed mode has no madmax on argv after parser fix; still scan final agy argv from `buildModeCommand` if it ever injects flags.

- [ ] **Step 3: In `bin/oma.ts`** before every `spawn`/`runner` that launches agy in legacy path, call `guardDangerousArgv(args)`.

- [ ] **Step 4: Unit tests with mocked ask / isTTY** prove no spawn when rejected (inject spy on ProcessRunner).

- [ ] **Step 5: Docs**

DESIGN.md: move confirmDangerousLaunch from pure blueprint to “implemented: TTY yes / non-TTY override”.  
README: document flags + `--i-understand-dangerous-launch`.

- [ ] **Step 6: Full unit green + commit**

```bash
npm run build && npm run test:unit
git commit -m "feat(cli): wire dangerous launch gate on structured and legacy agy spawns"
```

---

## Exit criteria

- [ ] Three paths gated: structured passThrough, managed launch (final argv), legacy bin
- [ ] Silent-drop fixed
- [ ] Non-TTY fail-closed without override
- [ ] `madmax`/`yolo` still forwarded to agy **after** confirm
- [ ] DESIGN/README honest
