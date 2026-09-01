# Capability-aware Workbench design

Date: 2026-08-25
Status: proposed

> Status note (2026-08-31): the nine-page Workbench is in tree. The remaining
> manifest navigation, Agent Document stage, replay, and read-only discovery
> work is tracked in
> [#105](https://github.com/ScriptedAlchemy/agent-bundle/issues/105). This
> spec is not the live execution plan.

## Context

The Workbench currently renders the same navigation and workflow for every
bundle. That exposes empty Hooks and MCP forms, a generic Playground that asks
developers to invent internal identifiers and JSON, and an Overview that
repeats every route as browser-default buttons. It also uses the internal term
"artifact epoch" throughout the product.

This is misleading for focused bundles such as `examples/skills-starter` and
needlessly difficult even for bundles that publish every capability. The UI is
reflecting storage and protocol concepts instead of helping a developer answer
three questions:

1. What does this bundle contain?
2. What can I run or inspect now?
3. What failed, and how do I repair it?

## Goals

- Derive visible Workbench routes from the current validated build.
- Make every visible capability page runnable with catalog-backed defaults.
- Use plain product language, with "build" replacing user-facing "epoch".
- Keep detailed identifiers, JSON, protocol state, and provenance available
  without making them the primary workflow.
- Make the three public examples credible, distinct desktop products.
- Preserve last-good capability access while a newer source build is stale.
- Reveal and remove routes immediately after successful rebuilds change the
  published capability set.

## Non-goals

- Changing internal epoch storage, route parameters, persisted schemas, or
  protocol terminology used by code and diagnostics.
- A mobile layout or mobile acceptance pass.
- Hiding diagnostics, traces, or raw data from developers who choose to inspect
  them.
- Creating example-specific Workbench branches or hard-coded route lists.

## Product model

### Capability catalog

The browser will build one immutable `WorkbenchCapabilityCatalog` for the
active (or last-good) build. It is composed from existing authoritative APIs:

- artifact inspection supplies emitted Hooks, MCP servers, scripts, targets,
  and executable files;
- the source Skill tree supplies authored Skills;
- the Eval suite listing supplies configured evaluation suites.

The catalog is keyed by the active build ID. It is loaded before the connected
Workbench shell is rendered, replaced atomically when a successful build
publishes a different ID, and retained when a failed rebuild leaves the prior
build active. A failed catalog request produces a visible recovery state; it
must not silently expose every route or guess capabilities.

The catalog derives these product capabilities:

- `skills`: at least one authored Skill;
- `hooks`: at least one emitted Hook;
- `mcp`: at least one emitted MCP server;
- `playground`: at least one emitted Hook or script operation;
- `evals`: at least one Eval suite;
- `comparisons`: the bundle has Eval suites, because comparisons are derived
  from their recorded runs;
- `artifacts`, `logs`, and `overview`: general build surfaces, always visible
  once the connected shell is ready.

This is a browser composition boundary rather than a new server endpoint. It
reuses the strict decoders and services already required by the pages, avoids
duplicating catalog schemas, and can be replaced later by a server summary
without changing product semantics.

### Navigation and direct routes

Navigation receives the catalog and renders three concise groups:

- **Build:** Overview
- **Capabilities:** only Skills, Hooks, Playground, and MCP capabilities that
  exist in the catalog
- **Quality:** Evals and Comparisons only when Eval suites exist
- **Inspect:** Artifacts and Logs

The labels need not render as large headings; their purpose is information
architecture and accessible grouping.

`pageForHash` resolves against the available page set. An unknown or unsupported
hash resolves to Overview and replaces the URL with `#overview`. If a successful
rebuild removes the currently open capability, the shell redirects to Overview.
If the rebuild adds it, the navigation item appears without reloading the page.

### Overview

Overview becomes a concise bundle dashboard instead of a four-step sitemap.
Its first viewport contains:

- a plain-language summary of capability counts and generated targets;
- build health and the last successful build time;
- up to three relevant next actions, chosen from actual capabilities;
- the Rebuild action.

It does not repeat the same route in multiple lifecycle stages. Action links use
the normal Workbench visual language rather than unstyled browser buttons.

Diagnostics remain prominent when present. Changed files, generated-target
digests, exact build ID, provenance, and other low-level details move into an
"Inspect build details" disclosure below the primary status. The source state,
build state, diagnostics, and stale/last-good distinction remain authoritative.

### Terminology

User-facing copy uses:

- "build" for an immutable published artifact epoch;
- "current build" and "last good build" for active/stale states;
- "build ID" where the opaque identifier is genuinely useful;
- "generated output" or "target output" for emitted host artifacts.

Internal types, field names, API paths, and diagnostic codes keep `epoch` where
it is part of the established implementation contract.

### Capability pages

Every visible page starts from a valid catalog selection:

- Hooks selects the first emitted Hook and its target and provides the canonical
  example input returned by the Hook catalog.
- Playground offers only operations backed by emitted Hooks or scripts. It
  selects the first runnable operation, target, and Hook/script. Editable JSON
  is prefilled and placed under an "Advanced input" disclosure.
- MCP selects the first emitted server and target. Exact server name, timeout,
  negotiated protocol, and trace controls remain available after a session is
  opened or under advanced details.
- Evals selects the first configured suite and keeps recorded-run inspection.

An empty catalog is a route-availability decision, not a form-level empty state.
The page is therefore absent rather than rendered with disabled or blank inputs.

### Skills experience

The Skills page explains the document modes directly:

- **Authored** is the source `SKILL.md` and linked resources.
- **Generated** is the exact host-ready document in the selected target.

When authored and generated Markdown are materially identical, the page says so
and explains that only packaging/layout changed. When they differ, it summarizes
the changed frontmatter/body and offers the exact Markdown. The opaque build ID
is not used as the primary badge.

`examples/skills-starter` becomes a small real-world bundle with three Skills:

- release readiness review;
- incident triage and handoff;
- dependency upgrade planning.

Each Skill has useful references or assets, and the example README walks through
their intended use, host output, deterministic evaluation, and a repair cycle.
The example remains public-API-only and uses `workspace:*` dependencies.

## State and error handling

- While a catalog for the current build is loading, the connected shell shows a
  short "Loading bundle capabilities" state rather than incorrect navigation.
- A stale source retains the last-good catalog and labels it as such.
- A successful rebuild swaps status and capability catalog together from the
  user's perspective; old async catalog results cannot overwrite a newer build.
- A catalog failure shows a retryable error on Overview and exposes only the
  general Overview surface until recovery. It never exposes unusable forms.
- Existing foreground-generation reset behavior still clears process-scoped MCP
  sessions and page state.

## Visual direction

The Workbench remains a dense desktop developer tool, but uses progressive
disclosure:

- one clear page title and purpose sentence;
- capability/count cards and a small next-action list;
- controls grouped around the task the developer is performing;
- advanced IDs, JSON, protocol frames, and provenance inside labeled details;
- consistent primary, secondary, and text-link treatments.

No mobile-specific layout or acceptance is added.

## Verification

### Unit and component tests

- capability derivation from Skills, artifact inspection, and Eval suites;
- navigation grouping and omission for representative bundles;
- unsupported hash fallback and dynamic removal/reveal;
- last-good catalog retention across a failed build;
- plain-language Overview and Skills comparison states;
- catalog-driven Hook, Playground, MCP, and Eval defaults;
- user-facing source scan that prevents reintroducing unexplained "epoch" copy.

### Desktop browser acceptance at 1440x900

1. **Skills Starter**
   - shows Overview, Skills, Evals, Comparisons, Artifacts, and Logs;
   - does not show Hooks, MCP, or Playground;
   - direct unsupported hashes return to Overview;
   - exposes three populated Skills and honest authored/generated comparison;
   - demonstrates failed rebuild, last-good state, repair, and current evidence.
2. **Hooks and Scripts**
   - shows Hooks and Playground with runnable defaults;
   - omits Skills, MCP, Evals, and Comparisons;
   - covers populated execution plus stale diagnostic and repair.
3. **MCP App**
   - shows its full supported capability set;
   - opens a catalog-selected MCP session and rendered App;
   - exercises Hook, script, Eval, comparison, artifact, and log surfaces.
4. **Dynamic capability change**
   - add a Hook to a temporary Skills Starter copy and rebuild;
   - verify Hooks and Playground appear without page reload;
   - remove it, rebuild, and verify both disappear and an open unsupported route
     returns to Overview.

Every capture waits for loading to finish and records zero unexpected page,
console, or application-route errors. Screenshots cover the simplified Overview,
multi-Skill comparison, catalog-driven Hooks/Playground, MCP session, stale
diagnostics, and repaired build.

## Delivery

Implementation is split into incremental commits for the capability model and
routing, Overview/terminology, capability-page defaults, multi-Skill example,
and browser acceptance. Each commit must keep unrelated worktree edits intact.
The final branch is pushed to PR2 only after focused, workspace, release, and
desktop browser gates pass.
