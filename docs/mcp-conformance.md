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

## Task-augmented requests: deferred 2026-09-02

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
