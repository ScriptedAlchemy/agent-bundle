/**
 * `agent-bundle/test` — the consumer test harness helpers.
 *
 * Stage 1 ships one proof level: `route-unit`. `renderRoute` executes a
 * compiled route module through the real Agent renderer and returns the final
 * Agent Document; the document matchers assert over the runtime's own document
 * contracts. Transport, browser, and packed-artifact levels are separate
 * helpers in later stages — nothing here stands in for them.
 */
export { compileTestManifest, testManifestFromRouteGraph, ROUTE_UNIT_PROOF_LEVEL } from './manifest.ts';
export type {
  AgentBundleTestManifest,
  AgentTestProofLevel,
  CompileTestManifestOptions,
  TestableRouteDescriptor,
} from './manifest.ts';
export { AGENT_TEST_REGISTRY_VERSION, registerTestRoutes, testManifest } from './registry.ts';
export type { AgentTestRouteRegistry } from './registry.ts';
export { AgentTestError } from './errors.ts';
export type { AgentTestErrorCode } from './errors.ts';
export { renderRoute } from './render.ts';
export type {
  RenderRouteContext,
  RenderRouteOptions,
  RenderRouteTarget,
  RenderedRoute,
} from './render.ts';
export { expectDocument } from './matchers.ts';
export type { AgentDocumentNodeKind, DocumentAssertions, DocumentSubject } from './matchers.ts';
export type {
  AgentRouteModule,
  AgentRouteModuleLoader,
  RenderableRouteKind,
  RenderedRouteProvenance,
} from './types.ts';
