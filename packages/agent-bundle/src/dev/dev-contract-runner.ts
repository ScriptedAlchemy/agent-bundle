import {
  DEV_EPOCH_PROOF_LEVEL,
  testManifestFromRouteGraph,
} from '../test/manifest.ts';
import {
  ContractMatrixViolationError,
  runDevEpochContractMatrix,
  type ContractMatrixClient,
  type ContractProgressNotification,
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
  code: 'AB7211',
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

/**
 * The generated target whose manifest carries the selected server. A server
 * restricted to `targets: ['claude']` is absent from the portable manifest, so
 * the choice is made over the server's own target list intersected with the
 * project's; `portable` still wins whenever it is eligible.
 */
export const devContractTarget = (
  prepared: Pick<PreparedProject, 'model'>,
  serverName: string,
): string => {
  const projectTargets = prepared.model?.targets.map((target) => target.name) ?? [];
  const server = prepared.model?.mcpServers.find((candidate) => candidate.name === serverName);
  const eligible = server === undefined
    ? projectTargets
    : projectTargets.filter((target) => server.targets.includes(target));
  const target = eligible.includes('portable') ? 'portable' : eligible[0];
  if (target === undefined) {
    throw new Error(
      projectTargets.length === 0
        ? 'Development contract matrix requires at least one generated target.'
        : `Development contract matrix server ${JSON.stringify(serverName)} is emitted for none of the project's targets.`,
    );
  }
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

/** The session's per-request timeout, applied afresh to each matrix request rather than once for the whole matrix. */
const requestSignal = (session: Pick<McpSession, 'timeoutMs'>, options: { readonly signal?: AbortSignal } | undefined): AbortSignal => {
  const timeout = AbortSignal.timeout(session.timeoutMs);
  return options?.signal === undefined ? timeout : AbortSignal.any([timeout, options.signal]);
};

type MatrixSession = Pick<
  McpSession,
  'callTool' | 'getPrompt' | 'listPrompts' | 'listResources' | 'listTools' | 'readResource' | 'subscribeTrace' | 'timeoutMs' | 'trace'
>;

export const matrixClient = (session: MatrixSession): ContractMatrixClient => ({
  callTool: async (params, options) => session.callTool({
    arguments: params.arguments ?? {},
    name: params.name,
    signal: requestSignal(session, options),
    ...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout }),
  }),
  getPrompt: async (params, options) => session.getPrompt({
    ...(params.arguments === undefined ? {} : { arguments: params.arguments }),
    name: params.name,
    signal: requestSignal(session, options),
    ...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout }),
  }),
  listPrompts: async (_params, options) => ({
    prompts: [...await session.listPrompts({
      signal: requestSignal(session, options),
      ...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout }),
    })],
  }),
  listResources: async (_params, options) => ({
    resources: [...await session.listResources({
      signal: requestSignal(session, options),
      ...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout }),
    })],
  }),
  listTools: async (_params, options) => ({
    tools: [...await session.listTools({
      signal: requestSignal(session, options),
      ...(options?.timeout === undefined ? {} : { timeoutMs: options.timeout }),
    })],
  }),
  // Lifecycle fixtures count live progress; the session records every server
  // notification in its trace synchronously on receipt, so a live trace
  // subscription is the supported notification path for this non-SDK client.
  observeProgress: (listener) => {
    const latest = session.trace().entries.at(-1)?.sequence ?? 0;
    const subscription = session.subscribeTrace({ afterSequence: latest }, (entry) => {
      if ('kind' in entry && entry.kind === 'progress') listener({ params: entry.payload as ContractProgressNotification['params'] });
    });
    return () => subscription.unsubscribe();
  },
  readResource: async (params, options) => ({
    contents: [...(await session.readResource({
      signal: requestSignal(session, options),
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
  const serverName = serverFor(prepared, contracts.server);
  const target = devContractTarget(prepared, serverName);
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
    await runDevEpochContractMatrix({
      fixtures: contracts.fixtures,
      manifest,
      ...(contracts.server === undefined ? {} : { server: contracts.server }),
      session: {
        client: matrixClient(session),
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
