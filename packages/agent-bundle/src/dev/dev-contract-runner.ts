import {
  DEV_EPOCH_PROOF_LEVEL,
  testManifestFromRouteGraph,
} from '../test/manifest.ts';
import {
  ContractMatrixViolationError,
  runDevEpochContractMatrix,
  type ContractMatrixClient,
} from '../test/contract.ts';
import type { Diagnostic } from '../core/diagnostics.ts';
import { emptyCompiledRouteGraph } from '../routes/graph.ts';
import type { PreparedDevContractMatrix } from '../config/dev-contracts.ts';
import type { PreparedProject } from './project-service.ts';
import type { McpSession, McpSessionService } from './mcp-session/mcp-session-service.ts';
import {
  contractFailures,
  type EpochContractEvaluation,
} from './epoch-adoption-policy.ts';

export interface RunDevEpochContractsOptions {
  readonly contracts: PreparedDevContractMatrix;
  readonly epochId: string;
  readonly mcpSessions: McpSessionService;
  readonly prepared: PreparedProject;
}

const failureDiagnostic = (epochId: string, message: string): Diagnostic => Object.freeze({
  code: 'AB7006',
  message,
  recovery: 'Fix the failing route or fixture, then rebuild; host-facing surfaces keep the last passing epoch active.',
  severity: 'error',
  target: epochId,
});

const failed = (
  epochId: string,
  summary: string,
  diagnostics: readonly Diagnostic[],
  failures: EpochContractEvaluation['failures'] = Object.freeze([]),
): EpochContractEvaluation => Object.freeze({
  diagnostics: Object.freeze([...diagnostics]),
  epochId,
  failures,
  state: 'failed',
  summary,
});

const targetFor = (prepared: PreparedProject): string => {
  const targets = prepared.model?.targets.map((target) => target.name) ?? [];
  const target = targets.includes('portable') ? 'portable' : targets[0];
  if (target === undefined) throw new Error('Development contract matrix requires at least one generated target.');
  return target;
};

const serverFor = (prepared: PreparedProject, requested: string | undefined): string => {
  if (requested !== undefined) return requested;
  const names = [...new Set((prepared.routeGraph?.servers ?? []).map((server) => server.name))].sort();
  if (names.length !== 1 || names[0] === undefined) {
    throw new Error('dev.contracts.server is required unless the project compiles exactly one MCP server.');
  }
  return names[0];
};

const matrixClient = (session: McpSession, signal: AbortSignal): ContractMatrixClient => ({
  callTool: async (params, options) => session.callTool({
    arguments: params.arguments ?? {},
    name: params.name,
    signal: options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal]),
    ...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout }),
  }),
  getPrompt: async (params, options) => session.getPrompt({
    ...(params.arguments === undefined ? {} : { arguments: params.arguments }),
    name: params.name,
    signal: options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal]),
    ...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout }),
  }),
  listPrompts: async (_params, options) => ({
    prompts: [...await session.listPrompts({
      signal: options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal]),
      ...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout }),
    })],
  }),
  listResources: async (_params, options) => ({
    resources: [...await session.listResources({
      signal: options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal]),
      ...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout }),
    })],
  }),
  listTools: async (_params, options) => ({
    tools: [...await session.listTools({
      signal: options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal]),
      ...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout }),
    })],
  }),
  readResource: async (params, options) => ({
    contents: [...(await session.readResource({
      signal: options?.signal === undefined ? signal : AbortSignal.any([signal, options.signal]),
      ...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout }),
      uri: params.uri,
    })).contents] as never[],
  }),
});

/** Executes one generated epoch through the same session class used by live host connections. */
export const runDevEpochContracts = async (
  options: RunDevEpochContractsOptions,
): Promise<EpochContractEvaluation> => {
  const { contracts, epochId, prepared } = options;
  if (contracts.fixtures === undefined) {
    return failed(
      epochId,
      'Development contract fixture declaration is invalid.',
      contracts.diagnostics,
    );
  }
  const target = targetFor(prepared);
  const serverName = serverFor(prepared, contracts.server);
  const manifest = testManifestFromRouteGraph({
    apps: prepared.model?.mcpApps ?? [],
    configPath: prepared.configPath,
    diagnostics: prepared.diagnostics,
    graph: prepared.routeGraph ?? emptyCompiledRouteGraph,
    ...(prepared.model === undefined
      ? {}
      : {
          plugin: {
            name: prepared.model.metadata.name,
            ...(prepared.model.metadata.packageName === undefined
              ? {}
              : { packageName: prepared.model.metadata.packageName }),
            ...(prepared.model.metadata.packageVersion === undefined
              ? {}
              : { packageVersion: prepared.model.metadata.packageVersion }),
            version: prepared.model.metadata.version,
          },
        }),
    projectRoot: prepared.root,
    ...(prepared.model?.state === undefined ? {} : { state: prepared.model.state }),
    targets: prepared.model?.targets.map((entry) => entry.name) ?? [],
  });
  let session: McpSession | undefined;
  try {
    session = await options.mcpSessions.open({
      epochId,
      serverName,
      target,
    });
    const signal = AbortSignal.timeout(session.timeoutMs);
    await runDevEpochContractMatrix({
      fixtures: contracts.fixtures,
      manifest,
      ...(contracts.server === undefined ? {} : { server: contracts.server }),
      session: {
        client: matrixClient(session, signal),
        provenance: {
          epochId,
          proofLevel: DEV_EPOCH_PROOF_LEVEL,
          serverName,
          target,
        },
        stderr: () => session?.stderr() ?? '',
      },
    });
    return Object.freeze({
      diagnostics: Object.freeze([]),
      epochId,
      failures: Object.freeze([]),
      state: 'passed',
      summary: 'Development contract matrix passed.',
    });
  } catch (error) {
    if (error instanceof ContractMatrixViolationError) {
      return failed(
        epochId,
        `Development contract matrix reported ${String(error.failures.length)} violation(s).`,
        [failureDiagnostic(epochId, error.message)],
        contractFailures(error.failures),
      );
    }
    return failed(
      epochId,
      'Development contract matrix could not complete.',
      [failureDiagnostic(epochId, error instanceof Error ? error.message : String(error))],
    );
  } finally {
    await session?.close().catch(() => undefined);
  }
};
