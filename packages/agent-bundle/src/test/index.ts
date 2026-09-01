/**
 * `agent-bundle/test` — the consumer test harness helpers.
 *
 * Four proof levels ship here, and they are deliberately separate. Each
 * helper names the level it supplies, stamps it into its provenance, and
 * prints it in every failure:
 *
 * | level | helper | what it proves |
 * | --- | --- | --- |
 * | `route-unit` | `renderRoute`, `renderRouteEvents` | the route component and its document, through the real Agent renderer |
 * | `mcp-in-memory` | `openInMemoryMcpServer`, `invokeMcpTool`, `readMcpResource`, `getMcpPrompt`, `listMcpSurface` | the real generated MCP server's protocol contract, over the SDK's in-memory transport |
 * | `cli-dispatch` | `invokeCli`, `cliJson` | a compiled CLI command dispatched through the routed CLI's own shell, in this process |
 * | `packed-stdio` | `openPackedMcpServer` | a built artifact's generated entry running as a real process over stdio |
 *
 * A pass at one level is never a receipt for another. Browser-App surfaces
 * and deleted-source artifact proofs are later stages; nothing here stands in
 * for them.
 */
export {
  CLI_DISPATCH_PROOF_LEVEL,
  MCP_IN_MEMORY_PROOF_LEVEL,
  PACKED_STDIO_PROOF_LEVEL,
  ROUTE_UNIT_PROOF_LEVEL,
  compileTestManifest,
  proofLevelLabel,
  testManifestFromRouteGraph,
} from './manifest.ts';
export type {
  AgentBundleTestManifest,
  AgentTestProofLevel,
  CompileTestManifestOptions,
  TestManifestPluginIdentity,
  TestableRouteDescriptor,
} from './manifest.ts';
export { AGENT_TEST_REGISTRY_VERSION, registerTestRoutes, testManifest } from './registry.ts';
export type { AgentTestRouteRegistry } from './registry.ts';
export { AgentTestError } from './errors.ts';
export type { AgentTestErrorCode } from './errors.ts';
export { renderRoute, renderRouteEvents } from './render.ts';
export type {
  RenderRouteContext,
  RenderRouteOptions,
  RenderRouteTarget,
  RenderedRoute,
  RenderedRouteEvents,
} from './render.ts';
export { expectDocument } from './matchers.ts';
export type { AgentDocumentNodeKind, DocumentAssertions, DocumentSubject } from './matchers.ts';
export { expectEvents } from './events.ts';
export type {
  AgentRenderEventType,
  ProgressExpectation,
  RenderEventAssertions,
  RenderEventSubject,
} from './events.ts';
export {
  getMcpPrompt,
  invokeMcpTool,
  listMcpSurface,
  openInMemoryMcpServer,
  readMcpResource,
} from './mcp.ts';
export type {
  InMemoryMcpSession,
  InMemoryMcpSessionOptions,
  McpContentBlock,
  McpInvocationOptions,
  McpProjectionProvenance,
  McpPromptResult,
  McpResourceRead,
  McpSurfaceListing,
  McpToolInvocation,
} from './mcp.ts';
export { cliJson, invokeCli } from './cli.ts';
export type { CliDispatchProvenance, CliInvocation, InvokeCliOptions } from './cli.ts';
export { openPackedMcpServer } from './packed.ts';
export type { PackedMcpProvenance, PackedMcpSession, PackedMcpSessionOptions } from './packed.ts';
export type {
  AgentRouteModule,
  AgentRouteModuleLoader,
  RenderableRouteKind,
  RenderedRouteProvenance,
} from './types.ts';
