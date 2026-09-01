# Capability-aware Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the desktop Workbench show only capabilities published by the current validated build, guide every visible workflow with catalog-backed defaults, use plain build terminology, and demonstrate the product through credible public examples.

**Architecture:** Add one browser-side immutable capability catalog composed from the existing strict artifact, Skill, and Eval clients. The Workbench shell waits for that catalog, derives its route set and dashboard from it, and atomically replaces it when a successful build publishes a new build ID while retaining last-good capabilities through failed rebuilds. Capability pages consume the same catalog data for defaults, so route availability and runnable controls cannot disagree.

**Tech Stack:** TypeScript, React 19, Zod-backed browser clients, Rstest, Rstest Playwright/Chrome, Rsbuild, pnpm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-25-capability-aware-workbench-design.md`

> Supersession note (#105 stage 1, compiler-manifest-driven navigation): this
> plan is landed and its structure invariants still hold with one amendment.
> The catalog is no longer composed from artifact, Skill, and Eval clients
> alone — it also reads the compiled route graph from one dedicated dev-server
> route (`GET /api/routes/manifest`) behind its own strict decoder, and
> `WorkbenchCapabilities` carries a `routes: RouteCatalog`. Task 1's page rules
> below are now the *union* of those counts and the compiled graph, and the
> page set gained `routes` (a compiled-catalog page under **Build**, beside
> Overview), so the Task 1 assertions and the `WorkbenchCapabilities` /
> `WorkbenchCapabilityClients` shapes quoted here are superseded by
> `packages/workbench/src/workbench-capabilities.ts` and
> `packages/workbench/tests/workbench-capabilities.test.ts`. Everything else is
> unchanged and intentionally so: there is still exactly one Workbench shell,
> one navigation rail, and one hash router in `main.tsx` /
> `workbench-screen.tsx`. The Routes catalog is a page inside them; it does not
> add a shell, a navigation component, or a router. Schema-driven input editors
> and the Agent Document stage remain stage 2 and are deliberately not
> scaffolded.

## Global Constraints

- The Workbench is desktop-only; acceptance viewport is exactly 1440×900.
- `examples/*` are public user-facing products and may use only public `agent-bundle` exports with `workspace:*` dependencies.
- Never capture or accept a Workbench route while a loading state is visible.
- Browser acceptance covers populated state plus the documented stale-diagnostic and repair flow.
- No mobile-specific layouts, responsive requirements, compatibility aliases, or internal epoch-schema changes.
- Internal field/type/API names may retain `epoch`; user-facing copy uses “build,” “current build,” “last good build,” and “build ID.”
- Preserve unrelated working-tree edits and commit each task separately.

---

### Task 1: Canonical browser capability catalog

**Files:**
- Create: `packages/workbench/src/workbench-capabilities.ts`
- Create: `packages/workbench/tests/workbench-capabilities.test.ts`
- Modify: `packages/workbench/src/main.tsx`
- Modify: `packages/workbench/src/workbench-screen.tsx`
- Create: `packages/workbench/tests/workbench-screen.test.ts`
- Modify: `packages/workbench/tests/overview.e2e.test.ts`

**Interfaces:**
- Consumes: `ArtifactClient.inspect(epochId)`, `SkillClient.sourceTree()`, `EvalClient.suites()`, and `activeEpochFor(status)`.
- Produces:

```ts
export interface WorkbenchCapabilities {
  readonly buildId: string;
  readonly counts: Readonly<{
    evalSuites: number;
    hooks: number;
    mcpServers: number;
    scripts: number;
    skills: number;
    targets: number;
  }>;
  readonly inspection: ArtifactInspection;
  readonly pages: ReadonlySet<WorkbenchPage>;
}

export const loadWorkbenchCapabilities = async (options: {
  readonly artifactClient: Pick<ArtifactClient, 'inspect'>;
  readonly buildId: string;
  readonly evalClient: Pick<EvalClient, 'suites'>;
  readonly signal?: AbortSignal;
  readonly skillClient: Pick<SkillClient, 'sourceTree'>;
}): Promise<WorkbenchCapabilities>;

export const pageForHash = (
  hash?: string,
  pages?: ReadonlySet<WorkbenchPage>,
): WorkbenchPage;
```

- Page rules: Overview/Artifacts/Logs always; Skills for `skills > 0`; Hooks for `hooks > 0`; MCP for `mcpServers > 0`; Playground for `hooks + scripts > 0`; Evals and Comparisons for `evalSuites > 0`.
  Amended by #105 stage 1: Routes is also always available once the catalog is
  ready, and Hooks, MCP, and Playground additionally open when the compiled
  route graph declares an event route, an MCP server surface, or a script route.

- [ ] **Step 1: Write failing capability derivation tests**

Add tests that construct exact source-tree, inspection, and Eval-suite responses and assert these representative page sets:

```ts
expect([...skillsOnly.pages]).toEqual([
  'overview', 'skills', 'artifacts', 'logs', 'evals', 'comparisons',
]);
expect([...hooksAndScripts.pages]).toEqual([
  'overview', 'hooks', 'artifacts', 'playground', 'logs',
]);
expect([...fullBundle.pages]).toEqual([
  'overview', 'skills', 'hooks', 'mcp', 'artifacts', 'playground', 'logs', 'evals', 'comparisons',
]);
expect(Object.isFrozen(fullBundle)).toBe(true);
expect(Object.isFrozen(fullBundle.counts)).toBe(true);
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```bash
pnpm exec rstest --config rstest.config.ts \
  packages/workbench/tests/workbench-capabilities.test.ts \
  packages/workbench/tests/workbench-screen.test.ts
```

Expected: FAIL because `workbench-capabilities.ts` and capability-aware route APIs do not exist.

- [ ] **Step 3: Implement the immutable catalog**

Create `loadWorkbenchCapabilities` with one `Promise.all`, verify all responses refer to the requested current build where applicable, retain the decoded inspection for downstream page defaults, and freeze the counts/page set wrapper. Use an ordered page array plus `Set` so navigation order is deterministic.

- [ ] **Step 4: Make navigation and hashes capability-aware**

Change `Navigation`, `WorkbenchScreen`, `SkillsScreen`, `Overview`, `McpScreen`, and `PlaygroundScreen` to receive the available page set. Render only included navigation items under accessible Build, Capabilities, Quality, and Inspect groups. Update `pageForHash` to reject pages absent from the set.

In `main.tsx`, maintain a build-keyed state:

```ts
type CapabilityState =
  | Readonly<{ state: 'loading'; buildId: string }>
  | Readonly<{ state: 'ready'; value: WorkbenchCapabilities }>
  | Readonly<{ buildId: string; message: string; state: 'error' }>;
```

Abort superseded catalog loads. Render “Loading bundle capabilities…” until ready. When the current hash is unavailable, call `history.replaceState(undefined, '', '#overview')` and render Overview. Preserve the last-good catalog when a failed rebuild leaves `activeEpochFor(status)?.id` unchanged.

- [ ] **Step 5: Add dynamic route RED/GREEN browser coverage**

In the existing Overview E2E harness, hold two capability responses for build A and B. Assert that an open Hooks route redirects when build B removes Hooks, and that Hooks/Playground links appear when build C adds an emitted Hook. Resolve an older build-A request last and assert it cannot replace build C.

- [ ] **Step 6: Run focused checks**

```bash
pnpm exec rstest --config rstest.config.ts \
  packages/workbench/tests/workbench-capabilities.test.ts \
  packages/workbench/tests/workbench-screen.test.ts \
  packages/workbench/tests/overview.e2e.test.ts
pnpm --filter agent-bundle-workbench typecheck
pnpm exec rslint packages/workbench/src/workbench-capabilities.ts packages/workbench/src/workbench-screen.tsx packages/workbench/src/main.tsx
```

Expected: all pass with zero lint warnings.

- [ ] **Step 7: Commit**

```bash
git add packages/workbench/src/workbench-capabilities.ts \
  packages/workbench/src/main.tsx packages/workbench/src/workbench-screen.tsx \
  packages/workbench/tests/workbench-capabilities.test.ts \
  packages/workbench/tests/workbench-screen.test.ts \
  packages/workbench/tests/overview.e2e.test.ts
git commit -m "feat(workbench): derive routes from bundle capabilities"
```

---

### Task 2: Plain-language dashboard and build terminology

**Files:**
- Modify: `packages/workbench/src/overview-page.tsx`
- Modify: `packages/workbench/src/overview-model.ts`
- Modify: `packages/workbench/src/styles.css`
- Modify: `packages/workbench/tests/overview-page.test.ts`
- Modify: `packages/workbench/tests/overview-model.test.ts`
- Modify: `packages/workbench/tests/overview.e2e.test.ts`
- Modify: user-visible copy in `packages/workbench/src/{skills-page.tsx,hooks/hooks-model.ts,mcp/mcp-page.tsx,artifacts/artifacts-model.ts,artifacts/artifacts-page.tsx,playground/playground-model.ts,playground/playground-page.tsx}`
- Modify: directly affected focused tests under `packages/workbench/tests/`

**Interfaces:**
- Consumes: `WorkbenchCapabilities` from Task 1 and existing `overviewFor(status, changedFiles)`.
- Produces: `BundleSummary`, a pure dashboard model used by `Overview`:

```ts
export interface BundleSummary {
  readonly capabilityLabels: readonly string[];
  readonly nextPages: readonly WorkbenchPage[];
  readonly targetCount: number;
}

export const bundleSummaryFor = (capabilities: WorkbenchCapabilities): BundleSummary;
```

- [ ] **Step 1: Replace dashboard expectations with failing product-language tests**

Assert the Skills Starter model renders one capability summary and relevant actions without repeated routes:

```ts
expect(markup).toContain('1 Skill');
expect(markup).toContain('1 Eval suite');
expect(markup).toContain('3 generated targets');
expect(markup.match(/>Skills</gu)).toHaveLength(1);
expect(markup).not.toContain('Hooks');
expect(markup).not.toContain('MCP');
expect(markup).not.toContain('artifact epoch');
expect(markup).toContain('Build ID');
```

Add a focused source-copy assertion over rendered components that rejects the phrases `Artifact epoch`, `artifact epoch`, `This epoch`, `selected epoch`, and `Epoch ID`.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm exec rstest --config rstest.config.ts \
  packages/workbench/tests/overview-page.test.ts \
  packages/workbench/tests/overview-model.test.ts \
  packages/workbench/tests/skills-page.test.ts \
  packages/workbench/tests/hooks-page.test.ts \
  packages/workbench/tests/artifacts-page.test.ts
```

Expected: FAIL on the old four-stage dashboard and epoch copy.

- [ ] **Step 3: Implement the simplified dashboard**

Replace `BundleWorkflow` with:

- one page heading and purpose sentence;
- capability summary cards generated from nonzero counts;
- one unique next-action link per relevant page, capped at three;
- build health plus Rebuild in the first viewport;
- diagnostics immediately below health when present;
- a native `<details>` labeled “Inspect build details” containing exact Build ID, generated target digests, changed files, and provenance-oriented tables.

Style links with explicit `.action-link`, `.capability-card`, and `.build-summary` classes. Delete the ordered workflow and default button presentation rather than restyling it.

- [ ] **Step 4: Replace user-facing epoch copy**

Change all browser-visible strings to build terminology while leaving wire error messages, field names, IDs, and internal comments unchanged. Examples:

```ts
'No artifact epoch is active' -> 'No successful build is available'
'Current artifact epoch' -> 'Current build'
'Last good artifact epoch' -> 'Last good build'
'This epoch published no hooks' -> 'This build contains no Hooks'
'Artifact epoch' label -> 'Build'
```

- [ ] **Step 5: Verify stale and repaired states**

Update Overview E2E expectations to assert “Last good build” after a failed rebuild and “Current build” after repair. Capture the diagnostic before opening advanced details; then open details and assert the exact Build ID remains available.

- [ ] **Step 6: Run focused checks and commit**

```bash
pnpm exec rstest --config rstest.config.ts \
  packages/workbench/tests/overview-page.test.ts \
  packages/workbench/tests/overview-model.test.ts \
  packages/workbench/tests/overview.e2e.test.ts \
  packages/workbench/tests/skills-page.test.ts \
  packages/workbench/tests/hooks-page.test.ts \
  packages/workbench/tests/artifacts-page.test.ts \
  packages/workbench/tests/mcp-page.test.ts
pnpm --filter agent-bundle-workbench typecheck
pnpm --filter agent-bundle-workbench build
git diff --check
git add packages/workbench/src packages/workbench/tests
git commit -m "feat(workbench): focus the dashboard on developer actions"
```

---

### Task 3: Catalog-driven capability controls

**Files:**
- Modify: `packages/workbench/src/hooks/hooks-page.tsx`
- Modify: `packages/workbench/src/playground-screen.tsx`
- Modify: `packages/workbench/src/playground/playground-page.tsx`
- Modify: `packages/workbench/src/playground/playground-page.css`
- Modify: `packages/workbench/src/mcp-screen.tsx`
- Modify: `packages/workbench/src/mcp/mcp-page.tsx`
- Modify: `packages/workbench/src/evals/evals-page.tsx`
- Modify: `packages/workbench/tests/{hooks-page,playground-page,mcp-page,evals-page}.test.ts`
- Modify: `packages/workbench/tests/examples-real.e2e.test.ts`

**Interfaces:**
- Consumes: `WorkbenchCapabilities.inspection.runtime` from Task 1.
- Produces:

```ts
export interface PlaygroundHookOption {
  readonly event: string;
  readonly id: string;
  readonly name: string;
  readonly target: string;
}

export interface PlaygroundAvailableOperations {
  readonly hooks: readonly PlaygroundHookOption[];
  readonly scripts: readonly PlaygroundScriptCatalogEntry[];
}
```

- [ ] **Step 1: Write failing catalog-default tests**

Cover:

- Hooks selects the first catalog Hook and receives its canonical input draft.
- Playground exposes only `hook.simulate` when only Hooks exist, only `script.run` when only scripts exist, and both when both exist.
- Playground defaults the first target and exact Hook/script ID; no visible blank text field asks for an internal ID.
- MCP selects the first emitted server/target and does not render a free-form Server name field in the primary session form.
- Evals selects the first suite when listings arrive.
- JSON/raw IDs/timeouts live inside a closed `details` element labeled “Advanced.”

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm exec rstest --config rstest.config.ts \
  packages/workbench/tests/hooks-page.test.ts \
  packages/workbench/tests/playground-page.test.ts \
  packages/workbench/tests/mcp-page.test.ts \
  packages/workbench/tests/evals-page.test.ts
```

Expected: FAIL because Playground accepts unsupported operations and blank IDs, and MCP exposes raw binding fields first.

- [ ] **Step 3: Wire capability inspection into pages**

Pass the immutable inspection from `WorkbenchCapabilities` into Hooks,
Playground, and MCP screens. Remove their duplicate artifact-inspection requests.
Derive available operations from emitted runtime catalogs only.

For Playground selection, preserve a user choice only while it still exists in
the catalog; otherwise choose the first operation, target, and option. Use the
Hook list’s canonical example input. Do not invent generic `{}` when a catalog
draft exists.

- [ ] **Step 4: Apply progressive disclosure**

Keep one primary action per page (`Run simulation`, `Start run`, `Open MCP
session`, `Run eval`). Move raw JSON, timeout, exact IDs, protocol frames, and
manual overrides into labeled advanced disclosures. Catalog selectors remain
visible when there is more than one valid choice.

- [ ] **Step 5: Prove populated browser workflows**

Update `examples-real.e2e.test.ts` to use only visible labels and selections.
Assert the Hooks and Scripts example opens with a complete runnable default and
the MCP App example opens its emitted `status` server without typing its name.
Assert no empty Hook/server input exists.

- [ ] **Step 6: Run checks and commit**

```bash
pnpm exec rstest --config rstest.config.ts \
  packages/workbench/tests/hooks-page.test.ts \
  packages/workbench/tests/playground-page.test.ts \
  packages/workbench/tests/mcp-page.test.ts \
  packages/workbench/tests/evals-page.test.ts \
  packages/workbench/tests/examples-real.e2e.test.ts
pnpm --filter agent-bundle-workbench typecheck
pnpm --filter agent-bundle-workbench build
pnpm exec rslint packages/workbench/src/hooks packages/workbench/src/playground packages/workbench/src/mcp packages/workbench/src/evals
git diff --check
git add packages/workbench/src packages/workbench/tests
git commit -m "feat(workbench): default capability workflows from catalogs"
```

---

### Task 4: Honest Skills comparison and credible multi-Skill example

**Files:**
- Modify: `packages/workbench/src/skills-page.tsx`
- Modify: `packages/workbench/src/styles.css`
- Modify: `packages/workbench/tests/skills-page.test.ts`
- Modify: `examples/skills-starter/agent-bundle.config.ts`
- Modify: `examples/skills-starter/README.md`
- Create: `examples/skills-starter/skills/incident-triage/SKILL.md`
- Create: `examples/skills-starter/skills/incident-triage/references/handoff-checklist.md`
- Create: `examples/skills-starter/skills/incident-triage/assets/incident-handoff.md`
- Create: `examples/skills-starter/skills/dependency-upgrade/SKILL.md`
- Create: `examples/skills-starter/skills/dependency-upgrade/references/upgrade-policy.md`
- Create: `examples/skills-starter/skills/dependency-upgrade/assets/upgrade-plan.md`
- Modify/Create: deterministic Eval suites/fixtures/graders under `examples/skills-starter/evals/` for direct coverage of all three Skills.
- Modify: `packages/workbench/tests/examples-real.e2e.test.ts`

**Interfaces:**
- Produces:

```ts
export interface SkillGenerationSummary {
  readonly kind: 'identical' | 'modified';
  readonly message: string;
}

export const skillGenerationSummaryFor = (
  source: ServedSkillDocument,
  generated: ServedSkillDocument,
): SkillGenerationSummary;
```

- [ ] **Step 1: Write failing Skills comparison tests**

Assert identical Markdown renders:

```text
This target keeps the authored instructions unchanged. Agent Bundle only changes the host package layout.
```

Assert changed Markdown renders a concise “Generated output differs from the authored Skill” notice. Replace Source/Generated provenance badges containing opaque build IDs with “Authored” and “Generated for Claude/Codex/portable.” Keep the exact build ID under advanced document details.

- [ ] **Step 2: Run focused Skills tests and verify RED**

```bash
pnpm exec rstest --config rstest.config.ts packages/workbench/tests/skills-page.test.ts
```

- [ ] **Step 3: Implement the comparison summary**

Compare exact normalized `markdown` strings from the selected source/generated documents. Do not create a line-diff engine. Render one honest summary sentence and retain the existing Rendered/Markdown tabs for exact inspection.

- [ ] **Step 4: Add the two real-world Skills and coverage**

Register all three public Skill directories. Each new `SKILL.md` must explain when to use it, required evidence, an executable workflow, stop conditions, and final deliverable; each links its reference and reusable asset. Add deterministic cases that name the relevant Skill explicitly so the existing Eval coverage panel reports direct coverage.

- [ ] **Step 5: Update the public walkthrough and Chrome assertions**

Document the three workflows and why portable/Codex/Claude output may be content-identical while package layouts differ. In Chrome, select each Skill, open linked resources, switch targets, and assert the correct identical/modified summary rather than implying a difference.

- [ ] **Step 6: Run package and browser checks, then commit**

```bash
pnpm --filter @agent-bundle-example/skills-starter validate
pnpm --filter @agent-bundle-example/skills-starter build
pnpm exec rstest --config rstest.config.ts \
  packages/workbench/tests/skills-page.test.ts \
  packages/workbench/tests/examples-real.e2e.test.ts
pnpm --filter agent-bundle-workbench typecheck
pnpm exec rslint packages/workbench/src/skills-page.tsx packages/workbench/tests/skills-page.test.ts
git diff --check
git add examples/skills-starter packages/workbench/src/skills-page.tsx \
  packages/workbench/src/styles.css packages/workbench/tests/skills-page.test.ts \
  packages/workbench/tests/examples-real.e2e.test.ts
git commit -m "feat(examples): demonstrate a real multi-skill bundle"
```

---

### Task 5: Dynamic capability, stale, repair, and screenshot acceptance

**Files:**
- Modify: `packages/workbench/tests/examples-real.e2e.test.ts`
- Modify: `packages/workbench/tests/support/example-acceptance.ts`
- Modify: `packages/workbench/tests/overview.e2e.test.ts`
- Modify: `.gitignore` only if a new generated report path must remain ignored.

**Interfaces:**
- Consumes: completed Workbench and examples from Tasks 1–4.
- Produces: deterministic Chrome evidence under the existing example report/screenshot support.

- [ ] **Step 1: Add a failing dynamic-capability E2E**

Copy Skills Starter to a temporary project. Start at `#hooks` and assert the URL becomes `#overview`, with no Hooks/MCP/Playground links. Add a minimal public-config Hook and handler, wait for a successful rebuild, and assert Hooks and Playground appear without reload. Open Hooks, remove the Hook, rebuild successfully, and assert redirect to Overview plus removal of both links.

- [ ] **Step 2: Extend stale/repair coverage**

Break the temporary Hook source, rebuild, and assert:

- diagnostics are populated;
- the UI says “Last good build”;
- Hooks/Playground remain available from the last-good catalog;
- no loading state is captured.

Repair the source, rebuild, and assert “Current build,” zero diagnostics, and the expected capability set.

- [ ] **Step 3: Capture all required desktop states**

At 1440×900 capture:

- Skills Starter simplified Overview;
- each of the three Skills and one target comparison;
- Hooks and Scripts runnable Hooks/Playground defaults;
- MCP App selected server plus rendered App;
- stale diagnostic and repaired Overview;
- dynamic capability reveal and removal.

Record URL, heading, visible nav labels, build state, viewport dimensions, page errors, console errors, and failed application routes in the JSON report.

- [ ] **Step 4: Run the full example acceptance file**

```bash
pnpm exec rstest --config rstest.config.ts packages/workbench/tests/examples-real.e2e.test.ts
```

Expected: all examples and dynamic mutation pass with zero unexpected browser errors.

- [ ] **Step 5: Commit**

```bash
git add packages/workbench/tests/examples-real.e2e.test.ts \
  packages/workbench/tests/support/example-acceptance.ts \
  packages/workbench/tests/overview.e2e.test.ts .gitignore
git commit -m "test(workbench): verify capability-aware example workflows"
```

---

### Task 6: Completion audit, release gates, and push

**Files:**
- Modify only files required by concrete gate failures; each unrelated fix receives its own commit.

**Interfaces:**
- Consumes: all preceding commits and the accepted spec.
- Produces: a clean pushed PR2 commit range and requirement-by-requirement evidence.

- [ ] **Step 1: Run focused source-copy and example scans**

```bash
rg -n "Artifact epoch|artifact epoch|This epoch|selected epoch|Epoch ID" packages/workbench/src
rg -n "skills:|hooks:|mcp:|scripts:" examples/*/agent-bundle.config.ts
git diff --check
```

Expected: no user-facing epoch copy; example capabilities match browser expectations.

- [ ] **Step 2: Run workspace quality gates**

```bash
pnpm build
pnpm test
pnpm lint
pnpm typecheck
```

Expected: zero failures and zero lint warnings.

- [ ] **Step 3: Run release and packed gates**

```bash
pnpm check:release
pnpm test:packed
pnpm lint:package
```

Expected: pack dry-run, publint, ATTW, dependency/audit/signature/SBOM checks, and packed Workbench tests all pass.

- [ ] **Step 4: Audit every design requirement against current evidence**

Create a checklist from the design Goals, Product model, State/error handling, and Browser acceptance sections. For each item, cite a current source symbol plus a passing focused/browser/release result. Treat missing or indirect evidence as incomplete and fix it before proceeding.

- [ ] **Step 5: Confirm clean state, push, and inspect PR checks**

```bash
git status --short
git log --oneline origin/codex/agent-bundle-implementation..HEAD
git push origin codex/agent-bundle-implementation
gh pr checks 2
```

Expected: clean status, no unpushed commit after push, and all hosted checks passing or actively monitored to completion.
