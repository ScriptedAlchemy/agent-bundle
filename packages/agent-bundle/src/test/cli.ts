/**
 * The CLI dispatch proof level.
 *
 * `invokeCli` runs one argv vector through the routed CLI's own shell
 * (`runGeneratedCliEntry`, #102 stage 2) over the compiled command graph the
 * manifest carries, in this process. Command resolution, the argv projection,
 * help, output-mode selection, and exit-code mapping are the product's. Plain
 * commands run through an in-process `execute` bridge; rendered commands run
 * through an in-process render session that shares the route-unit harness's
 * dispatcher and Flight renderer. Projected MCP commands use that local
 * renderer with the same tool invocation and request-context shapes as the
 * generated MCP server; no MCP transport or wire client is involved.
 *
 * It does **not** spawn the generated binary: no shebang, no executable bit,
 * worker thread, process framing, or chunk-by-chunk Flight streaming timing.
 * It also does not negotiate MCP progress or task support over a wire. The
 * packed CLI route suite owns executable evidence; MCP transport suites own
 * wire behavior.
 */
import type * as AgentRuntime from '@agent-bundle/runtime';
import type { RegisteredRouteId } from '@agent-bundle/runtime';

import { runGeneratedCliEntry } from '../cli-entry.ts';
import type { CliRenderedEvent } from '../cli-entry.ts';
import { createProviderProcessLifetime } from '../routes/provider-execution.ts';
import type { CompiledCliCommand } from '../routes/types.ts';
import { AgentTestError, captured } from './errors.ts';
import { CLI_DISPATCH_PROOF_LEVEL, type AgentBundleTestManifest } from './manifest.ts';
import { parseCanonicalJsonLine, parseRenderedEventLines } from './output-modes.ts';
import { claimProcessHit, harnessPluginRoot, mountProviders } from './providers.ts';
import { registeredRouteLoader, testManifest } from './registry.ts';
import {
  loadCliProjectionModules,
  parseCliCommandInput,
  prepareCliRenderHost,
  type HarnessOptionsArguments,
  type RenderRouteContextInit,
} from './render.ts';
import { harnessTerminal } from './terminal.ts';
import type { AgentRouteModule, RenderedRouteProvenance } from './types.ts';

export type { CliRenderedEvent };

export interface InvokeCliOptionsBase {
  readonly manifest?: AgentBundleTestManifest;
  readonly signal?: AbortSignal;
  /**
   * Selects interactive rendered output explicitly. Generated binaries probe
   * `process.stdout`; the in-process harness defaults to piped output. The
   * same knob shapes the `request.terminal` the command observes (#511): a
   * synthetic 80×24 basic-color terminal on both streams, or two color-free
   * pipes. Inject `context.terminal` to choose other values.
   */
  readonly tty?: boolean;
}

/**
 * Dispatch options; `context` carries the request-scope overrides for the
 * dispatched command over the runtime's request contract; omitting it (or its
 * `providers`) mounts the project's conventional providers exactly as the
 * generated executable does (see {@link RenderRouteContextInit}).
 */
export type InvokeCliOptions = InvokeCliOptionsBase & RenderRouteContextInit;

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
  /**
   * The compiled route the shell executed: a `cli:` route, or the `tool:`
   * route behind a projected MCP command. Typed from the project's route
   * registration once `.agent-bundle/routes.d.ts` is in the program (both
   * kinds register), `string` without it; absent for help, `--version`, and
   * usage failures. `argv` itself stays `readonly string[]` — it is the shell's
   * input, not a route id.
   */
  readonly routeId?: RegisteredRouteId;
  /** Everything the shell wrote to its diagnostic stream. */
  readonly stderr: string;
  /** Everything the shell wrote to stdout, including rendered Markdown, TTY, JSON, or NDJSON output. */
  readonly stdout: string;
  /** The validated plain result or rendered document value; absent unless a command completed validation. */
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
    recovery: 'Add a command route under src/cli/ exporting inputSchema, resultSchema, and an async default function or component.',
  },
);

interface Runtime {
  readonly available: typeof AgentRuntime.available;
  readonly resolvePluginRoot: typeof AgentRuntime.resolvePluginRoot;
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
      resolvePluginRoot: runtime.resolvePluginRoot,
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
  ...[options = {}]: HarnessOptionsArguments<InvokeCliOptions>
): Promise<CliInvocation> => {
  const manifest = options.manifest ?? testManifest();
  if (manifest.cliCommands.length === 0) throw noCommands(manifest);
  const provenance = provenanceOf(manifest);
  const runtime = await loadRuntime();
  const context = options.context ?? {};
  const signal = options.signal ?? new AbortController().signal;
  // One simulated executable per invocation: the generated CLI creates its
  // process identity at module load, so every separate run starts at hit 1.
  const processLifetime = createProviderProcessLifetime();
  const renderedCommands = manifest.cliCommands.filter((command) => command.rendered);
  const projectionModules = await loadCliProjectionModules(manifest, manifest.cliCommands);

  let executed: CompiledCliCommand | undefined;
  let value: unknown;
  let out = '';
  let err = '';

  const renderedModules = new Map<string, AgentRouteModule>();
  for (const command of renderedCommands) {
    renderedModules.set(command.routeId, await moduleFor(manifest, command.routeId, provenance));
  }
  const firstRendered = renderedCommands[0];
  const firstDescriptor = firstRendered === undefined ? undefined : manifest.routes[firstRendered.routeId];
  const renderHost = firstRendered === undefined
    ? undefined
    : await prepareCliRenderHost({
      context,
      manifest,
      modules: renderedModules,
      onValidated: (validated) => { value = validated; },
      processLifetime,
      projectionModules,
      provenance: {
        kind: 'cli',
        manifestDigest: manifest.digest,
        ...(firstDescriptor === undefined
          ? {}
          : {
              modulePath: firstDescriptor.source,
              relativePath: firstDescriptor.relativePath,
            }),
        projectRoot: manifest.projectRoot,
        proofLevel: CLI_DISPATCH_PROOF_LEVEL,
        routeId: firstRendered.routeId,
        source: 'manifest',
        targets: manifest.targets,
      },
      signal,
    });

  let exitCode: number;
  try {
    exitCode = await runGeneratedCliEntry({
      argv,
      commands: manifest.cliCommands,
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
        const parsed = parseCliCommandInput(
          command,
          module,
          projectionModules.get(command.routeId),
          input,
        );
        const root = process.cwd();
        const plugin = harnessPluginRoot({ context, manifest, resolvePluginRoot: runtime.resolvePluginRoot });
        // Same provider invocation the generated plain-command path builds (#366).
        const providers = mountProviders({
          explicit: context.providers,
          invocation: { kind: 'cli', props: { args: execution.args, command: commandPath(command) } },
          manifest,
          processHit: claimProcessHit(processLifetime),
          provenance: { ...provenance, kind: 'cli', routeId: command.routeId, source: 'manifest', targets: [] },
        });
        const result = await runtime.runAgentRequest({
          capabilities: {
            command: runtime.unavailable(),
            filesystem: runtime.unavailable(),
            network: runtime.unavailable(),
            projectRoot: runtime.available({ root }, 'derived'),
          },
          host: runtime.unavailable('unsupported-surface'),
          plugin,
          terminal: runtime.available(execution.terminal, 'native'),
          workspace: runtime.available({ root }, 'derived'),
          ...context,
          providers,
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
      ...(renderHost === undefined
        ? {}
        : {
            render: (command, input, execution) => {
              executed = command;
              return renderHost.render(command, input, execution);
            },
          }),
      signal,
      terminal: harnessTerminal('cli', options.tty === true),
      version: manifest.plugin.version,
      writeErr: (text) => { err += text; },
      writeOut: (text) => { out += text; },
    });
  } finally {
    await renderHost?.close();
  }

  return Object.freeze({
    argv: Object.freeze([...argv]),
    // The compiled command graph's ids are the ones the registration lists.
    ...(executed === undefined ? {} : { command: commandPath(executed), routeId: executed.routeId as RegisteredRouteId }),
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
    return parseCanonicalJsonLine(invocation.stdout);
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

/** The ordered render events a successful `--ndjson` invocation wrote to stdout. */
export const cliNdjson = (invocation: CliInvocation): readonly CliRenderedEvent[] => {
  try {
    return parseRenderedEventLines(invocation.stdout);
  } catch (error) {
    throw new AgentTestError('projection-failed', 'The dispatched command did not write one JSON object per line to stdout.', {
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
      recovery: 'Call cliNdjson() only for a rendered invocation that passed --ndjson and wrote a complete event stream.',
    });
  }
};
