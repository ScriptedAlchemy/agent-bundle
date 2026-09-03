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

import { CliInputError, runGeneratedCliEntry } from '../cli-entry.ts';
import type { CliRenderedEvent } from '../cli-entry.ts';
import type { CompiledCliCommand } from '../routes/types.ts';
import { AgentTestError, captured } from './errors.ts';
import { CLI_DISPATCH_PROOF_LEVEL, type AgentBundleTestManifest } from './manifest.ts';
import { mountProviders } from './providers.ts';
import { registeredRouteLoader, testManifest } from './registry.ts';
import { prepareCliRenderHost, type HarnessOptionsArguments, type RenderRouteContextInit } from './render.ts';
import type { AgentRouteModule, RenderedRouteProvenance } from './types.ts';

export type { CliRenderedEvent };

export interface InvokeCliOptionsBase {
  readonly manifest?: AgentBundleTestManifest;
  readonly signal?: AbortSignal;
  /**
   * Selects interactive rendered output explicitly. Generated binaries use
   * `process.stdout.isTTY`; the in-process harness defaults to piped output.
   */
  readonly tty?: boolean;
}

/**
 * Dispatch options; `context` carries the request-scope overrides for the
 * dispatched command over the runtime's request contract and is required once
 * the project declares providers (see {@link RenderRouteContextInit}).
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
  readonly routeId?: string;
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
  ...[options = {}]: HarnessOptionsArguments<InvokeCliOptions>
): Promise<CliInvocation> => {
  const manifest = options.manifest ?? testManifest();
  if (manifest.cliCommands.length === 0) throw noCommands(manifest);
  const provenance = provenanceOf(manifest);
  const runtime = await loadRuntime();
  const context = options.context ?? {};
  const signal = options.signal ?? new AbortController().signal;
  const renderedCommands = manifest.cliCommands.filter((command) => command.rendered);

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
        let parsed: unknown;
        try {
          parsed = module.inputSchema.parse(input);
        } catch (error) {
          throw new CliInputError(error instanceof Error ? error.message : String(error));
        }
        const root = process.cwd();
        // Same provider invocation the generated plain-command path builds (#366).
        const providers = await mountProviders({
          explicit: context.providers,
          invocation: { kind: 'cli', props: { args: execution.args, command: commandPath(command) } },
          manifest,
          provenance: { ...provenance, kind: 'cli', routeId: command.routeId, source: 'manifest', targets: [] },
          signal: execution.signal,
        });
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
      isTty: () => options.tty === true,
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
      version: manifest.plugin.version,
      writeErr: (text) => { err += text; },
      writeOut: (text) => { out += text; },
    });
  } finally {
    await renderHost?.close();
  }

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

/** The ordered render events a successful `--ndjson` invocation wrote to stdout. */
export const cliNdjson = (invocation: CliInvocation): readonly CliRenderedEvent[] => {
  try {
    const lines = invocation.stdout.endsWith('\n')
      ? invocation.stdout.slice(0, -1).split('\n')
      : invocation.stdout.split('\n');
    if (lines.length === 0 || lines.some((line) => line.trim() === '')) {
      throw new SyntaxError('NDJSON output must contain one non-empty JSON object per line.');
    }
    return Object.freeze(lines.map((line) => {
      const event = JSON.parse(line) as unknown;
      if (typeof event !== 'object' || event === null || Array.isArray(event)) {
        throw new SyntaxError('NDJSON output lines must be JSON objects.');
      }
      const record = event as Record<string, unknown>;
      if (!Number.isInteger(record['sequence'])) {
        throw new SyntaxError('NDJSON render events must carry an integer sequence.');
      }
      switch (record['type']) {
        case 'shell':
        case 'progress':
        case 'replace':
        case 'error':
        case 'complete':
          break;
        default:
          throw new SyntaxError('NDJSON output contains an unknown render-event type.');
      }
      return event as CliRenderedEvent;
    }));
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
