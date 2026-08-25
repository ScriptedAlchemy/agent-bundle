# Public Examples and Workbench UX Design

## Purpose

Agent Bundle is a developer workstation for authoring one plugin bundle and
turning it into host-ready Claude Code, Codex, and portable artifacts. The
three public examples must teach that workflow through realistic source
material, while the Workbench must explain what each surface does before it
exposes immutable epochs, digests, traces, and protocol detail.

The repository remains desktop-only. Acceptance targets a 1440×900 Chrome
viewport and desktop keyboard/mouse interaction. Mobile-specific behavior is
outside this design.

## Product shape

Keep the three approved example packages. Small recipes remain useful, but the
MCP App example also becomes the integrated end-to-end showcase.

### Skills Starter: release readiness review

`examples/skills-starter` models a release-readiness reviewer instead of a
minimal Markdown stub. Its authored Skill explains when it applies, required
inputs, a repeatable workflow, severity rules, evidence requirements, and the
final verdict. Supporting references contain a release policy and verification
matrix; the report asset is a reusable output contract.

The example includes a credential-free deterministic eval whose explicit
invocation references `release-review`. The Workbench therefore shows real eval
coverage beneath the Skill instead of an empty coverage panel.

### Hooks and Scripts: release automation

`examples/hooks-and-scripts` models a release preparation session. Its
`sessionStart` Hook injects actionable release context. `verify-release`
inspects a checked-in release manifest and succeeds with useful evidence;
`detect-risk` inspects a checked-in risk record and exits non-zero with a clear
blocking finding. The failure is deliberate product behavior, not an arbitrary
`process.exitCode = 2` demonstration.

The Hooks surface starts with a canonical event-shaped JSON document so its
primary action succeeds without requiring users to reverse engineer the host
contract. Playground preselects the sole target, selects Script execution when
the artifact publishes scripts, and selects the first available script.

### MCP App: integrated service-readiness assistant

`examples/mcp-app` becomes the unified showcase. It retains a local MCP server
and App, and adds a service-readiness Skill, a session-start Hook, a release
check script, and Claude/Codex/portable targets. The MCP tool returns structured
service health with healthy and degraded states, a summary, and individual
checks. The App renders that structured result as a useful readiness panel.

Its deterministic eval remains credential-free and proves the checked-in
healthy service fixture. The Workbench walkthrough crosses Skills, Hooks,
Playground, MCP, Evals, Logs, Artifacts, and the expected empty Comparisons
state so users see one source bundle expressed across every station.

## Workbench information architecture

### Overview

Rename the primary concept from a generic project overview to a bundle
dashboard. Lead with a concise explanation and a four-step workflow:

1. Author Skills, Hooks, scripts, and MCP capabilities.
2. Build an immutable artifact epoch for selected hosts.
3. Exercise the emitted behavior in Skills, Hooks, Playground, and MCP.
4. Evaluate, compare, and inspect durable evidence.

The existing normalization, epoch, target, diagnostic, changed-file, and
rebuild sections remain authoritative. The workflow is navigation, not a
second source of project state.

### Skills

Explain that the page renders the authored `SKILL.md`, its linked resources,
the immutable host-generated document, and authored eval coverage. Use human
labels such as “Generated for Codex” in the primary document label; keep the
exact epoch identity in provenance detail. Empty states explain how to add a
Skill rather than merely reporting that none exists.

### Hooks

Provide canonical default documents for `sessionStart`, `beforeTool`,
`afterTool`, and `stop`. Selecting a different Hook updates the default only
until the user edits the draft. Failures point users back to the selected
event’s canonical fields and preserve the server-provided diagnostic.

### Playground

Preserve server-owned admission and evidence. Improve only initial choices:
select the first valid target, prefer Script execution when scripts exist, and
select the first script for that target. Explicit user selections remain
stable across catalog refreshes when still valid.

### MCP

Load the active epoch’s strict artifact inspection in `McpScreen`. Supply its
MCP server catalog to `McpPage`, preselect the sole/first valid target and
server, and retain an editable catalog-backed server input. Session lifecycle,
protocol trace, Inspector, and App preview behavior remain unchanged.

### Evals

Rename the trial field to “Trial override (leave blank to use authored count).”
No eval protocol or persistence contract changes.

## Error and diagnostic behavior

The checked-in examples start healthy. The Hooks example retains the reversible
syntax-error walkthrough: a failed rebuild shows source diagnostics and keeps
the last good epoch; restoring the file and rebuilding publishes a new current
epoch. Browser acceptance must wait for each loading state to settle before it
captures or asserts a page.

Expected script blockers are successful Workbench interactions whose trace
records a non-zero exit code. Unexpected page errors, console errors, and
unclassified request failures remain test failures.

## Compatibility and scope

- Examples use only public `agent-bundle` exports and `workspace:*` dependencies.
- CLI usage remains `pnpm dev`, `pnpm build`, and `pnpm validate` from each
  example directory; project roots continue to be inferred from the current
  directory.
- No version aliases, migrations, compatibility branches, new transport
  protocol, or mobile layout are introduced.
- pkg.pr.new continues to publish only `packages/agent-bundle`; example
  workspaces remain private and are never preview-published.

## Acceptance evidence

Automated acceptance must prove:

- every example validates and builds through public APIs;
- Skills source/generated/resource/eval coverage states are populated;
- Hook simulation and replay succeed from the default draft;
- both release scripts produce expected success/blocking evidence;
- MCP target/server defaults open a session without manual binding entry;
- the service tool and App render a degraded service with individual checks;
- deterministic eval, Logs, Artifacts, and empty Comparisons render correctly;
- diagnostic → stale epoch → repair → current epoch works in real Chrome;
- no capture occurs while a loading state is visible; and
- the final showcase is open in X11 Chrome and Cursor after all release gates.

