# Worktree proximity

This advanced composition reference coordinates one root task and two child
agents working in linked worktrees of the same Git repository. The runtime's
lineage registry supplies the agent tree — who the root is, which children
are alive, who is a sibling — through `(await agent()).lineage`; application
code records only which worktree each agent works in and its current intent,
detects path or dependency overlap, warns the actor handling the current
event, and publishes a durable notice addressed to the other actor. The
notice ledger attempts delivery on that actor's next admitted event. No
daemon and no native directed-message API are required.

This example is intentionally not part of the newcomer path.

## Scenario

1. A `session/start` event binds the root conversation to its worktree.
2. Two `agent/start` events bind the child conversations the runtime placed
   under that root to distinct worktrees.
3. `tool/before` records current path and dependency intent.
4. The pure proximity domain compares active intents from different
   worktrees, ignoring an intent whose agent `request.lineage.tree` no longer
   lists as alive.
5. A conflict renders an `Agent.Context` warning with an `outcome: continue`
   result and publishes a notice addressed to the other actor's lineage
   conversation (`recipient.conversation`).
6. That actor's next event — and only that actor's, even when a sibling works
   in the same worktree — admits the pending notice, changes its
   evidence-backed state to `attempted`, and renders its content as context.
7. `tool/after` records an empty current intent; `agent/stop` and `stop`
   release the actor's binding and whatever intent it still held (the
   registry records the stop itself, so siblings stop seeing it).

The demonstration dependency convention is a `deps:` string in tool input:

```json
{ "file_path": "src/shared.ts", "deps": "deps:react,zod" }
```

`Write`, `Edit`, and `Read` contribute `file_path`. Dependency names are
trimmed and compared case-insensitively. Paths are normalized to
repository-relative slash-separated paths by the domain module.

## Architecture

The application has four planes:

- **Lineage** — the agent tree is the runtime's. `(await agent()).lineage`
  answers who this request is (`conversation`, `parent`, `root`, `depth`,
  `resolution`) and, through `lineage.value.tree`, who else is alive:
  `siblings` (every other live conversation under the same root, the root
  included), `children`, and other live `roots`, each with the registry's own
  `resolution` for its placement. `agentTree()` in `src/event-support.ts`
  turns that into the coordinator's report; `liveConversations()` turns it
  into the liveness the domain uses.
- **Providers** — `git-worktree` derives repository, branch, commit, common
  Git directory, and linked-worktree identity without throwing for expected
  degradation. `agent-topology` assembles the coordinator's snapshot once per
  request from the request view every provider receives: the agent tree
  `context.lineage` resolved (own chain plus the live tree), a read of the
  mounted intent state through `context.state.read()`, and the counts of the
  notices this caller published through `context.notices.published()`; each
  part carries its own availability, and the provider can only read.
- **Events** — canonical shared-runtime routes bind actors to worktrees,
  record or clear intent, detect conflicts, render current-actor context,
  release stopped actors, and publish or admit notices.
- **State and notices** — one workspace-durable intent definition (worktree
  bindings, activities, refusals) and the framework notice definition share
  the generated runtime's SQLite driver. Routes use only the mounted
  `(await agent()).state` and `(await agent()).notices` handles; SQLite
  supplies cross-process durability and idempotency without a daemon.
- **Domain** — `src/domain/proximity.ts` contains all collision decisions and
  performs no I/O.

The generated runtime owns the durable root. It mounts SQLite at
`$AGENT_BUNDLE_PLUGIN_ROOT/state`, with the generated artifact root as the
fallback anchor, and mounts intent state, the notice ledger, and its own
lineage journal over that same driver. The application never opens a second
store from Git identity data; `gitWorktree.commonDir` remains identity
evidence only.

`providers.agentTopology` is that snapshot: a provider factory receives the
request's `host`, `session`, `workspace`, `plugin`, and `lineage` — with the
live tree ([#457](https://github.com/scriptedalchemy/agent-bundle/issues/457))
— plus read-only `state` (`read()`) and `notices` (`inbox()`, `published()`)
handles ([#459](https://github.com/scriptedalchemy/agent-bundle/issues/459)),
so the coordinator `status` tool reads `providers.agentTopology` and performs
no read of its own. Event routes still use the mounted `(await agent()).state`
and `.notices` handles through `withIntent`/`withNotices`, because they
dispatch and publish.

`worktree()` in `src/api.ts` is the issue-mandated custom Promise API over the
provider value. `useWorktree()` is the hook-shaped variant for Server
Components and synchronous helpers: it reads the same request handle through
the runtime's `useAgent()`, so it follows the identical lease rules and throws
the runtime's `outside-invocation` error outside a request.

## Actor identity and provenance

Every identity claim records where it came from. `native` is read from the
host envelope (or a `request.lineage` the runtime resolved natively),
`registry`, `inferred`, `confirmed` and `transcript` are the runtime lineage
registry's own resolutions (`confirmed` once the host has named every edge up
to the root; `transcript` is read from the host's own rollout file), and
`derived` is this application's fallback:

- `session/start` binds the root conversation — `(await agent()).lineage.root`
  when the runtime resolved a lineage and the native `session_id` otherwise —
  to its worktree, under the same id `request.lineage.tree` lists it by.
- `agent/start` binds the child named by `request.lineage` (`conversation`,
  with `resolution` as the binding's provenance) when the runtime placed the
  start below the root — which needs the spawning `Agent`/`Task`
  `tool/before` to have passed through the same shared runtime — and the
  native `agent_id` otherwise. Either way the child's actor id is its lineage
  conversation (Claude and Codex spell it `agent_id`), which is what a
  directed notice targets. The edge itself (parent, depth, root) is not
  recorded: the registry holds it.
- Claude and Codex put the subagent's `agent_id` on every one of its hook
  payloads; Cursor gives the child a fresh `conversation_id` that only the
  runtime registry can bind to its `subagentStart`. A tool or stop event
  therefore resolves its actor in order of evidence: the child named by
  `request.lineage` (depth above zero), then the native `agent_id`, then the
  actor most recently bound to the event worktree, and finally the explicit
  derived identity `worktree:<root>`. A carried child not yet bound is bound
  with the provenance the evidence carried; a derived identity is never
  upgraded. A root-level tool envelope (lineage
  depth zero) resolves through the worktree binding, so intent stays
  attributed per worktree.
- `agent/start` without either lineage or native identity records an
  `edgeRefused` event and renders that parent identity is unavailable. It
  refuses to fabricate a topology edge.
- `agent/stop` and `stop` release the actor the envelope names (binding and
  intent); an identity-less stop releases nobody.

Liveness is the registry's word, not this application's: when
`request.lineage.tree` is present, an intent held by a host-identified actor
the tree no longer lists under our root is stale and warns nobody; a derived
`worktree:<root>` actor is not a conversation and is never filtered that
way; and a lineage with no tree (a payload that proved only its own chain, a
standalone hook, or none at all) presumes nothing about who stopped. The
coordinator `status` tool reports the tree the runtime resolved for *its*
call — a client no pre-tool hook window names gets an honest
`agents: unavailable`, never a tree from another caller's point of view.

Unsupported worktree, actor, parent, state, and delivery conditions are
rendered as unavailable instead of being replaced with invented evidence.

## Framework primitive wiring

Generated route workers mount the extracted `src/state.ts` definition and the
notice ledger into every request scope. `withIntent` and `withNotices` are
small capability adapters over those real handles. If a surface has no
mounted handle, they return an unavailable result and the route renders that
reason as `Agent.Context`; there is no fallback write path.

Notice admission runs once per event invocation in the render scope.
Generated event principals mount host, session, workspace, and lineage
identity, but not actor identity (#391/#444). A proximity notice is therefore
addressed to the other actor's lineage conversation —
`recipient: { conversation }`, matched against the admitting request's
`request.lineage.conversation` — so only that agent thread admits it, even
when a sibling shares its worktree and every subagent shares the root
`session_id`. An event whose lineage the runtime could not resolve (no shared
runtime, an unplaced `agent_id`) is never the addressed agent; the notice
stays pending for the next event that is. Only the application's derived
`worktree:<root>` fallback actor, which names no conversation, is still
addressed through `recipient.workspace.root`. `recipient.root` (every
conversation under one root) is available but unused here: proximity is a
message to one peer, not to the tree.
`(await agent()).notices.read()` exposes only deliveries attempted for the
current invocation, and `inbox()` only what is pending for the current
recipient. The coordinator status reports, beside the agent tree, bindings,
and intents, what became of the notices *the calling agent* published — `pending`,
`attempted`, `acknowledged`, and the other ledger states, counted by the
`agent-topology` provider from the request's own `notices.published()`
([#460](https://github.com/scriptedalchemy/agent-bundle/issues/460)). That
view is scoped by the publisher identity the ledger recorded at publish, the
agent's lineage conversation, so a status call correlated to agent B's
conversation (Claude names the pre-tool hook's `tool_use_id` in the MCP call's
`_meta`) counts agent B's notices whatever the MCP client name, session id, or
server cwd; a call whose lineage the runtime cannot resolve counts zero. It is
never a whole-ledger count and never another agent's.

## Evidence boundary

The route-unit suite is in-process real-renderer evidence: it compiles the
manifest, mounts the real state and notice handles, renders the event routes,
and exercises the documented journeys against one shared durable runtime
owner. The root integration-pool suite
`packages/agent-bundle/tests/worktree-proximity-journeys.test.ts` builds the
real artifact, invokes generated hooks as separate processes against linked
Git worktrees, and proves warning, conversation-directed delivery (the
spawning `Agent` `PreToolUse` opens the registry's spawn window and the
child's hook payloads carry its `agent_id`, as Claude's do; an event the
runtime cannot place under that child is not delivered to), replay
idempotency, exact-revision restart durability, and the registry-fed agent
tree — spawned children visible to the root's `status` call, still visible
after a server restart, gone after `agent/stop` — through the generated MCP
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
