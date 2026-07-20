# OMA Autopilot OMX Five-Phase FSM — Full Session Parity

> **For Codex / Grok / Claude:** Use subagent-driven-development to implement task-by-task.

**Goal:** Fully align OMA Autopilot with OMX’s five-phase loop so an Antigravity session can run `deep-interview → ralplan → ultragoal → code-review → ultraqa` with durable state, CLI gates, skill injection, and in-session discovery.

**Architecture:** Keep SessionAggregate as sole durable authority. Rename/alias active phases to OMX names while accepting legacy gate evidence kinds. Add handoff artifact ledger + phase-advance CLI. Inject phase-specific skill protocol on `drive`. Ship session skill discovery (`oma skill list|show`) and plugin skill surface.

**Tech Stack:** TypeScript (strict), Jest, existing AutopilotRuntime / SessionAggregate / GateValidator, plugin `skills/*`.

**OMX contract (source of truth):**
```text
deep-interview → ralplan → ultragoal (+ team optional) → code-review → ultraqa → complete
```
Non-clean review/QA → return to `ralplan` with `return_to_ralplan_reason`. Production causal-trace gate remains OMA-specific terminal before `completed`.

**Legacy mapping (compat):**
| Legacy (current) | OMX canonical |
|------------------|---------------|
| requirements | deep-interview |
| planning | ralplan |
| executing | ultragoal |
| review | code-review |
| qa | ultraqa |

---

### Task 1: Phase model + aliases + GateKind dual names

**Files:**
- Modify: `src/continuation/session-aggregate.ts`
- Modify: `src/verification/evidence.ts`
- Modify: `src/autopilot/runtime.ts` (PHASE_ORDER, nextPhaseAfter, gateKindFor, isActivePhase)
- Create: `src/autopilot/phases.ts` (canonical names, alias normalize/map)
- Test: `tests/autopilot/phases.spec.ts`, update `tests/autopilot/runtime.spec.ts`

**Step 1:** Add `src/autopilot/phases.ts` with:
- `OMX_ACTIVE_PHASES = ['deep-interview','ralplan','ultragoal','code-review','ultraqa']`
- `normalizeAutopilotPhase(input): AutopilotPhase` (legacy → omx)
- `legacyGateKindAlias` / `canonicalGateKind`
- `PHASE_CYCLE` for state JSON

**Step 2:** Change `AutopilotActivePhase` / default start phase to OMX names; keep reading old aggregates by normalizing on load in store read path OR normalize only at runtime edges (prefer runtime edges + createInitial uses `deep-interview`).

**Step 3:** GateKind accepts both legacy and omx strings; validator normalizes to omx before compare.

**Step 4:** Tests: full start→…→production→completed with OMX names; legacy evidence kinds still accepted.

**Step 5:** Commit `feat(autopilot): OMX phase names with legacy gate aliases`

---

### Task 2: Handoff artifacts + return_to_ralplan + state view

**Files:**
- Modify: `src/continuation/session-aggregate.ts` (`AutopilotAggregateV1` extend)
- Modify: `src/autopilot/runtime.ts` (status/doctor enrich)
- Create: `src/autopilot/handoff.ts`
- Test: `tests/autopilot/handoff.spec.ts`

**Fields to add under `autopilot` (or nested `pipeline`):**
```ts
{
  phaseCycle: string[];
  iteration: number;
  reviewCycle: number;
  handoffArtifacts: {
    contextSnapshotPath: string | null;
    deepInterview: string | null;
    ralplan: string | null;
    ralplanConsensusGate: {
      complete: boolean;
      architectReview: { verdict: string; at: string } | null;
      criticReview: { verdict: string; at: string } | null;
    };
    ultragoal: string | null;
    codeReview: string | null;
    ultraqa: string | null;
  };
  reviewVerdict: { clean: boolean; recommendation: string; at: string } | null;
  qaVerdict: { clean: boolean; skipped: boolean; reason: string | null; at: string } | null;
  returnToRalplanReason: string | null;
}
```

**Step 1:** Extend aggregate + createInitial defaults.  
**Step 2:** `status`/`doctor` expose full pipeline view.  
**Step 3:** When review/qa gate fails validation path sets return reason (accept fail stays fail); add `autopilot fail-gate` optional later — for clean fail path use explicit `advance` with reject.  
**Step 4:** Commit.

---

### Task 3: CLI — advance, handoff, phase skill inject on drive

**Files:**
- Modify: `src/autopilot/commands.ts`
- Modify: `src/autopilot/runtime.ts`
- Modify: `src/cli/application.ts` (help)
- Modify: `src/cli/services.ts` (drive inject phase skill)
- Test: `tests/autopilot/commands.spec.ts`, `tests/autopilot/runtime.spec.ts`

**New commands:**
```bash
oma autopilot advance --session <id> --expected-revision <n> --evidence <file>
  # alias of checkpoint with omx-aware messaging

oma autopilot handoff --session <id> --expected-revision <n> \
  --key deepInterview|ralplan|ultragoal|codeReview|ultraqa \
  --path <artifact>

oma autopilot consensus --session <id> --expected-revision <n> \
  --role architect|critic --verdict approve|revise --note <text>

oma autopilot return-ralplan --session <id> --expected-revision <n> --reason <text>
```

**Drive:** when launching managed agy for autopilot, inject skill for **current phase** (`deep-interview` skill when phase is deep-interview, etc.) via existing `appendSkillProtocol` generalized to any skill name.

**Step 1–5:** TDD commands → runtime → help → tests → commit.

---

### Task 4: Session discovery — `oma skill list|show` + skill protocol for all workflow skills

**Files:**
- Create: `src/cli/skill-commands.ts`
- Modify: `src/cli/parser.ts`, `application.ts`, `services.ts`
- Modify: `src/modes/skill-protocol.ts` (generic skill name inject)
- Modify: `skills/*` (ultragoal, code-review, ultraqa)
- Test: `tests/cli/skill-commands.spec.ts`, skill-surface

**Commands:**
```bash
oma skill list
oma skill show autopilot|deep-interview|ralplan|ultragoal|…
```

JSON stdout for agents.

**Skills to add/rename align:**
- `skills/ultragoal/SKILL.md` (implement phase; may alias ralph for persistence)
- `skills/code-review/SKILL.md`
- `skills/ultraqa/SKILL.md`
- Update `autopilot` skill to OMX five-phase with CLI examples for advance/handoff/consensus

---

### Task 5: Workspace artifact helpers + context snapshot

**Files:**
- Create: `src/autopilot/workspace-artifacts.ts`
- Modify: start() to write `.agy/context/<slug>-<ts>.md` seed + record path
- Test: unit for slug + write

---

### Task 6: Docs + e2e smoke path

**Files:**
- Modify: `skills/autopilot/SKILL.md`, `skills/oma-runtime/SKILL.md`, `README.md`, `DESIGN.md`
- Modify: `e2e/structured-cli.spec.ts` (help lists skill; autopilot start phase deep-interview)
- Optional: `scripts/smoke-autopilot-fsm.ts`

---

### Task 7: Full verification

```bash
npm run build
npm run test:unit
npx jest e2e/structured-cli.spec.ts --runInBand
```

---

## Session user playbook (target UX)

```bash
oma setup && oma doctor --no-strict-plugin
oma skill list
oma skill show autopilot

oma autopilot start -- "Ship feature X"
# phase=deep-interview
oma autopilot drive --session $SID --conversation $CID --expected-revision 0
# agent follows deep-interview skill in session; writes .agy/specs/...

oma autopilot handoff --session $SID --expected-revision N --key deepInterview --path .agy/specs/foo.md
oma autopilot advance --session $SID --expected-revision N --evidence evidence/deep-interview.json
# → ralplan

# … consensus architect+critic …
oma autopilot consensus --session $SID --expected-revision N --role architect --verdict approve --note ok
oma autopilot consensus --session $SID --expected-revision N --role critic --verdict approve --note ok
oma autopilot advance …  # → ultragoal
# implement + verify
oma autopilot review …   # → ultraqa
oma autopilot qa …
# production evidence for completed
oma autopilot advance … --evidence production.json
```

## Out of scope
- Real multi-model architect/critic subagents (session self-dual-pass is enough)
- npmjs publish
- Changing Stop hook oracle semantics
