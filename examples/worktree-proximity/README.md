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
  degradation. `agent-topology` exposes a read-only durable snapshot.
- **Events** — canonical shared-runtime routes observe actors, bind worktrees,
  record or clear intent, detect conflicts, render current-actor context, and
  publish or admit notices.
- **State and notices** — one workspace-durable topology definition and the
  framework notice definition share a SQLite state root. Each request opens,
  uses, and closes its stores; SQLite supplies cross-process durability and
  idempotency without a daemon.
- **Domain** — `src/domain/proximity.ts` contains all collision decisions and
  performs no I/O.

`WORKTREE_PROXIMITY_STATE_DIR` overrides storage for tests and explicit
deployments. Otherwise state lives at
`<git common dir>/agent-bundle-proximity/`, so linked worktrees share one
durable topology and notice ledger.

`worktree()` in `src/api.ts` is the issue-mandated custom Promise API over the
provider value. A `useWorktree()` React-hook variant is recorded unavailable:
main exposes no client-hook contract for provider values.

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

The topology and notice operations are custom APIs composed from public
framework primitives. Generated bundles do not yet mount `(await
agent()).state` or `(await agent()).notices` (issue #233). The application
probes those reserved request handles first and uses them when available,
then falls back to opening the SQLite driver and notice ledger for the current
request. This is application wiring, not a private framework import, and it
can disappear naturally when #233 lands.

The local notice authorizer admits this repository-scoped demonstration's
actor-addressed publications and deliveries. Recipient matching uses only the
actor axis, so it does not accidentally require a matching session or
worktree axis.

## Evidence boundary

The deterministic suite is artifact/contract integration evidence, NOT
commercial-host dispatch proof. Route-unit tests render compiled route
modules through the framework request and document contracts in-process. They
do not prove that Claude, Codex, or another commercial host invokes a hook,
preserves its envelope, or displays projected context in production.

The later real-child-process journey suite is responsible for process-level
restart and dispatch evidence. The version-1 state design is restart durable,
but this slice makes no claim that the later journey suite has run.

## External-driver boundary

Version 1 connects NO external adapter and claims none. A real external
adapter must pass the framework state-driver conformance suite before any
“integrated” claim. SQLite is the only durable driver used by this example.
