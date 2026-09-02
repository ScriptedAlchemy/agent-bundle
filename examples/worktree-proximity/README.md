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
  before request mounting.
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
providers execute before request state is mounted, so this provider reports
an honest unavailable result and routes read snapshots from
`(await agent()).state.read()` instead.

`worktree()` in `src/api.ts` is the issue-mandated custom Promise API over the
provider value. A `useWorktree()` React-hook variant is recorded unavailable:
the framework exposes no client-hook contract for provider values.

## Actor identity and provenance

Every identity claim records whether it came from a native envelope or was
derived:

- `session/start` observes `session:<session_id>` as the root actor.
- `agent/start` requires native `agent_id` and `session_id`, records the child,
  and records its parent session provenance as native.
- Tool envelopes contain no `agent_id`. A tool event first resolves an active
  actor already bound to the event worktree. Without an earlier binding it
  uses the explicit derived identity `worktree:<root>` and records that
  provenance; it never upgrades the derived identity to native.
- `agent/start` without native identity records an `edgeRefused` event and
  renders that parent identity is unavailable. It refuses to fabricate a
  topology edge.

Unsupported worktree, actor, parent, state, and delivery conditions are
rendered as unavailable instead of being replaced with invented evidence.

## Framework primitive wiring

Generated route workers mount the extracted `src/state.ts` definition and the
notice ledger into every request scope. `withTopology` and `withNotices` are
small capability adapters over those real handles. If a surface has no
mounted handle, they return an unavailable result and the route renders that
reason as `Agent.Context`; there is no fallback write path.

Notice admission runs once per event invocation in the render scope.
Recipient matching uses the actor identity mounted in that request, and
`(await agent()).notices.read()` exposes only deliveries attempted for that
invocation. The coordinator status therefore reports topology facts only and
does not claim a whole-ledger pending count.

## Evidence boundary

The route-unit suite is in-process real-renderer evidence: it compiles the
manifest, mounts the real state and notice handles, renders the event routes,
and exercises the documented journeys against one shared durable runtime
owner. The multi-process artifact/contract suite is the next slice and has
not run here. Neither level is proof that Claude, Codex, or another commercial
host dispatches a hook, preserves its envelope, or displays projected context
in production.

## External-driver boundary

Version 1 connects no external driver adapter and claims none. A future
external adapter must pass the framework state-driver conformance suite
before any “integrated” claim. The generated runtime's SQLite driver is the
only durable driver used by this example.
