/**
 * The CLI dispatch proof level.
 *
 * `invokeCli` runs one argv vector through the routed CLI's own shell
 * (`runGeneratedCliEntry`, #102 stage 2) over the compiled command graph the
 * manifest carries, in this process. Command resolution, the argv projection,
 * help, `--version`, and the exit-code mapping are the product's; the only
 * thing the harness supplies is the `execute` bridge that runs the matched
 * route module — and that mirrors the generated executable's, so a command
 * that passes here fails in the same place a shipped binary would.
 *
 * It does **not** spawn the generated binary: no shebang, no executable bit,
 * no process framing. That is the `packed-stdio` level's business.
 *
 * Rendered (`.tsx`) command routes compile no command until #102 stage 3, so
 * this level dispatches plain command routes only; a rendered command is a
 * compiler error (`AB4816`) long before it reaches a test.
 */
import type * as AgentRuntime from '@agent-bundle/runtime';

import { CliInputError, runGeneratedCliEntry } from '../cli-entry.ts';
import type { CompiledCliCommand } from '../routes/types.ts';
import { AgentTestError, captured } from './errors.ts';
import { CLI_DISPATCH_PROOF_LEVEL, type AgentBundleTestManifest } from './manifest.ts';
import { registeredRouteLoader, testManifest } from './registry.ts';
import type { RenderRouteContext } from './render.ts';
import type { AgentRouteModule, RenderedRouteProvenance } from './types.ts';

export interface InvokeCliOptions {
  /** Request-scope overrides for the dispatched command, over the runtime's request contract. */
  readonly context?: RenderRouteContext;
  readonly manifest?: AgentBundleTestManifest;
  readonly signal?: AbortSignal;
}

export interface CliInvocation {
  /** The argv vector as dispatched, including the command path segments. */
  readonly argv: readonly string[];
  /** The resolved command path (`db migrate`); absent for help, `--version`, and usage failures. */
  readonly command?: string;
  /**
   * The process exit code the routed shell mapped: 0 success (or the result's
   * `exitCode` under `config.exitCode: 'result'`), 1 execution failure,
   * 2 usage or input-validation failure.
   */
  readonly exitCode: number;
  readonly provenance: CliDispatchProvenance;
  readonly routeId?: string;
  /** Everything the shell wrote to its diagnostic stream. */
  readonly stderr: string;
  /** Everything the shell wrote to its output stream: one canonical JSON line, or help text. */
  readonly stdout: string;
  /** The validated result the command returned; absent unless a command executed. */
  readonly value?: unknown;
}

export interface CliDispatchProvenance extends Pick<RenderedRouteProvenance, 'manifestDigest' | 'projectRoot'> {
  readonly proofLevel: typeof CLI_DISPATCH_PROOF_LEVEL;
  /** Every command the graph compiled, so a dispatch failure can name the alternatives. */
  readonly commands: readonly string[];
}

const commandPath = (command: CompiledCliCommand): string => command.path.join(' ');

const provenanceOf = (manifest: AgentBundleTestManifest): CliDispatchProvenance => Object.freeze({
  commands: Object.freeze(manifest.cliCommands.map((command) => commandPath(command))),
  manifestDigest: manifest.digest,
  proofLevel: CLI_DISPATCH_PROOF_LEVEL,
  projectRoot: manifest.projectRoot,
});

const noCommands = (manifest: AgentBundleTestManifest): AgentTestError => new AgentTestError(
  'command-not-found',
  'This project compiled no routed CLI commands.',
  {
    details: [
      `project root: ${manifest.projectRoot}`,
      ...(manifest.diagnostics.length === 0
        ? []
        : [`compiler:     ${String(manifest.diagnostics.length)} diagnostic(s), first ${manifest.diagnostics[0]!.code}: ${manifest.diagnostics[0]!.message}`]),
    ],
    recovery: 'Add a plain command route under src/cli/ exporting inputSchema, resultSchema, and an async default function.',
  },
);

interface Runtime {
  readonly available: typeof AgentRuntime.available;
  readonly runAgentRequest: typeof AgentRuntime.runAgentRequest;
  readonly unavailable: typeof AgentRuntime.unavailable;
}

let runtimePromise: Promise<Runtime> | undefined;

/**
 * The runtime is loaded on first dispatch, not at module scope:
 * `@agent-bundle/runtime` is an optional peer, so importing this module must
 * stay free for a project that only reads the manifest.
 */
const loadRuntime = async (): Promise<Runtime> => {
  runtimePromise ??= import('@agent-bundle/runtime')
    .then((runtime) => ({
      available: runtime.available,
      runAgentRequest: runtime.runAgentRequest,
      unavailable: runtime.unavailable,
    }))
    .catch((error: unknown) => {
      runtimePromise = undefined;
      throw new AgentTestError('render-failed', 'Unable to load the Agent runtime for a CLI dispatch.', {
        cause: error,
        details: [`cause:        ${error instanceof Error ? error.message : String(error)}`],
        recovery: 'Install @agent-bundle/runtime; routed CLI projects depend on it for the request context.',
      });
    });
  return runtimePromise;
};

const moduleFor = async (
  manifest: AgentBundleTestManifest,
  routeId: string,
  provenance: CliDispatchProvenance,
): Promise<AgentRouteModule> => {
  const loader = registeredRouteLoader(manifest, routeId);
  if (loader === undefined) {
    throw new AgentTestError(
      'manifest-unavailable',
      `Command route ${routeId} is compiled but no test-time module loader is registered for it.`,
      {
        provenance: { ...provenance, kind: 'cli', routeId, source: 'manifest', targets: [] },
        recovery: 'Build the Rstest configuration with agentBundleRstest() so the generated setup registers route loaders.',
      },
    );
  }
  return loader();
};

/**
 * Dispatches one argv vector through the routed CLI shell in this process and
 * returns its exit code, streams, and validated result.
 *
 * This is the `cli-dispatch` proof level. Nothing is spawned.
 */
export const invokeCli = async (
  argv: readonly string[],
  options: InvokeCliOptions = {},
): Promise<CliInvocation> => {
  const manifest = options.manifest ?? testManifest();
  if (manifest.cliCommands.length === 0) throw noCommands(manifest);
  const provenance = provenanceOf(manifest);
  const runtime = await loadRuntime();
  const context = options.context ?? {};

  let executed: CompiledCliCommand | undefined;
  let value: unknown;
  let out = '';
  let err = '';

  const exitCode = await runGeneratedCliEntry({
    argv,
    commands: manifest.cliCommands,
    // The bridge the generated executable inlines: the module's own schemas
    // stay the validation boundary, an input rejection is a usage failure,
    // and the command body runs inside the typed request scope.
    execute: async (command, input, execution) => {
      executed = command;
      const module = await moduleFor(manifest, command.routeId, provenance);
      const component = (module as { default?: unknown }).default;
      if (typeof component !== 'function') {
        throw new AgentTestError('invalid-route-module', `Command route ${command.routeId} must default-export an async function.`, {
          details: [`received:     default export of type ${typeof component}`],
          recovery: 'Export the command function as the module default.',
        });
      }
      if (module.inputSchema === undefined || module.resultSchema === undefined) {
        throw new AgentTestError('invalid-route-module', `Command route ${command.routeId} must export inputSchema and resultSchema.`, {
          recovery: 'Export both zod schemas from the command module; the routed CLI validates argv through them.',
        });
      }
      let parsed: unknown;
      try {
        parsed = module.inputSchema.parse(input);
      } catch (error) {
        throw new CliInputError(error instanceof Error ? error.message : String(error));
      }
      const root = manifest.projectRoot;
      const result = await runtime.runAgentRequest({
        capabilities: {
          command: runtime.unavailable(),
          filesystem: runtime.unavailable(),
          network: runtime.unavailable(),
          projectRoot: runtime.available({ root }, 'derived'),
        },
        host: runtime.unavailable('unsupported-surface'),
        workspace: runtime.available({ root }, 'derived'),
        ...context,
        invocation: {
          kind: 'cli',
          operationId: command.routeId,
          surface: commandPath(command),
          ...context.invocation,
        },
        ...(context.progress === undefined ? {} : { progress: context.progress }),
        signal: execution.signal,
      }, async () => (component as (props: unknown) => Promise<unknown>)({
        input: parsed,
        signal: execution.signal,
      }));
      value = module.resultSchema.parse(result);
      return value;
    },
    name: manifest.plugin.name,
    version: manifest.plugin.version,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    writeErr: (text) => { err += text; },
    writeOut: (text) => { out += text; },
  });

  return Object.freeze({
    argv: Object.freeze([...argv]),
    ...(executed === undefined ? {} : { command: commandPath(executed), routeId: executed.routeId }),
    exitCode,
    provenance,
    stderr: err,
    stdout: out,
    ...(value === undefined ? {} : { value }),
  });
};

/** The parsed canonical JSON line a successful command wrote to stdout. */
export const cliJson = (invocation: CliInvocation): unknown => {
  try {
    return JSON.parse(invocation.stdout) as unknown;
  } catch (error) {
    throw new AgentTestError('projection-failed', 'The dispatched command did not write one canonical JSON line to stdout.', {
      cause: error,
      details: [
        `exit code:    ${String(invocation.exitCode)}`,
        `stdout:       ${captured(invocation.stdout)}`,
        ...(invocation.stderr === '' ? [] : [`stderr:       ${captured(invocation.stderr)}`]),
      ],
      provenance: {
        ...invocation.provenance,
        kind: 'cli',
        routeId: invocation.routeId ?? '(no command executed)',
        source: 'manifest',
        targets: [],
      },
      recovery: 'Assert stdout only for an invocation that executed a command; help and usage failures write text.',
    });
  }
};
