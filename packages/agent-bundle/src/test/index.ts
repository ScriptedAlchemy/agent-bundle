/**
 * `agent-bundle/test` — the consumer test harness helpers.
 *
 * Eight Node proof levels ship here, and the browser-safe ninth level ships
 * from `agent-bundle/test/browser`. The repository's real-host install proof
 * uses the same level convention. Each helper names the level it supplies,
 * stamps it into its provenance, and prints it in every failure:
 *
 * | level | helper | what it proves |
 * | --- | --- | --- |
 * | `route-unit` | `renderRoute`, `renderRouteEvents`, `createTargetCapabilityFixture`, `projectTargetCapabilities` | the route component and its document through the real Agent renderer; explicit target-capability projection through the real MCP projector, without transport or host proof |
 * | `mcp-in-memory` | `openInMemoryMcpServer`, `invokeMcpTool`, `readMcpResource`, `getMcpPrompt`, `listMcpSurface`, `runContractMatrix` | the real generated MCP server's protocol contract, over the SDK's in-memory transport; MCP App routes are not registered and report `not-applicable` |
 * | `dev-epoch` | `runDevEpochContractMatrix` | an epoch-pinned generated stdio process opened through the Workbench session service; MCP App routes are covered (surface + `ui://` sweep) and auto-covered without a fixture |
 * | `cli-dispatch` | `invokeCli`, `cliJson`, `cliNdjson` | a compiled plain or rendered CLI command dispatched through the routed CLI's own shell, including rendered output modes, in this process |
 * | `packed-stdio` | `openPackedMcpServer`, `runPackedContractMatrix` | a built artifact's generated entry running as a real process over stdio; MCP App routes are covered (surface + `ui://` sweep) and auto-covered without a fixture |
 * | `packed-deleted-source` | `removeProjectSource`, `openPackedMcpServer({ deletedSource })`, `runPackedContractMatrix` | the packed stdio process still runs after project source and configuration are removed and verified absent; MCP App routes are covered as at `packed-stdio` |
 * | `browser-app` | `mountBrowserApp` (`agent-bundle/test/browser`) | production-compiled MCP App HTML mounted over the product bridge in a real browser page |
 * | `simulated` | `openInstalledHostMcpServer` without `sessionEvidence` | an emitted bundle staged directly into an isolated host-shaped root and spawned without a host-owned install |
 * | `host-install` | `openInstalledHostMcpServer`, `runInstalledHostContractMatrix` | a built bundle staged into an isolated host root, discovered in the host's emitted format, and spawned from the installed layout; MCP App routes are covered as at `packed-stdio` |
 *
 * Contract-matrix fixtures cover every compiled tool, prompt, and resource
 * route. App routes are auto-covered (`apps: 'auto'`, the default) wherever
 * they are registered; `{ kind: 'resource' }` names one explicitly and
 * `apps: 'explicit'` requires that for every app route.
 *
 * A pass at one level is never a receipt for another. The `deletedSource`
 * option upgrades `openPackedMcpServer` provenance only after every path in a
 * non-empty removal receipt is verified absent immediately before spawn.
 */
export {
  BROWSER_APP_PROOF_LEVEL,
  CLI_DISPATCH_PROOF_LEVEL,
  DEV_EPOCH_PROOF_LEVEL,
  HOST_INSTALL_PROOF_LEVEL,
  MCP_IN_MEMORY_PROOF_LEVEL,
  PACKED_DELETED_SOURCE_PROOF_LEVEL,
  PACKED_STDIO_PROOF_LEVEL,
  ROUTE_UNIT_PROOF_LEVEL,
  SIMULATED_PROOF_LEVEL,
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
  TestableProviderDescriptor,
  TestableRouteDescriptor,
  TestableStateDescriptor,
} from './manifest.ts';
export { AGENT_TEST_REGISTRY_VERSION, registerTestRoutes, testManifest } from './registry.ts';
export type { AgentProviderModuleLoader, AgentTestRouteRegistry } from './registry.ts';
export { AgentTestError } from './errors.ts';
export type { AgentTestErrorCode } from './errors.ts';
export { renderRoute, renderRouteEvents } from './render.ts';
export type {
  HarnessOptionsArguments,
  RenderRouteContext,
  RenderRouteContextInit,
  RenderRouteOptions,
  RenderRouteOptionsBase,
  RenderRouteTarget,
  RenderedRoute,
  RenderedRouteEvents,
} from './render.ts';
export { expectDocument } from './matchers.ts';
export type {
  AgentDocumentNodeKind,
  DocumentAssertions,
  DocumentSubject,
  MediaNodeExpectation,
  ResourceNodeExpectation,
} from './matchers.ts';
export { createTargetCapabilityFixture, projectTargetCapabilities } from './target-capabilities.ts';
export type {
  TargetCapabilityFixture,
  TargetCapabilityFixtureInput,
  TargetCapabilityProjection,
} from './target-capabilities.ts';
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
export {
  ContractMatrixViolationError,
  negativeInputsFromJsonSchema,
  runContractMatrix,
  runDevEpochContractMatrix,
  runInstalledHostContractMatrix,
  runPackedContractMatrix,
} from './contract.ts';
export type {
  ContractAppCoverage,
  ContractCheckOutcome,
  ContractCheckStatus,
  ContractEventRuntimeAddress,
  ContractResourceFixture,
  ContractLifecycleFixture,
  ContractLifecyclePhase,
  ContractLifecycleTransition,
  ContractMatrixClient,
  ContractMatrixOptions,
  ContractMatrixFailure,
  ContractMatrixProvenance,
  ContractMatrixReport,
  ContractMatrixRestartSession,
  DevEpochContractMatrixOptions,
  DevEpochContractMatrixSession,
  DevEpochMcpProvenance,
  ContractRouteFixture,
  ContractRouteReport,
  InstalledHostContractMatrixOptions,
  InstalledHostContractMatrixReport,
  PackedContractMatrixOptions,
  ResultCompatPolicy,
} from './contract.ts';
export type {
  InMemoryMcpSession,
  InMemoryMcpSessionOptions,
  InMemoryMcpSessionOptionsBase,
  McpContentBlock,
  McpInvocationOptions,
  McpProjectionProvenance,
  McpPromptResult,
  McpResourceRead,
  McpSurfaceListing,
  McpToolInvocation,
} from './mcp.ts';
export { cliJson, cliNdjson, invokeCli } from './cli.ts';
export type { CliDispatchProvenance, CliInvocation, CliRenderedEvent, InvokeCliOptions, InvokeCliOptionsBase } from './cli.ts';
export { openPackedMcpServer, removeProjectSource } from './packed.ts';
export type {
  DeletedSourceReceipt,
  PackedMcpProvenance,
  PackedMcpSession,
  PackedMcpSessionOptions,
} from './packed.ts';
export { openInstalledHostMcpServer } from './installed.ts';
export type {
  InstalledHostBinaryVersion,
  InstalledHostCheckName,
  InstalledHostCheckOutcome,
  InstalledHostEvidenceMetadata,
  InstalledHostMcpProvenance,
  InstalledHostMcpSession,
  InstalledHostObservation,
  InstalledHostVersionQuadruple,
  OpenInstalledHostMcpServerOptions,
} from './installed.ts';
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
export { validateCodexPlugin } from '../host-contracts/codex-plugin-validation.ts';
export type {
  CodexPluginCommandResult,
  CodexPluginCommandRunner,
  CodexPluginValidationReport,
  CodexPluginValidationStatus,
  ValidateCodexPluginOptions,
} from '../host-contracts/codex-plugin-validation.ts';
export { validateCursorPlugin } from '../host-contracts/cursor-plugin-validation.ts';
export type {
  CursorPluginCommandResult,
  CursorPluginCommandRunner,
  CursorPluginValidationReport,
  CursorPluginValidationStatus,
  ValidateCursorPluginOptions,
} from '../host-contracts/cursor-plugin-validation.ts';
