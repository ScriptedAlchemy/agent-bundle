import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { createDefaultRegistry, TargetRegistry } from './adapters/registry.ts';
import type { TargetArtifactEntry, TargetHookEntry } from './adapters/types.ts';
import { build as buildArtifact, type BuildResult } from './build/build.ts';
export type { BuildResult } from './build/build.ts';
export type { ArtifactOutputKind, ArtifactOutputProvenance } from './build/provenance.ts';
export type { ProjectContext, ProjectSourceInput, ProjectSourceSnapshotInput } from './core/project-context.ts';
export type {
  ArtifactManifestAgentSkills,
  ArtifactManifestFile,
  ArtifactManifestFileKind,
  ArtifactManifestProducer,
  ArtifactManifestProject,
  ArtifactManifestSourceInput,
  ArtifactManifestTarget,
  ArtifactManifestTargetSchema,
  ArtifactManifestTargetValidation,
  ArtifactManifestV2,
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
import { validateArtifact } from './build/validate-artifact.ts';
import { DiagnosticError, type Diagnostic } from './core/diagnostics.ts';
export type { Diagnostic, DiagnosticSeverity } from './core/diagnostics.ts';
import type { ProjectContext } from './core/project-context.ts';
import type { NormalizedPlugin } from './core/types.ts';
import { ProjectService, type PreparedProject } from './dev/project-service.ts';
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

export { HookService } from './services/hook-service.ts';
export type { HookListOptions, HookSimulationOptions } from './services/hook-service.ts';
export { createDefaultRegistry, TargetRegistry } from './adapters/registry.ts';
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
}

export interface ValidateResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly model?: NormalizedPlugin;
}

export interface InspectionPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly entries: readonly TargetArtifactEntry[];
  readonly hookEntries: readonly TargetHookEntry[];
  readonly target: string;
}

export interface InspectOptions extends ProjectOptions {
  readonly focus?: 'hooks' | 'skills';
  readonly target?: string;
}

export interface ReadyInspectResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly model: NormalizedPlugin;
  readonly plans: readonly InspectionPlan[];
  readonly projectContext: ProjectContext;
  readonly selected?: {
    readonly hooks?: NormalizedPlugin['hooks'];
    readonly skills?: NormalizedPlugin['skills'];
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
}

export interface BuildProjectResult {
  readonly build: BuildResult;
  readonly diagnostics: readonly Diagnostic[];
  readonly model: NormalizedPlugin;
  readonly projectContext: ProjectContext;
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

export interface ListHooksOptions extends ArtifactOperationOptions {
  readonly target?: string;
}

export interface SimulateHookOptions extends ListHooksOptions {
  readonly hook: string;
  readonly input: Record<string, unknown>;
  readonly target: string;
}

const freezeDiagnostics = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] =>
  Object.freeze(diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })));

const hasErrors = (diagnostics: readonly Diagnostic[]): boolean =>
  diagnostics.some((diagnostic) => diagnostic.severity === 'error');

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

const resolveOutput = (root: string, output: string | undefined): string =>
  resolve(root, output ?? 'dist');

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
  const plans = Object.freeze(
    model.targets
      .filter((candidate) => options.target === undefined || candidate.name === options.target)
      .map((target) => {
        const plan = prepared.registry.get(target.name).plan(model);
        return Object.freeze({
          diagnostics: freezeDiagnostics(plan.diagnostics),
          entries: Object.freeze([...plan.entries]),
          hookEntries: Object.freeze([...(plan.hookEntries ?? [])]),
          target: target.name,
        });
      }),
  );
  const selected = options.focus === undefined
    ? undefined
    : Object.freeze({
      ...(options.focus === 'hooks' ? { hooks: model.hooks } : {}),
      ...(options.focus === 'skills' ? { skills: model.skills } : {}),
    });
  return Object.freeze({
    diagnostics: prepared.diagnostics,
    model,
    plans,
    projectContext,
    ...(selected === undefined ? {} : { selected }),
    state: 'ready',
  });
};

export const build = async (options: BuildOptions): Promise<BuildProjectResult> => {
  const root = resolve(options.root);
  const output = resolveOutput(root, options.output);
  const prepared = await new ProjectService({ ...options, outputRoots: [output], root }).prepare('build');
  const model = requirePreparedModel(prepared);
  const projectContext = prepared.projectContext;
  if (projectContext === undefined) throw new DiagnosticError(prepared.diagnostics);
  log(options.logger, 'artifact.build', { output, root: prepared.root });
  const result = await buildArtifact({
    model,
    outputRoot: output,
    projectContext,
    projectRoot: prepared.root,
    registry: prepared.registry,
  });
  return Object.freeze({ build: result, diagnostics: prepared.diagnostics, model, projectContext });
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
