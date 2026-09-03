import { execFile as executeFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { capabilityIsSupported, unavailableCapability } from './adapters/capability-state.ts';
import { createDefaultRegistry, TargetRegistry } from './adapters/registry.ts';
import type { TargetArtifactEntry, TargetHookEntry } from './adapters/types.ts';
import { build as buildArtifact, type BuildResult } from './build/build.ts';
import { buildPackageOutputs, type PackageBuildResult } from './build/package-build.ts';
import {
  packInventoryDiagnostics,
  packOutputFromJson,
  type PackOutput,
} from './build/pack-inventory.ts';
import type { CapabilityState } from './core/capabilities.ts';
import { isInsideOrEqual } from './core/paths.ts';
import {
  stateDefinitionProjection,
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
export { validateClaudePlugin, validateCodexPlugin, validateCursorPlugin };
export type { ClaudePluginValidationReport, CodexPluginValidationReport, CursorPluginValidationReport };

export { HookService } from './services/hook-service.ts';
export type { HookListOptions, HookSimulationOptions } from './services/hook-service.ts';
export { createDefaultRegistry, TargetRegistry } from './adapters/registry.ts';
export { CapabilityStateError, capabilityStateNames, isCapabilityState } from './core/capabilities.ts';
export type {
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
export type {
  CreateDevRuntimeProvider,
  DevRuntimeProvider,
} from './dev/runtime-provider.ts';

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
  )[];
  readonly model?: NormalizedPlugin;
}

export type InspectionSkipReason = 'excluded-by-targets' | 'unsupported-capability';

export type InspectionComponentKind = 'command' | 'hook' | 'mcp-app' | 'mcp-server' | 'rule' | 'script' | 'skill';

/**
 * The target's own four-state judgment of the capability a component needs,
 * named so a reader can find the pinned row. Scripts need no host capability
 * and carry none.
 */
export type InspectionComponentCapability = CapabilityState & { readonly name: string };

/** One component the plan emits for this target. */
export interface InspectionSelectedComponent {
  readonly capability?: InspectionComponentCapability;
  readonly id: string;
  readonly kind: InspectionComponentKind;
  readonly name: string;
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

export interface InspectionPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly entries: readonly TargetArtifactEntry[];
  readonly hookEntries: readonly TargetHookEntry[];
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
  readonly output?: string;
  /**
   * Also produce the framework-owned npm package build (`dist/` bin + lib
   * outputs) when the project declares or conventionally provides one. The
   * CLI `build` command always requests this; programmatic artifact
   * operations (temporary artifacts, dev, evals) never do.
   */
  readonly packageOutputs?: boolean;
}

export interface BuildProjectResult {
  readonly build: BuildResult;
  readonly diagnostics: readonly Diagnostic[];
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

  const artifact = await mkdtemp(join(resolve(options.root), '.agent-bundle-artifact-'));
  try {
    await build({
      configPath: options.configPath,
      logger: options.logger,
      mode: options.mode,
      output: artifact,
      registry: options.registry,
      root: options.root,
      targets: options.targets,
    });
    return await operation(artifact);
  } finally {
    await rm(artifact, { force: true, recursive: true });
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
        .filter((target) =>
          target.name === 'claude' || target.name === 'codex' || target.name === 'cursor' || target.name === 'plugin')
        .map((target) => target.name === 'codex'
          ? validateCodexPlugin({
            pluginDirectory: join(artifact, target.name),
            strict: options.strict,
            target: target.name,
          })
          : target.name === 'cursor'
            ? validateCursorPlugin({
              pluginDirectory: join(artifact, target.name),
              target: target.name,
            })
            : validateClaudePlugin({
              pluginDirectory: join(artifact, target.name),
              strict: options.strict,
              target: target.name,
            })));
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
  readonly id: string;
  readonly kind: InspectionComponentKind;
  readonly name: string;
  readonly targets: readonly string[];
}

const inspectableComponents = (model: NormalizedPlugin): readonly InspectableComponent[] => [
  ...(model.commands ?? []).map((command) => ({ capability: 'commands', id: command.id, kind: 'command' as const, name: command.name, targets: command.targets })),
  ...model.hooks.map((hook) => ({ capability: 'hooks', id: hook.id, kind: 'hook' as const, name: hook.event, targets: hook.targets })),
  ...(model.mcpApps ?? []).map((app) => ({ capability: 'mcp', id: app.id, kind: 'mcp-app' as const, name: app.name, targets: app.targets })),
  ...model.mcpServers.map((server) => ({ capability: 'mcp', id: server.id, kind: 'mcp-server' as const, name: server.name, targets: server.targets })),
  ...(model.rules ?? []).map((rule) => ({ capability: 'rules', id: rule.id, kind: 'rule' as const, name: rule.name, targets: rule.targets })),
  ...model.scripts.map((script) => ({ id: script.id, kind: 'script' as const, name: script.name, targets: script.targets })),
  ...model.skills.map((skill) => ({ capability: 'skills', id: skill.id, kind: 'skill' as const, name: skill.name, targets: skill.targets })),
];

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
  const state = capabilities[component.capability];
  return Object.freeze({
    name: component.capability,
    ...(state ?? unavailableCapability(
      `The ${target} adapter publishes no ${component.capability} capability row.`,
    )),
  });
};

interface AccountedComponents {
  readonly selected: readonly InspectionSelectedComponent[];
  readonly skipped: readonly InspectionSkippedComponent[];
}

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
    } else if (capability !== undefined && !capabilityIsSupported(capability)) {
      skipped.push(Object.freeze({ ...identity, reason: 'unsupported-capability' satisfies InspectionSkipReason }));
    } else {
      selected.push(Object.freeze(identity));
    }
  }
  return { selected: Object.freeze(selected), skipped: Object.freeze(skipped) };
};

const inspectState = (model: NormalizedPlugin): StateInspection => {
  const definition = model.state;
  if (definition === undefined) return Object.freeze({ declared: false });
  const projection = stateDefinitionProjection(definition);
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
        targets: plans.map((plan) => ({ hookEntries: plan.hookEntries, name: plan.target })),
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
  return Object.freeze({
    build: result,
    diagnostics: prepared.diagnostics,
    model,
    ...(packageBuild === undefined ? {} : { packageBuild }),
    projectContext,
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
