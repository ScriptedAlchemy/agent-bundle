# Public examples and pnpm workspace design

## Context

PR #2 ships the Agent Bundle compiler, CLI, developer Workbench, package
preview workflow, and extensive integration fixtures. It does not ship a
public example project. The existing `fixtures/integration/*` projects are
test inputs: they optimize for exhaustive assertions and adversarial mutation,
not for teaching a user how to author and run an Agent Bundle plugin.

The repository currently uses npm workspaces for `packages/*`. Adding several
public example packages is the right point to adopt one explicit pnpm workspace
covering product packages and examples. The published `agent-bundle` tarball
must remain package-manager-neutral and continue to be tested in a clean npm
consumer.

## Goals

- Ship three progressive, independently runnable example projects.
- Make every example useful as readable documentation rather than as a test
  fixture.
- Populate the relevant Workbench pages with real data and interactions.
- Use one pnpm workspace and lockfile for product packages and examples.
- Keep the published package usable from npm, pnpm, and other conforming Node
  package managers.
- Validate examples in CI and exercise them in a real desktop browser.
- Capture settled desktop screenshots for healthy, populated, and diagnostic
  states.

## Non-goals

- No Turbo, Nx, or other task-graph layer.
- No mobile-specific layouts or acceptance requirements.
- No API-key-based native-host example.
- No second lockfile or nested package-manager workspace.
- No publication of example packages.
- No reuse of `fixtures/integration/*` as the public example source.
- No migration or compatibility layer for npm-workspace commands; the
  repository has one canonical contributor workflow after this change.

## Workspace architecture

The root becomes a pnpm workspace pinned through
`"packageManager": "pnpm@11.23.0"`. `pnpm-workspace.yaml` includes
`packages/*` and `examples/*`. The npm lockfile is removed and replaced by one
frozen `pnpm-lock.yaml`. Every example is private and depends on
`agent-bundle` through `workspace:*`, so it always exercises the branch under
development.

The root remains the single command surface. Existing build, test, lint,
typecheck, package-preview, and release scripts are expressed with pnpm. npm is
used only inside external-consumer release audits where the intended contract
is specifically an installed npm tarball. CI installs pnpm through Corepack,
uses the pinned package-manager version, and installs with
`pnpm install --frozen-lockfile`.

The repository layout is:

```text
examples/
├── skills-starter/
├── hooks-and-scripts/
└── mcp-app/
packages/
├── agent-bundle/
└── workbench/
pnpm-workspace.yaml
pnpm-lock.yaml
```

## Example contracts

### 1. Skills Starter

`examples/skills-starter` is the smallest useful Agent Bundle project. It
contains one well-documented Skill with one reference and one asset, a typed
`agent-bundle.config.ts`, and portable, Claude, and Codex targets. It teaches:

- package installation and config structure;
- source versus generated Skill documents;
- target selection;
- artifact inspection and provenance;
- rebuild behavior after editing Skill Markdown.

The Workbench must show populated Overview, Skills, and Artifacts pages. The
example README explains the authored inputs, generated outputs, and the exact
commands to validate, build, and launch the Workbench.

### 2. Hooks and Scripts

`examples/hooks-and-scripts` contains one session-start Hook and two scripts:
one successful script producing stdout/stderr and one deterministic non-zero
exit. It teaches:

- canonical Hook input and result shapes;
- Hook simulation and saved replay;
- Script Playground execution and ordered traces;
- live Logs filtering and detail inspection;
- diagnostic recovery while retaining the last good artifact.

The checked-in project is healthy. Its README includes one reversible
diagnostic walkthrough: temporarily change the Hook export to an invalid shape,
press Rebuild, inspect the stale-artifact diagnostic, restore the file, and
rebuild successfully. Browser acceptance performs this sequence in a temporary
copy, never by dirtying the checked-in example.

### 3. MCP App

`examples/mcp-app` contains one local MCP server with a text tool and one
official MCP App resource. The App renders a small interactive status panel and
receives the tool result through the supported MCP App bridge. A deterministic
eval verifies the tool result without requiring a native Claude or Codex login.
It teaches:

- MCP server registration;
- tool schemas and structured results;
- MCP App resource registration and preview;
- session open, catalog discovery, invocation, restart, and close;
- protocol trace and Inspector configuration export;
- deterministic eval authoring and results.

The Workbench must show a ready MCP session, populated catalogs, invocation
history, a rendered App preview, trace entries, and a completed eval.

## Package scripts and contributor flow

Each example exposes the same local scripts:

- `dev`: launch `agent-bundle dev --root .`;
- `validate`: validate the authored project;
- `build`: compile its artifacts;
- `check`: run validation and build without opening a browser.

The root exposes:

- `pnpm example:skills`;
- `pnpm example:hooks`;
- `pnpm example:mcp-app`;
- `pnpm examples:check`.

The three `example:*` commands select the example package and run its `dev`
script. `examples:check` runs each example's noninteractive `check` script. The
root README has an Examples section with a progression table and screenshots;
each example README is self-contained and begins with the shortest runnable
command.

## Data flow and error handling

Examples use only public `agent-bundle` exports and the public CLI. They must
not import repository source paths, test helpers, or fixture utilities. Their
runtime flow is the same as an external consumer:

```text
authored example → Agent Bundle config loader → compiler artifact epoch
                 → foreground dev server → Workbench routes and Agent API
```

A failed rebuild keeps the last good epoch active and publishes the new
diagnostics. The Hooks example demonstrates that state explicitly. A repaired
rebuild publishes a new active epoch and clears the stale state. Example
commands fail with the normal CLI diagnostic and exit semantics; no
example-specific error wrapper is introduced.

The native Claude and Codex harnesses remain documented as optional advanced
capabilities in the package documentation. None of these three examples needs
credentials, API keys, or a signed-in native host to complete its default
walkthrough.

## Release and CI migration

CI and package-preview workflows use the pinned pnpm version, pnpm cache, and a
frozen install. Existing Node 22.19, 24, and 26 verification remains. The fast
CI path adds `pnpm examples:check`; full test and release gates remain separate.

The release boundary stays package-manager-neutral:

- `publint` and `attw` inspect the built package;
- the package tarball is installed into an external temporary npm consumer;
- npm dependency, signature, audit, and CycloneDX SBOM checks run against that
  clean production consumer rather than pnpm's workspace store;
- packed browser tests continue exercising the installed tarball, not a
  workspace link.

The package preview workflow continues publishing only
`packages/agent-bundle` through `pkg.pr.new`. Example packages are private and
never included in preview or release publication.

## Testing and acceptance

Implementation follows test-driven development. Required automated coverage:

1. A workspace-boundary test proves both product packages and all three
   examples are selected by pnpm and that examples remain private.
2. An example contract test invokes the public CLI against each example and
   validates its expected artifact surface.
3. The Hooks example test simulates its real Hook and executes both scripts.
4. The MCP App example test opens the real MCP server, invokes its tool,
   validates the App resource, and runs its deterministic eval.
5. Release tests prove the tarball contains no examples and installs without a
   workspace dependency.

Desktop browser acceptance uses real Chrome at 1440×900 and the checked-in
examples. It must:

- wait for every route-specific loading indicator to disappear;
- capture populated Skills and Artifacts from Skills Starter;
- capture the settled Hook form and canonical result, successful and failed
  Script Playground traces, populated Logs, a stale artifact with visible
  diagnostics, and the repaired state from Hooks and Scripts;
- capture a ready MCP session, tool result, App preview, protocol trace, and
  completed eval from MCP App;
- report zero page errors, unmatched console errors, and failed application
  routes outside explicitly classified stream cancellation during navigation.

The final gate is `pnpm check`, `pnpm examples:check`, and
`pnpm check:release`, followed by the non-opt-in native gate and action/YAML
validation. Browser screenshots and a machine-readable report are stored in
the task's visualization directory and linked from the final handoff.

## Incremental delivery

1. Migrate the root workspace, lockfile, scripts, and CI from npm to pnpm while
   keeping the existing product gates green.
2. Add Skills Starter with its contract tests and documentation.
3. Add Hooks and Scripts with simulation, execution, logs, and diagnostic
   recovery coverage.
4. Add MCP App with App preview and deterministic eval coverage.
5. Add the root examples guide and command surface.
6. Run browser acceptance, fix any real interaction defects, and capture the
   settled desktop states.
7. Run the complete workspace, examples, packed-release, and CI-equivalent
   verification before pushing the final commits.

Every increment is committed separately and leaves the workspace buildable.
