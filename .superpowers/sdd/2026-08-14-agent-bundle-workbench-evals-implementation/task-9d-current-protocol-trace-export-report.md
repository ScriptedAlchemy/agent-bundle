# Task 9D report: current MCP protocol trace export

## Scope guard

Implemented only the browser-side current MCP protocol trace export. The export is deliberately distinct from Task 10's durable Playground session export: it has no persistence, append/finalize route, transport call, session POST, backend, hook, artifact, App, timeout, vendor, eval, or launch-config/environment/session-capability surface.

The shared Task 9C controller/session remains the sole source of truth. The MCP page uses the existing generic Blob browser-download sink, and Inspector Protocol and Logging use their existing `onExportTrace` callback with the full underlying timeline rather than a filtered or cleared presentation list.

Concurrent unrelated worktree edits (including Hooks, closure, config, and other MCP test changes) were preserved and are excluded from this commit.

## RED

Before production code, ran:

```text
npx rstest run packages/workbench/tests/mcp-page.test.ts packages/workbench/tests/inspector-session-adapter.test.ts
```

Expected RED: `packages/workbench/tests/mcp-page.test.ts` failed because `../src/mcp/mcp-protocol-trace.ts` did not exist. The new contracts covered the missing versioned builder/page trace action; the real Inspector Chrome flow was then extended to require the absent browser download wiring.

## GREEN

- Added `mcp-protocol-trace.ts`, a pure canonical builder with `kind: "agent-bundle.mcp-protocol-trace"`, `schemaVersion: 1`, explicit null session facts, full cursor/timeline/history, immediate detached JSON Blob serialization, trailing newline, JSON MIME type, and deterministic opaque-session/idle filename.
- Added the labeled MCP Trace action and explanatory copy: it exports the current browser MCP trace, not a durable Playground session export.
- Reused one generic browser Blob/download sink for Inspector config, MCP trace, and Inspector Protocol/Logging trace downloads.
- Added unit coverage for exact export shape, raw ordered entries including replay gaps/invocations, cursor/history preservation, nulls, MIME/newline/filename, detached bytes after caller mutation, sensitive launch/config/session-capability omission, page sink handoff, and complete Inspector Protocol/Logging timeline handoff.
- Extended the existing artifact-backed Inspector Chrome fixture to parse downloads from MCP Page, Inspector Protocol, and Inspector Logging; it proves matching canonical traces, the real `tools/call` payload, one session POST, no page errors, and 390 px no-overflow behavior.
- Applied explicit `undefined` `useRef` initializers in the owned entry file to satisfy the current Workbench TypeScript version without changing runtime behavior.

## Verification

All post-change commands passed:

```text
npx rstest run packages/workbench/tests/mcp-page.test.ts packages/workbench/tests/inspector-session-adapter.test.ts packages/workbench/tests/mcp-session-controller.test.ts packages/workbench/tests/mcp-session-model.test.ts
# 62 passed

npx rstest run packages/workbench/tests/inspector-shell.e2e.test.ts
# 3 passed: production legacy/real-session and development artifact coverage

npm run typecheck --workspace agent-bundle-workbench
npx rslint packages/workbench/src/mcp/mcp-protocol-trace.ts packages/workbench/src/mcp/mcp-page.tsx packages/workbench/src/main.tsx packages/workbench/tests/mcp-page.test.ts packages/workbench/tests/inspector-session-adapter.test.ts packages/workbench/tests/inspector-shell.e2e.test.ts
npm run build --workspace agent-bundle-workbench
git diff --check
```

TraceDecay MCP was unavailable. One required CLI fallback attempt failed exactly with:

```text
Error: config error: TraceDecay daemon socket '/home/zack/.tracedecay/daemon.sock' is not available. Run `tracedecay daemon install-service` and ensure the service is running.
```

Used local scoped source/test evidence after that single failed attempt. The requested code-simplifier and deslop reviews found no behavior-preserving cleanup to apply in the Task 9D hunks.
