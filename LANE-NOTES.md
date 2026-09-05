# Lane W6 notes

## Files and behavior

- Added `packages/workbench/src/shell/wire-text.ts` and rewired both Raw Logs and Trace clients to share control-character and path-like-text validation.
- Raw Logs now accepts slash-bearing relative identities in summaries/details while continuing to reject absolute POSIX, home-relative, drive-letter, UNC, and `file:` paths.
- Moved `mcpCorrelationMetaKey` to `packages/agent-bundle/src/contracts/mcp-session.ts`; the dev trace publisher, Workbench controller, and remote transport now import that source.
- Added optional bounded `correlationId` fields to runtime MCP and MCP App tool-call contracts, then preserved the field through Workbench request canonicalization, runtime/App route decoders, preview execution, and runtime binding execution.
- Added focused coverage in LogClient, Workbench MCP controller/client/transport, runtime MCP routes, MCP App routes, preview service, binding service, and trace publisher tests.

## Cross-lane requests

- The integration lane should add the PR's single package changeset; proposed line: `Propagate Workbench correlation IDs through runtime MCP App tool calls and accept safe slash-bearing Raw Logs text. (#600)`
- `DevRuntimeMcpOperationRequest.correlationId` now reaches the provider-owned `RuntimeMcpExecutionContext.request`. This checkout has no package-owned adapter that turns that runtime operation into MCP `tools/call` params; a provider that emits an MCP frame must stamp it as `params._meta[mcpCorrelationMetaKey]`.

## Open risks

- `contracts/mcp-session.ts` is a browser-safe internal contract consumed by Workbench through the repository's existing source import pattern; `package.json` does not expose a separate `./mcp-session` npm subpath.
- No hand-written English or Chinese documentation page lists this internal contract constant, so no website files were changed.

## Verification

- `pnpm build`
- `npx tsc --noEmit`
- `npx tsc --project packages/workbench/tsconfig.json --noEmit`
- `pnpm lint`
- Affected unit files under `rstest.unit.config.ts`: 183 tests passed.
- Full `rstest.route-unit.config.ts` pool: 85 tests passed.
- `packages/workbench/tests/logs-real.e2e.test.ts`: passed.
- `packages/workbench/tests/audiobook-curator.acceptance.e2e.test.ts`: passed.
- Dead-module check: `wire-text` has two production importers (`log-client.ts`, `trace-client.ts`).
- Deslop: GPT-5.6 Sol, 0 follow-up edits.

## Diagnostic codes

- Existing decoder and runtime validation codes remain unchanged: `AB8093`, `AB8015`, and `AB8203`.
- No diagnostic codes were added or removed.
