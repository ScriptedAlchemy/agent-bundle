# Worktree proximity

This advanced composition reference coordinates one root task and two child
agents working in linked worktrees of the same Git repository. Application
code records topology and current intent, detects path or dependency overlap,
warns the actor handling the current event, and publishes a durable notice
addressed to the other actor. The notice ledger attempts delivery on that
actor's next admitted event. No daemon and no native directed-message API are
required.

This example is intentionally not part of the newcomer path.

## Scenario

1. A `session/start` event records the root actor.
2. Two `agent/start` events bind native child actor IDs to distinct worktrees.
3. `tool/before` records current path and dependency intent.
4. The pure proximity domain compares active intents from different worktrees.
5. A conflict renders an `Agent.Context` warning with an `outcome: continue`
   result and publishes a recipient-scoped notice.
6. The other actor's next event admits the pending notice, changes its
   evidence-backed state to `attempted`, and renders its content as context.
7. `tool/after` records an empty current intent, and `stop` marks the actor
   stopped.

The demonstration dependency convention is a `deps:` string in tool input:

```json
{ "file_path": "src/shared.ts", "deps": "deps:react,zod" }
```

`Write`, `Edit`, and `Read` contribute `file_path`. Dependency names are
trimmed and compared case-insensitively. Paths are normalized to
repository-relative slash-separated paths by the domain module.

## Architecture

The application has four planes:

- **Providers** — `git-worktree` derives repository, branch, commit, common
  Git directory, and linked-worktree identity without throwing for expected
  degradation. `agent-topology` reports that its snapshot is unavailable
  because providers receive no request identity or state handle.
- **Events** — canonical shared-runtime routes observe actors, bind worktrees,
  record or clear intent, detect conflicts, render current-actor context, and
  publish or admit notices.
- **State and notices** — one workspace-durable topology definition and the
  framework notice definition share the generated runtime's SQLite driver.
  Routes use only the mounted `(await agent()).state` and
  `(await agent()).notices` handles; SQLite supplies cross-process durability
  and idempotency without a daemon.
- **Domain** — `src/domain/proximity.ts` contains all collision decisions and
  performs no I/O.

The generated runtime owns the durable root. It mounts SQLite at
`$AGENT_BUNDLE_PLUGIN_ROOT/state`, with the generated artifact root as the
fallback anchor, and mounts topology state and the notice ledger over that
same driver. The application never opens a second store from Git identity
data; `gitWorktree.commonDir` remains identity evidence only.

The issue sketch places a snapshot at `providers.agentTopology.snapshot`, but
a provider factory receives only `{ invocation, signal }` — no request
identity, no `lineage`, and no mounted `state` handle
([agent-bundle#459](https://github.com/scriptedalchemy/agent-bundle/issues/459)) —
so this provider reports an honest unavailable result and routes read
snapshots from `(await agent()).state.read()` instead.

`worktree()` in `src/api.ts` is the issue-mandated custom Promise API over the
provider value. `useWorktree()` is the hook-shaped variant for Server
Components and synchronous helpers: it reads the same request handle through
the runtime's `useAgent()`, so it follows the identical lease rules and throws
the runtime's `outside-invocation` error outside a request.

## Actor identity and provenance

Every identity claim records where it came from. `native` is read from the
host envelope (or a `request.lineage` the runtime resolved natively),
`registry`, `inferred` and `confirmed` are the runtime lineage registry's own
resolutions (`confirmed` once the host has named every edge up to the root),
and `derived` is this application's fallback:

- `session/start` observes `session:<root>` as the root actor, where the root
  is `(await agent()).lineage.root` when the runtime resolved a lineage and the
  native `session_id` otherwise.
- `agent/start` records the child and its parent from `request.lineage`
  (`subagent.id`, `parent`, `resolution`) when the runtime placed the start
  below the root — which needs the spawning `Agent`/`Task` `tool/before` to
  have passed through the same shared runtime — and from the native `agent_id`
  + `session_id` pair otherwise.
- Claude and Codex put the subagent's `agent_id` on every one of its hook
  payloads; Cursor gives the child a fresh `conversation_id` that only the
  runtime registry can bind to its `subagentStart`. A tool or stop event
  therefore resolves its actor in order of evidence: the child named by
  `request.lineage` (depth above zero), then the native `agent_id`, then the
  active actor already bound to the event worktree, and finally the explicit
  derived identity `worktree:<root>`. A carried child the topology has not
  seen is observed and bound with the provenance the evidence carried; a
  derived identity is never upgraded. A root-level tool envelope (lineage
  depth zero) resolves through the worktree binding, so intent stays
  attributed per worktree.
- `agent/start` without either lineage or native identity records an
  `edgeRefused` event and renders that parent identity is unavailable. It
  refuses to fabricate a topology edge.

`request.lineage` covers the request's own parent, root, depth, and subagent
record. Siblings, children, and other roots are not exposed
([#457](https://github.com/scriptedalchemy/agent-bundle/issues/457)), so this
application keeps its own topology state for the whole-tree view the
coordinator status reports.

Unsupported worktree, actor, parent, state, and delivery conditions are
rendered as unavailable instead of being replaced with invented evidence.

## Framework primitive wiring

Generated route workers mount the extracted `src/state.ts` definition and the
notice ledger into every request scope. `withTopology` and `withNotices` are
small capability adapters over those real handles. If a surface has no
mounted handle, they return an unavailable result and the route renders that
reason as `Agent.Context`; there is no fallback write path.

Notice admission runs once per event invocation in the render scope.
Generated event principals in v1 mount host, session, and workspace identity,
but not actor identity. Proximity notices therefore target the recipient
worktree through `recipient.workspace.root`, while their content and dedupe
keys continue to name the target actor. Lineage-addressed delivery
(`recipient.conversation` / `recipient.root` matched against
`request.lineage`) is tracked in
[agent-bundle#458](https://github.com/scriptedalchemy/agent-bundle/issues/458).
`(await agent()).notices.read()` exposes only deliveries attempted for the
current invocation; publisher-scoped visibility is
[#460](https://github.com/scriptedalchemy/agent-bundle/issues/460). The
coordinator status therefore reports topology facts only and does not claim a
whole-ledger pending count.

## Evidence boundary

The route-unit suite is in-process real-renderer evidence: it compiles the
manifest, mounts the real state and notice handles, renders the event routes,
and exercises the documented journeys against one shared durable runtime
owner. The root integration-pool suite
`packages/agent-bundle/tests/worktree-proximity-journeys.test.ts` builds the
real artifact, invokes generated hooks as separate processes against linked
Git worktrees, and proves warning, workspace-directed delivery, replay
idempotency, and exact-revision restart durability through the generated MCP
server. Journey 8 has two honesty layers: the generated wrapper fails closed
on an identity-less `SubagentStart` for host contracts that require
`agent_id`, while the route-unit suite proves the route records a refusal for
host contracts that genuinely omit it. Neither level proves that Claude,
Codex, or another commercial host dispatches a hook, preserves its envelope,
or displays projected context in production.

## External-driver boundary

Version 1 connects no external driver adapter and claims none. A future
external adapter must pass the framework state-driver conformance suite
before any “integrated” claim. The generated runtime's SQLite driver is the
only durable driver used by this example.
