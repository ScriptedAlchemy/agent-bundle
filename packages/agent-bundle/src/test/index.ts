/**
 * `agent-bundle/test` — the consumer test harness helpers.
 *
 * Six Node proof levels ship here, and the browser-safe seventh level ships
 * from `agent-bundle/test/browser`. The repository's real-host install proof
 * uses the same level convention. Each helper names the level it supplies,
 * stamps it into its provenance, and prints it in every failure:
 *
 * | level | helper | what it proves |
 * | --- | --- | --- |
 * | `route-unit` | `renderRoute`, `renderRouteEvents` | the route component and its document, through the real Agent renderer |
 * | `mcp-in-memory` | `openInMemoryMcpServer`, `invokeMcpTool`, `readMcpResource`, `getMcpPrompt`, `listMcpSurface` | the real generated MCP server's protocol contract, over the SDK's in-memory transport |
 * | `cli-dispatch` | `invokeCli`, `cliJson` | a compiled CLI command dispatched through the routed CLI's own shell, in this process |
 * | `packed-stdio` | `openPackedMcpServer` | a built artifact's generated entry running as a real process over stdio |
 * | `packed-deleted-source` | `removeProjectSource`, `openPackedMcpServer` | the packed stdio process still runs after project source and configuration are removed and verified absent |
 * | `browser-app` | `mountBrowserApp` (`agent-bundle/test/browser`) | production-compiled MCP App HTML mounted over the product bridge in a real browser page |
 * | `host-install` | repository real-host install proof | a built bundle accepted through a real host's public install path in an isolated home, with registration observed by that host |
 *
 * A pass at one level is never a receipt for another. The `deletedSource`
 * option upgrades `openPackedMcpServer` provenance only after every path in a
 * non-empty removal receipt is verified absent immediately before spawn.
 */
export {
  BROWSER_APP_PROOF_LEVEL,
  CLI_DISPATCH_PROOF_LEVEL,
  HOST_INSTALL_PROOF_LEVEL,
  MCP_IN_MEMORY_PROOF_LEVEL,
  PACKED_DELETED_SOURCE_PROOF_LEVEL,
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
  TestableAppDescriptor,
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
export { openPackedMcpServer, removeProjectSource } from './packed.ts';
export type {
  DeletedSourceReceipt,
  PackedMcpProvenance,
  PackedMcpSession,
  PackedMcpSessionOptions,
} from './packed.ts';
export type {
  AgentRouteModule,
  AgentRouteModuleLoader,
  RenderableRouteKind,
  RenderedRouteProvenance,
} from './types.ts';
export { validateClaudePlugin } from '../host-contracts/claude-plugin-validation.ts';
export type {
  ClaudePluginCommandResult,
  ClaudePluginCommandRunner,
  ClaudePluginValidationReport,
  ClaudePluginValidationStatus,
  ValidateClaudePluginOptions,
} from '../host-contracts/claude-plugin-validation.ts';
