# Public Examples and Workbench UX Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the three public examples into realistic agent-plugin products and make the desktop Workbench explain, preselect, and exercise their useful states.

**Architecture:** Keep three private pnpm example workspaces and public Agent Bundle APIs. Enrich their authored content, then add small presentation/defaulting helpers at existing Workbench boundaries; use strict artifact inspection for MCP server choices rather than introducing a new protocol. Extend the existing real-Chrome example suite for end-to-end proof.

**Tech Stack:** TypeScript, React 19, pnpm 11.23.0, Rslib, Rsbuild, Rstest, Playwright/Chrome, MCP SDK 2.0.0.

**Spec:** `docs/superpowers/plans/2026-08-25-public-examples-workbench-ux-design.md`

## Global Constraints

- The Workbench is desktop-only; browser acceptance uses 1440×900.
- Keep exactly `skills-starter`, `hooks-and-scripts`, and `mcp-app` under `examples/`.
- Examples use public `agent-bundle` exports and `workspace:*` dependencies only.
- Preserve inferred project roots for `pnpm dev`, `pnpm build`, and `pnpm validate`.
- Keep one greenfield contract; add no aliases, migrations, or compatibility branches.
- Keep pkg.pr.new scoped to `packages/agent-bundle`; examples remain private.
- Capture no Workbench page while any loading state is visible.

---

### Task 1: Make Skills Starter a real release-readiness product

**Files:**
- Modify: `examples/skills-starter/agent-bundle.config.ts`
- Modify: `examples/skills-starter/skills/release-review/SKILL.md`
- Modify: `examples/skills-starter/skills/release-review/references/checklist.md`
- Create: `examples/skills-starter/skills/release-review/references/release-policy.md`
- Modify: `examples/skills-starter/skills/release-review/assets/report-template.md`
- Create: `examples/skills-starter/evals/release-readiness.eval.ts`
- Create: `examples/skills-starter/evals/fixtures/release/result.json`
- Create: `examples/skills-starter/evals/graders/release-result.ts`
- Modify: `examples/skills-starter/README.md`
- Test: `packages/agent-bundle/tests/examples-contract.test.ts`

**Interfaces:**
- Consumes: `defineConfig`, `defineEvalSuite`, and `expectOutcome` from public package exports.
- Produces: Skill `release-review`, suite `release-readiness`, and case `release-artifact-is-ready` with explicit Skill invocation.

- [ ] **Step 1: Write the failing public-example contract**

Add assertions that the built Skill contains `## When to use`, the policy and
report resources are emitted, and `runEvals({ caseIds:
['release-artifact-is-ready'] })` returns one deterministic pass. The expected
suite invocation is `{ mode: 'explicit', skill: 'release-review' }` so the
Skills page classifies it as indirect authored coverage.

- [ ] **Step 2: Run the contract and verify RED**

Run: `pnpm exec rstest packages/agent-bundle/tests/examples-contract.test.ts -t "Skills Starter"`

Expected: FAIL because the richer resource, suite, and case do not exist.

- [ ] **Step 3: Author the Skill and deterministic suite**

Use this suite boundary:

```ts
import { defineEvalSuite, expectOutcome } from 'agent-bundle/eval';

export default defineEvalSuite({
  cases: [{
    assertions: [expectOutcome({ script: './graders/release-result.ts' })],
    fixture: './fixtures/release',
    hosts: { portable: { model: 'deterministic' } },
    id: 'release-artifact-is-ready',
    invocation: { mode: 'explicit', skill: 'release-review' },
    prompt: 'Review the release evidence and issue a readiness verdict.',
    trials: 1,
  }],
  name: 'release-readiness',
});
```

The grader reads only `result.json` and passes only when `verdict === 'ready'`
and `blockers` is an empty array. The Skill links every authored resource and
defines evidence, severity, workflow, and final report requirements.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec rstest packages/agent-bundle/tests/examples-contract.test.ts`

Expected: all example contract tests pass.

- [ ] **Step 5: Verify the package-local workflow**

Run: `pnpm --filter @agent-bundle-example/skills-starter check`

Expected: validation and build pass with no diagnostics.

- [ ] **Step 6: Commit**

```bash
git add examples/skills-starter packages/agent-bundle/tests/examples-contract.test.ts
git commit -m "feat(examples): teach release readiness skills"
```

### Task 2: Replace synthetic Hooks scripts with release automation

**Files:**
- Modify: `examples/hooks-and-scripts/agent-bundle.config.ts`
- Modify: `examples/hooks-and-scripts/src/hooks/session-start.ts`
- Delete: `examples/hooks-and-scripts/src/scripts/succeed.ts`
- Delete: `examples/hooks-and-scripts/src/scripts/fail.ts`
- Create: `examples/hooks-and-scripts/src/scripts/verify-release.ts`
- Create: `examples/hooks-and-scripts/src/scripts/detect-risk.ts`
- Create: `examples/hooks-and-scripts/release/release-manifest.json`
- Create: `examples/hooks-and-scripts/release/risk-register.json`
- Modify: `examples/hooks-and-scripts/README.md`
- Test: `packages/agent-bundle/tests/examples-contract.test.ts`

**Interfaces:**
- Consumes: existing string and `{ entry, targets }` script declarations.
- Produces: `script:verify-release`, `script:detect-risk`, and a session-start result that points developers at both checks.

- [ ] **Step 1: Write the failing Hook/script contract**

Replace the synthetic script expectations with:

```ts
expect(result.additionalContext).toContain('release preparation');
expect(verify.stdout).toContain('Release 2.4.0 is ready for packaging.');
expect(blocker.stderr).toContain('REL-204');
expect(blocker.code).toBe(2);
```

Also assert the artifact catalog exposes `verify-release` and `detect-risk`.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec rstest packages/agent-bundle/tests/examples-contract.test.ts -t "Hooks example"`

Expected: FAIL because the release files and script IDs are absent.

- [ ] **Step 3: Implement deterministic release checks**

`verify-release.ts` reads `release/release-manifest.json`, validates version,
changelog, and three required artifacts, and prints a concise successful
summary. `detect-risk.ts` reads `release/risk-register.json`, prints each open
high-severity risk with its identifier, and sets exit code 2 when any exists.
Both resolve paths from `process.cwd()` so emitted scripts behave as ordinary
project commands.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec rstest packages/agent-bundle/tests/examples-contract.test.ts`

Expected: all contracts pass.

- [ ] **Step 5: Verify the package-local workflow**

Run: `pnpm --filter @agent-bundle-example/hooks-and-scripts check`

Expected: validation and build pass.

- [ ] **Step 6: Commit**

```bash
git add examples/hooks-and-scripts packages/agent-bundle/tests/examples-contract.test.ts
git commit -m "feat(examples): model release automation"
```

### Task 3: Turn MCP App into the integrated service-readiness showcase

**Files:**
- Modify: `examples/mcp-app/agent-bundle.config.ts`
- Modify: `examples/mcp-app/src/mcp-server.ts`
- Create: `examples/mcp-app/src/hooks/session-start.ts`
- Create: `examples/mcp-app/src/scripts/check-service-fixture.ts`
- Create: `examples/mcp-app/skills/service-readiness/SKILL.md`
- Create: `examples/mcp-app/skills/service-readiness/references/status-policy.md`
- Create: `examples/mcp-app/skills/service-readiness/assets/readiness-report.md`
- Modify: `examples/mcp-app/views/status-panel.ts`
- Modify: `examples/mcp-app/views/status-panel.html`
- Modify: `examples/mcp-app/evals/fixtures/status/result.json`
- Modify: `examples/mcp-app/evals/graders/status-result.ts`
- Modify: `examples/mcp-app/evals/status.eval.ts`
- Modify: `examples/mcp-app/README.md`
- Test: `packages/agent-bundle/tests/examples-contract.test.ts`

**Interfaces:**
- Consumes: public MCP Apps build export and MCP SDK server APIs.
- Produces: `show-status({ service })` structured content `{ checks, service, status, summary }`, Skill `service-readiness`, Hook `sessionStart`, and script `check-service-fixture` across portable/Codex/Claude targets.

- [ ] **Step 1: Write the failing integrated-example contract**

Require the artifact to contain the new Skill, Hook, script, and three targets.
Invoke `show-status` for `payments-api` and expect:

```ts
{
  service: 'payments-api',
  status: 'degraded',
  summary: 'Payment latency is above the release threshold.',
  checks: [
    { label: 'Availability', status: 'passing' },
    { label: 'P95 latency', status: 'failing' },
  ],
}
```

- [ ] **Step 2: Verify RED**

Run: `pnpm exec rstest packages/agent-bundle/tests/examples-contract.test.ts -t "MCP App example"`

Expected: FAIL on missing integrated capabilities and degraded result.

- [ ] **Step 3: Implement the showcase**

Use an immutable in-module service catalog for `compiler` and `payments-api`.
Validate `service` with `z.enum(['compiler', 'payments-api'])`. Return ordinary
text plus the exact structured content above. Render the App from official
tool-input/tool-result notifications and expose each check in a labelled list.
Add the Skill, Hook, and script through the existing config fields and change
targets to `['portable', 'codex', 'claude']`; keep the App resource portable.

- [ ] **Step 4: Verify GREEN**

Run: `pnpm exec rstest packages/agent-bundle/tests/examples-contract.test.ts`

Expected: all example contracts pass.

- [ ] **Step 5: Verify generated App and target artifacts**

Run: `pnpm --filter @agent-bundle-example/mcp-app check`

Expected: validation and build pass; portable contains the App while all three
targets contain their supported Skill/Hook/script/MCP outputs.

- [ ] **Step 6: Commit**

```bash
git add examples/mcp-app packages/agent-bundle/tests/examples-contract.test.ts
git commit -m "feat(examples): showcase unified service readiness"
```

### Task 4: Explain Skills and the bundle workflow

**Files:**
- Modify: `packages/workbench/src/overview-page.tsx`
- Modify: `packages/workbench/src/skills-page.tsx`
- Modify: `packages/workbench/src/evals/evals-page.tsx`
- Create: `packages/workbench/tests/overview-page.test.ts`
- Modify: `packages/workbench/tests/skills-page.test.ts`
- Modify: `packages/workbench/tests/evals-page.test.ts`

**Interfaces:**
- Consumes: existing `onNavigate(WorkbenchPage)` and immutable Skill/Eval view models.
- Produces: an onboarding workflow, explanatory Skills copy, human generated-document labels, actionable empty states, and the renamed trial label.

- [ ] **Step 1: Write failing presentation tests**

Assert static markup contains:

```text
Bundle dashboard
Author once, exercise host-ready behavior, and evaluate durable evidence.
Authored SKILL.md
Generated for portable
Add a Skill path to agent-bundle.config.ts
Trial override (leave blank to use authored count)
```

Also assert the workflow navigation offers Skills, Hooks, Playground, MCP,
Evals, and Artifacts without duplicating project state.

- [ ] **Step 2: Verify RED**

Run: `pnpm exec rstest packages/workbench/tests/overview-page.test.ts packages/workbench/tests/skills-page.test.ts packages/workbench/tests/evals-page.test.ts`

Expected: FAIL on the new product language and navigation.

- [ ] **Step 3: Implement the presentation changes**

Add a small exported `BundleWorkflow` component to `overview-page.tsx` whose
buttons call `onNavigate`. Change only labels and empty-state copy in Skills and
Evals; keep exact epoch provenance available in the existing provenance badge.

- [ ] **Step 4: Verify GREEN and accessibility contracts**

Run: `pnpm exec rstest packages/workbench/tests/overview-page.test.ts packages/workbench/tests/skills-page.test.ts packages/workbench/tests/evals-page.test.ts`

Expected: all tests pass with headings, buttons, tab labels, and alerts intact.

- [ ] **Step 5: Commit**

```bash
git add packages/workbench/src/overview-page.tsx packages/workbench/src/skills-page.tsx packages/workbench/src/evals/evals-page.tsx packages/workbench/tests/overview-page.test.ts packages/workbench/tests/skills-page.test.ts packages/workbench/tests/evals-page.test.ts
git commit -m "feat(workbench): explain the bundle workflow"
```

### Task 5: Add contextual Hook, Playground, and MCP defaults

**Files:**
- Modify: `packages/workbench/src/hooks/hooks-page.tsx`
- Modify: `packages/workbench/src/playground/playground-page.tsx`
- Modify: `packages/workbench/src/mcp-screen.tsx`
- Modify: `packages/workbench/src/mcp/mcp-page.tsx`
- Modify: `packages/workbench/src/main.tsx`
- Modify: `packages/workbench/tests/hooks-page.test.ts`
- Modify: `packages/workbench/tests/playground-page.test.ts`
- Modify: `packages/workbench/tests/mcp-page.test.ts`
- Modify: `packages/workbench/tests/examples-real.e2e.test.ts`

**Interfaces:**
- Consumes: `ArtifactClient.inspect(epochId)` and `ArtifactInspection.runtime.mcpServers`.
- Produces: `canonicalHookInput(event)`, catalog-preserving Playground selections, and `McpPageServerOption { name, target }` options.

- [ ] **Step 1: Write failing unit tests for pure defaults**

Test the four Hook canonical documents, first-target/first-script selection,
explicit-selection preservation, and target-filtered MCP server options. The
session-start default is:

```ts
{
  cwd: '/workspace',
  sessionId: 'workbench-preview',
  source: 'workbench',
  transcriptPath: '/workspace/transcript.json',
}
```

- [ ] **Step 2: Write the failing real-Chrome default assertions**

In the Hooks example, remove manual target/operation/script selection. Assert
that the loaded page already selects `portable`, `script.run`, and
`script:verify-release`, and that Hook simulation succeeds without replacing
the default JSON. In MCP, assert `portable` and `status` are selected before
opening the session.

- [ ] **Step 3: Verify RED**

Run: `pnpm exec rstest packages/workbench/tests/hooks-page.test.ts packages/workbench/tests/playground-page.test.ts packages/workbench/tests/mcp-page.test.ts`

Expected: FAIL because current defaults are `{}`, empty target/server, and
`skill.inspect`.

- [ ] **Step 4: Implement Hook and Playground defaults**

Export `canonicalHookInput(event)` from `hooks-page.tsx`. Initialize or update
the draft when the selected Hook changes until the user edits it. In Playground,
select the first valid target and script; prefer `script.run` only while the
operation remains implicit. Never overwrite a still-valid explicit choice.

- [ ] **Step 5: Implement MCP artifact catalog defaults**

Pass the existing `ArtifactClient` from `main.tsx` into `McpScreen`. Inspect the
active epoch with cancellation on unmount/epoch change, map runtime servers to
frozen `{ name, target }` options, and pass them to `McpPage`. Select the first
valid target/server and expose a datalist-backed editable server input.

- [ ] **Step 6: Verify GREEN**

Run: `pnpm exec rstest packages/workbench/tests/hooks-page.test.ts packages/workbench/tests/playground-page.test.ts packages/workbench/tests/mcp-page.test.ts`

Expected: all focused unit tests pass.

- [ ] **Step 7: Verify real default behavior**

Run: `pnpm exec rstest packages/workbench/tests/examples-real.e2e.test.ts`

Expected: three real-Chrome examples pass without manual binding boilerplate.

- [ ] **Step 8: Commit**

```bash
git add packages/workbench/src packages/workbench/tests/hooks-page.test.ts packages/workbench/tests/playground-page.test.ts packages/workbench/tests/mcp-page.test.ts packages/workbench/tests/examples-real.e2e.test.ts
git commit -m "feat(workbench): choose useful artifact defaults"
```

### Task 6: Complete desktop browser acceptance and handoff documentation

**Files:**
- Modify: `packages/workbench/tests/examples-real.e2e.test.ts`
- Modify: `packages/workbench/tests/support/example-acceptance.ts`
- Modify: `examples/skills-starter/README.md`
- Modify: `examples/hooks-and-scripts/README.md`
- Modify: `examples/mcp-app/README.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: the three final example packages and existing capture/error-ledger helpers.
- Produces: one 1440×900 report covering every Workbench route plus diagnostic and repair states.

- [ ] **Step 1: Add missing browser acceptance assertions**

Extend the MCP showcase flow to visit Overview, Skills, Hooks, Playground,
MCP, Evals, Logs, Artifacts, and Comparisons. Assert populated states where the
example publishes a capability and the precise empty Comparisons explanation
before two runs exist. Call `payments-api`, assert degraded summary/checks in
both invocation history and App preview, and capture each settled state.

- [ ] **Step 2: Run browser acceptance with screenshot output**

Run:

```bash
AGENT_BUNDLE_EXAMPLE_SCREENSHOT_DIR=/tmp/agent-bundle-example-acceptance \
  pnpm exec rstest packages/workbench/tests/examples-real.e2e.test.ts
```

Expected: 3/3 pass; `report.json` lists 1440×900 captures only; page errors,
console errors, and unexpected request failures are empty.

- [ ] **Step 3: Review every screenshot**

Open each PNG from `/tmp/agent-bundle-example-acceptance`, verify no loading
state, clipped desktop controls, generic request error, empty required panel,
or stale prior-example content, and correct any reproduced defect through a
new RED→GREEN focused test.

- [ ] **Step 4: Update public walkthroughs**

Document the actual default selections, integrated capability flow, expected
degraded App state, deterministic eval, diagnostic repair, and the role of each
Workbench page. Keep commands package-local and root-inferred.

- [ ] **Step 5: Run all example and workspace gates**

Run sequentially:

```bash
pnpm examples:check
pnpm test:examples:browser
pnpm check
pnpm check:release
pnpm test:packed:native
actionlint
node -e "for (const file of ['.github/workflows/ci.yml','.github/workflows/package-preview.yml']) require('yaml').parse(require('node:fs').readFileSync(file,'utf8'))"
```

Expected: every command exits 0; authenticated native tests may skip only when
their explicit opt-in is absent.

- [ ] **Step 6: Commit**

```bash
git add README.md examples packages/workbench/tests/examples-real.e2e.test.ts packages/workbench/tests/support/example-acceptance.ts
git commit -m "test(examples): verify the complete desktop workflow"
```

- [ ] **Step 7: Push and verify pkg.pr.new**

Run:

```bash
git push origin codex/agent-bundle-implementation
gh pr checks 2 --watch --fail-fast=false
```

Expected: `Publish pkg.pr.new preview` succeeds for the pushed SHA and prints
an install URL scoped to `ScriptedAlchemy/agent-bundle@<short-sha>`.

- [ ] **Step 8: Launch the final handoff environment**

Run the MCP example with `pnpm example:mcp-app`, open its Workbench URL in X11
Chrome at `#overview`, and open `examples/mcp-app` in Cursor. Verify both windows
are visible on the configured X11 display and leave them running for the user.

