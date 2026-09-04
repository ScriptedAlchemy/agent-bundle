import { execFile as executeFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { Effect } from 'effect';

import { capabilityIsSupported, unavailableCapability } from './adapters/capability-state.ts';
import { createDefaultRegistry, TargetRegistry } from './adapters/registry.ts';
import type { TargetArtifactEntry, TargetHookEntry } from './adapters/types.ts';
import { build as buildArtifact, type BuildResult } from './build/build.ts';
import { routedCliBins, targetHostsCliBin } from './build/cli-bins.ts';
import { buildPackageOutputs, type PackageBuildResult } from './build/package-build.ts';
import {
  packInventoryDiagnostics,
  packOutputFromJson,
  type PackOutput,
} from './build/pack-inventory.ts';
import type { CapabilityEvidence, CapabilityState } from './core/capabilities.ts';
import {
  agentComponentKinds,
  componentKindCapabilityName,
  featureCapabilityName,
  type AgentComponentKind,
} from './core/components.ts';
import { isInsideOrEqual } from './core/paths.ts';
import {
  stateDefinitionProjection,
  type StateNoticeRetentionProjection,
  type StateProjectionBudgets,
  type StateProjectionDriver,
} from './core/state-inspection.ts';
import { emptyCompiledRouteGraph } from './routes/graph.ts';
import { inspectRouteGraph, type RouteGraphInspection } from './routes/inspect.ts';
import { mcpServerStateDirectory, runMcpForeground } from './services/mcp-run.ts';
import { deepFreeze } from './core/freeze.ts';

export { compileRouteGraph, emptyCompiledRouteGraph, isEmptyRouteGraph } from './routes/graph.ts';
export { canonicalAgentEvents } from './routes/public.ts';
export type {
  AgentEventCanonicalIdentity,
  AgentEventDelivery,
  AgentEventFallbackMode,
  AgentEventNativePayload,
  AgentEventProvenance,
  AgentEventRouteConfig,
  AgentEventRouteProps,
  AgentEventRuntimeMode,
  AgentProviderContext,
  AgentProviderFactory,
  AppRouteConfig,
  CanonicalAgentEvent,
  PromptConfig,
  ResourceConfig,
  RouteSchema,
  RouteSchemaOutput,
  ToolConfig,
  ToolRouteProps,
} from './routes/public.ts';
export { inspectRouteGraph } from './routes/inspect.ts';
export type { RouteGraphInspection } from './routes/inspect.ts';
export { emptyRouteConfig } from './routes/types.ts';
export type {
  CapabilityEvidence,
  CapabilityState,
  CompiledAgentRoute,
  CompiledCliMode,
  CompiledCliSurface,
  CompiledProvider,
  CompiledRouteGraph,
  CompiledRouteKind,
  CompiledServerMode,
  CompiledServerSurface,
  RouteProvenance,
} from './routes/types.ts';
export type { BuildResult } from './build/build.ts';
export type { PackageBuildResult, PackageOutputFile } from './build/package-build.ts';
export type { ArtifactOutputKind, ArtifactOutputProvenance } from './build/provenance.ts';
export type { ProjectContext, ProjectSourceInput, ProjectSourceSnapshotInput } from './core/project-context.ts';
export type {
  ArtifactManifestAgentSkills,
  ArtifactManifestFile,
  ArtifactManifestFileKind,
  ArtifactManifestProducer,
  ArtifactManifestProject,
  ArtifactManifestRuntime,
  ArtifactManifestSourceInput,
  ArtifactManifestTarget,
  ArtifactManifestTargetSchema,
  ArtifactManifestTargetValidation,
  ArtifactManifest,
  ArtifactManifestValidation,
  ArtifactManifestValidationRecord,
  ArtifactManifestValidationStatus,
  AssembledArtifactManifest,
} from './build/manifest.ts';
export {
  assembleArtifactManifest,
  parseArtifactManifest,
  serializeArtifactManifest,
} from './build/manifest.ts';
import { composeBundlerInspection, type BundlerInspection } from './build/inspect-bundler.ts';
import { defaultPackageArtifactDistPath } from './config/normalize.ts';
export type { BundlerInspection, BundlerInspectionEntry } from './build/inspect-bundler.ts';
import { validateArtifact, validateArtifactWithSnapshot } from './build/validate-artifact.ts';
import { freezeDiagnostics, hasErrors, DiagnosticError, type Diagnostic } from './core/diagnostics.ts';
export type { Diagnostic, DiagnosticSeverity } from './core/diagnostics.ts';
import type { ProjectContext } from './core/project-context.ts';
import type { NormalizedPlugin } from './core/types.ts';
import {
  validateClaudePlugin,
  type ClaudePluginCommandRunner,
  type ClaudePluginValidationReport,
} from './host-contracts/claude-plugin-validation.ts';
import {
  validateCodexPlugin,
  type CodexPluginValidationReport,
} from './host-contracts/codex-plugin-validation.ts';
import {
  validateCursorPlugin,
  type CursorPluginValidationReport,
} from './host-contracts/cursor-plugin-validation.ts';
import {
  validatePortablePlugin,
  type PortablePluginValidationReport,
} from './host-contracts/portable-plugin-validation.ts';
import type { EvalComparison } from './eval/compare.ts';
import { EvalRunStoreError } from './eval/errors.ts';
import {
  EvalService,
  EvalServiceError,
  type EvalRunResult,
  type EvalRunSelection,
  type EvalServiceErrorCode,
} from './dev/eval/eval-service.ts';
export { EvalService, EvalServiceError } from './dev/eval/eval-service.ts';
export type { EvalComparison } from './eval/compare.ts';
export type {
  EvalAssertionSummary,
  EvalCaseSummary,
  EvalRunRequest,
  EvalRunResult,
  EvalRunSelection,
  EvalServiceErrorCode,
  EvalServiceNativeOptions,
  EvalServiceOptions,
  EvalSuiteListing,
  EvalSuiteSummary,
} from './dev/eval/eval-service.ts';
import {
  ProjectService,
  projectDiagnostic,
  type PreparedProject,
} from './dev/project-service.ts';
import {
  HookService,
  type HookListOptions,
  type HookSimulationOptions,
} from './services/hook-service.ts';
import {
  McpService,
  type McpInvokeOptions,
  type McpInvokeResult,
  type McpListOptions,
  type McpListResult,
} from './services/mcp-service.ts';
// Imported after the service modules on purpose: the position of
// `effect/lift.ts` in the module graph fixes its position in the emitted
// hook bundles, and this order keeps those bundles byte-identical.
import { runWithPlatform, withTempDirectory } from './effect/platform.ts';
import { liftPromise } from './effect/lift.ts';

export {
  compareInstalledHostContract,
  compareLocalHostContract,
  evaluateHostContract,
  nativeHostContractComparisonEnabled,
  parseHostContractManifest,
  parseRedactedEventEnvelopes,
} from './host-contracts/host-contract.ts';
export type {
  CompareInstalledHostContractOptions,
  HostContractCommand,
  HostContractCommandResult,
  HostContractCommandRunner,
  HostContractDiagnostic,
  HostContractEvidence,
  HostContractHelpProbe,
  HostContractManifest,
  HostContractProbe,
  HostContractProbeKind,
  HostContractReport,
  HostContractStatus,
  NativeHost,
  RedactedEventEnvelope,
} from './host-contracts/host-contract.ts';
export { validateClaudePlugin, validateCodexPlugin, validateCursorPlugin, validatePortablePlugin };
export type {
  ClaudePluginValidationReport,
  CodexPluginValidationReport,
  CursorPluginValidationReport,
  PortablePluginValidationReport,
};

export { HookService } from './services/hook-service.ts';
export type { HookListOptions, HookSimulationOptions } from './services/hook-service.ts';
export { createDefaultRegistry, TargetRegistry } from './adapters/registry.ts';
export { CapabilityStateError, capabilityStateNames, isCapabilityState } from './core/capabilities.ts';
export type {
  NoticeDeliveryAdvertisement,
  NoticeDeliveryRoute,
  NoticeDeliveryRouteState,
  TargetAdapter,
  TargetAdapterMetadata,
  TargetArtifactCopy,
  TargetArtifactDocumentContract,
  TargetArtifactDocumentIssue,
  TargetArtifactDocumentValidator,
  TargetArtifactEntry,
  TargetArtifactPlan,
  TargetArtifactSchemaContract,
  TargetArtifactValidationContract,
  TargetArtifactWrite,
  TargetConfigExtension,
  TargetHookEntry,
  TargetHookWrapper,
  TargetSchemaDescriptor,
} from './adapters/types.ts';
export type { TargetHookContract } from './adapters/hook-contract.ts';
export type {
  McpRuntimeRoots,
  McpRuntimeValueField,
  McpRuntimeValueResolution,
  ModernMcpServer,
  ModernMcpServerReadResult,
  ModernMcpStdioServer,
  ModernMcpStreamableHttpServer,
  TargetMcpRuntimeContract,
} from './services/mcp-runtime.ts';
export { McpService } from './services/mcp-service.ts';
export type {
  McpConnectionState,
  McpInvokeOptions,
  McpInvokeResult,
  McpListOptions,
  McpListResult,
  McpOperationOptions,
} from './services/mcp-service.ts';
export { startDevServer } from './dev/workbench-server.ts';
export type { DevServerSession, StartDevServerOptions } from './dev/workbench-server.ts';
export type {
  AgentBundleDevConfig,
  AgentBundleDevContractsConfig,
  AgentBundleDevRuntimeConfig,
} from './core/types.ts';
// The `dev.runtime.provider` protocol (#485): everything a provider module
// accepts through `start()` or hands back through its session, the two errors
// a provider throws to get the documented Workbench behaviour, and the
// generation store and MCP registry a session drives. Test-only services
// (`ProjectService`, `EpochStore`, the provider loader) stay internal.
export {
  DevRuntimeGenerationConflictError,
  DevRuntimeUnavailableError,
} from './dev/runtime-provider.ts';
export type {
  CreateDevRuntimeProvider,
  DevRuntimeClientSurfaceEndpoint,
  DevRuntimeEventInput,
  DevRuntimeMcpRegistry,
  DevRuntimeMcpRegistryListener,
  DevRuntimeMcpRegistryMessage,
  DevRuntimeMcpRegistrySubscription,
  DevRuntimeMcpSession,
  DevRuntimeMcpSessionCloseObservation,
  DevRuntimeMcpSessionExecuteOptions,
  DevRuntimeMcpSessionView,
  DevRuntimePreparedMcpApp,
  DevRuntimePreparedMcpServer,
  DevRuntimePreparedProject,
  DevRuntimeProvider,
  DevRuntimeSession,
  DevRuntimeStartContext,
} from './dev/runtime-provider.ts';
export type {
  DevRuntimeAsset,
  DevRuntimeAssetRequest,
  DevRuntimeDescriptor,
  DevRuntimeDiagnostic,
  DevRuntimeDiagnosticPhase,
  DevRuntimeFixture,
  DevRuntimeInspectionEnvelope,
  DevRuntimeInvocationRequest,
  DevRuntimeMcpAppRunBinding,
  DevRuntimeMcpConnectionState,
  DevRuntimeMcpInvalidatedBinding,
  DevRuntimeMcpOperationRequest,
  DevRuntimeMcpOperationResult,
  DevRuntimeMcpRegistryReconcileInput,
  DevRuntimeMcpRegistryReconcileResult,
  DevRuntimeMcpRegistryReplayGap,
  DevRuntimeMcpRegistrySnapshot,
  DevRuntimeMcpServerDescriptor,
  DevRuntimeMcpSessionBinding,
  DevRuntimeMcpSessionControlRequest,
  DevRuntimeMcpSessionRequest,
  DevRuntimeMcpSessionSnapshot,
  DevRuntimeReplayRequest,
  DevRuntimeRun,
  DevRuntimeStateIdentity,
  DevRuntimeStateResetRequest,
  DevRuntimeStatus,
  DevRuntimeSurface,
  DevRuntimeTraceSpan,
  DevRuntimeTreeNode,
  RuntimeVector,
} from './dev/runtime-protocol.ts';
export {
  RuntimeGenerationStore,
  RuntimeGenerationStoreCloseError,
  RuntimeGenerationStoreError,
} from './dev/runtime-generation-store.ts';
export type {
  RuntimeGeneration,
  RuntimeGenerationActivationGuard,
  RuntimeGenerationAsset,
  RuntimeGenerationCandidate,
  RuntimeGenerationCloseFailure,
  RuntimeGenerationLease,
  RuntimeGenerationManifest,
  RuntimeGenerationManifestInput,
  RuntimeGenerationMetadataCodec,
  RuntimeGenerationPrepareOptions,
  RuntimeGenerationPreparedActivation,
  RuntimeGenerationStoreErrorCode,
  RuntimeGenerationStoreOptions,
  RuntimeGenerationValidationInput,
  RuntimeGenerationValidator,
} from './dev/runtime-generation-store.ts';
export {
  RuntimeMcpRegistry,
  RuntimeMcpRegistryCloseError,
  RuntimeMcpRegistryError,
} from './dev/runtime-mcp-registry.ts';
export type {
  RuntimeMcpCommittedActivationReconcile,
  RuntimeMcpConnection,
  RuntimeMcpConnector,
  RuntimeMcpExecutionContext,
  RuntimeMcpExecutionValue,
  RuntimeMcpPreparedActivationReconcile,
  RuntimeMcpRegistryCloseFailure,
  RuntimeMcpRegistryErrorCode,
  RuntimeMcpRegistryOptions,
} from './dev/runtime-mcp-registry.ts';

export interface StructuredLogger {
  log?(event: string, details: Readonly<Record<string, unknown>>): void;
}

export interface ProjectOptions {
  readonly configPath?: string;
  readonly logger?: StructuredLogger;
  readonly mode?: string;
  /** Advanced adapter registry used for every source, artifact, and runtime operation. */
  readonly registry?: TargetRegistry;
  readonly root: string;
  readonly targets?: readonly string[];
}

export interface ValidateOptions extends ProjectOptions {
  readonly artifact?: string;
  /** Run installed host developer tools for compatible built targets. */
  readonly hostValidation?: boolean;
  /** Promote host-tool warnings to errors. */
  readonly strict?: boolean;
}

export interface ValidateResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly hostValidation?: readonly (
    | ClaudePluginValidationReport
    | CodexPluginValidationReport
    | CursorPluginValidationReport
    | PortablePluginValidationReport
  )[];
  readonly model?: NormalizedPlugin;
}

export type InspectionSkipReason = 'excluded-by-targets' | 'unsupported-capability';

export type { AgentComponentKind } from './core/components.ts';
export { agentComponentKinds, componentKindCapability, componentKindCapabilityName } from './core/components.ts';

/**
 * The canonical component kinds inspection accounts for (#100). `hook` is a
 * config-declared hook escape hatch; `event-route` is a filesystem
 * `src/events` route judged per canonical event (`event:<name>` rows).
 */
export type InspectionComponentKind = AgentComponentKind;

/**
 * The target's own four-state judgment of the capability a component needs,
 * named so a reader can find the pinned row. Scripts need no host capability
 * and carry none; the routed CLI bin (`cli`) needs the target's `cli` row
 * (#387).
 */
export type InspectionComponentCapability = CapabilityState & { readonly name: string };

/**
 * One host feature a selected component uses that this target cannot express
 * (#100 feature sets): the component still ships, minus the feature, and the
 * host's own `<kind>.<feature>` row explains why.
 */
export interface InspectionOmittedFeature {
  readonly capability: InspectionComponentCapability;
  readonly feature: string;
}

/** One component the plan emits for this target. */
export interface InspectionSelectedComponent {
  readonly capability?: InspectionComponentCapability;
  readonly id: string;
  readonly kind: InspectionComponentKind;
  readonly name: string;
  /** Features this target omits from the emitted component, in feature order; absent when none. */
  readonly omittedFeatures?: readonly InspectionOmittedFeature[];
}

/**
 * One component the plan omits for this target, with the intersection-rule
 * cause. `unsupported-capability` carries the host's `degraded`,
 * `unavailable`, or `prohibited` judgment and reason; `excluded-by-targets`
 * carries the judgment the host would have applied had the author selected it.
 */
export interface InspectionSkippedComponent {
  readonly capability?: InspectionComponentCapability;
  readonly id: string;
  readonly kind: InspectionComponentKind;
  readonly name: string;
  readonly reason: InspectionSkipReason;
}

/**
 * The target's judgment of one canonical component kind, whether or not the
 * project declares a component of that kind: `capability` is the host's own
 * four-state row for the kind (absent for `script`, which needs no host
 * surface, and for `event-route`, whose rows are per canonical event and
 * travel on each component instead), and the counts are this target's
 * selected and omitted components of the kind.
 */
export interface InspectionComponentKindReport {
  readonly capability?: InspectionComponentCapability;
  readonly kind: InspectionComponentKind;
  readonly selected: number;
  readonly skipped: number;
}

export interface InspectionPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly entries: readonly TargetArtifactEntry[];
  readonly hookEntries: readonly TargetHookEntry[];
  /** Every canonical component kind with this target's judgment and counts, in kind order. */
  readonly kinds: readonly InspectionComponentKindReport[];
  /** Components this target emits, in the same deterministic order as `skipped`. */
  readonly selected: readonly InspectionSelectedComponent[];
  readonly skipped: readonly InspectionSkippedComponent[];
  readonly target: string;
}

export interface InspectOptions extends ProjectOptions {
  readonly focus?: 'bundler' | 'hooks' | 'routes' | 'skills' | 'state';
  readonly target?: string;
}

export type StateInspectionDriver = StateProjectionDriver;

export type StateInspectionBudgets = StateProjectionBudgets;

export type { StateNoticeRetentionProjection };

export type StateInspection =
  | {
    readonly declared: false;
  }
  | {
    readonly budgets:
      | {
        readonly resolved: StateInspectionBudgets;
        readonly source: 'declared' | 'defaults';
      }
      | {
        readonly source: 'dynamic';
      };
    readonly declared: true;
    readonly driver: StateInspectionDriver;
    readonly durableLocation?: string;
    readonly id: string;
    readonly lifetime: NonNullable<NormalizedPlugin['state']>['lifetime'];
    readonly noticeRetention?: StateNoticeRetentionProjection;
    readonly notices: readonly string[];
    readonly provenance: NonNullable<NormalizedPlugin['state']>['provenance'];
    readonly source: string;
  };

export interface ReadyInspectResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly model: NormalizedPlugin;
  readonly output: {
    readonly distPath: string;
  };
  readonly plans: readonly InspectionPlan[];
  readonly projectContext: ProjectContext;
  readonly selected?: {
    readonly bundler?: BundlerInspection;
    readonly hooks?: NormalizedPlugin['hooks'];
    readonly routes?: RouteGraphInspection;
    readonly skills?: NormalizedPlugin['skills'];
    readonly state?: StateInspection;
    readonly skillTreeLayouts?: readonly {
      readonly layout?: NormalizedPlugin['skills'][number]['skillTreeLayout'];
      readonly skillId: string;
    }[];
  };
  readonly state: 'ready';
}

export interface InvalidInspectResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly plans: readonly [];
  readonly state: 'invalid';
}

export type InspectResult = ReadyInspectResult | InvalidInspectResult;

export interface BuildOptions extends ProjectOptions {
  /**
   * After the artifact is written, run the installed Claude developer
   * validator (`claude plugin validate --strict` against the emitted
   * `plugin.json` and `marketplace.json`) for every built `claude` and
   * `plugin` target, exactly as `validate --artifact` does. The CLI `build`
   * command requests this by default; programmatic artifact operations
   * (temporary artifacts, dev, evals) never do. Without `claude` on `PATH`
   * the run costs one failed spawn and reports a single `AB6019` info.
   */
  readonly hostValidation?: boolean;
  /** Injectable only to make the Claude host validator deterministic in tests; production always spawns `claude`. */
  readonly hostValidationRunner?: ClaudePluginCommandRunner;
  readonly output?: string;
  /**
   * Also produce the framework-owned npm package build (`dist/` bin + lib
   * outputs) when the project declares or conventionally provides one. The
   * CLI `build` command always requests this; programmatic artifact
   * operations (temporary artifacts, dev, evals) never do.
   */
  readonly packageOutputs?: boolean;
  /** Promote host-tool warnings to errors (`hostValidation` only). */
  readonly strict?: boolean;
}

export interface BuildProjectResult {
  readonly build: BuildResult;
  /** Project diagnostics followed by the host-validation findings (`AB6019`–`AB6022`) when `hostValidation` ran. */
  readonly diagnostics: readonly Diagnostic[];
  /** One report per built `claude`/`plugin` target; present only when `hostValidation` was requested. */
  readonly hostValidation?: readonly ClaudePluginValidationReport[];
  readonly model: NormalizedPlugin;
  readonly packageBuild?: PackageBuildResult;
  readonly projectContext: ProjectContext;
}

export interface PrepackResult {
  readonly build: BuildProjectResult;
  readonly pack: PackOutput;
}

export interface ArtifactOperationOptions extends ProjectOptions {
  readonly artifact?: string;
}

export interface ListMcpOptions extends ArtifactOperationOptions {
  readonly server: string;
  readonly target: string;
  readonly timeoutMs?: number;
}

export interface InvokeMcpOptions extends ListMcpOptions {
  readonly input: Record<string, unknown>;
  readonly tool: string;
}

export interface RunEvalsOptions extends ArtifactOperationOptions, EvalRunSelection {
  readonly harness?: string;
  readonly signal?: AbortSignal;
  readonly trials?: number;
}

export interface CompareEvalsOptions extends ProjectOptions {
  readonly baseRunId: string;
  readonly candidateRunId: string;
}

export interface RunMcpOptions extends ArtifactOperationOptions {
  /**
   * Explicit `.env` files replacing the conventional project-root set.
   * Loaded in order, later files winning on collision; relative paths
   * resolve from the working directory.
   */
  readonly envFiles?: readonly string[];
  /** Set false to launch the server without any `.env` layer. */
  readonly loadEnvFiles?: boolean;
  /**
   * Root the env-declared plugin-root anchors (for example
   * `AGENT_BUNDLE_PLUGIN_ROOT`) expand to. Defaults to the project root so
   * durable server state survives artifact rebuilds; point it at the
   * artifact target root for a byte-faithful rehearsal of a copied-artifact
   * launch.
   */
  readonly pluginRoot?: string;
  readonly server: string;
  /** Injectable only to make foreground process behavior deterministic in tests. */
  readonly spawnProcess?: Parameters<typeof runMcpForeground>[0]['spawnProcess'];
  readonly target: string;
}

export interface ListHooksOptions extends ArtifactOperationOptions {
  readonly target?: string;
}

export interface SimulateHookOptions extends ListHooksOptions {
  readonly hook: string;
  readonly input: Record<string, unknown>;
  readonly target: string;
}

const log = (
  logger: StructuredLogger | undefined,
  event: string,
  details: Readonly<Record<string, unknown>>,
): void => {
  logger?.log?.(event, Object.freeze({ ...details }));
};

const prepareProject = async (
  options: ProjectOptions,
  command: 'build' | 'inspect' | 'validate',
): Promise<PreparedProject> => new ProjectService(options).prepare(command);

const requirePreparedModel = (prepared: PreparedProject): NormalizedPlugin => {
  if (prepared.model !== undefined && !hasErrors(prepared.diagnostics)) return prepared.model;
  throw new DiagnosticError(prepared.diagnostics);
};

const noInspectionPlans: readonly [] = Object.freeze<[]>([]);

const invalidInspection = (diagnostics: readonly Diagnostic[]): InvalidInspectResult =>
  Object.freeze({
    diagnostics,
    plans: noInspectionPlans,
    state: 'invalid',
  });

const resolveOutput = (root: string, output: string): string =>
  resolve(root, output);

const registryFor = (options: ProjectOptions): TargetRegistry =>
  options.registry ?? createDefaultRegistry();

const temporaryArtifact = async <Result>(
  options: ArtifactOperationOptions,
  operation: (artifact: string) => Promise<Result>,
): Promise<Result> => {
  if (options.artifact !== undefined) return operation(resolve(options.artifact));

  // The staging directory lives exactly as long as the operation: created
  // next to the project (same filesystem as a real `artifact/`), removed
  // when the build or the operation settles, success, failure or interrupt.
  return runWithPlatform(withTempDirectory(
    { directory: resolve(options.root), prefix: '.agent-bundle-artifact-' },
    (artifact) => Effect.gen(function* () {
      yield* liftPromise(() => build({
        configPath: options.configPath,
        logger: options.logger,
        mode: options.mode,
        output: artifact,
        registry: options.registry,
        root: options.root,
        targets: options.targets,
      }));
      return yield* liftPromise(() => operation(artifact));
    }),
  ));
};

type HostValidatedTarget = 'claude' | 'codex' | 'cursor' | 'plugin' | 'portable';

const hostValidatedTargets: ReadonlySet<string> = new Set<HostValidatedTarget>([
  'claude',
  'codex',
  'cursor',
  'plugin',
  'portable',
]);

const isHostValidatedTarget = (name: string): name is HostValidatedTarget => hostValidatedTargets.has(name);

const hostValidationReport = (
  target: HostValidatedTarget,
  pluginDirectory: string,
  strict: boolean | undefined,
): Promise<NonNullable<ValidateResult['hostValidation']>[number]> => {
  switch (target) {
    case 'codex':
      return validateCodexPlugin({ pluginDirectory, strict, target });
    case 'cursor':
      return validateCursorPlugin({ pluginDirectory, target });
    case 'portable':
      return validatePortablePlugin({ pluginDirectory, target });
    case 'claude':
    case 'plugin':
      return validateClaudePlugin({ pluginDirectory, strict, target });
    default: {
      const exhaustive: never = target;
      throw new TypeError(`Unknown host-validated target ${String(exhaustive)}.`);
    }
  }
};

export const validate = async (options: ValidateOptions): Promise<ValidateResult> => {
  if (options.artifact !== undefined) {
    const artifact = resolve(options.artifact);
    log(options.logger, 'artifact.validate', { artifact });
    if (options.hostValidation === true) {
      const validated = await validateArtifactWithSnapshot({
        artifactRoot: artifact,
        registry: registryFor(options),
      });
      if (validated.snapshot === undefined) {
        return Object.freeze({ diagnostics: freezeDiagnostics(validated.diagnostics) });
      }
      const reports = await Promise.all(validated.snapshot.manifest.targets
        .map((target) => target.name)
        .filter(isHostValidatedTarget)
        .map((target) => hostValidationReport(target, join(artifact, target), options.strict)));
      return Object.freeze({
        diagnostics: freezeDiagnostics([
          ...validated.diagnostics,
          ...reports.flatMap((report) => report.diagnostics),
        ]),
        ...(reports.length === 0 ? {} : { hostValidation: Object.freeze(reports) }),
      });
    }
    return Object.freeze({
      diagnostics: freezeDiagnostics(await validateArtifact({ artifactRoot: artifact, registry: registryFor(options) })),
    });
  }

  const prepared = await prepareProject(options, 'validate');
  return Object.freeze({
    diagnostics: prepared.diagnostics,
    ...(prepared.model === undefined ? {} : { model: prepared.model }),
  });
};

interface InspectableComponent {
  readonly capability?: string;
  /** Host features the component uses, judged per target by `<capability>.<feature>` rows. */
  readonly features?: readonly string[];
  readonly id: string;
  readonly kind: InspectionComponentKind;
  readonly name: string;
  readonly targets: readonly string[];
}

const fixedKindComponent = (
  kind: Exclude<InspectionComponentKind, 'event-route'>,
  component: { readonly id: string; readonly name: string; readonly targets: readonly string[] },
  features: readonly string[] = [],
): InspectableComponent => {
  const capability = componentKindCapabilityName(kind);
  return {
    ...(capability === undefined ? {} : { capability }),
    ...(features.length === 0 ? {} : { features: [...features].sort((left, right) => left.localeCompare(right)) }),
    id: component.id,
    kind,
    name: component.name,
    targets: component.targets,
  };
};

/** Frontmatter keys are the features a command or rule uses (the closed sets from #219/#207). */
const frontmatterFeatures = (frontmatter: Readonly<Record<string, unknown>>): readonly string[] =>
  Object.keys(frontmatter);

const hookFeatures = (hook: NormalizedPlugin['hooks'][number]): readonly string[] => [
  ...(hook.timeoutMs === undefined ? [] : ['timeout']),
  ...(hook.tools.length === 0 && (hook.nativeTools ?? []).length === 0 ? [] : ['toolMatchers']),
];

/**
 * Skill features follow the Skill IR (#108): typed host frontmatter extensions
 * and Skill Markdown placeholder tokens. The IR already fails closed per host
 * (AB3006/AB3008/AB3010); inspection reports the same classes against the
 * host's `skills.*` rows.
 */
const skillFeatures = (skill: NormalizedPlugin['skills'][number]): readonly string[] => {
  const ir = skill.skillIr;
  if (ir === undefined) return [];
  return [
    ...(ir.extensions.claude === undefined && ir.extensions.codex === undefined && ir.extensions.cursor === undefined
      ? []
      : ['hostFrontmatter']),
    ...(ir.placeholders.length === 0 ? [] : ['markdownTokens']),
  ];
};

/**
 * Every project component in canonical-kind terms. Config-declared hooks stay
 * `hook` (judged by the host's `hooks` row); filesystem event routes are the
 * distinct `event-route` kind, judged by the host's row for their canonical
 * event (#258 matrix) so `inspect` reports them separately. The `agent` kind
 * has no producer while the G5 deferral (#220) holds.
 */
const inspectableComponents = (model: NormalizedPlugin): readonly InspectableComponent[] => [
  // The routed CLI bin is offered to every selected target; the host's `cli`
  // capability row decides whether the artifact hosts it (#387).
  ...routedCliBins(model).map((bin) => fixedKindComponent('cli', {
    id: bin.id,
    name: bin.name,
    targets: model.targets.map((target) => target.name),
  })),
  ...(model.commands ?? []).map((command) => fixedKindComponent('command', command, frontmatterFeatures(command.frontmatter))),
  ...model.hooks.map((hook) => hook.eventRoute === undefined
    ? fixedKindComponent('hook', { id: hook.id, name: hook.event, targets: hook.targets }, hookFeatures(hook))
    : {
      capability: `event:${hook.eventRoute.event}`,
      id: hook.id,
      kind: 'event-route' as const,
      name: hook.eventRoute.event,
      targets: hook.targets,
    }),
  ...(model.lspServers ?? []).map((server) => fixedKindComponent('lsp', server)),
  ...(model.mcpApps ?? []).map((app) => fixedKindComponent('mcp-app', app)),
  ...model.mcpServers.map((server) => fixedKindComponent('mcp-server', server)),
  ...(model.rules ?? []).map((rule) => fixedKindComponent('rule', rule, frontmatterFeatures(rule.frontmatter))),
  ...model.scripts.map((script) => fixedKindComponent('script', script)),
  ...model.skills.map((skill) => fixedKindComponent('skill', skill, skillFeatures(skill))),
];

/**
 * The features a selected component uses that this target's `<kind>.<feature>`
 * rows do not support. A host with no row for a feature has not evidenced it,
 * so the feature reads as omitted `unavailable` rather than silently kept.
 */
const omittedFeaturesFor = (
  component: InspectableComponent,
  target: string,
  capabilities: Readonly<Record<string, CapabilityState>>,
): readonly InspectionOmittedFeature[] => {
  if (component.capability === undefined || component.features === undefined) return Object.freeze([]);
  const kindCapability = component.capability;
  return Object.freeze(component.features.flatMap((feature) => {
    const capability = componentCapabilityFor(
      { ...component, capability: featureCapabilityName(kindCapability, feature) },
      target,
      capabilities,
    );
    return capability === undefined || capabilityIsSupported(capability) ? [] : [Object.freeze({ capability, feature })];
  }));
};

/**
 * The target's judgment for one component capability. An adapter that
 * publishes no row for a capability it is asked about has not evidenced it, so
 * the absence reads as an honest `unavailable` rather than a crash or a silent
 * pass.
 */
const componentCapabilityFor = (
  component: InspectableComponent,
  target: string,
  capabilities: Readonly<Record<string, CapabilityState>>,
): InspectionComponentCapability | undefined => {
  if (component.capability === undefined) return undefined;
  const state = capabilities[component.capability] ?? unavailableCapability(
    `The ${target} adapter publishes no ${component.capability} capability row.`,
  );
  return Object.freeze({ ...capabilityContract(state), name: component.capability });
};

/**
 * Projects only the four-state contract fields of an adapter-owned capability
 * row. `isCapabilityState` admits extension fields on JavaScript and third-party
 * adapters, and copying them would let one named `name` shadow the canonical
 * capability name or a cyclic one break `inspect --json`.
 */
const capabilityContract = (state: CapabilityState): CapabilityState => {
  switch (state.state) {
    case 'supported':
      return { evidence: capabilityEvidenceContract(state.evidence), state: state.state };
    case 'degraded':
      return {
        ...(state.evidence === undefined ? {} : { evidence: capabilityEvidenceContract(state.evidence) }),
        reason: state.reason,
        state: state.state,
      };
    case 'unavailable':
    case 'prohibited':
      return { reason: state.reason, state: state.state };
    default: {
      const exhaustive: never = state;
      throw new Error(`Unhandled capability state ${JSON.stringify(exhaustive)}`);
    }
  }
};

const capabilityEvidenceContract = (evidence: CapabilityEvidence): CapabilityEvidence =>
  Object.freeze({ observedVersion: evidence.observedVersion, target: evidence.target });

/**
 * Whether the target's judgment lets a component ship. Event routes follow the
 * validation rule in `config/validate.ts`, which admits a `degraded` `event:*`
 * row (the route lowers with a documented limitation), so an emitted degraded
 * route is accounted as selected rather than omitted; every other kind ships
 * only on a `supported` row.
 */
const admitsComponent = (kind: InspectionComponentKind, capability: CapabilityState): boolean => {
  switch (capability.state) {
    case 'supported':
      return true;
    case 'degraded':
      return kind === 'event-route';
    case 'unavailable':
    case 'prohibited':
      return false;
    default: {
      const exhaustive: never = capability;
      throw new Error(`Unhandled capability state ${JSON.stringify(exhaustive)}`);
    }
  }
};

interface AccountedComponents {
  readonly kinds: readonly InspectionComponentKindReport[];
  readonly selected: readonly InspectionSelectedComponent[];
  readonly skipped: readonly InspectionSkippedComponent[];
}

/**
 * The per-kind matrix: every canonical kind, the target's row for it, and how
 * many components of the kind this target selected and omitted. Kinds the
 * project never declares still report the host's judgment, so a host with no
 * `lsp`, `native-diagnostics`, or `native-extension` surface says so in its
 * own words rather than by silence.
 */
const componentKindReports = (
  target: string,
  capabilities: Readonly<Record<string, CapabilityState>>,
  selected: readonly InspectionSelectedComponent[],
  skipped: readonly InspectionSkippedComponent[],
): readonly InspectionComponentKindReport[] => Object.freeze(agentComponentKinds.map((kind) => {
  const capabilityName = componentKindCapabilityName(kind);
  const capability = capabilityName === undefined
    ? undefined
    : componentCapabilityFor({ capability: capabilityName, id: kind, kind, name: kind, targets: [] }, target, capabilities);
  return Object.freeze({
    ...(capability === undefined ? {} : { capability }),
    kind,
    selected: selected.filter((component) => component.kind === kind).length,
    skipped: skipped.filter((component) => component.kind === kind).length,
  });
}));

/**
 * Splits the project's components into the ones this target emits and the
 * ones it omits. Author exclusion (`targets`) is reported before the host's
 * capability judgment, and every component that needs a capability carries the
 * target's four-state judgment so `inspect` explains, not just counts.
 */
const accountComponentsFor = (
  components: readonly InspectableComponent[],
  target: string,
  capabilities: Readonly<Record<string, CapabilityState>>,
): AccountedComponents => {
  const selected: InspectionSelectedComponent[] = [];
  const skipped: InspectionSkippedComponent[] = [];
  for (const component of components) {
    const capability = componentCapabilityFor(component, target, capabilities);
    const identity = {
      ...(capability === undefined ? {} : { capability }),
      id: component.id,
      kind: component.kind,
      name: component.name,
    };
    if (!component.targets.includes(target)) {
      skipped.push(Object.freeze({ ...identity, reason: 'excluded-by-targets' satisfies InspectionSkipReason }));
    } else if (capability !== undefined && !admitsComponent(component.kind, capability)) {
      skipped.push(Object.freeze({ ...identity, reason: 'unsupported-capability' satisfies InspectionSkipReason }));
    } else {
      const omittedFeatures = omittedFeaturesFor(component, target, capabilities);
      selected.push(Object.freeze({
        ...identity,
        ...(omittedFeatures.length === 0 ? {} : { omittedFeatures }),
      }));
    }
  }
  return {
    kinds: componentKindReports(target, capabilities, selected, skipped),
    selected: Object.freeze(selected),
    skipped: Object.freeze(skipped),
  };
};

const inspectState = (model: NormalizedPlugin): StateInspection => {
  const definition = model.state;
  if (definition === undefined) return Object.freeze({ declared: false });
  const projection = stateDefinitionProjection(definition, definition.source, model.notices);
  return deepFreeze({
    declared: true,
    ...projection,
    provenance: definition.provenance,
  });
};

export const inspect = async (options: InspectOptions): Promise<InspectResult> => {
  const prepared = await prepareProject(options, 'inspect');
  if (
    hasErrors(prepared.diagnostics) ||
    prepared.model === undefined ||
    prepared.projectContext === undefined
  ) {
    return invalidInspection(prepared.diagnostics);
  }
  const { model, projectContext } = prepared;
  if (options.target !== undefined && !model.targets.some((candidate) => candidate.name === options.target)) {
    return invalidInspection(freezeDiagnostics([
      ...prepared.diagnostics,
      projectDiagnostic(
        'AB7004',
        `Requested inspection target ${JSON.stringify(options.target)} is not selected for this project.`,
        { sourcePath: prepared.configPath, target: options.target },
      ),
    ]));
  }
  let plans: readonly InspectionPlan[];
  try {
    const components = inspectableComponents(model);
    plans = Object.freeze(model.targets
      .filter((candidate) => options.target === undefined || candidate.name === options.target)
      .map((target) => {
        const adapter = prepared.registry.get(target.name);
        const plan = adapter.plan(model);
        const accounted = accountComponentsFor(
          components,
          target.name,
          adapter.componentCapabilities ?? adapter.capabilities,
        );
        return Object.freeze({
          diagnostics: freezeDiagnostics(plan.diagnostics),
          entries: Object.freeze([...plan.entries]),
          hookEntries: Object.freeze([...(plan.hookEntries ?? [])]),
          kinds: accounted.kinds,
          selected: accounted.selected,
          skipped: accounted.skipped,
          target: target.name,
        });
      }));
  } catch {
    return invalidInspection(freezeDiagnostics([
      ...prepared.diagnostics,
      projectDiagnostic(
        'AB7001',
        'Unable to prepare inspection plans.',
        { sourcePath: prepared.configPath },
      ),
    ]));
  }
  let bundler: BundlerInspection | undefined;
  if (options.focus === 'bundler') {
    try {
      bundler = await composeBundlerInspection({
        model,
        projectRoot: prepared.root,
        targets: plans.map((plan) => {
          const noticeDelivery = prepared.registry.noticeDelivery(plan.target);
          return {
            cliBin: targetHostsCliBin(prepared.registry, plan.target),
            hookEntries: plan.hookEntries,
            name: plan.target,
            ...(noticeDelivery === undefined ? {} : { noticeDelivery }),
          };
        }),
        ...(prepared.tools === undefined ? {} : { tools: prepared.tools }),
      });
    } catch {
      return invalidInspection(freezeDiagnostics([
        ...prepared.diagnostics,
        projectDiagnostic(
          'AB7001',
          'Unable to compose the bundler inspection.',
          { sourcePath: prepared.configPath },
        ),
      ]));
    }
  }
  // The route focus serves the graph preparation already compiled during
  // discovery — never a second configuration evaluation, so the focus can
  // not diverge from the validated model. Route-free projects attach no
  // graph and serve the shared empty one.
  const routes: RouteGraphInspection | undefined = options.focus === 'routes'
    ? inspectRouteGraph(prepared.routeGraph ?? emptyCompiledRouteGraph)
    : undefined;
  const selected = options.focus === undefined
    ? undefined
    : Object.freeze({
      ...(bundler === undefined ? {} : { bundler }),
      ...(options.focus === 'hooks' ? { hooks: model.hooks } : {}),
      ...(routes === undefined ? {} : { routes }),
      ...(options.focus === 'skills'
        ? {
          skills: model.skills,
          skillTreeLayouts: Object.freeze(model.skills.map((skill) => Object.freeze({
            skillId: skill.id,
            ...(skill.skillTreeLayout === undefined ? {} : { layout: skill.skillTreeLayout }),
          }))),
        }
        : {}),
      ...(options.focus === 'state' ? { state: inspectState(model) } : {}),
    });
  return Object.freeze({
    diagnostics: prepared.diagnostics,
    model,
    output: Object.freeze({ distPath: prepared.artifactDistPath }),
    plans,
    projectContext,
    ...(selected === undefined ? {} : { selected }),
    state: 'ready',
  });
};

const assertPackageOutputSources = (
  packageBuild: PackageBuildResult,
  projectContext: ProjectContext,
): void => {
  const declaredSources = new Set(projectContext.sourceInputs.map((input) => input.path));
  for (const file of packageBuild.files) {
    for (const sourceInput of file.sourceInputs) {
      if (!declaredSources.has(sourceInput)) {
        throw new Error(`Package output source ${JSON.stringify(sourceInput)} is not declared in the project context.`);
      }
    }
  }
};

export const build = async (options: BuildOptions): Promise<BuildProjectResult> => {
  const root = resolve(options.root);
  const outputRoots = options.output === undefined
    ? undefined
    : [resolveOutput(root, options.output)];
  const prepared = await new ProjectService({
    ...options,
    ...(options.packageOutputs === true ? { artifactDistPathDefault: defaultPackageArtifactDistPath } : {}),
    ...(outputRoots === undefined ? {} : { outputRoots }),
    root,
  }).prepare('build');
  const output = resolve(root, options.output ?? prepared.artifactDistPath);
  const model = requirePreparedModel(prepared);
  const projectContext = prepared.projectContext;
  if (projectContext === undefined) throw new DiagnosticError(prepared.diagnostics);
  const packageOutputRoot = model.packageBuild === undefined || options.packageOutputs !== true
    ? undefined
    : resolve(prepared.root, model.packageBuild.outputDir);
  if (packageOutputRoot !== undefined && (isInsideOrEqual(packageOutputRoot, output) || isInsideOrEqual(output, packageOutputRoot))) {
    throw new DiagnosticError([{
      code: 'AB4706',
      message: `Artifact output ${JSON.stringify(output)} overlaps the package build output ${JSON.stringify(packageOutputRoot)}; configure a different output.distPath or pass a different --output.`,
      severity: 'error',
    }]);
  }
  log(options.logger, 'artifact.build', { output, root: prepared.root });
  const result = await buildArtifact({
    model,
    outputRoot: output,
    projectContext,
    projectRoot: prepared.root,
    registry: prepared.registry,
    ...(prepared.tools === undefined ? {} : { tools: prepared.tools }),
  });
  let packageBuild: PackageBuildResult | undefined;
  if (packageOutputRoot !== undefined) {
    packageBuild = await buildPackageOutputs({
      ...(isInsideOrEqual(prepared.root, output) ? { artifactRoot: output } : {}),
      model,
      projectRoot: prepared.root,
      ...(prepared.tools === undefined ? {} : { tools: prepared.tools }),
    });
    if (packageBuild !== undefined) assertPackageOutputSources(packageBuild, projectContext);
  }
  const hostValidation = options.hostValidation === true
    ? await buildHostValidation(result.manifest.targets.map((target) => target.name), output, options)
    : undefined;
  return Object.freeze({
    build: result,
    diagnostics: hostValidation === undefined
      ? prepared.diagnostics
      : freezeDiagnostics([...prepared.diagnostics, ...hostValidation.diagnostics]),
    ...(hostValidation === undefined ? {} : { hostValidation: hostValidation.reports }),
    model,
    ...(packageBuild === undefined ? {} : { packageBuild }),
    projectContext,
  });
};

const claudeValidatedTargets: ReadonlySet<string> = new Set<HostValidatedTarget>(['claude', 'plugin']);

/**
 * `build --host-validation`: the Claude developer validator (`plugin validate`
 * over both manifests, then the `--plugin-dir … plugin list --json` load check)
 * over every built `claude`/`plugin` target (#476). Targets run one after
 * another: once the CLI proves absent (`AB6019`), the remaining targets are
 * marked `unavailable` without another spawn, so a build without `claude` on
 * `PATH` costs one failed spawn and reports the skip once.
 */
const buildHostValidation = async (
  targets: readonly string[],
  output: string,
  options: Pick<BuildOptions, 'hostValidationRunner' | 'strict'>,
): Promise<{ readonly diagnostics: readonly Diagnostic[]; readonly reports: readonly ClaudePluginValidationReport[] }> => {
  const reports: ClaudePluginValidationReport[] = [];
  let unavailable = false;
  for (const target of targets.filter((name) => claudeValidatedTargets.has(name))) {
    if (unavailable) {
      reports.push(Object.freeze({ diagnostics: freezeDiagnostics([]), host: 'claude', status: 'unavailable', target }));
      continue;
    }
    const report = await validateClaudePlugin({
      pluginDirectory: join(output, target),
      ...(options.hostValidationRunner === undefined ? {} : { run: options.hostValidationRunner }),
      ...(options.strict === undefined ? {} : { strict: options.strict }),
      target,
    });
    reports.push(report);
    unavailable = report.status === 'unavailable';
  }
  return Object.freeze({
    diagnostics: freezeDiagnostics(reports.flatMap((report) => report.diagnostics)),
    reports: Object.freeze(reports),
  });
};

const execFile = promisify(executeFile);

export const prepack = async (options: BuildOptions): Promise<PrepackResult> => {
  const result = await build({ ...options, packageOutputs: true });
  if (result.packageBuild === undefined) {
    throw new DiagnosticError([{
      code: 'AB7010',
      message: 'Prepack requires at least one framework-owned package output.',
      recovery: 'Declare a package bin or lib entry before running agent-bundle prepack.',
      severity: 'error',
    }]);
  }
  const { stdout } = await execFile('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: resolve(options.root),
  });
  const pack = packOutputFromJson(stdout);
  const diagnostics = await packInventoryDiagnostics({
    artifactRoot: result.build.outputRoot,
    model: result.model,
    packageBuild: result.packageBuild,
    packOutput: pack,
    projectRoot: options.root,
  });
  if (diagnostics.length > 0) throw new DiagnosticError(diagnostics);
  return deepFreeze({ build: result, pack });
};

/** Every eval refusal reaches a caller as one actionable diagnostic, never a raw service error. */
const evalDiagnostics: Readonly<Record<EvalServiceErrorCode, Readonly<{
  readonly code: string;
  readonly recovery: string;
}>>> = deepFreeze({
  EVAL_ARTIFACT_NOT_FOUND: {
    code: 'AB9009',
    recovery: 'Select raw evidence that the recorded eval trial persisted.',
  },
  EVAL_ARTIFACT_UNAVAILABLE: {
    code: 'AB9010',
    recovery: 'Regenerate the recorded eval run before reading its raw evidence.',
  },
  EVAL_EVENTS_CURSOR_INVALID: {
    code: 'AB9011',
    recovery: 'Reconnect from a non-negative cursor no later than the durable event sequence.',
  },
  EVAL_HARNESS_UNSUPPORTED: {
    code: 'AB9001',
    recovery: 'Use deterministic, claude, or codex, or correct an unknown harness name.',
  },
  EVAL_RUN_NOT_FOUND: {
    code: 'AB9003',
    recovery: 'Read a run that this project recorded, or start a new one.',
  },
  EVAL_SELECTION_EMPTY: {
    code: 'AB9002',
    recovery: 'Select a suite or case that "agent-bundle eval --json" reports as discovered.',
  },
  EVAL_SEMANTIC_GRADER_UNSUPPORTED: {
    code: 'AB9008',
    recovery: 'Run the configured semantic grader with "--harness claude" and a Claude-pinned eval case.',
  },
  EVAL_TARGET_MISSING: {
    code: 'AB9004',
    recovery: 'Select the targets the pinned eval hosts name, then evaluate again.',
  },
  EVAL_TRIALS_INVALID: {
    code: 'AB9005',
    recovery: 'Request an integer trial count between 1 and 100.',
  },
});

const evalDiagnostic = (error: EvalServiceError): Diagnostic => {
  const mapped = evalDiagnostics[error.code];
  return Object.freeze({
    code: mapped.code,
    message: error.message,
    recovery: mapped.recovery,
    severity: 'error',
  });
};

const evalRunStoreDiagnostic = (error: EvalRunStoreError): Diagnostic | undefined => {
  if (error.code === 'EVAL_RUN_NOT_FOUND') {
    return evalDiagnostic(new EvalServiceError('EVAL_RUN_NOT_FOUND', error.message));
  }
  if (error.code === 'EVAL_RUN_CORRUPT' || error.code === 'EVAL_RUN_RECORD_INVALID') {
    return Object.freeze({
      code: 'AB9007',
      message: 'A persisted eval run is corrupt and cannot be compared.',
      recovery: 'Repair or remove the corrupt persisted eval run, then compare two completed runs.',
      severity: 'error',
    });
  }
  return undefined;
};

const evalService = (options: ProjectOptions): EvalService => new EvalService({
  ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
  ...(options.mode === undefined ? {} : { mode: options.mode }),
  projectRoot: resolve(options.root),
  registry: registryFor(options),
  ...(options.targets === undefined ? {} : { targets: options.targets }),
});

/** Runs deterministic or native eval suites through the service the CLI and workbench browser also use. */
export const runEvals = async (options: RunEvalsOptions): Promise<EvalRunResult> => {
  log(options.logger, 'eval.run', { root: resolve(options.root) });
  try {
    return await evalService(options).run({
      ...(options.artifact === undefined ? {} : { artifact: options.artifact }),
      ...(options.caseIds === undefined ? {} : { caseIds: options.caseIds }),
      ...(options.harness === undefined ? {} : { harness: options.harness }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.suites === undefined ? {} : { suites: options.suites }),
      ...(options.trials === undefined ? {} : { trials: options.trials }),
    });
  } catch (error) {
    if (error instanceof EvalServiceError) throw new DiagnosticError([evalDiagnostic(error)]);
    throw error;
  }
};

/** Compares two persisted eval runs through the same service the CLI and workbench use. */
export const compareEvals = async (options: CompareEvalsOptions): Promise<EvalComparison> => {
  log(options.logger, 'eval.compare', {
    baseRunId: options.baseRunId,
    candidateRunId: options.candidateRunId,
    root: resolve(options.root),
  });
  try {
    return await evalService(options).compare(options.baseRunId, options.candidateRunId);
  } catch (error) {
    if (error instanceof EvalServiceError) throw new DiagnosticError([evalDiagnostic(error)]);
    if (error instanceof EvalRunStoreError) {
      const diagnostic = evalRunStoreDiagnostic(error);
      if (diagnostic !== undefined) throw new DiagnosticError([diagnostic]);
    }
    throw error;
  }
};

export const listMcp = async (options: ListMcpOptions): Promise<McpListResult> => {
  const registry = registryFor(options);
  return temporaryArtifact({ ...options, registry }, async (artifact) => new McpService({ registry }).list({
    artifact,
    server: options.server,
    target: options.target,
    timeoutMs: options.timeoutMs,
    workspaceRoot: resolve(options.root),
  } satisfies McpListOptions));
};

export const invokeMcp = async (options: InvokeMcpOptions): Promise<McpInvokeResult> => {
  const registry = registryFor(options);
  return temporaryArtifact({ ...options, registry }, async (artifact) => new McpService({ registry }).invoke({
    artifact,
    input: options.input,
    server: options.server,
    target: options.target,
    timeoutMs: options.timeoutMs,
    tool: options.tool,
    workspaceRoot: resolve(options.root),
  } satisfies McpInvokeOptions));
};

/**
 * Runs one built stdio MCP server in the foreground with inherited stdio,
 * resolving its content-hashed generated entry from the target manifest.
 * Both durable-state anchors point at the project root: plugin-data state
 * persists under `.agent-bundle/mcp-run/<target>/<server>`, and env-declared
 * plugin-root anchors expand to the project root itself (override with
 * `pluginRoot`). The launch environment layers, lowest to highest: manifest
 * env, the project-root `.env` set (or `envFiles`), the operator's real
 * `process.env`.
 */
export const runMcp = async (options: RunMcpOptions): Promise<number> => {
  const registry = registryFor(options);
  const workspaceRoot = resolve(options.root);
  return temporaryArtifact({ ...options, registry }, async (artifact) => runMcpForeground({
    artifact,
    ...(options.envFiles === undefined ? {} : { envFiles: options.envFiles }),
    ...(options.pluginRoot === undefined ? {} : { envPluginRoot: resolve(options.pluginRoot) }),
    ...(options.loadEnvFiles === undefined ? {} : { loadEnvFiles: options.loadEnvFiles }),
    ...(options.mode === undefined ? {} : { mode: options.mode }),
    pluginDataRoot: join(workspaceRoot, '.agent-bundle', 'mcp-run', options.target, mcpServerStateDirectory(options.server)),
    registry,
    server: options.server,
    ...(options.spawnProcess === undefined ? {} : { spawnProcess: options.spawnProcess }),
    target: options.target,
    workspaceRoot,
  }));
};

export const listHooks = async (options: ListHooksOptions) => {
  const registry = registryFor(options);
  if (options.target !== undefined && !registry.has(options.target)) {
    throw new RangeError(`Unknown target ${JSON.stringify(options.target)}.`);
  }
  return temporaryArtifact({ ...options, registry }, async (artifact) => new HookService({ registry }).list({
    artifact,
    target: options.target,
  } satisfies HookListOptions));
};

export const simulateHook = async (options: SimulateHookOptions): Promise<unknown> => {
  const registry = registryFor(options);
  return temporaryArtifact({ ...options, registry }, async (artifact) => new HookService({ registry }).simulate({
    artifact,
    hook: options.hook,
    input: options.input,
    target: options.target,
  } satisfies HookSimulationOptions));
};
