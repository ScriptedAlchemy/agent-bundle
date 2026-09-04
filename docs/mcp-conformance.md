# MCP conformance evidence

The MCP conformance lane is intentionally opt-in. Run it locally with:

```sh
pnpm test:mcp-conformance
```

CI exposes the same command through the manually dispatched `MCP conformance`
workflow. The lane uses one Node version and one existing fixture, and uploads
the official runner's `checks.json` artifacts from `artifacts/mcp-conformance`.
It is not part of pull request, push, scheduled, or default Rstest execution.

## Transport and fixture

Generated agent-bundle MCP artifacts are managed stdio executables; they do
not expose an HTTP transport seam. The harness therefore builds the existing
`packages/agent-bundle/fixtures/route-harness` generated-route fixture through
the public build pipeline, starts the generated stdio artifact, and forwards
raw JSON-RPC frames through the official SDK's
`NodeStreamableHTTPServerTransport`. The adapter owns only loopback transport,
health checking, bounded runner execution, and teardown. Route registration,
Flight rendering, schemas, and responses remain the generated artifact's
logic.

The copied fixture is narrowed to its MCP routes before building. Its state,
event, and CLI sources are omitted because conformance needs one generated MCP
surface and must not add the packed fixture's separate npm-install journey.

## Recorded run: 2026-09-02

- Runner: `@modelcontextprotocol/conformance@0.1.16`
- Suite: `server --suite active`
- Specification: `2025-11-25`
- Scenarios: 30 total; 7 passed, 23 expected failures, 0 skipped
- Unexpected failures: 0

The dated expected-failure baseline is
`packages/agent-bundle/tests/fixtures/mcp-conformance-expected-failures.yml`.
It records three unsupported generated-server operation families
(`completion/complete`, `logging/setLevel`, and resource subscriptions) plus
the canonical content-specific tools, resources, and prompts that the reused
route harness does not provide. The official runner rejects both unexpected
failures and stale baseline entries, so newly fixed scenarios must be removed
from the baseline.

## Task-augmented requests: served 2026-09-04

Issue [#369](https://github.com/ScriptedAlchemy/agent-bundle/issues/369) (the #96
acceptance remainder) is implemented for generated route servers: a tool route
that declares `config.execution.taskSupport` (`optional` or `required`,
validated as `AB4836` and advertised in `tools/list`) may be called as a task
under the MCP `2025-11-25` Tasks utility. The `2026-09-02` deferral recorded
below was lifted after re-auditing the installed SDK.

What the audit found on `@modelcontextprotocol/server@2.0.0` /
`@modelcontextprotocol/client@2.0.0` (unchanged since the deferral):

- The task methods are outside the SDK's typed spec-method surface, but the
  SDK's documented custom-method form — `setRequestHandler(method, { params },
  handler)` on the server and `request(request, resultSchema)` on the client —
  routes them, and the SDK exports their result schemas publicly as
  `specTypeSchemas.CreateTaskResult`, `GetTaskResult`, `CancelTaskResult`,
  `ListTasksResult` (the deferral note's "not exported publicly" was wrong; they
  are keyed without the `Schema` suffix). On a `2025-11-25` session the SDK's
  own method registry admits `tasks/*`; on `2026-07-28` it answers `-32601`
  before any handler and its codec strips `execution.taskSupport` and
  `capabilities.tasks`, so a modern-revision client keeps the ordinary contract.
- The SDK's `tools/call` result validation admits `CallToolResult` only and
  refuses a `task` body. The lifecycle therefore lives in a `Server` subclass
  (`packages/agent-bundle/src/mcp-tasks.ts`) whose `_wrapHandler` — the SDK's
  documented protected seam for role-specific request handling — answers a
  task-augmented request with a `CreateTaskResult` and runs the SDK-validated
  handler behind the task. Nothing reaches past the SDK's public or protected
  surface.
- The `2026-07-28` revision moves tasks to the `io.modelcontextprotocol/tasks`
  extension (SEP-2663) with a different shape (`resultType: "task"`,
  `tasks/update`, no `tasks/result`/`tasks/list`). This SDK release does not
  implement that extension; the generated server serves the core `2025-11-25`
  shape only and is gated on the negotiated protocol version. Serving the
  extension is a follow-up that inherits the same route contract.

Behaviour (proven at the `mcp-in-memory` level by
`packages/agent-bundle/tests/projection/mcp-in-memory.test.ts`, at the unit
level by `packages/agent-bundle/tests/mcp-tasks.test.ts`, and over real stdio
framing by `packages/agent-bundle/tests/packed-stdio-projection.test.ts`):

- A server with at least one opted-in tool declares
  `capabilities.tasks: { list, cancel, requests: { tools: { call } } }`; a
  server with none declares nothing and processes a task-augmented request as
  an ordinary one (the fallback the utility requires of a receiver without the
  capability).
- `tools/call` with `params.task` on an opted-in tool answers a
  `CreateTaskResult` (status `working`, honoured `ttl` ≤ 24 h, `pollInterval`
  ≥ 100 ms, `_meta["io.modelcontextprotocol/model-immediate-response"]`);
  on a `forbidden` tool it is `-32601`; an ordinary call to a `required` tool
  is `-32601`.
- `tasks/get` reports `working` with the latest render progress
  (`statusMessage`, `_meta["agent-bundle/progress"]`), `completed`, `failed`
  (a result with `isError: true`, as the spec requires), or `cancelled`.
- `tasks/result` blocks until the task settles and returns exactly what the
  ordinary call would have returned, stamped with
  `_meta["io.modelcontextprotocol/related-task"]`; a JSON-RPC error is
  returned as that error.
- `tasks/cancel` transitions to `cancelled` before answering and aborts the
  render through its `AbortSignal`; cancelling a settled task is `-32602`, as
  is any unknown `taskId`. `tasks/list` pages the session's tasks by cursor.
- Progress notifications flow only under the client's own `progressToken`,
  stamped with the related-task key; the task observes progress either way.
  Records are session-scoped, retained for `ttl` after settling, bounded at
  256 per server, and cancelled when the session closes.
- The operation-based `createRscMcpServer` (`@agent-bundle/runtime/plugin`) is
  unchanged: no `tasks` capability, ordinary processing.

The conformance lane (`server --suite active`, specification `2025-11-25`)
does not yet exercise the Tasks utility; when the official runner adds task
scenarios, the reused route harness's `wait` and `catalog` tools already
declare `execution.taskSupport: "optional"`.

### Deferral record (2026-09-02, lifted)

The section below is the dated deferral as recorded by #394, kept for the
audit trail. Its sentinel test (`packages/rsc-runtime/tests/mcp-tasks-deferral.test.ts`)
and the `@ts-expect-error` sentinel in `mcp-in-memory.test.ts` were removed
with the implementation; the SDK pin itself is unchanged.

#### Original text

Issue [#369](https://github.com/ScriptedAlchemy/agent-bundle/issues/369) tracks
the #96 acceptance remainder: a task-augmented `tools/call` that returns a
`CreateTaskResult` and resolves through `tasks/get` / `tasks/result`, with
`tasks/cancel` mapped into the renderer `AbortSignal`. It is deferred because
the installed SDK has no task runtime to build on; the repository does not
hand-roll the protocol outside the SDK's typed surface.

Audited state (2026-09-02):

- Generated servers use `@modelcontextprotocol/server@2.0.0` with
  `@modelcontextprotocol/client@2.0.0` for in-memory proof; both share
  `@modelcontextprotocol/core@2.0.0`. Their latest core protocol revision is
  `2025-11-25`, the revision this conformance lane records.
- The SDK ships the `2025-11-25` task wire vocabulary as importable types only.
  Its own declaration states that `tasks/get`, `tasks/result`, `tasks/list`,
  `tasks/cancel`, and `notifications/tasks/status` are "wire vocabulary with no
  SDK runtime": the typed `request()`, `setRequestHandler()`, and
  `ctx.mcpReq.send()` surfaces exclude them, the client refuses to issue them
  as spec methods, the only task-named runtime exports are
  `RELATED_TASK_META_KEY` and a deprecated `isTaskAugmentedRequestParams`
  guard, and no `TaskStore` or `experimental.tasks` namespace exists (the 1.x
  experimental API was not carried into v2).
- The `2026-07-28` specification revision moved tasks out of the core protocol
  into the `io.modelcontextprotocol/tasks` extension
  ([SEP-2663](https://github.com/modelcontextprotocol/modelcontextprotocol/issues/2663)):
  `tasks/result` and `tasks/list` are gone, polling goes through `tasks/get`,
  and `tasks/update` is new. Implementing the `2025-11-25` core shape now would
  target a surface the next revision removes. The SDK tracks the extension in
  [typescript-sdk#2189](https://github.com/modelcontextprotocol/typescript-sdk/issues/2189)
  (open, "needs decision"); reported v2 gaps include custom `tasks/get` /
  `tasks/cancel` handlers being unreachable on a `2026-07-28` session
  ([#2598](https://github.com/modelcontextprotocol/typescript-sdk/issues/2598))
  and `Client.callTool()` rejecting a `CreateTaskResult`
  ([#2637](https://github.com/modelcontextprotocol/typescript-sdk/issues/2637)).

Behaviour while deferred (fail-closed, both proven at the `mcp-in-memory`
level):

- Generated servers never advertise a `tasks` capability, even to a client that
  negotiated one, so no client is invited into a lifecycle the server cannot
  serve.
- A `tools/call` carrying task augmentation is processed as an ordinary request
  and returns one final `CallToolResult` with no task handle — the behaviour
  the `2025-11-25` Tasks utility requires of a receiver that declared no task
  capability for that request type. `tasks/get`, `tasks/result`, `tasks/list`,
  and `tasks/cancel` answer with JSON-RPC `-32601`.
- Ordinary progress-token gating and the single final `CallToolResult` pinned
  by #175 are unchanged.

Unblock condition: a published `@modelcontextprotocol/server` /
`@modelcontextprotocol/client` release that routes task operations through its
typed surface — a server-side task store or `registerTool` task handler, a
typed client path for `CreateTaskResult` and task polling, and a `tasks`
capability the SDK itself gates — for whichever revision the conformance lane
then records. `packages/rsc-runtime/tests/mcp-tasks-deferral.test.ts` pins the
audited SDK version and asserts each fact above against the installed
packages; when one stops holding, that test (or `pnpm typecheck`, through its
`@ts-expect-error` sentinel on `setRequestHandler('tasks/get', …)`) fails and
this section must be re-audited before the pin is moved.
