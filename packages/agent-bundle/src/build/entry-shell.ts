import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { eventIpcRuntimeSpecifier, eventProjectRuntimeSpecifier } from '../adapters/hook-contract.ts';
import { operatorEnvLayerImport, operatorEnvLayerImports, operatorEnvLayerStatement } from './launch-env-shell.ts';
import type { NoticeDeliveryAdvertisement } from '../adapters/notice-delivery.ts';
import { stableJson } from '../core/digest.ts';
import type { NormalizedHook, NormalizedNoticeRetentionPolicy, NormalizedStateDefinition } from '../core/types.ts';
import {
  orderedProviders,
  requiredProviderKeyProblemMessage,
  selectRequiredProviders,
} from '../routes/provider-execution.ts';
import { layoutChainFor, layoutRouteName } from '../routes/layouts.ts';
import { mcpRouteProtocolName } from '../routes/protocol-name.ts';
import { providerKeyFromName } from '../routes/providers.ts';
import type { CompiledAgentRoute, CompiledCliCommand, CompiledLayout, CompiledProvider } from '../routes/types.ts';

/**
 * Generated-entry templates: the framework-provided entry files consumers
 * would otherwise write by hand (react-router's provided-entry trick). Every
 * template imports its consumer module by absolute path, exactly like the
 * generated hook wrappers, and is bundled through the same Rslib synthesis.
 */

export const mcpEntryRuntimeSpecifier = 'agent-bundle/mcp-entry';

/**
 * The shared server runtime a generated route entry delegates to: warm Flight
 * host, route registration, projection. Aliased rather than imported so the
 * emitted artifact stays self-contained, and shared rather than templated so
 * `agent-bundle/test`'s in-memory projection level exercises this exact code.
 */
export const mcpServerRuntimeSpecifier = 'agent-bundle/mcp-server-runtime';

const noticeInboxRuntimeSpecifier = '@agent-bundle/runtime/notices/inbox-route';

/**
 * The on-disk location of one runtime module used as a bundler alias, so
 * generated entries inline it instead of leaving an `agent-bundle` import in
 * the emitted artifact (artifacts must stay self-contained). From the bundled
 * package this module's URL is `dist/<bundle>.js` with `<name>.js` as a
 * sibling; from checked-out sources it is `src/build/entry-shell.ts` with
 * `../<name>.ts`. Spelled as paths, not `new URL(…, import.meta.url)`: the
 * package's own Rslib build would otherwise read the template as a directory
 * context and replace it with a lookup that throws at run time.
 */
const runtimeModulePath = (name: string): string => {
  const here = dirname(fileURLToPath(import.meta.url));
  for (const path of [join(here, `${name}.js`), join(here, '..', `${name}.ts`)]) {
    if (existsSync(path)) return path;
  }
  throw new Error(`Unable to locate the agent-bundle/${name} runtime module for generated entries.`);
};

export const mcpEntryRuntimePath = (): string => runtimeModulePath('mcp-entry');

export const mcpServerRuntimePath = (): string => runtimeModulePath('mcp-server-runtime');

/** The on-disk `agent-bundle/launch-env` module (#469), aliased into every artifact shell that applies the operator `.env` layer. */
export const launchEnvRuntimePath = (): string => runtimeModulePath('launch-env');

/**
 * The terminal-capability probe (#511) aliased into `main`-envelope
 * executables: plain Node, dependency-free, so a plain script or bin learns
 * its TTY-ness, color, and size without loading the routed-CLI shell.
 */
export const terminalCapabilityRuntimeSpecifier = 'agent-bundle/terminal-capability';

export const terminalCapabilityRuntimePath = (): string => runtimeModulePath('terminal-capability');

/** The surface a `main`-envelope executable reports as its `terminal.hostSurface`. */
export type GeneratedExecutableSurface = 'cli' | 'script';

/**
 * The generated prelude of a stdio MCP entry: the stdout guard, then the
 * operator `.env` layer (#469), as one virtual module the shell imports
 * first. stdout is the protocol wire on a stdio server, so the guard must be
 * in place before the server module's own top level runs — and under
 * bundling that top level precedes the shell body whichever way the module
 * is imported, so only an earlier import can install it. The guard is the
 * one `agent-bundle/mcp-entry` exports; the lifecycle adopts it rather than
 * installing a second. Hook wrappers and the CLI bin import the env-only
 * layer instead: they legitimately write stdout.
 */
export const stdioPreludeSpecifier = 'agent-bundle/stdio-prelude';

/** The import every generated stdio MCP entry places first. */
export const stdioPreludeImport = `import ${JSON.stringify(stdioPreludeSpecifier)};`;

/** The prelude source: guard first, so nothing after it can reach stdout; then the layer with the server's manifest `env` defaults. */
export const stdioPreludeModuleSource = (manifestEnv?: Readonly<Record<string, string>>): string => [
  ...operatorEnvLayerImports,
  `import { redirectConsoleToStderr } from ${JSON.stringify(mcpEntryRuntimeSpecifier)};`,
  '',
  'redirectConsoleToStderr();',
  operatorEnvLayerStatement(manifestEnv),
  '',
].join('\n');

/** The prelude as the virtual module an Rslib entry serves beside its shell. */
export const stdioPreludeVirtualModule = (
  manifestEnv?: Readonly<Record<string, string>>,
): { readonly name: string; readonly source: string } => ({
  name: stdioPreludeSpecifier,
  source: stdioPreludeModuleSource(manifestEnv),
});

/**
 * The generated stdio MCP entry body for a factory-exporting server module.
 * The prelude is the first import and the server module a static import
 * after it: the bundler inlines every module of the single-chunk bundle
 * ahead of the entry body and places a dynamic import's target ahead of the
 * static ones, so only static import order puts the guard and the layer
 * before the server module's own top level (see launchEnvLayerSpecifier).
 */
export const generatedStdioMcpEntrySource = (options: {
  readonly entrySource: string;
  readonly serverName: string;
}): string => [
  stdioPreludeImport,
  `import { runGeneratedStdioMcpEntry } from ${JSON.stringify(mcpEntryRuntimeSpecifier)};`,
  `import * as serverModule from ${JSON.stringify(options.entrySource)};`,
  '',
  'await runGeneratedStdioMcpEntry({',
  '  loadEntry: async () => serverModule,',
  `  serverName: ${JSON.stringify(options.serverName)},`,
  '});',
  '',
].join('\n');

/**
 * The generated process envelope for a `main`- or default-exporting
 * executable entry (npm bin outputs and artifact Scripts): await the entry
 * point with argv and the process's terminal capability (#511), adopt a
 * numeric return as the exit code, and let an escaped rejection surface
 * through Node's top-level failure path (stack to stderr, exit code 1).
 */
export const generatedExecutableEntrySource = (options: {
  readonly entrySource: string;
  readonly exportName: 'default' | 'main';
  /** `cli` for a package bin, `script` for an artifact script; defaults to `script`. */
  readonly hostSurface?: GeneratedExecutableSurface;
}): string => [
  `import { detectProcessTerminal } from ${JSON.stringify(terminalCapabilityRuntimeSpecifier)};`,
  `import * as entry from ${JSON.stringify(options.entrySource)};`,
  '',
  `const main = entry[${JSON.stringify(options.exportName)}];`,
  "if (typeof main !== 'function') {",
  `  throw new TypeError('Executable entry must export a ${options.exportName} function: ' + ${JSON.stringify(options.entrySource)});`,
  '}',
  `const code = await main(process.argv.slice(2), Object.freeze({ terminal: detectProcessTerminal(${JSON.stringify(options.hostSurface ?? 'script')}) }));`,
  "if (typeof code === 'number') process.exitCode = code;",
  '',
].join('\n');


export const cliEntryRuntimeSpecifier = 'agent-bundle/cli-entry';

/**
 * The on-disk location of the `agent-bundle/cli-entry` runtime module,
 * aliased into generated CLI executables exactly like the mcp-entry
 * lifecycle so emitted bins stay self-contained.
 */
export const cliEntryRuntimePath = (): string => runtimeModulePath('cli-entry');

export const webHostRuntimeSpecifier = 'agent-bundle/web-host';

export const webHostRuntimePath = (): string => runtimeModulePath('web-host');

export const installEntryRuntimeSpecifier = 'agent-bundle/install-entry';

export const installEntryRuntimePath = (): string => runtimeModulePath('install-entry');

export const generatedInstallBinEntrySource = (options: {
  readonly artifactRelativeUrl: string;
  readonly hosts: readonly ('claude' | 'codex' | 'cursor')[];
  readonly name: string;
}): string => [
  `import { runGeneratedInstallProcess } from ${JSON.stringify(installEntryRuntimeSpecifier)};`,
  '',
  'process.exitCode = await runGeneratedInstallProcess(process.argv.slice(2), Object.freeze({',
  `  artifactRoot: new URL(${JSON.stringify(options.artifactRelativeUrl)}, import.meta.url),`,
  `  hosts: Object.freeze(${stableJson(options.hosts)}),`,
  `  name: ${JSON.stringify(options.name)},`,
  '}));',
  '',
].join('\n');

/**
 * The code root a generated module falls back to when the host supplies no
 * `AGENT_BUNDLE_PLUGIN_ROOT`, and with it where its state root derives absent
 * `AGENT_BUNDLE_STATE_ROOT`: `cwd` (the caller's `.agent-bundle`, the npm
 * package bin's contract; state stays under `<root>/state`) or `artifact`
 * (the parent of the executable's own directory — the target root — shared by
 * the artifact-hosted CLI, its render worker, the MCP entry and the Flight
 * worker; state goes to the user state directory keyed by that root, never
 * into the installed, possibly read-only artifact).
 */
export type GeneratedStateFallback = 'artifact' | 'cwd';

export interface GeneratedCliBinEntryOptions {
  readonly commands: readonly CompiledCliCommand[];
  readonly plugin: { readonly description?: string; readonly name: string; readonly version: string };
  /** Absolute projection-module sources keyed by their backing tool route id. */
  readonly projectionSources?: Readonly<Record<string, string>>;
  /** Conventional request context providers, mounted for plain commands in this process (#313). */
  readonly providers?: readonly CompiledProvider[];
  readonly routes: readonly CompiledAgentRoute[];
  /** The project's resolved `notices.retention`; the runtime defaults apply when absent. */
  readonly noticeRetention?: NormalizedNoticeRetentionPolicy;
  readonly state?: NormalizedStateDefinition;
  /** Code-root fallback; defaults to `cwd` (the npm package bin). */
  readonly stateFallback?: GeneratedStateFallback;
  readonly web?: {
    readonly manifestRelativeUrl: string;
    readonly pluginRootRelativeUrl: string;
  };
  /** The sibling react-server worker bundle; required when any command is rendered. */
  readonly workerFile?: string;
}

/**
 * The Node imports the plugin-root fallback expression needs: the artifact
 * root is the parent of the module's own directory (`mcp/`, `bin/`, `hooks/`),
 * the npm bin anchors on the caller's `.agent-bundle`. Emitted once per
 * generated module, ahead of every other `node:path` / `node:url` import.
 */
const pluginRootImports = (
  fallback: GeneratedStateFallback,
  relativeUrl?: string,
): readonly string[] =>
  fallback === 'artifact' || relativeUrl !== undefined
    ? ["import { fileURLToPath } from 'node:url';"]
    : ["import { join } from 'node:path';"];

const pluginRootFallbackExpression = (
  fallback: GeneratedStateFallback,
  relativeUrl?: string,
): string =>
  relativeUrl !== undefined
    ? `fileURLToPath(new URL(${JSON.stringify(relativeUrl)}, import.meta.url))`
    : fallback === 'artifact'
      ? "fileURLToPath(new URL('..', import.meta.url))"
      : "join(process.cwd(), '.agent-bundle')";

/**
 * The one plugin-root resolution of a generated module (#468, #637): the code
 * root (`AGENT_BUNDLE_PLUGIN_ROOT`, else the fallback) and the state root
 * (`AGENT_BUNDLE_STATE_ROOT`, else derived from the code root). The SQLite
 * kernel, the notice ledger, the lineage journal, and every request scope the
 * module opens read `pluginRoot`, so `(await agent()).plugin.stateRoot` is the
 * directory they mount by construction. An artifact-anchored module derives
 * its state root in the user state directory keyed by the code root; the npm
 * bin keeps `<root>/state`.
 */
const pluginRootDeclaration = (
  fallback: GeneratedStateFallback,
  relativeUrl?: string,
): string =>
  `const pluginRoot = resolvePluginRoot({ fallback: ${pluginRootFallbackExpression(fallback, relativeUrl)}${
    fallback === 'artifact' ? ", stateAnchor: 'user-data'" : ''
  } });`;

const generatedStateImports = (
  state: NormalizedStateDefinition | undefined,
): readonly string[] => {
  if (state === undefined) return [];
  return [
    ...(state.lifetime === 'workspace-durable'
      ? ["import { createSqliteStateDriver } from '@agent-bundle/runtime/state/sqlite';"]
      : ["import { createMemoryStateDriver } from '@agent-bundle/runtime/state';"]),
    "import { createGeneratedRuntimeState } from '@agent-bundle/runtime/mount';",
    `import stateDefinition from ${JSON.stringify(state.source)};`,
  ];
};

/**
 * Notice ledger policy the generated runtime mounts (#99 acceptance item 7):
 * the host's delivery advertisement, whose per-route sensitivity ceilings the
 * ledger honours, and the project's resolved retention policy. Emitted as
 * literals so the artifact carries the exact policy it was built with.
 */
export interface GeneratedNoticePolicy {
  readonly noticeDelivery?: NoticeDeliveryAdvertisement;
  readonly noticeRetention?: NormalizedNoticeRetentionPolicy;
}

/** The policy literals, declared once per generated module and referenced by name. */
const noticePolicyDeclarations = (policy: GeneratedNoticePolicy): readonly string[] => [
  ...(policy.noticeDelivery === undefined
    ? []
    : [`const noticeDeliveryAdvertisement = Object.freeze(${stableJson(policy.noticeDelivery)});`]),
  ...(policy.noticeRetention === undefined
    ? []
    : [`const noticeRetentionPolicy = Object.freeze(${stableJson(policy.noticeRetention)});`]),
];

const noticePolicyFields = (policy: GeneratedNoticePolicy): string => [
  ...(policy.noticeDelivery === undefined ? [] : [', noticeDelivery: noticeDeliveryAdvertisement']),
  ...(policy.noticeRetention === undefined ? [] : [', noticeRetention: noticeRetentionPolicy']),
].join('');

/** The state owner, mounted on the module's `pluginRoot` (declared by {@link pluginRootDeclaration}). */
const generatedStateOwner = (
  state: NormalizedStateDefinition | undefined,
  policy: GeneratedNoticePolicy,
): readonly string[] => {
  if (state === undefined) return [];
  if (state.lifetime !== 'workspace-durable') {
    return [
      ...noticePolicyDeclarations(policy),
      `const runtimeState = createGeneratedRuntimeState({ definition: stateDefinition, driver: createMemoryStateDriver({ lifetime: ${JSON.stringify(state.lifetime)} })${noticePolicyFields(policy)} });`,
      '',
    ];
  }
  return [
    ...noticePolicyDeclarations(policy),
    `const runtimeState = createGeneratedRuntimeState({ definition: stateDefinition, driver: createSqliteStateDriver({ root: pluginRoot.stateRoot })${noticePolicyFields(policy)} });`,
    '',
  ];
};

/**
 * The worker-backed render-session factory shared by generated CLI
 * executables and rendered scripts: one worker per rendered invocation, raw
 * Flight bytes streamed chunk by chunk into the runtime dispatcher's public
 * `stream()`, progress messages forwarded to the dispatcher's reporter, and
 * worker stdout guarded onto stderr (machine output owns stdout).
 */
const renderedSessionSource = (workerFile: string): readonly string[] => [
  // `limits` is the route's compiled render budget (#454), absent for the
  // runtime default; it rides the dispatch so one dispatcher serves every budget.
  'const openRenderedSession = ({ invocation, limits, props, request, routeId, signal, terminal, validate }) => {',
  `  const worker = new Worker(new URL(${JSON.stringify(`./${workerFile}`)}, import.meta.url), { stderr: true, stdout: true });`,
  "  worker.stdout?.on('data', (chunk) => process.stderr.write(chunk));",
  "  worker.stderr?.on('data', (chunk) => process.stderr.write(chunk));",
  '  const pending = new Map();',
  '  let sequence = 0;',
  '  const failPending = (error) => { for (const entry of [...pending.values()]) entry.fail(error); pending.clear(); };',
  "  worker.on('error', failPending);",
  "  worker.on('exit', (code) => { if (pending.size > 0) failPending(new Error(`Generated render worker exited with code ${String(code)}.`)); });",
  "  worker.on('message', (message) => {",
  '    const entry = pending.get(message.id);',
  '    if (entry === undefined) return;',
  "    if (message.type === 'progress') { Promise.resolve().then(() => entry.progress?.report(message.update)).catch(entry.fail); return; }",
  "    if (message.type === 'chunk') { entry.enqueue(message.bytes); return; }",
  '    pending.delete(message.id);',
  "    entry.signal.removeEventListener('abort', entry.abort);",
  "    if (message.type === 'error') { entry.fail(new Error(message.message)); return; }",
  "    if (message.type === 'end') entry.close();",
  '  });',
  '  const host = Object.freeze({',
  '    execute: async (dispatch) => {',
  '      const id = ++sequence;',
  '      let streamController;',
  '      const stream = new ReadableStream({ start(controller) { streamController = controller; } });',
  '      const entry = {',
  "        abort: () => { worker.postMessage({ id, type: 'cancel' }); pending.delete(id); try { streamController.error(new DOMException('Agent render was aborted', 'AbortError')); } catch {} },",
  '        close: () => { try { streamController.close(); } catch {} },',
  '        enqueue: (bytes) => { try { streamController.enqueue(bytes); } catch {} },',
  "        fail: (error) => { pending.delete(id); dispatch.signal.removeEventListener('abort', entry.abort); try { streamController.error(error); } catch {} },",
  '        progress: dispatch.progress,',
  '        signal: dispatch.signal,',
  '      };',
  '      pending.set(id, entry);',
  "      dispatch.signal.addEventListener('abort', entry.abort, { once: true });",
  '      if (dispatch.signal.aborted) { entry.abort(); return stream; }',
  // The invocation rides to the worker so conventional providers observe the
  // real surface (`cli`, `script`, `tool`) instead of an undefined invocation;
  // the terminal capability rides with it because a worker thread's own
  // streams are pipes to this process, never the terminal (#511).
  "      worker.postMessage({ id, invocation, props, request, routeId, terminal, type: 'render' });",
  '      return stream;',
  '    },',
  '  });',
  '  const dispatcher = createAgentRenderDispatcher(host);',
  '  return Object.freeze({',
  '    close: async () => { await worker.terminate(); },',
  '    events: () => dispatcher.stream({ invocation, ...(limits === undefined ? {} : { limits }), signal }),',
  '    validate,',
  '  });',
  '};',
];

/**
 * The generated routed-CLI executable (#102 stages 2-3): the compiled
 * command graph rides the bundle as data, the cli-entry shell owns argv
 * parsing, help, output modes, exit codes, and signals, plain commands
 * execute inside the typed Agent request context, and rendered commands
 * render through the runtime dispatcher against a sibling react-server
 * worker. Input validation failures are usage failures (`CliInputError`,
 * exit 2); the route module's zod schemas stay the runtime validation
 * boundary.
 */
export const generatedCliBinEntrySource = (input: GeneratedCliBinEntryOptions): string => {
  const commandRoutes = input.routes.filter((route) =>
    input.commands.some((command) => command.routeId === route.id));
  // A bin that compiles no command opens no request scope (a `web`-only
  // plugin, #564): it mounts neither the project's state nor its providers
  // and never imports the optional `@agent-bundle/runtime` they need, so a
  // state or provider module's evaluation cannot keep `<plugin> web` from
  // starting.
  const runtimeBacked = commandRoutes.length > 0;
  const options: GeneratedCliBinEntryOptions = runtimeBacked ? input : { ...input, providers: [], state: undefined };
  const projectedCommands = options.commands.flatMap((command) =>
    command.projection === undefined ? [] : [{ command, projection: command.projection }]);
  const projectionSources = projectedCommands.map(({ command, projection }) => {
    const source = options.projectionSources?.[command.routeId];
    if (source === undefined) {
      throw new Error(`Generated CLI projection ${JSON.stringify(projection.module)} for ${command.routeId} requires an absolute source path.`);
    }
    return source;
  });
  const projectionIndexByRoute = new Map(projectedCommands.map(({ command }, index) => [command.routeId, index]));
  const rendered = options.commands.some((command) => command.rendered);
  if (rendered && options.workerFile === undefined) {
    throw new Error('A generated CLI with rendered commands requires a worker file.');
  }
  const providers = orderedProviders(options.providers ?? []);
  const plainIndent = options.state === undefined ? '  ' : '    ';
  const stateFallback = options.stateFallback ?? 'cwd';
  return [
    // The artifact-hosted executable is part of an installed pack, so it
    // applies the pack's operator `.env` layer (#469) — first, before the
    // route, provider, and state modules it imports evaluate, so a
    // module-level `process.env` read sees the composed environment. The
    // npm package bin runs from the operator's own shell and reads none.
    ...(stateFallback === 'artifact' ? [operatorEnvLayerImport] : []),
    `import { mapGeneratedCliInput, parseGeneratedCliArgv, runGeneratedCliProcess } from ${JSON.stringify(cliEntryRuntimeSpecifier)};`,
    ...(options.web === undefined
      ? []
      : [
        `import { runWebCommand } from ${JSON.stringify(webHostRuntimeSpecifier)};`,
        "import webHostPage from 'agent-bundle/web-host-page';",
      ]),
    ...(runtimeBacked
      ? [rendered
        ? "import { available, createAgentRenderDispatcher, resolvePluginRoot, runAgentRequest, unavailable } from '@agent-bundle/runtime';"
        : "import { available, resolvePluginRoot, runAgentRequest, unavailable } from '@agent-bundle/runtime';"]
      : []),
    ...pluginRootImports(stateFallback, options.web?.pluginRootRelativeUrl),
    ...(rendered ? ["import { Worker } from 'node:worker_threads';"] : []),
    ...generatedStateImports(options.state),
    ...routeImports(commandRoutes),
    ...projectionSources.map((source, index) =>
      `import * as projection${String(index)} from ${JSON.stringify(source)};`),
    ...providerImports(providers),
    '',
    ...(runtimeBacked ? [pluginRootDeclaration(stateFallback, options.web?.pluginRootRelativeUrl)] : []),
    // Launch from the artifact carrying the manifest, not an environment override.
    ...(options.web === undefined
      ? []
      : [`const artifactRoot = ${pluginRootFallbackExpression(stateFallback, options.web.pluginRootRelativeUrl)};`]),
    ...generatedStateOwner(options.state, options),
    'const processLifetime = { hits: 0, instanceId: crypto.randomUUID(), pid: process.pid };',
    ...providerRegistrySource(providers),
    'const routes = Object.freeze({',
    ...commandRoutes.map((route, index) => {
      const projectionIndex = projectionIndexByRoute.get(route.id);
      return `  ${JSON.stringify(route.id)}: Object.freeze({ module: route${String(index)}${projectionIndex === undefined ? '' : `, projection: projection${String(projectionIndex)}`} }),`;
    }),
    '});',
    '',
    `const commands = Object.freeze(${stableJson(options.commands)});`,
    '',
    'const parseInput = (command, route, input) => mapGeneratedCliInput(command, route.module.inputSchema, route.projection, input);',
    'export const prepareRouteInvocation = (routeId, argv) => {',
    '  const command = commands.find((candidate) => candidate.routeId === routeId);',
    "  if (command === undefined) throw new TypeError(`Generated CLI route ${JSON.stringify(routeId)} is not available.`);",
    '  const route = routes[routeId];',
    "  if (route === undefined) throw new TypeError(`Generated CLI route ${JSON.stringify(routeId)} has no compiled module.`);",
    '  return parseInput(command, route, parseGeneratedCliArgv(command, argv).input);',
    '};',
    '',
    // Plain commands mount the same conventional providers as every other
    // generated request scope (#313, #459): once per request, in deterministic
    // key order, fail-closed, as the typed Agent request's own resolver.
    ...(runtimeBacked ? [] : [
      "const execute = async (command) => { throw new TypeError(`This plugin compiles no CLI command (${command.path.join(' ')}).`); };",
    ]),
    ...(runtimeBacked ? [
    'const execute = async (command, input, context) => {',
    '  const route = routes[command.routeId];',
    "  if (route === undefined || typeof route.module.default !== 'function') throw new TypeError('Generated CLI route must default-export an async function.');",
    '  const parsed = parseInput(command, route, input);',
    '  const cwd = process.cwd();',
    ...processHitSource('  '),
    ...(options.state === undefined
      ? []
      : ['  const bindings = await runtimeState.requestBindings({ signal: context.signal });', '  try {']),
    `${plainIndent}const result = await runAgentRequest({`,
    '    capabilities: {',
    '      command: unavailable(),',
    '      filesystem: unavailable(),',
    '      network: unavailable(),',
    "      projectRoot: available({ root: cwd }, 'derived'),",
    '    },',
    "    host: unavailable('unsupported-surface'),",
    "    invocation: { kind: 'cli', operationId: command.routeId, surface: command.path.join(' ') },",
    "    lineage: unavailable('unsupported-surface'),",
    ...(options.state === undefined ? [] : ['      noticeLedger: bindings.noticeLedger,']),
    '    plugin: pluginRoot.identity,',
    ...providersFieldSource(providers, {
      indent: '    ',
      invocation: "{ kind: 'cli', props: { args: context.args, command: command.path.join(' ') } }",
    }),
    '    signal: context.signal,',
    ...(options.state === undefined ? [] : ['      state: bindings.state,']),
    "    terminal: available(context.terminal, 'native'),",
    "    workspace: available({ root: cwd }, 'derived'),",
    `  }, async () => route.module.default({ input: parsed, signal: context.signal }));`,
    `${options.state === undefined ? '  ' : '    '}return route.module.resultSchema.parse(result);`,
    ...(options.state === undefined
      ? []
      : ['  } finally {', '    await bindings.close();', '  }']),
    '};',
    ] : []),
    '',
    ...(rendered
      ? [
        ...renderedSessionSource(options.workerFile!),
        '',
        'const render = (command, input, context) => {',
        '  const route = routes[command.routeId];',
        '  const parsed = parseInput(command, route, input);',
        '  return openRenderedSession({',
        "    invocation: { kind: 'cli', props: { args: context.args, command: command.path.join(' ') } },",
        '    limits: command.render,',
        '    props: { input: parsed },',
        "    request: { kind: 'cli', operationId: command.routeId, surface: command.path.join(' ') },",
        '    routeId: command.routeId,',
        '    signal: context.signal,',
        '    terminal: context.terminal,',
        '    validate: (value) => route.module.resultSchema.parse(value),',
        '  });',
        '};',
        '',
      ]
      : []),
    'if (import.meta.main) {',
    ...(options.state === undefined ? [] : ['try {']),
    `${options.state === undefined ? '' : '  '}await runGeneratedCliProcess({`,
    '  commands,',
    ...(options.plugin.description === undefined ? [] : [`  description: ${JSON.stringify(options.plugin.description)},`]),
    '  execute,',
    `  name: ${JSON.stringify(options.plugin.name)},`,
    ...(rendered ? ['  render,'] : []),
    `  version: ${JSON.stringify(options.plugin.version)},`,
    ...(options.web === undefined
      ? []
      : [
        '  web: Object.freeze({',
        '    run: (argv, context) => runWebCommand({',
        '      argv,',
        `      manifestPath: fileURLToPath(new URL(${JSON.stringify(options.web.manifestRelativeUrl)}, import.meta.url)),`,
        '      pageScript: webHostPage,',
        '      pluginRoot: artifactRoot,',
        '      ...context,',
        '    }),',
        '  }),',
      ]),
    '});',
    ...(options.state === undefined
      ? []
      : ['} finally {', '  await runtimeState.close();', '}']),
    '}',
    '',
  ].join('\n');
};

export interface GeneratedRenderedRouteWorkerOptions {
  readonly layouts?: readonly CompiledLayout[];
  readonly providers?: readonly CompiledProvider[];
  readonly routes: readonly CompiledAgentRoute[];
  /** The project's resolved `notices.retention`; the runtime defaults apply when absent. */
  readonly noticeRetention?: NormalizedNoticeRetentionPolicy;
  readonly state?: NormalizedStateDefinition;
  /** Code-root fallback; defaults to `cwd` and must match the owning executable. */
  readonly stateFallback?: GeneratedStateFallback;
}

/**
 * The layouts one worker imports: only those some route of this worker
 * composes through, ordered by id. A server layout for a server this worker
 * never renders is left out entirely, so its module-level initialization
 * cannot run in — or break — an unrelated CLI, script, or server process.
 */
const workerLayouts = (
  layouts: readonly CompiledLayout[],
  routes: readonly Pick<CompiledAgentRoute, 'kind' | 'serverId'>[],
): readonly CompiledLayout[] => {
  const applicable = new Set(routes.flatMap((route) => layoutChainFor(route, layouts)));
  return layouts.filter((layout) => applicable.has(layout)).sort((left, right) => left.id.localeCompare(right.id));
};

const layoutImports = (layouts: readonly CompiledLayout[]): readonly string[] =>
  layouts.map((layout, index) => `import * as layout${String(index)} from ${JSON.stringify(layout.source)};`);

const layoutRecords = (layouts: readonly CompiledLayout[]): readonly string[] =>
  layouts.map((layout, index) =>
    `  Object.freeze({ id: ${JSON.stringify(layout.id)}, module: layout${String(index)}, source: ${JSON.stringify(layout.provenance.relativePath)} }),`);

/** The generated `layouts: [...]` record field: indices into the worker's layout table, outermost first. */
const layoutChainField = (route: CompiledAgentRoute, layouts: readonly CompiledLayout[]): string => {
  const chain = layoutChainFor(route, layouts).map((layout) => layouts.indexOf(layout));
  return chain.length === 0 ? '' : `, layouts: Object.freeze(${JSON.stringify(chain)})`;
};

const layoutRouteFields = (route: CompiledAgentRoute): string => [
  `id: ${JSON.stringify(route.id)}`,
  `kind: ${JSON.stringify(route.kind)}`,
  `name: ${JSON.stringify(layoutRouteName(route))}`,
  ...(route.serverId === undefined ? [] : [`serverId: ${JSON.stringify(route.serverId)}`]),
].join(', ');

/**
 * The generated layout composition. Without layouts the route component is
 * the Flight root, so a layout-free project renders exactly the element it
 * rendered before this convention existed (the emitted worker source itself
 * changes with every release and is not a compatibility surface). With
 * layouts, one root component awaits the route's element first and then
 * wraps it in the chain from the
 * innermost (server) layout outward — so a throwing route still rejects the
 * root and fails the render exactly as it does without a layout, instead of
 * degrading into a represented boundary error below the layout's shell. Every
 * layout receives the route's stable identity and the request signal; a
 * layout module without a function default export fails the request closed.
 */
const composeLayoutsSource = (layouts: readonly CompiledLayout[]): readonly string[] => layouts.length === 0
  ? ['const composeLayouts = (route, props) => createElement(route.module.default, props);']
  : [
    'const layouts = Object.freeze([',
    ...layoutRecords(layouts),
    ']);',
    'const composeLayouts = (route, props, signal) => {',
    '  const chain = route.layouts ?? [];',
    '  if (chain.length === 0) return createElement(route.module.default, props);',
    '  return createElement(async () => {',
    '    let composed = await route.module.default(props);',
    '    for (const index of [...chain].reverse()) {',
    '      const layout = layouts[index];',
    "      if (typeof layout.module.default !== 'function') {",
    '        throw new TypeError(`Layout "${layout.id}" (${layout.source}) must default-export a function component.`);',
    '      }',
    "      composed = createElement(layout.module.default, { children: composed, route: { id: route.id, kind: route.kind, name: route.name, ...(route.serverId === undefined ? {} : { serverId: route.serverId }) }, signal });",
    '    }',
    '    return composed;',
    '  });',
    '};',
  ];

/**
 * The react-server worker behind generated CLI executables and rendered
 * scripts: renders one route's async default component through Flight,
 * streaming raw bytes back chunk by chunk, with progress reports and the
 * typed Agent request context installed around every render.
 */
export const generatedRenderedRouteWorkerSource = (
  options: GeneratedRenderedRouteWorkerOptions,
): string => {
  const providers = orderedProviders(options.providers ?? []);
  const stateFallback = options.stateFallback ?? 'cwd';
  const layouts = workerLayouts(options.layouts ?? [], options.routes);
  return [
    "import { parentPort } from 'node:worker_threads';",
    "import { createElement } from 'react';",
    "import { renderAgentFlight } from '@agent-bundle/runtime/flight/server';",
    "import { available, resolvePluginRoot, runAgentRequest, unavailable } from '@agent-bundle/runtime';",
    ...pluginRootImports(stateFallback),
    ...generatedStateImports(options.state),
    ...routeImports(options.routes),
    ...providerImports(providers),
    ...layoutImports(layouts),
    '',
    pluginRootDeclaration(stateFallback),
    ...generatedStateOwner(options.state, options),
    '// Generated routes contain only intrinsic Agent protocol elements, so no client references exist.',
    'globalThis.__rspack_rsc_manifest__ ??= Object.freeze({ clientManifest: Object.freeze({}) });',
    "if (parentPort === null) throw new Error('Generated render worker requires a parent port.');",
    '// Machine output owns the parent stdout; anything a route logs goes to stderr.',
    'process.stdout.write = process.stderr.write.bind(process.stderr);',
    'const processLifetime = { hits: 0, instanceId: crypto.randomUUID(), pid: process.pid };',
    ...providerRegistrySource(providers),
    ...composeLayoutsSource(layouts),
    'const routes = Object.freeze({',
    ...options.routes.map((route, index) =>
      `  ${JSON.stringify(route.id)}: Object.freeze({ ${layoutRouteFields(route)}, module: route${String(index)}${layoutChainField(route, layouts)} }),`),
    '});',
    'const requests = new Map();',
    '',
    'const render = async (message) => {',
    '  const route = routes[message.routeId];',
    "  if (route === undefined || typeof route.module.default !== 'function') throw new TypeError('Generated rendered route must default-export an async function component.');",
    '  const observedRoute = message.observe !== true ? route : { ...route, module: { ...route.module, default: async (props) => {',
    '    const handlerStartedAt = performance.now();',
    "    try { return await route.module.default(props); } finally { parentPort.postMessage({ durationMs: performance.now() - handlerStartedAt, id: message.id, type: 'observed-handler' }); }",
    '  } } };',
    '  const controller = new AbortController();',
    '  requests.set(message.id, controller);',
    ...processHitSource('  '),
    '  try {',
    '    const cwd = process.cwd();',
    ...(options.state === undefined
      ? []
      : ['    const bindings = await runtimeState.requestBindings({ signal: controller.signal });']),
    ...(options.state === undefined ? [] : ['    try {']),
    '    await runAgentRequest({',
    '      capabilities: {',
    '        command: unavailable(),',
    '        filesystem: unavailable(),',
    '        network: unavailable(),',
    "        projectRoot: available({ root: cwd }, 'derived'),",
    '      },',
    "      host: unavailable('unsupported-surface'),",
    '      invocation: message.request,',
    "      lineage: unavailable('unsupported-surface'),",
    ...(options.state === undefined ? [] : ['      noticeLedger: bindings.noticeLedger,']),
    '      plugin: pluginRoot.identity,',
    "      progress: { report: async (update) => { parentPort.postMessage({ id: message.id, type: 'progress', update }); } },",
    ...providersFieldSource(providers, { indent: '      ', invocation: 'message.invocation', observe: 'message.observe === true' }),
    '      signal: controller.signal,',
    ...(options.state === undefined ? [] : ['      state: bindings.state,']),
    // The executable probed its terminal once and forwards the value; a worker
    // thread cannot probe it (its streams are pipes to the parent).
    "      terminal: message.terminal === undefined ? unavailable('not-provided') : available(message.terminal, 'native'),",
    "      workspace: available({ root: cwd }, 'derived'),",
    '    }, async () => {',
    "      if (message.observe === true) parentPort.postMessage({ id: message.id, type: 'observed-render-start' });",
    '      const renderStartedAt = performance.now();',
    '      const flight = renderAgentFlight(composeLayouts(observedRoute, { ...message.props, signal: controller.signal }, controller.signal), { signal: controller.signal });',
    '      const reader = flight.getReader();',
    '      while (true) {',
    '        const next = await reader.read();',
    '        if (next.done) break;',
    '        const bytes = next.value;',
    "        parentPort.postMessage({ bytes, id: message.id, type: 'chunk' }, [bytes.buffer]);",
    '      }',
    "      if (message.observe === true) parentPort.postMessage({ durationMs: performance.now() - renderStartedAt, id: message.id, type: 'observed-render-finish' });",
    '    });',
    ...(options.state === undefined
      ? []
      : ['    } finally {', '      await bindings.close();', '    }']),
    "    parentPort.postMessage({ id: message.id, type: 'end' });",
    '  } catch (error) {',
    "    parentPort.postMessage({ id: message.id, message: error instanceof Error ? error.message : String(error), type: 'error' });",
    '  } finally {',
    '    requests.delete(message.id);',
    '  }',
    '};',
    '',
    "parentPort.on('message', (message) => {",
    "  if (message.type === 'cancel') { requests.get(message.id)?.abort(); return; }",
    "  if (message.type === 'render') void render(message);",
    '});',
    '',
  ].join('\n');
};

export interface GeneratedRenderedScriptEntryOptions {
  readonly name: string;
  readonly routeId: string;
  /** The project's resolved `notices.retention`; the runtime defaults apply when absent. */
  readonly noticeRetention?: NormalizedNoticeRetentionPolicy;
  readonly state?: NormalizedStateDefinition;
  readonly workerFile: string;
}

/**
 * The generated rendered-script executable (`src/scripts/<name>.tsx`,
 * #102 stage 3): the script's async default component renders through the
 * runtime dispatcher with the full CLI output contract (`--json`,
 * `--ndjson`, interactive TTY progress, piped Markdown); every other
 * argument passes through as the component's `argv` prop.
 */
export const generatedRenderedScriptEntrySource = (
  options: GeneratedRenderedScriptEntryOptions,
): string => [
  `import { runGeneratedRenderedScriptProcess } from ${JSON.stringify(cliEntryRuntimeSpecifier)};`,
  "import { createAgentRenderDispatcher } from '@agent-bundle/runtime';",
  "import { Worker } from 'node:worker_threads';",
  '',
  ...renderedSessionSource(options.workerFile),
  '',
  'await runGeneratedRenderedScriptProcess({',
  '  createSession: (argv, context) => openRenderedSession({',
  `    invocation: { kind: 'script', props: { input: argv, name: ${JSON.stringify(options.name)} } },`,
  '    props: { argv },',
  `    request: { kind: 'script', operationId: ${JSON.stringify(options.routeId)}, surface: ${JSON.stringify(options.name)} },`,
  `    routeId: ${JSON.stringify(options.routeId)},`,
  '    signal: context.signal,',
  '    terminal: context.terminal,',
  '    validate: (value) => value,',
  '  }),',
  `  name: ${JSON.stringify(options.name)},`,
  '});',
  '',
].join('\n');

export interface GeneratedRouteMcpEntryOptions {
  readonly artifactEpoch?: string;
  readonly eventRoutes?: readonly NormalizedHook[];
  /**
   * The target host's notice delivery advertisement (`TargetAdapter.noticeDelivery`).
   * Cross-request routes are wired only where the host advertises them; an
   * absent advertisement wires none, so a target the registry knows nothing
   * about never receives a fabricated channel.
   */
  readonly noticeDelivery?: NoticeDeliveryAdvertisement;
  readonly plugin: { readonly name: string; readonly version: string };
  readonly routes: readonly CompiledAgentRoute[];
  readonly serverName: string;
  /** The project's resolved `notices.retention`; the runtime defaults apply when absent. */
  readonly noticeRetention?: NormalizedNoticeRetentionPolicy;
  readonly state?: NormalizedStateDefinition;
  /**
   * The hosts whose hook wrappers may deliver events to this entry: the
   * selected hosts of the composite root that the server targets (#555).
   * The entry's event endpoint is identified by the artifact alone — epoch
   * and root directory — and the invoking host arrives with each request and
   * is checked against this set; `targets` select projections, they are not
   * runtime identity (#592). Absent means no host may deliver events.
   */
  readonly allowedTargets?: readonly string[];
  /**
   * The selected hosts whose MCP documents list this server — the hosts that
   * can launch it. When exactly one can, the runtime assumes that host for
   * tool-call lineage when the MCP client does not name itself; otherwise the
   * client's own name alone decides (#592). Absent means none.
   */
  readonly hosts?: readonly string[];
  readonly workerFile: string;
}

export interface GeneratedRouteFlightWorkerOptions {
  readonly artifactEpoch: string;
  readonly eventRoutes?: readonly NormalizedHook[];
  readonly layouts?: readonly CompiledLayout[];
  /** The target host's advertisement; the worker mounts the inbox route only where it is advertised. */
  readonly noticeDelivery?: NoticeDeliveryAdvertisement;
  readonly providers?: readonly CompiledProvider[];
  readonly routes: readonly CompiledAgentRoute[];
  readonly serverName: string;
  /** The project's resolved `notices.retention`; the runtime defaults apply when absent. */
  readonly noticeRetention?: NormalizedNoticeRetentionPolicy;
  readonly state?: NormalizedStateDefinition;
}

export const generatedRouteArtifactEpoch = (plugin: {
  readonly name: string;
  readonly version: string;
}): string => `${plugin.name}@${plugin.version}`;

const executableMcpRoutes = (routes: readonly CompiledAgentRoute[]): readonly CompiledAgentRoute[] =>
  routes.filter((route) => route.kind !== 'app');

const routeImports = (routes: readonly CompiledAgentRoute[]): readonly string[] =>
  routes.map((route, index) => `import * as route${String(index)} from ${JSON.stringify(route.source)};`);

/**
 * The compiled route table. The entry-side table registers routes; the
 * worker-side table (`worker` set) additionally carries each route's layout
 * chain and owning server so layouts receive stable route identity.
 */
const routeRecords = (
  routes: readonly CompiledAgentRoute[],
  worker?: { readonly layouts: readonly CompiledLayout[] },
): readonly string[] =>
  routes.map((route, index) => {
    const layoutFields = worker === undefined ? '' : layoutChainField(route, worker.layouts);
    const serverField = worker === undefined || route.serverId === undefined ? '' : `, serverId: ${JSON.stringify(route.serverId)}`;
    return `  ${JSON.stringify(route.id)}: Object.freeze({ config: ${stableJson(route.config)}, id: ${JSON.stringify(route.id)}, kind: ${JSON.stringify(route.kind)}${layoutFields}, module: route${String(index)}, name: ${JSON.stringify(mcpRouteProtocolName(route.id))}${serverField} }),`;
  });

const noticeInboxImport = (wired: boolean): readonly string[] =>
  wired
    ? [`import * as noticeInboxRoute from ${JSON.stringify(noticeInboxRuntimeSpecifier)};`]
    : [];

const noticeInboxRecord = (wired: boolean): readonly string[] =>
  wired
    ? ['  [noticeInboxRoute.AGENT_NOTICE_INBOX_ROUTE_ID]: noticeInboxRoute.noticeInboxRouteRecord(noticeInboxRoute),']
    : [];

interface NoticeRouteSelection {
  readonly noticeDelivery?: NoticeDeliveryAdvertisement;
  /** The project's resolved `notices.retention`; the runtime defaults apply when absent. */
  readonly noticeRetention?: NormalizedNoticeRetentionPolicy;
  readonly state?: NormalizedStateDefinition;
}

/**
 * Whether the generated artifact exposes the `mcp-inbox` route (#99 stage 3):
 * the cross-request inbox resource needs a mounted notice ledger, so the
 * project must declare state, and the target host must advertise the route
 * in its pinned capability table. Each route is selected from its own
 * advertised state; a host whose table marks it unavailable, or a target with
 * no advertisement at all, exposes nothing it cannot honestly carry.
 */
const wiresInboxRoute = (options: NoticeRouteSelection): boolean =>
  options.state !== undefined && options.noticeDelivery?.['mcp-inbox'].state === 'supported';

/**
 * Whether the generated entry wires the `mcp-resource-updated` delivery route
 * (#99 stage 4). It signals about the inbox resource, so the inbox must be
 * exposed; the host must advertise the route itself; and the project's state
 * must be workspace-durable. SQLite is the one lifetime two threads can
 * share, so only durable artifacts can give the server process its own handle
 * on the notice store its Flight worker mounts; volatile lifetimes live in
 * the worker's heap and honestly advertise no subscription capability.
 */
const wiresResourceUpdatedRoute = (options: NoticeRouteSelection): boolean =>
  wiresInboxRoute(options) &&
  options.state?.lifetime === 'workspace-durable' &&
  options.noticeDelivery?.['mcp-resource-updated'].state === 'supported';

/**
 * The server process's own handle on the durable notice store. Both roots
 * resolve as in the worker, so both open the same files.
 */
const noticeDeliveryImports = (wired: boolean): readonly string[] =>
  wired
    ? [
      "import { createGeneratedNoticeRuntime } from '@agent-bundle/runtime/mount';",
      "import { createNoticeInboxSignaller } from '@agent-bundle/runtime/notices';",
    ]
    : [];

/** The server process's notice store, opened on the module's `pluginRoot` (#468). */
const noticeDeliveryOwner = (wired: boolean, policy: GeneratedNoticePolicy): readonly string[] =>
  wired
    ? [
      ...noticePolicyDeclarations(policy),
      `const noticeDelivery = createNoticeInboxSignaller({ ${
        policy.noticeDelivery === undefined ? '' : 'delivery: noticeDeliveryAdvertisement, '
      }store: createGeneratedNoticeRuntime({ driver: createSqliteStateDriver({ root: pluginRoot.stateRoot }), lifetime: 'workspace-durable'${noticePolicyFields(policy)} }) });`,
      '',
    ]
    : [];

const eventRouteImports = (
  routes: readonly NormalizedHook[],
  offset: number,
): readonly string[] => routes.map((route, index) =>
  `import * as route${String(offset + index)} from ${JSON.stringify(route.source)};`);

/**
 * Event route records stay keyed by the hook identity the worker resolves
 * from the canonical event (`hook:event-route:tool-after`), but the record's
 * `id` is the compiled route id (`event:tool/after`): that is the
 * `operationId` the hook shell opens the request scope with, the lifecycle
 * replay mounts, the test manifest addresses, and the harness renders, so a
 * route reading `invocation.operationId` sees one value everywhere.
 */
const eventRouteRecords = (
  routes: readonly NormalizedHook[],
  offset: number,
  providers: readonly CompiledProvider[],
  selections: ReadonlyMap<string, readonly CompiledProvider[]>,
): readonly string[] => routes.map((route, index) =>
  `  ${JSON.stringify(route.id)}: Object.freeze({ event: ${JSON.stringify(route.eventRoute!.event)}, id: ${JSON.stringify(`event:${route.eventRoute!.event}`)}, kind: 'event-route', module: route${String(offset + index)}, name: ${JSON.stringify(route.eventRoute!.event)}${
    route.eventRoute!.providers === undefined
      ? ''
      : `, providers: Object.freeze([${
        (selections.get(route.id) ?? []).map((provider) => `providers[${String(providers.indexOf(provider))}]`).join(', ')
      }])`
  } }),`);

const providerImports = (providers: readonly CompiledProvider[]): readonly string[] =>
  providers.map((provider, index) =>
    `import * as provider${String(index)} from ${JSON.stringify(provider.source)};`);

const providerRecords = (providers: readonly CompiledProvider[]): readonly string[] =>
  providers.map((provider, index) =>
    `  Object.freeze({ key: ${JSON.stringify(providerKeyFromName(provider.name))}, module: provider${String(index)}, source: ${JSON.stringify(provider.provenance.relativePath)} }),`);

/** The frozen provider registry a generated request scope iterates; empty when the project declares none. */
const providerRegistrySource = (providers: readonly CompiledProvider[]): readonly string[] =>
  providers.length === 0
    ? []
    : ['const providers = Object.freeze([', ...providerRecords(providers), ']);'];

/**
 * Claims this request's hit on the process identity and snapshots it in the
 * same synchronous step, before any state binding or provider `await`, so a
 * concurrent request on the same scope cannot move the value this request
 * mounts as `providers.processLifetime`.
 */
const processHitSource = (indent: string): readonly string[] => [
  `${indent}processLifetime.hits += 1;`,
  `${indent}const processHit = { hits: processLifetime.hits, instanceId: processLifetime.instanceId, pid: processLifetime.pid };`,
];

const processLifetimeValueSource = 'processHit';

/**
 * The `providers` field of every generated `runAgentRequest` init (shared
 * Flight worker, rendered CLI/script worker, plain routed CLI): only the
 * framework-owned process identity for a project without providers, otherwise
 * the request's provider resolver (#459) — run by the runtime once per
 * request, after the identity axes are frozen and the notice lease is open,
 * before the route; sequentially in deterministic key order; fail-closed on a
 * missing factory or a thrown/rejected factory; `processLifetime` seeded
 * first. Each factory receives the runtime's read-only request view (`host`,
 * `session`, `workspace`, `plugin`, `lineage`, `signal`, the `read`-only
 * `state` handle, and the `inbox`/`published`-only `notices` handle) spread
 * beside the surface-specific `invocation`.
 * The emitted loop mirrors `executeProviders` in
 * `../routes/provider-execution.ts`, which the in-process test harness runs;
 * `entry-shell.test.ts` pins the two together.
 */
const providersFieldSource = (
  providers: readonly CompiledProvider[],
  expressions: {
    readonly indent: string;
    readonly invocation: string;
    readonly observe?: string;
    readonly providers?: string;
  },
): readonly string[] => {
  const { indent, invocation, observe, providers: providerExpression = 'providers' } = expressions;
  if (providers.length === 0) {
    if (observe === undefined) return [`${indent}providers: { processLifetime: ${processLifetimeValueSource} },`];
    return [
      `${indent}providers: async () => {`,
      `${indent}  const providersStartedAt = performance.now();`,
      `${indent}  if (${observe}) parentPort.postMessage({ id: message.id, type: 'observed-providers-start' });`,
      `${indent}  if (${observe}) parentPort.postMessage({ count: 0, durationMs: performance.now() - providersStartedAt, id: message.id, type: 'observed-providers-finish' });`,
      `${indent}  return { processLifetime: ${processLifetimeValueSource} };`,
      `${indent}},`,
    ];
  }
  return [
    `${indent}providers: async (request) => {`,
    `${indent}  const providerValues = { processLifetime: ${processLifetimeValueSource} };`,
    ...(observe === undefined
      ? []
      : [
          `${indent}  const providersStartedAt = performance.now();`,
          `${indent}  if (${observe}) parentPort.postMessage({ id: message.id, type: 'observed-providers-start' });`,
        ]),
    `${indent}  for (const provider of ${providerExpression}) {`,
    ...(observe === undefined ? [] : [`${indent}    const providerStartedAt = performance.now();`]),
    `${indent}    if (typeof provider.module.default !== 'function') {`,
    `${indent}      throw new TypeError(\`Context provider "\${provider.key}" (\${provider.source}) must default-export a factory.\`);`,
    `${indent}    }`,
    `${indent}    try {`,
    `${indent}      providerValues[provider.key] = await provider.module.default({ ...request, invocation: ${invocation} });`,
    ...(observe === undefined
      ? []
      : [`${indent}      if (${observe}) parentPort.postMessage({ durationMs: performance.now() - providerStartedAt, id: message.id, key: provider.key, source: provider.source, status: 'mounted', type: 'observed-provider' });`]),
    `${indent}    } catch (error) {`,
    ...(observe === undefined
      ? []
      : [`${indent}      if (${observe}) parentPort.postMessage({ durationMs: performance.now() - providerStartedAt, id: message.id, key: provider.key, message: error instanceof Error ? error.message : String(error), source: provider.source, status: 'failed', type: 'observed-provider' });`]),
    `${indent}      throw new Error(\`Context provider "\${provider.key}" (\${provider.source}) failed: \${error instanceof Error ? error.message : String(error)}\`, { cause: error });`,
    `${indent}    }`,
    `${indent}  }`,
    ...(observe === undefined
      ? []
      : [`${indent}  if (${observe}) parentPort.postMessage({ count: Object.keys(providerValues).length - 1, durationMs: performance.now() - providersStartedAt, id: message.id, type: 'observed-providers-finish' });`]),
    `${indent}  return providerValues;`,
    `${indent}},`,
  ];
};

/** The long-lived react-server worker used by one generated MCP process. */
export const generatedRouteFlightWorkerSource = (options: GeneratedRouteFlightWorkerOptions): string => {
  const routes = executableMcpRoutes(options.routes);
  const eventRoutes = options.eventRoutes ?? [];
  const wiresInbox = wiresInboxRoute(options);
  const allProviders = orderedProviders(options.providers ?? []);
  const providerSelections = new Map<string, readonly CompiledProvider[]>();
  let importsAllProviders = routes.length > 0 || wiresInbox;
  for (const route of eventRoutes) {
    const required = route.eventRoute?.providers;
    const selection = selectRequiredProviders(allProviders, required);
    if (!selection.ok) {
      throw new Error(
        `Event route ${JSON.stringify(route.id)} has an invalid provider selection: ${
          selection.problems.map(requiredProviderKeyProblemMessage).join(' ')
        }`,
      );
    }
    if (required === undefined) importsAllProviders = true;
    else providerSelections.set(route.id, selection.providers);
  }
  const providers = importsAllProviders
    ? allProviders
    : orderedProviders([...new Set([...providerSelections.values()].flat())]);
  const hasProviderSelections = providerSelections.size > 0;
  const layouts = workerLayouts(options.layouts ?? [], routes);
  return [
    "import { parentPort } from 'node:worker_threads';",
    "import { createElement } from 'react';",
    "import { renderAgentFlight } from '@agent-bundle/runtime/flight/server';",
    "import { resolvePluginRoot, runAgentRequest, unavailable } from '@agent-bundle/runtime';",
    ...pluginRootImports('artifact'),
    ...generatedStateImports(options.state),
    ...noticeInboxImport(wiresInbox),
    ...routeImports(routes),
    ...eventRouteImports(eventRoutes, routes.length),
    ...providerImports(providers),
    ...layoutImports(layouts),
    '',
    '// Generated routes contain only intrinsic Agent protocol elements, so no client references exist.',
    'globalThis.__rspack_rsc_manifest__ ??= Object.freeze({ clientManifest: Object.freeze({}) });',
    "if (parentPort === null) throw new Error('Generated Flight worker requires a parent port.');",
    'process.stdout.write = process.stderr.write.bind(process.stderr);',
    `const ARTIFACT_EPOCH = ${JSON.stringify(options.artifactEpoch)};`,
    'const processLifetime = { hits: 0, instanceId: crypto.randomUUID(), pid: process.pid };',
    // The worker resolves the same code and state roots as the server process
    // beside it (same environment, same artifact layout); the server's
    // observed value rides each render message and wins when present.
    pluginRootDeclaration('artifact'),
    ...generatedStateOwner(options.state, options),
    ...providerRegistrySource(providers),
    ...composeLayoutsSource(layouts),
    'const routes = Object.freeze({',
    ...routeRecords(routes, { layouts }),
    ...noticeInboxRecord(wiresInbox),
    ...eventRouteRecords(eventRoutes, routes.length, providers, providerSelections),
    '});',
    'const requests = new Map();',
    '',
    'const render = async (message) => {',
    '  if (message.artifactEpoch !== undefined && message.artifactEpoch !== ARTIFACT_EPOCH) {',
    "    parentPort.postMessage({ code: 'artifact-epoch-mismatch', id: message.id, message: `Runtime artifact epoch ${JSON.stringify(ARTIFACT_EPOCH)} does not match request epoch ${JSON.stringify(message.artifactEpoch)}`, receivedEpoch: message.artifactEpoch, type: 'error' });",
    '    return;',
    '  }',
    "  const routeId = message.invocation.kind === 'event' ? `hook:event-route:${message.invocation.props.event.replace('/', '-')}` : message.invocation.props.operationId;",
    '  const route = routes[routeId];',
    "  if (route === undefined || typeof route.module.default !== 'function') throw new TypeError('Generated route must default-export an async Server Component.');",
    '  const observedRoute = message.observe !== true ? route : { ...route, module: { ...route.module, default: async (props) => {',
    '    const handlerStartedAt = performance.now();',
    "    try { return await route.module.default(props); } finally { parentPort.postMessage({ durationMs: performance.now() - handlerStartedAt, id: message.id, type: 'observed-handler' }); }",
    '  } } };',
    '  const controller = new AbortController();',
    '  requests.set(message.id, controller);',
    ...processHitSource('  '),
    '  try {',
    ...(options.state === undefined
      ? []
      : ['    const bindings = await runtimeState.requestBindings({ signal: controller.signal });', '    try {']),
    '    const plugin = message.plugin ?? pluginRoot.identity;',
    '    const bytes = await runAgentRequest({',
    '      ...(message.actor === undefined ? {} : { actor: message.actor }),',
    '      ...(message.host === undefined ? {} : { host: message.host }),',
    '      invocation: { ...message.requestInvocation, artifactEpoch: ARTIFACT_EPOCH, kind: message.invocation.kind, operationId: route.id, surface: route.name },',
    "      lineage: message.lineage ?? unavailable('not-provided'),",
    ...(options.state === undefined ? [] : ['      noticeLedger: bindings.noticeLedger,']),
    '      plugin,',
    '      progress: { report: async (update) => { parentPort.postMessage({ id: message.id, type: \'progress\', update }); } },',
    ...providersFieldSource(providers, {
      indent: '      ',
      invocation: 'message.invocation',
      observe: 'message.observe === true',
      ...(hasProviderSelections ? { providers: 'route.providers ?? providers' } : {}),
    }),
    '      ...(message.session === undefined ? {} : { session: message.session }),',
    '      signal: controller.signal,',
    ...(options.state === undefined ? [] : ['      state: bindings.state,']),
    // MCP and hook surfaces have no terminal; the host scope says so and the
    // worker forwards it rather than probing its own pipes (#511).
    "      terminal: message.terminal ?? unavailable('not-provided'),",
    '      ...(message.workspace === undefined ? {} : { workspace: message.workspace }),',
    '    }, async () => {',
    "      const props = message.invocation.kind === 'event'",
    '        ? Object.freeze({ canonical: Object.freeze(message.invocation.props.payload.canonical), native: Object.freeze(message.invocation.props.payload.native), signal: controller.signal })',
    '        : { input: message.invocation.props.input, signal: controller.signal };',
    "      if (message.observe === true) parentPort.postMessage({ id: message.id, type: 'observed-render-start' });",
    '      const renderStartedAt = performance.now();',
    '      const flight = renderAgentFlight(composeLayouts(observedRoute, props, controller.signal), { signal: controller.signal });',
    '      const renderedBytes = new Uint8Array(await new Response(flight).arrayBuffer());',
    "      if (message.observe === true) parentPort.postMessage({ durationMs: performance.now() - renderStartedAt, id: message.id, type: 'observed-render-finish' });",
    '      return renderedBytes;',
    '    });',
    '    parentPort.postMessage({ bytes, id: message.id, type: \'complete\' }, [bytes.buffer]);',
    ...(options.state === undefined
      ? []
      : ['    } finally {', '      await bindings.close();', '    }']),
    '  } catch (error) {',
    "    parentPort.postMessage({ id: message.id, message: error instanceof Error ? error.message : String(error), type: 'error' });",
    '  } finally {',
    '    requests.delete(message.id);',
    '  }',
    '};',
    '',
    'parentPort.on(\'message\', (message) => {',
    "  if (message.type === 'cancel') { requests.get(message.id)?.abort(); return; }",
    "  if (message.type === 'render') void render(message);",
    '});',
    '',
  ].join('\n');
};

/**
 * Build-time validation of the MCP route kinds a generated server registers.
 * Registration itself is data-driven at runtime (`registerGeneratedRoutes` in
 * `agent-bundle/mcp-server-runtime`), but a resource without a static
 * `config.uri` and a non-MCP route inside an MCP server are compile-time
 * defects: they must fail the build, not the first request.
 */
const assertRegistrableMcpRoutes = (
  routes: readonly CompiledAgentRoute[],
  injectNoticeInbox: boolean,
): void => {
  for (const route of routes) {
    if (injectNoticeInbox && mcpRouteProtocolName(route.id) === 'notice-inbox') {
      throw new Error(
        `Generated MCP route ${JSON.stringify(route.id)} uses the reserved protocol name "notice-inbox".`,
      );
    }
    if (injectNoticeInbox && route.config['uri'] === 'agent-bundle://notices/inbox') {
      throw new Error(
        `Generated MCP route ${JSON.stringify(route.id)} uses the reserved URI "agent-bundle://notices/inbox".`,
      );
    }
    switch (route.kind) {
      case 'tool':
      case 'prompt':
      case 'app':
        break;
      case 'resource': {
        const uri = route.config['uri'];
        if (typeof uri !== 'string' || uri.trim() === '') {
          throw new Error(`Generated resource route ${JSON.stringify(route.id)} requires a non-empty static config.uri.`);
        }
        break;
      }
      case 'event-route':
      case 'cli':
      case 'script':
        throw new Error(`Generated MCP server contains non-MCP route ${JSON.stringify(route.id)}.`);
      default: {
        const unreachable: never = route.kind;
        throw new TypeError(`Unhandled generated route kind ${String(unreachable)}.`);
      }
    }
  }
};

/**
 * The generated MCP entry: the compiled route table, the compiled App
 * registry, and one warm Flight worker handed to the shared server runtime.
 * The worker is split out only to satisfy React's react-server condition; it
 * is reused for every request until the MCP server closes.
 *
 * Everything below the route table lives in `agent-bundle/mcp-server-runtime`,
 * so the in-memory projection proof level registers, renders, and projects
 * through the same code this artifact runs.
 */
export const generatedRouteMcpEntrySource = (options: GeneratedRouteMcpEntryOptions): string => {
  const routes = executableMcpRoutes(options.routes);
  assertRegistrableMcpRoutes(routes, options.state !== undefined);
  const artifactEpoch = generatedRouteArtifactEpoch(options.plugin);
  const hasEvents = (options.eventRoutes?.length ?? 0) > 0;
  const allowedEventTargets = [...(options.allowedTargets ?? [])].sort((left, right) => left.localeCompare(right));
  const eventHosts = [...(options.hosts ?? [])].sort((left, right) => left.localeCompare(right));
  const wiresInbox = wiresInboxRoute(options);
  const wiresResourceUpdated = wiresResourceUpdatedRoute(options);
  // The lineage registry journals durably only where the project already
  // accepted the sqlite kernel and its state root (a workspace-durable
  // `src/state.ts`); stateless and volatile projects keep a process-lifetime
  // registry so `node:sqlite` never loads for them and no state directory
  // is created for an artifact that declared none.
  const durableLineage = options.state?.lifetime === 'workspace-durable';
  return [
    ...(hasEvents ? ["import { dirname, resolve } from 'node:path';"] : []),
    ...pluginRootImports('artifact'),
    "import { resolvePluginRoot } from '@agent-bundle/runtime';",
    `import { createFlightWorkerHost, createGeneratedRouteMcpServer } from ${JSON.stringify(mcpServerRuntimeSpecifier)};`,
    ...(hasEvents
      ? [
          `import { createEventRuntimeServer } from ${JSON.stringify(eventIpcRuntimeSpecifier)};`,
          `import { createCanonicalEventProps, projectEventDocument } from ${JSON.stringify(eventProjectRuntimeSpecifier)};`,
        ]
      : []),
    `import { ${durableLineage ? 'agentLineageStateDefinition, ' : ''}createAgentLineageRegistry } from '@agent-bundle/runtime/lineage';`,
    ...(durableLineage || wiresResourceUpdated ? ["import { createSqliteStateDriver } from '@agent-bundle/runtime/state/sqlite';"] : []),
    "import mcpApps from 'agent-bundle/mcp-apps';",
    ...noticeDeliveryImports(wiresResourceUpdated),
    ...noticeInboxImport(wiresInbox),
    ...routeImports(routes),
    '',
    `const ARTIFACT_EPOCH = ${JSON.stringify(artifactEpoch)};`,
    // The server process's one root resolution (#468): the lineage journal,
    // the notice store, and every request identity it publishes read `pluginRoot`.
    pluginRootDeclaration('artifact'),
    ...(durableLineage
      ? [
          // In the project's own state root, so a restarted MCP process
          // still knows which subagents are alive. A store that cannot open
          // degrades to memory rather than failing the server: lineage is an
          // observed axis, never a precondition.
          'const openLineage = async () => {',
          '  const driver = createSqliteStateDriver({ root: pluginRoot.stateRoot });',
          '  try {',
          '    const store = await driver.open(agentLineageStateDefinition());',
          '    return { dispose: async () => { await store.close(); await driver.close(); }, registry: createAgentLineageRegistry({ store }) };',
          '  } catch (error) {',
          "    process.stderr.write(`agent-bundle lineage registry is in-memory only: ${error instanceof Error ? error.message : String(error)}\\n`);",
          '    await driver.close().catch(() => undefined);',
          '    return { dispose: async () => undefined, registry: createAgentLineageRegistry() };',
          '  }',
          '};',
        ]
      : [
          'const openLineage = async () => ({ dispose: async () => undefined, registry: createAgentLineageRegistry() });',
        ]),
    'const routes = Object.freeze({',
    ...routeRecords(routes),
    ...noticeInboxRecord(wiresInbox),
    '});',
    '',
    ...noticeDeliveryOwner(wiresResourceUpdated, options),
    ...(hasEvents
      ? [
          // The endpoint identity is artifact-location dependent, so it stays
          // in the artifact rather than the shared runtime: the artifact epoch
          // and the root directory (the entry lives in `mcp/`), never the
          // projection selection — the hook wrapper derives the same id (#592).
          `const EVENT_ARTIFACT_EPOCH = ${JSON.stringify(options.artifactEpoch ?? 'unknown')};`,
          `const EVENT_ALLOWED_TARGETS = Object.freeze(${JSON.stringify(allowedEventTargets)});`,
          `const EVENT_HOSTS = Object.freeze(${JSON.stringify(eventHosts)});`,
          'const events = Object.freeze({',
          '  allowedTargets: EVENT_ALLOWED_TARGETS,',
          '  artifactEpoch: EVENT_ARTIFACT_EPOCH,',
          '  createCanonicalEventProps,',
          '  createEventRuntimeServer,',
          '  endpointId: `${EVENT_ARTIFACT_EPOCH}:${dirname(dirname(resolve(process.argv[1])))}`,',
          '  hosts: EVENT_HOSTS,',
          '  projectEventDocument,',
          '});',
          '',
        ]
      : []),
    'export default async () => {',
    '  const lineage = await openLineage();',
    '  return createGeneratedRouteMcpServer({',
    '    apps: mcpApps,',
    '    artifactEpoch: ARTIFACT_EPOCH,',
    '    disposeLineage: lineage.dispose,',
    ...(hasEvents ? ['    events,'] : []),
    `    host: createFlightWorkerHost(new URL(${JSON.stringify(`./${options.workerFile}`)}, import.meta.url), ARTIFACT_EPOCH),`,
    '    lineage: lineage.registry,',
    ...(wiresResourceUpdated ? ['    notices: noticeDelivery,'] : []),
    `    plugin: ${stableJson(options.plugin)},`,
    '    pluginRoot: pluginRoot.identity,',
    '    routes,',
    '  });',
    '};',
    '',
  ].join('\n');
};
