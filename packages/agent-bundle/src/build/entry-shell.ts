import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { eventIpcRuntimeSpecifier, eventProjectRuntimeSpecifier } from '../adapters/hook-contract.ts';
import { stableJson } from '../core/digest.ts';
import type { NormalizedHook, NormalizedStateDefinition } from '../core/types.ts';
import { providerKeyFromName } from '../routes/providers.ts';
import type { CompiledAgentRoute, CompiledCliCommand, CompiledProvider } from '../routes/types.ts';

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
 * `../<name>.ts`.
 */
const runtimeModulePath = (name: string): string => {
  for (const candidate of [
    new URL(`./${name}.js`, import.meta.url),
    new URL(`../${name}.ts`, import.meta.url),
  ]) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return path;
  }
  throw new Error(`Unable to locate the agent-bundle/${name} runtime module for generated entries.`);
};

export const mcpEntryRuntimePath = (): string => runtimeModulePath('mcp-entry');

export const mcpServerRuntimePath = (): string => runtimeModulePath('mcp-server-runtime');

/**
 * The generated stdio MCP entry body for a factory-exporting server module:
 * the lifecycle installs the console guard before the consumer module
 * evaluates, so `loadEntry` stays a deferred dynamic import.
 */
export const generatedStdioMcpEntrySource = (options: {
  readonly entrySource: string;
  readonly serverName: string;
}): string => [
  `import { runGeneratedStdioMcpEntry } from ${JSON.stringify(mcpEntryRuntimeSpecifier)};`,
  '',
  'await runGeneratedStdioMcpEntry({',
  `  loadEntry: () => import(${JSON.stringify(options.entrySource)}),`,
  `  serverName: ${JSON.stringify(options.serverName)},`,
  '});',
  '',
].join('\n');

/**
 * The generated process envelope for a `main`- or default-exporting
 * executable entry (npm bin outputs and artifact Scripts): await the entry
 * point with argv, adopt a numeric return as the exit code, and let an
 * escaped rejection surface through Node's top-level failure path (stack to
 * stderr, exit code 1).
 */
export const generatedExecutableEntrySource = (options: {
  readonly entrySource: string;
  readonly exportName: 'default' | 'main';
}): string => [
  `import * as entry from ${JSON.stringify(options.entrySource)};`,
  '',
  `const main = entry[${JSON.stringify(options.exportName)}];`,
  "if (typeof main !== 'function') {",
  `  throw new TypeError('Executable entry must export a ${options.exportName} function: ' + ${JSON.stringify(options.entrySource)});`,
  '}',
  'const code = await main(process.argv.slice(2));',
  "if (typeof code === 'number') process.exitCode = code;",
  '',
].join('\n');


export const cliEntryRuntimeSpecifier = 'agent-bundle/cli-entry';

/**
 * The on-disk location of the `agent-bundle/cli-entry` runtime module,
 * aliased into generated CLI executables exactly like the mcp-entry
 * lifecycle so emitted bins stay self-contained.
 */
export const cliEntryRuntimePath = (): string => {
  for (const candidate of [
    new URL('./cli-entry.js', import.meta.url),
    new URL('../cli-entry.ts', import.meta.url),
  ]) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return path;
  }
  throw new Error('Unable to locate the agent-bundle/cli-entry runtime module for generated CLI executables.');
};

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

export interface GeneratedCliBinEntryOptions {
  readonly commands: readonly CompiledCliCommand[];
  readonly plugin: { readonly description?: string; readonly name: string; readonly version: string };
  /** Conventional request context providers, mounted for plain commands in this process (#313). */
  readonly providers?: readonly CompiledProvider[];
  readonly routes: readonly CompiledAgentRoute[];
  readonly state?: NormalizedStateDefinition;
  /** The sibling react-server worker bundle; required when any command is rendered. */
  readonly workerFile?: string;
}

type GeneratedStateFallback = 'artifact' | 'cwd';

const generatedStateImports = (
  state: NormalizedStateDefinition | undefined,
  fallback: GeneratedStateFallback,
): readonly string[] => {
  if (state === undefined) return [];
  return [
    ...(state.lifetime === 'workspace-durable'
      ? [
        "import { join } from 'node:path';",
        ...(fallback === 'artifact' ? ["import { fileURLToPath } from 'node:url';"] : []),
        "import { createSqliteStateDriver } from '@agent-bundle/runtime/state/sqlite';",
      ]
      : ["import { createMemoryStateDriver } from '@agent-bundle/runtime/state';"]),
    "import { createGeneratedRuntimeState } from '@agent-bundle/runtime/mount';",
    `import stateDefinition from ${JSON.stringify(state.source)};`,
  ];
};

const generatedStateOwner = (
  state: NormalizedStateDefinition | undefined,
  fallback: GeneratedStateFallback,
): readonly string[] => {
  if (state === undefined) return [];
  if (state.lifetime !== 'workspace-durable') {
    return [
      `const runtimeState = createGeneratedRuntimeState({ definition: stateDefinition, driver: createMemoryStateDriver({ lifetime: ${JSON.stringify(state.lifetime)} }) });`,
      '',
    ];
  }
  const fallbackExpression = fallback === 'artifact'
    ? "fileURLToPath(new URL('..', import.meta.url))"
    : "join(process.cwd(), '.agent-bundle')";
  return [
    `const durableAnchor = process.env.AGENT_BUNDLE_PLUGIN_ROOT ?? ${fallbackExpression};`,
    "const runtimeState = createGeneratedRuntimeState({ definition: stateDefinition, driver: createSqliteStateDriver({ root: join(durableAnchor, 'state') }) });",
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
  'const openRenderedSession = ({ invocation, props, request, routeId, signal, validate }) => {',
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
  // real surface (`cli`, `script`, `tool`) instead of an undefined invocation.
  "      worker.postMessage({ id, invocation, props, request, routeId, type: 'render' });",
  '      return stream;',
  '    },',
  '  });',
  '  const dispatcher = createAgentRenderDispatcher(host);',
  '  return Object.freeze({',
  '    close: async () => { await worker.terminate(); },',
  '    events: () => dispatcher.stream({ invocation, signal }),',
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
export const generatedCliBinEntrySource = (options: GeneratedCliBinEntryOptions): string => {
  const commandRoutes = options.routes.filter((route) =>
    options.commands.some((command) => command.routeId === route.id));
  const rendered = options.commands.some((command) => command.rendered);
  if (rendered && options.workerFile === undefined) {
    throw new Error('A generated CLI with rendered commands requires a worker file.');
  }
  const providers = orderedProviders(options.providers ?? []);
  const plainIndent = options.state === undefined ? '  ' : '    ';
  return [
    `import { CliInputError, runGeneratedCliProcess } from ${JSON.stringify(cliEntryRuntimeSpecifier)};`,
    rendered
      ? "import { available, createAgentRenderDispatcher, runAgentRequest, unavailable } from '@agent-bundle/runtime';"
      : "import { available, runAgentRequest, unavailable } from '@agent-bundle/runtime';",
    ...(rendered ? ["import { Worker } from 'node:worker_threads';"] : []),
    ...generatedStateImports(options.state, 'cwd'),
    ...routeImports(commandRoutes),
    ...providerImports(providers),
    '',
    ...generatedStateOwner(options.state, 'cwd'),
    'const processLifetime = { hits: 0, instanceId: crypto.randomUUID(), pid: process.pid };',
    ...providerRegistrySource(providers),
    'const routes = Object.freeze({',
    ...commandRoutes.map((route, index) =>
      `  ${JSON.stringify(route.id)}: Object.freeze({ module: route${String(index)} }),`),
    '});',
    '',
    `const commands = Object.freeze(${stableJson(options.commands)});`,
    '',
    'const parseInput = (route, input) => {',
    '  try {',
    '    return route.module.inputSchema.parse(input);',
    '  } catch (error) {',
    '    throw new CliInputError(error instanceof Error ? error.message : String(error));',
    '  }',
    '};',
    '',
    // Plain commands mount the same conventional providers as every other
    // generated request scope (#313): once per request, in deterministic key
    // order, fail-closed, before the typed Agent request context opens.
    'const execute = async (command, input, context) => {',
    '  const route = routes[command.routeId];',
    "  if (route === undefined || typeof route.module.default !== 'function') throw new TypeError('Generated CLI route must default-export an async function.');",
    '  const parsed = parseInput(route, input);',
    '  const cwd = process.cwd();',
    '  processLifetime.hits += 1;',
    ...(options.state === undefined
      ? []
      : ['  const bindings = await runtimeState.requestBindings({ signal: context.signal });', '  try {']),
    ...providerExecutionSource(providers, {
      indent: plainIndent,
      invocation: "{ kind: 'cli', props: { args: context.args, command: command.path.join(' ') } }",
      signal: 'context.signal',
    }),
    `${plainIndent}const result = await runAgentRequest({`,
    '    capabilities: {',
    '      command: unavailable(),',
    '      filesystem: unavailable(),',
    '      network: unavailable(),',
    "      projectRoot: available({ root: cwd }, 'derived'),",
    '    },',
    "    host: unavailable('unsupported-surface'),",
    "    invocation: { kind: 'cli', operationId: command.routeId, surface: command.path.join(' ') },",
    ...(options.state === undefined ? [] : ['      noticeLedger: bindings.noticeLedger,']),
    `    providers: ${providerValuesExpression(providers)},`,
    '    signal: context.signal,',
    ...(options.state === undefined ? [] : ['      state: bindings.state,']),
    "    workspace: available({ root: cwd }, 'derived'),",
    `  }, async () => route.module.default({ input: parsed, signal: context.signal }));`,
    `${options.state === undefined ? '  ' : '    '}return route.module.resultSchema.parse(result);`,
    ...(options.state === undefined
      ? []
      : ['  } finally {', '    await bindings.close();', '  }']),
    '};',
    '',
    ...(rendered
      ? [
        ...renderedSessionSource(options.workerFile!),
        '',
        'const render = (command, input, context) => {',
        '  const route = routes[command.routeId];',
        '  const parsed = parseInput(route, input);',
        '  if (command.mcp !== undefined) {',
        '    return openRenderedSession({',
        "      invocation: { kind: 'tool', props: { input: parsed, operationId: command.routeId } },",
        '      props: { input: parsed },',
        `      request: { artifactEpoch: ${JSON.stringify(generatedRouteArtifactEpoch(options.plugin))}, kind: 'tool', operationId: command.routeId, surface: command.mcp.tool },`,
        '      routeId: command.routeId,',
        '      signal: context.signal,',
        '      validate: (value) => route.module.resultSchema.parse(value),',
        '    });',
        '  }',
        '  return openRenderedSession({',
        "    invocation: { kind: 'cli', props: { args: context.args, command: command.path.join(' ') } },",
        '    props: { input: parsed },',
        "    request: { kind: 'cli', operationId: command.routeId, surface: command.path.join(' ') },",
        '    routeId: command.routeId,',
        '    signal: context.signal,',
        '    validate: (value) => route.module.resultSchema.parse(value),',
        '  });',
        '};',
        '',
      ]
      : []),
    ...(options.state === undefined ? [] : ['try {']),
    `${options.state === undefined ? '' : '  '}await runGeneratedCliProcess({`,
    '  commands,',
    ...(options.plugin.description === undefined ? [] : [`  description: ${JSON.stringify(options.plugin.description)},`]),
    '  execute,',
    `  name: ${JSON.stringify(options.plugin.name)},`,
    ...(rendered ? ['  render,'] : []),
    `  version: ${JSON.stringify(options.plugin.version)},`,
    '});',
    ...(options.state === undefined
      ? []
      : ['} finally {', '  await runtimeState.close();', '}']),
    '',
  ].join('\n');
};

export interface GeneratedRenderedRouteWorkerOptions {
  readonly providers?: readonly CompiledProvider[];
  readonly routes: readonly CompiledAgentRoute[];
  readonly state?: NormalizedStateDefinition;
}

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
  return [
    "import { parentPort } from 'node:worker_threads';",
    "import { createElement } from 'react';",
    "import { renderAgentFlight } from '@agent-bundle/runtime/flight/server';",
    "import { available, runAgentRequest, unavailable } from '@agent-bundle/runtime';",
    ...generatedStateImports(options.state, 'cwd'),
    ...routeImports(options.routes),
    ...providerImports(providers),
    '',
    ...generatedStateOwner(options.state, 'cwd'),
    '// Generated routes contain only intrinsic Agent protocol elements, so no client references exist.',
    'globalThis.__rspack_rsc_manifest__ ??= Object.freeze({ clientManifest: Object.freeze({}) });',
    "if (parentPort === null) throw new Error('Generated render worker requires a parent port.');",
    '// Machine output owns the parent stdout; anything a route logs goes to stderr.',
    'process.stdout.write = process.stderr.write.bind(process.stderr);',
    'const processLifetime = { hits: 0, instanceId: crypto.randomUUID(), pid: process.pid };',
    ...providerRegistrySource(providers),
    'const routes = Object.freeze({',
    ...options.routes.map((route, index) =>
      `  ${JSON.stringify(route.id)}: Object.freeze({ module: route${String(index)} }),`),
    '});',
    'const requests = new Map();',
    '',
    'const render = async (message) => {',
    '  const route = routes[message.routeId];',
    "  if (route === undefined || typeof route.module.default !== 'function') throw new TypeError('Generated rendered route must default-export an async function component.');",
    '  const controller = new AbortController();',
    '  requests.set(message.id, controller);',
    '  processLifetime.hits += 1;',
    '  try {',
    '    const cwd = process.cwd();',
    ...(options.state === undefined
      ? []
      : ['    const bindings = await runtimeState.requestBindings({ signal: controller.signal });']),
    ...(options.state === undefined ? [] : ['    try {']),
    ...providerExecutionSource(providers, { indent: '    ', invocation: 'message.invocation', signal: 'controller.signal' }),
    '    await runAgentRequest({',
    '      capabilities: {',
    '        command: unavailable(),',
    '        filesystem: unavailable(),',
    '        network: unavailable(),',
    "        projectRoot: available({ root: cwd }, 'derived'),",
    '      },',
    "      host: unavailable('unsupported-surface'),",
    '      invocation: message.request,',
    ...(options.state === undefined ? [] : ['      noticeLedger: bindings.noticeLedger,']),
    "      progress: { report: async (update) => { parentPort.postMessage({ id: message.id, type: 'progress', update }); } },",
    `      providers: ${providerValuesExpression(providers)},`,
    '      signal: controller.signal,',
    ...(options.state === undefined ? [] : ['      state: bindings.state,']),
    "      workspace: available({ root: cwd }, 'derived'),",
    '    }, async () => {',
    '      const flight = renderAgentFlight(createElement(route.module.default, { ...message.props, signal: controller.signal }), { signal: controller.signal });',
    '      const reader = flight.getReader();',
    '      while (true) {',
    '        const next = await reader.read();',
    '        if (next.done) break;',
    '        const bytes = next.value;',
    "        parentPort.postMessage({ bytes, id: message.id, type: 'chunk' }, [bytes.buffer]);",
    '      }',
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
  '    validate: (value) => value,',
  '  }),',
  `  name: ${JSON.stringify(options.name)},`,
  '});',
  '',
].join('\n');

export interface GeneratedRouteMcpEntryOptions {
  readonly artifactEpoch?: string;
  readonly eventRoutes?: readonly NormalizedHook[];
  readonly plugin: { readonly name: string; readonly version: string };
  readonly routes: readonly CompiledAgentRoute[];
  readonly serverName: string;
  readonly state?: NormalizedStateDefinition;
  readonly target?: string;
  readonly workerFile: string;
}

export interface GeneratedRouteFlightWorkerOptions {
  readonly artifactEpoch: string;
  readonly eventRoutes?: readonly NormalizedHook[];
  readonly providers?: readonly CompiledProvider[];
  readonly routes: readonly CompiledAgentRoute[];
  readonly serverName: string;
  readonly state?: NormalizedStateDefinition;
}

export const generatedRouteArtifactEpoch = (plugin: {
  readonly name: string;
  readonly version: string;
}): string => `${plugin.name}@${plugin.version}`;

const routeProtocolName = (route: CompiledAgentRoute): string =>
  route.id.slice(route.id.lastIndexOf('/') + 1);

const executableMcpRoutes = (routes: readonly CompiledAgentRoute[]): readonly CompiledAgentRoute[] =>
  routes.filter((route) => route.kind !== 'app');

const routeImports = (routes: readonly CompiledAgentRoute[]): readonly string[] =>
  routes.map((route, index) => `import * as route${String(index)} from ${JSON.stringify(route.source)};`);

const routeRecords = (routes: readonly CompiledAgentRoute[]): readonly string[] =>
  routes.map((route, index) =>
    `  ${JSON.stringify(route.id)}: Object.freeze({ config: ${stableJson(route.config)}, id: ${JSON.stringify(route.id)}, kind: ${JSON.stringify(route.kind)}, module: route${String(index)}, name: ${JSON.stringify(routeProtocolName(route))} }),`);

const noticeInboxImport = (state: NormalizedStateDefinition | undefined): readonly string[] =>
  state === undefined
    ? []
    : [`import * as noticeInboxRoute from ${JSON.stringify(noticeInboxRuntimeSpecifier)};`];

const noticeInboxRecord = (state: NormalizedStateDefinition | undefined): readonly string[] =>
  state === undefined
    ? []
    : ['  [noticeInboxRoute.AGENT_NOTICE_INBOX_ROUTE_ID]: noticeInboxRoute.noticeInboxRouteRecord(noticeInboxRoute),'];

const eventRouteImports = (
  routes: readonly NormalizedHook[],
  offset: number,
): readonly string[] => routes.map((route, index) =>
  `import * as route${String(offset + index)} from ${JSON.stringify(route.source)};`);

const eventRouteRecords = (
  routes: readonly NormalizedHook[],
  offset: number,
): readonly string[] => routes.map((route, index) =>
  `  ${JSON.stringify(route.id)}: Object.freeze({ event: ${JSON.stringify(route.eventRoute!.event)}, id: ${JSON.stringify(route.id)}, kind: 'event-route', module: route${String(offset + index)}, name: ${JSON.stringify(route.eventRoute!.event)} }),`);

const orderedProviders = (providers: readonly CompiledProvider[]): readonly CompiledProvider[] =>
  [...providers].sort((left, right) => {
    const byKey = providerKeyFromName(left.name).localeCompare(providerKeyFromName(right.name));
    return byKey === 0 ? left.source.localeCompare(right.source) : byKey;
  });

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

const processLifetimeValueSource =
  '{ hits: processLifetime.hits, instanceId: processLifetime.instanceId, pid: processLifetime.pid }';

/**
 * Per-request provider execution shared by every generated request scope
 * (shared Flight worker, rendered CLI/script worker, plain routed CLI): once
 * per request, sequentially in deterministic key order, fail-closed on a
 * missing factory or a thrown/rejected factory, with the framework-owned
 * `processLifetime` value seeded first.
 */
const providerExecutionSource = (
  providers: readonly CompiledProvider[],
  expressions: { readonly indent: string; readonly invocation: string; readonly signal: string },
): readonly string[] => {
  if (providers.length === 0) return [];
  const { indent, invocation, signal } = expressions;
  return [
    `${indent}const providerValues = { processLifetime: ${processLifetimeValueSource} };`,
    `${indent}for (const provider of providers) {`,
    `${indent}  if (typeof provider.module.default !== 'function') {`,
    `${indent}    throw new TypeError(\`Context provider "\${provider.key}" (\${provider.source}) must default-export a factory.\`);`,
    `${indent}  }`,
    `${indent}  try {`,
    `${indent}    providerValues[provider.key] = await provider.module.default({ invocation: ${invocation}, signal: ${signal} });`,
    `${indent}  } catch (error) {`,
    `${indent}    throw new Error(\`Context provider "\${provider.key}" (\${provider.source}) failed: \${error instanceof Error ? error.message : String(error)}\`, { cause: error });`,
    `${indent}  }`,
    `${indent}}`,
  ];
};

/** The `providers` request-scope value: the executed map, or only the framework-owned process identity. */
const providerValuesExpression = (providers: readonly CompiledProvider[]): string =>
  providers.length === 0 ? `{ processLifetime: ${processLifetimeValueSource} }` : 'providerValues';

/** The long-lived react-server worker used by one generated MCP process. */
export const generatedRouteFlightWorkerSource = (options: GeneratedRouteFlightWorkerOptions): string => {
  const routes = executableMcpRoutes(options.routes);
  const eventRoutes = options.eventRoutes ?? [];
  const providers = orderedProviders(options.providers ?? []);
  return [
    "import { parentPort } from 'node:worker_threads';",
    "import { createElement } from 'react';",
    "import { renderAgentFlight } from '@agent-bundle/runtime/flight/server';",
    "import { runAgentRequest } from '@agent-bundle/runtime';",
    ...generatedStateImports(options.state, 'artifact'),
    ...noticeInboxImport(options.state),
    ...routeImports(routes),
    ...eventRouteImports(eventRoutes, routes.length),
    ...providerImports(providers),
    '',
    '// Generated routes contain only intrinsic Agent protocol elements, so no client references exist.',
    'globalThis.__rspack_rsc_manifest__ ??= Object.freeze({ clientManifest: Object.freeze({}) });',
    "if (parentPort === null) throw new Error('Generated Flight worker requires a parent port.');",
    'process.stdout.write = process.stderr.write.bind(process.stderr);',
    `const ARTIFACT_EPOCH = ${JSON.stringify(options.artifactEpoch)};`,
    'const processLifetime = { hits: 0, instanceId: crypto.randomUUID(), pid: process.pid };',
    ...generatedStateOwner(options.state, 'artifact'),
    ...providerRegistrySource(providers),
    'const routes = Object.freeze({',
    ...routeRecords(routes),
    ...noticeInboxRecord(options.state),
    ...eventRouteRecords(eventRoutes, routes.length),
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
    '  const controller = new AbortController();',
    '  requests.set(message.id, controller);',
    '  processLifetime.hits += 1;',
    '  try {',
    ...(options.state === undefined
      ? []
      : ['    const bindings = await runtimeState.requestBindings({ signal: controller.signal });', '    try {']),
    ...providerExecutionSource(providers, { indent: '    ', invocation: 'message.invocation', signal: 'controller.signal' }),
    '    const bytes = await runAgentRequest({',
    '      ...(message.actor === undefined ? {} : { actor: message.actor }),',
    '      ...(message.host === undefined ? {} : { host: message.host }),',
    '      invocation: { ...message.requestInvocation, artifactEpoch: ARTIFACT_EPOCH, kind: message.invocation.kind, operationId: route.id, surface: route.name },',
    ...(options.state === undefined ? [] : ['      noticeLedger: bindings.noticeLedger,']),
    '      progress: { report: async (update) => { parentPort.postMessage({ id: message.id, type: \'progress\', update }); } },',
    `      providers: ${providerValuesExpression(providers)},`,
    '      ...(message.session === undefined ? {} : { session: message.session }),',
    '      signal: controller.signal,',
    ...(options.state === undefined ? [] : ['      state: bindings.state,']),
    '      ...(message.workspace === undefined ? {} : { workspace: message.workspace }),',
    '    }, async () => {',
    "      const props = message.invocation.kind === 'event'",
    '        ? Object.freeze({ canonical: Object.freeze(message.invocation.props.payload.canonical), native: Object.freeze(message.invocation.props.payload.native), signal: controller.signal })',
    '        : { input: message.invocation.props.input, signal: controller.signal };',
    '      const flight = renderAgentFlight(createElement(route.module.default, props), { signal: controller.signal });',
    '      return new Uint8Array(await new Response(flight).arrayBuffer());',
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
    if (injectNoticeInbox && routeProtocolName(route) === 'notice-inbox') {
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
  const eventTarget = options.target ?? 'unknown';
  const allowedEventTargets = eventTarget === 'plugin'
    ? ['claude', 'codex', 'cursor']
    : [eventTarget];
  return [
    ...(hasEvents ? ["import { dirname, resolve } from 'node:path';"] : []),
    `import { createFlightWorkerHost, createGeneratedRouteMcpServer } from ${JSON.stringify(mcpServerRuntimeSpecifier)};`,
    ...(hasEvents
      ? [
          `import { createEventRuntimeServer } from ${JSON.stringify(eventIpcRuntimeSpecifier)};`,
          `import { createCanonicalEventProps, projectEventDocument } from ${JSON.stringify(eventProjectRuntimeSpecifier)};`,
        ]
      : []),
    "import mcpApps from 'agent-bundle/mcp-apps';",
    ...noticeInboxImport(options.state),
    ...routeImports(routes),
    '',
    `const ARTIFACT_EPOCH = ${JSON.stringify(artifactEpoch)};`,
    'const routes = Object.freeze({',
    ...routeRecords(routes),
    ...noticeInboxRecord(options.state),
    '});',
    '',
    ...(hasEvents
      ? [
          // The endpoint identity is artifact-location dependent, so it stays
          // in the artifact rather than the shared runtime.
          `const EVENT_ARTIFACT_EPOCH = ${JSON.stringify(options.artifactEpoch ?? 'unknown')};`,
          `const EVENT_TARGET = ${JSON.stringify(eventTarget)};`,
          `const EVENT_ALLOWED_TARGETS = Object.freeze(${JSON.stringify(allowedEventTargets)});`,
          'const events = Object.freeze({',
          '  allowedTargets: EVENT_ALLOWED_TARGETS,',
          '  artifactEpoch: EVENT_ARTIFACT_EPOCH,',
          '  createCanonicalEventProps,',
          '  createEventRuntimeServer,',
          '  endpointId: `${EVENT_ARTIFACT_EPOCH}:${EVENT_TARGET}:${dirname(dirname(resolve(process.argv[1])))}`,',
          '  projectEventDocument,',
          '  target: EVENT_TARGET,',
          '});',
          '',
        ]
      : []),
    'export default async () => createGeneratedRouteMcpServer({',
    '  apps: mcpApps,',
    '  artifactEpoch: ARTIFACT_EPOCH,',
    ...(hasEvents ? ['  events,'] : []),
    `  host: createFlightWorkerHost(new URL(${JSON.stringify(`./${options.workerFile}`)}, import.meta.url), ARTIFACT_EPOCH),`,
    `  plugin: ${stableJson(options.plugin)},`,
    '  routes,',
    '});',
    '',
  ].join('\n');
};
