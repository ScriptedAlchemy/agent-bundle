import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { createDefaultRegistry } from './adapters/registry.ts';
import type { TargetArtifactEntry, TargetHookEntry } from './adapters/types.ts';
import { build as buildArtifact, type BuildResult } from './build/build.ts';
export type { BuildResult } from './build/build.ts';
export type { ArtifactOutputKind, ArtifactOutputProvenance } from './build/provenance.ts';
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
import { validateArtifact } from './build/validate-artifact.ts';
import { DiagnosticError, type Diagnostic } from './core/diagnostics.ts';
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

export interface StructuredLogger {
  log?(event: string, details: Readonly<Record<string, unknown>>): void;
}

export interface ProjectOptions {
  readonly configPath?: string;
  readonly logger?: StructuredLogger;
  readonly mode?: string;
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

export interface InspectResult {
  readonly diagnostics: readonly Diagnostic[];
  readonly model: NormalizedPlugin;
  readonly plans: readonly InspectionPlan[];
  readonly selected?: {
    readonly hooks?: NormalizedPlugin['hooks'];
    readonly skills?: NormalizedPlugin['skills'];
  };
}

export interface BuildOptions extends ProjectOptions {
  readonly output?: string;
}

export interface BuildProjectResult {
  readonly build: BuildResult;
  readonly diagnostics: readonly Diagnostic[];
  readonly model: NormalizedPlugin;
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

const resolveOutput = (root: string, output: string | undefined): string =>
  resolve(root, output ?? 'dist');

const temporaryArtifact = async <Result>(
  options: ArtifactOperationOptions,
  operation: (artifact: string) => Promise<Result>,
): Promise<Result> => {
  if (options.artifact !== undefined) return operation(resolve(options.artifact));

  const artifact = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-'));
  try {
    await build({
      configPath: options.configPath,
      logger: options.logger,
      mode: options.mode,
      output: artifact,
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
    return Object.freeze({ diagnostics: freezeDiagnostics(await validateArtifact({ artifactRoot: artifact })) });
  }

  const prepared = await prepareProject(options, 'validate');
  return Object.freeze({
    diagnostics: prepared.diagnostics,
    ...(prepared.model === undefined ? {} : { model: prepared.model }),
  });
};

export const inspect = async (options: InspectOptions): Promise<InspectResult> => {
  const prepared = await prepareProject(options, 'inspect');
  const model = requirePreparedModel(prepared);
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
    ...(selected === undefined ? {} : { selected }),
  });
};

export const build = async (options: BuildOptions): Promise<BuildProjectResult> => {
  const prepared = await prepareProject(options, 'build');
  const model = requirePreparedModel(prepared);
  const output = resolveOutput(prepared.root, options.output);
  log(options.logger, 'artifact.build', { output, root: prepared.root });
  const result = await buildArtifact({
    model,
    outputRoot: output,
    projectRoot: prepared.root,
    registry: prepared.registry,
  });
  return Object.freeze({ build: result, diagnostics: prepared.diagnostics, model });
};

export const listMcp = async (options: ListMcpOptions): Promise<McpListResult> =>
  temporaryArtifact(options, async (artifact) => new McpService().list({
    artifact,
    server: options.server,
    target: options.target,
    timeoutMs: options.timeoutMs,
    workspaceRoot: resolve(options.root),
  } satisfies McpListOptions));

export const invokeMcp = async (options: InvokeMcpOptions): Promise<McpInvokeResult> =>
  temporaryArtifact(options, async (artifact) => new McpService().invoke({
    artifact,
    input: options.input,
    server: options.server,
    target: options.target,
    timeoutMs: options.timeoutMs,
    tool: options.tool,
    workspaceRoot: resolve(options.root),
  } satisfies McpInvokeOptions));

export const listHooks = async (options: ListHooksOptions) => {
  if (options.target !== undefined && !createDefaultRegistry().has(options.target)) {
    throw new RangeError(`Unknown target ${JSON.stringify(options.target)}.`);
  }
  return temporaryArtifact(options, async (artifact) => new HookService().list({
    artifact,
    target: options.target,
  } satisfies HookListOptions));
};

export const simulateHook = async (options: SimulateHookOptions): Promise<unknown> =>
  temporaryArtifact(options, async (artifact) => new HookService().simulate({
    artifact,
    hook: options.hook,
    input: options.input,
    target: options.target,
  } satisfies HookSimulationOptions));
