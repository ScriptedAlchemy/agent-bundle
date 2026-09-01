import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { eventIpcRuntimeSpecifier, eventProjectRuntimeSpecifier } from '../adapters/hook-contract.ts';
import { stableJson } from '../core/digest.ts';
import type { NormalizedHook } from '../core/types.ts';
import type { CompiledAgentRoute, CompiledCliCommand } from '../routes/types.ts';

/**
 * Generated-entry templates: the framework-provided entry files consumers
 * would otherwise write by hand (react-router's provided-entry trick). Every
 * template imports its consumer module by absolute path, exactly like the
 * generated hook wrappers, and is bundled through the same Rslib synthesis.
 */

export const mcpEntryRuntimeSpecifier = 'agent-bundle/mcp-entry';

/**
 * The on-disk location of the `agent-bundle/mcp-entry` runtime module, used
 * as a bundler alias so generated entries inline the lifecycle instead of
 * leaving an `agent-bundle` import in the emitted artifact (artifacts must
 * stay self-contained). From the bundled package this module's URL is
 * `dist/<bundle>.js` with `mcp-entry.js` as a sibling; from checked-out
 * sources it is `src/build/entry-shell.ts` with `../mcp-entry.ts`.
 */
export const mcpEntryRuntimePath = (): string => {
  for (const candidate of [
    new URL('./mcp-entry.js', import.meta.url),
    new URL('../mcp-entry.ts', import.meta.url),
  ]) {
    const path = fileURLToPath(candidate);
    if (existsSync(path)) return path;
  }
  throw new Error('Unable to locate the agent-bundle/mcp-entry runtime module for generated stdio entries.');
};

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

export interface GeneratedCliBinEntryOptions {
  readonly commands: readonly CompiledCliCommand[];
  readonly plugin: { readonly description?: string; readonly name: string; readonly version: string };
  readonly routes: readonly CompiledAgentRoute[];
  /** The sibling react-server worker bundle; required when any command is rendered. */
  readonly workerFile?: string;
}

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
  "  worker.on('exit', (code) => { if (code !== 0) failPending(new Error(`Generated render worker exited with code ${String(code)}.`)); });",
  "  worker.on('message', (message) => {",
  '    const entry = pending.get(message.id);',
  '    if (entry === undefined) return;',
  "    if (message.type === 'progress') { void entry.progress?.report(message.update); return; }",
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
  '        fail: (error) => { pending.delete(id); try { streamController.error(error); } catch {} },',
  '        progress: dispatch.progress,',
  '        signal: dispatch.signal,',
  '      };',
  '      pending.set(id, entry);',
  "      dispatch.signal.addEventListener('abort', entry.abort, { once: true });",
  '      if (dispatch.signal.aborted) { entry.abort(); return stream; }',
  "      worker.postMessage({ id, props, request, routeId, type: 'render' });",
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
  return [
    `import { CliInputError, runGeneratedCliProcess } from ${JSON.stringify(cliEntryRuntimeSpecifier)};`,
    rendered
      ? "import { available, createAgentRenderDispatcher, runAgentRequest, unavailable } from '@agent-bundle/runtime';"
      : "import { available, runAgentRequest, unavailable } from '@agent-bundle/runtime';",
    ...(rendered ? ["import { Worker } from 'node:worker_threads';"] : []),
    ...routeImports(commandRoutes),
    '',
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
    'const execute = async (command, input, context) => {',
    '  const route = routes[command.routeId];',
    "  if (route === undefined || typeof route.module.default !== 'function') throw new TypeError('Generated CLI route must default-export an async function.');",
    '  const parsed = parseInput(route, input);',
    '  const cwd = process.cwd();',
    '  const result = await runAgentRequest({',
    '    capabilities: {',
    '      command: unavailable(),',
    '      filesystem: unavailable(),',
    '      network: unavailable(),',
    "      projectRoot: available({ root: cwd }, 'derived'),",
    '    },',
    "    host: unavailable('unsupported-surface'),",
    "    invocation: { kind: 'cli', operationId: command.routeId, surface: command.path.join(' ') },",
    '    signal: context.signal,',
    "    workspace: available({ root: cwd }, 'derived'),",
    '  }, async () => route.module.default({ input: parsed, signal: context.signal }));',
    '  return route.module.resultSchema.parse(result);',
    '};',
    '',
    ...(rendered
      ? [
        ...renderedSessionSource(options.workerFile!),
        '',
        'const render = (command, input, context) => {',
        '  const route = routes[command.routeId];',
        '  const parsed = parseInput(route, input);',
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
    'await runGeneratedCliProcess({',
    '  commands,',
    ...(options.plugin.description === undefined ? [] : [`  description: ${JSON.stringify(options.plugin.description)},`]),
    '  execute,',
    `  name: ${JSON.stringify(options.plugin.name)},`,
    ...(rendered ? ['  render,'] : []),
    `  version: ${JSON.stringify(options.plugin.version)},`,
    '});',
    '',
  ].join('\n');
};

export interface GeneratedRenderedRouteWorkerOptions {
  readonly routes: readonly CompiledAgentRoute[];
}

/**
 * The react-server worker behind generated CLI executables and rendered
 * scripts: renders one route's async default component through Flight,
 * streaming raw bytes back chunk by chunk, with progress reports and the
 * typed Agent request context installed around every render.
 */
export const generatedRenderedRouteWorkerSource = (
  options: GeneratedRenderedRouteWorkerOptions,
): string => [
  "import { parentPort } from 'node:worker_threads';",
  "import { createElement } from 'react';",
  "import { renderAgentFlight } from '@agent-bundle/runtime/flight/server';",
  "import { available, runAgentRequest, unavailable } from '@agent-bundle/runtime';",
  ...routeImports(options.routes),
  '',
  '// Generated routes contain only intrinsic Agent protocol elements, so no client references exist.',
  'globalThis.__rspack_rsc_manifest__ ??= Object.freeze({ clientManifest: Object.freeze({}) });',
  "if (parentPort === null) throw new Error('Generated render worker requires a parent port.');",
  '// Machine output owns the parent stdout; anything a route logs goes to stderr.',
  'process.stdout.write = process.stderr.write.bind(process.stderr);',
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
  '  try {',
  '    const cwd = process.cwd();',
  '    await runAgentRequest({',
  '      capabilities: {',
  '        command: unavailable(),',
  '        filesystem: unavailable(),',
  '        network: unavailable(),',
  "        projectRoot: available({ root: cwd }, 'derived'),",
  '      },',
  "      host: unavailable('unsupported-surface'),",
  '      invocation: message.request,',
  "      progress: { report: async (update) => { parentPort.postMessage({ id: message.id, type: 'progress', update }); } },",
  '      signal: controller.signal,',
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

export interface GeneratedRenderedScriptEntryOptions {
  readonly name: string;
  readonly routeId: string;
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
  readonly target?: string;
  readonly workerFile: string;
}

export interface GeneratedRouteFlightWorkerOptions {
  readonly artifactEpoch: string;
  readonly eventRoutes?: readonly NormalizedHook[];
  readonly routes: readonly CompiledAgentRoute[];
  readonly serverName: string;
}

export const generatedRouteArtifactEpoch = (plugin: {
  readonly name: string;
  readonly version: string;
}): string => `${plugin.name}@${plugin.version}`;

const routeProtocolName = (route: CompiledAgentRoute): string =>
  route.id.slice(route.id.lastIndexOf('/') + 1);

const selectedConfig = (
  config: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Readonly<Record<string, unknown>> => Object.fromEntries(
  keys.filter((key) => config[key] !== undefined).map((key) => [key, config[key]]),
);

const executableMcpRoutes = (routes: readonly CompiledAgentRoute[]): readonly CompiledAgentRoute[] =>
  routes.filter((route) => route.kind !== 'app');

const routeImports = (routes: readonly CompiledAgentRoute[]): readonly string[] =>
  routes.map((route, index) => `import * as route${String(index)} from ${JSON.stringify(route.source)};`);

const routeRecords = (routes: readonly CompiledAgentRoute[]): readonly string[] =>
  routes.map((route, index) =>
    `  ${JSON.stringify(route.id)}: Object.freeze({ config: ${stableJson(route.config)}, id: ${JSON.stringify(route.id)}, kind: ${JSON.stringify(route.kind)}, module: route${String(index)}, name: ${JSON.stringify(routeProtocolName(route))} }),`);

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

/** The long-lived react-server worker used by one generated MCP process. */
export const generatedRouteFlightWorkerSource = (options: GeneratedRouteFlightWorkerOptions): string => {
  const routes = executableMcpRoutes(options.routes);
  const eventRoutes = options.eventRoutes ?? [];
  return [
    "import { parentPort } from 'node:worker_threads';",
    "import { createElement } from 'react';",
    "import { renderAgentFlight } from '@agent-bundle/runtime/flight/server';",
    "import { runAgentRequest } from '@agent-bundle/runtime';",
    ...routeImports(routes),
    ...eventRouteImports(eventRoutes, routes.length),
    '',
    '// Generated routes contain only intrinsic Agent protocol elements, so no client references exist.',
    'globalThis.__rspack_rsc_manifest__ ??= Object.freeze({ clientManifest: Object.freeze({}) });',
    "if (parentPort === null) throw new Error('Generated Flight worker requires a parent port.');",
    'process.stdout.write = process.stderr.write.bind(process.stderr);',
    `const ARTIFACT_EPOCH = ${JSON.stringify(options.artifactEpoch)};`,
    'const processLifetime = { hits: 0, instanceId: crypto.randomUUID(), pid: process.pid };',
    'const routes = Object.freeze({',
    ...routeRecords(routes),
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
    '    const bytes = await runAgentRequest({',
    '      ...(message.actor === undefined ? {} : { actor: message.actor }),',
    '      invocation: { artifactEpoch: ARTIFACT_EPOCH, kind: message.invocation.kind, operationId: route.id, surface: route.name },',
    '      progress: { report: async (update) => { parentPort.postMessage({ id: message.id, type: \'progress\', update }); } },',
    '      providers: { processLifetime: { hits: processLifetime.hits, instanceId: processLifetime.instanceId, pid: processLifetime.pid } },',
    '      ...(message.session === undefined ? {} : { session: message.session }),',
    '      signal: controller.signal,',
    '    }, async () => {',
    "      const props = message.invocation.kind === 'event'",
    '        ? Object.freeze({ canonical: Object.freeze(message.invocation.props.payload.canonical), native: Object.freeze(message.invocation.props.payload.native), signal: controller.signal })',
    '        : { input: message.invocation.props.input, signal: controller.signal };',
    '      const flight = renderAgentFlight(createElement(route.module.default, props), { signal: controller.signal });',
    '      return new Uint8Array(await new Response(flight).arrayBuffer());',
    '    });',
    '    parentPort.postMessage({ bytes, id: message.id, type: \'complete\' }, [bytes.buffer]);',
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

const routeRegistrations = (routes: readonly CompiledAgentRoute[]): readonly string[] => {
  const registrations: string[] = [];
  for (const route of routes) {
    const access = `routes[${JSON.stringify(route.id)}]`;
    switch (route.kind) {
      case 'tool': {
        const config = selectedConfig(route.config, ['_meta', 'annotations', 'description', 'icons', 'title']);
        registrations.push([
          `  server.registerTool(${JSON.stringify(routeProtocolName(route))}, {`,
          `    ...${stableJson(config)},`,
          `    inputSchema: ${access}.module.inputSchema,`,
          `    outputSchema: ${access}.module.resultSchema,`,
          `  }, async (input, context) => {`,
          `    const rendered = await renderRoute(dispatcher, ${access}, input, context);`,
          '    return attachMcpStructuredContent(rendered.toolResult, rendered.result);',
          '  });',
        ].join('\n'));
        break;
      }
      case 'resource': {
        const uri = route.config['uri'];
        if (typeof uri !== 'string' || uri.trim() === '') {
          throw new Error(`Generated resource route ${JSON.stringify(route.id)} requires a non-empty static config.uri.`);
        }
        const config = selectedConfig(route.config, ['_meta', 'description', 'icons', 'mimeType', 'title']);
        registrations.push([
          `  server.registerResource(${JSON.stringify(routeProtocolName(route))}, ${JSON.stringify(uri)}, ${stableJson(config)}, async (uri, context) => {`,
          `    const rendered = await renderRoute(dispatcher, ${access}, { uri: uri.href }, context);`,
          '    return rendered.result;',
          '  });',
        ].join('\n'));
        break;
      }
      case 'prompt': {
        const config = selectedConfig(route.config, ['_meta', 'description', 'icons', 'title']);
        registrations.push([
          `  server.registerPrompt(${JSON.stringify(routeProtocolName(route))}, {`,
          `    ...${stableJson(config)},`,
          `    argsSchema: ${access}.module.inputSchema,`,
          `  }, async (input, context) => (await renderRoute(dispatcher, ${access}, input, context)).result);`,
        ].join('\n'));
        break;
      }
      case 'app':
        break;
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
  return registrations;
};

/**
 * The generated MCP entry owns the stream projector and one warm Flight
 * worker. The worker is split only to satisfy React's react-server condition;
 * it is reused for every request until the MCP server closes.
 */
export const generatedRouteMcpEntrySource = (options: GeneratedRouteMcpEntryOptions): string => {
  const routes = executableMcpRoutes(options.routes);
  const artifactEpoch = generatedRouteArtifactEpoch(options.plugin);
  const hasEvents = (options.eventRoutes?.length ?? 0) > 0;
  return [
    ...(hasEvents ? ["import { dirname, resolve } from 'node:path';"] : []),
    "import { Worker } from 'node:worker_threads';",
    "import { McpServer } from '@modelcontextprotocol/server';",
    "import { AgentRuntimeError, agent, attachMcpStructuredContent, available, createAgentRenderDispatcher, createWarmFlightHost, projectMcpRenderStream, runAgentRequest } from '@agent-bundle/runtime';",
    ...(hasEvents
      ? [
          `import { createEventRuntimeServer } from ${JSON.stringify(eventIpcRuntimeSpecifier)};`,
          `import { createCanonicalEventProps, projectEventDocument } from ${JSON.stringify(eventProjectRuntimeSpecifier)};`,
        ]
      : []),
    "import mcpApps from 'agent-bundle/mcp-apps';",
    ...routeImports(routes),
    '',
    `const ARTIFACT_EPOCH = ${JSON.stringify(artifactEpoch)};`,
    'const routes = Object.freeze({',
    ...routeRecords(routes),
    '});',
    '',
    'const workerError = (message) => {',
    "  if (message.code === 'artifact-epoch-mismatch') return new AgentRuntimeError('artifact-epoch-mismatch', message.message, { expectedEpoch: ARTIFACT_EPOCH, receivedEpoch: message.receivedEpoch });",
    "  if (message.code === 'runtime-unavailable') return new AgentRuntimeError('runtime-unavailable', message.message);",
    "  if (message.code === 'runtime-restarted') return new AgentRuntimeError('runtime-restarted', message.message);",
    '  return new Error(message.message);',
    '};',
    '',
    'const createWorkerHost = () => {',
    `  const worker = new Worker(new URL(${JSON.stringify(`./${options.workerFile}`)}, import.meta.url), { stderr: true, stdout: true });`,
    '  worker.stdout?.on(\'data\', (chunk) => process.stderr.write(chunk));',
    '  worker.stderr?.on(\'data\', (chunk) => process.stderr.write(chunk));',
    '  const pending = new Map();',
    '  let sequence = 0;',
    '  let exited = false;',
    '  const failPending = (error) => { for (const request of pending.values()) request.reject(error); pending.clear(); };',
    '  worker.on(\'error\', (error) => { exited = true; failPending(error); });',
    '  worker.on(\'exit\', (code) => {',
    '    exited = true;',
    "    failPending(new AgentRuntimeError(code === 0 ? 'runtime-unavailable' : 'runtime-restarted', code === 0 ? 'The MCP render runtime is unavailable' : `The MCP render runtime restarted; worker exited with code ${String(code)}.`));",
    '  });',
    '  worker.on(\'message\', (message) => {',
    '    const request = pending.get(message.id);',
    '    if (request === undefined) return;',
    "    if (message.type === 'progress') { void request.progress?.report(message.update); return; }",
    '    pending.delete(message.id);',
    '    request.signal.removeEventListener(\'abort\', request.abort);',
    "    if (message.type === 'error') { request.reject(workerError(message)); return; }",
    '    request.resolve(new ReadableStream({ start(controller) { controller.enqueue(message.bytes); controller.close(); } }));',
    '  });',
    '  const host = Object.freeze({',
    '    close: async () => { await worker.terminate(); },',
    '    execute: async ({ artifactEpoch, invocation, progress, signal }) => {',
    "      if (exited) throw new AgentRuntimeError('runtime-unavailable', 'The MCP render runtime is unavailable');",
    '      const context = await agent();',
    '      const id = ++sequence;',
    '      return new Promise((resolve, reject) => {',
    "        const abort = () => { worker.postMessage({ id, type: 'cancel' }); pending.delete(id); reject(new DOMException('Agent render was aborted', 'AbortError')); };",
    '        pending.set(id, { abort, progress, reject, resolve, signal });',
    "        signal.addEventListener('abort', abort, { once: true });",
    '        if (signal.aborted) { abort(); return; }',
    '        worker.postMessage({ actor: context.actor, artifactEpoch: artifactEpoch ?? ARTIFACT_EPOCH, id, invocation, session: context.session, type: \'render\' });',
    '      });',
    '    },',
    '  });',
    '  return createWarmFlightHost({ artifactEpoch: ARTIFACT_EPOCH, close: host.close, host });',
    '};',
    '',
    'const requestIdentity = (context) => ({',
    '  ...(context.http?.authInfo?.clientId === undefined ? {} : { actor: available({ id: context.http.authInfo.clientId }, \'native\') }),',
    "  ...(typeof context.sessionId === 'string' && context.sessionId.trim() !== '' ? { session: available({ sessionId: context.sessionId }, 'native') } : {}),",
    '});',
    '',
    'const mcpProjectorOptions = (context) => {',
    '  const progressToken = context.mcpReq._meta?.progressToken;',
    '  return {',
    '    signal: context.mcpReq.signal,',
    '    ...(progressToken === undefined ? {} : {',
    '      progressToken,',
    "      sendProgress: (params) => context.mcpReq.notify({ method: 'notifications/progress', params }),",
    '    }),',
    '  };',
    '};',
    '',
    'const renderRoute = async (dispatcher, route, input, context) => runAgentRequest({',
    '  ...requestIdentity(context),',
    "  invocation: { artifactEpoch: ARTIFACT_EPOCH, kind: 'tool', operationId: route.id, surface: route.name },",
    '  signal: context.mcpReq.signal,',
    '}, async () => {',
    '  const projected = await projectMcpRenderStream(dispatcher.stream({',
    '    artifactEpoch: ARTIFACT_EPOCH,',
    "    invocation: { kind: 'tool', props: { input, operationId: route.id } },",
    '    signal: context.mcpReq.signal,',
    '  }), mcpProjectorOptions(context));',
    '  return { document: projected.document, result: route.module.resultSchema.parse(projected.document.value), toolResult: projected.result };',
    '});',
    '',
    'const createGeneratedRouteServer = async () => {',
    `  const server = new McpServer(${stableJson(options.plugin)});`,
    '  const workerHost = createWorkerHost();',
    '  const dispatcher = createAgentRenderDispatcher(workerHost);',
    ...(hasEvents
      ? [
          `  const artifactEpoch = ${JSON.stringify(options.artifactEpoch ?? 'unknown')};`,
          `  const target = ${JSON.stringify(options.target ?? 'unknown')};`,
          "  const endpointId = `${artifactEpoch}:${target}:${dirname(dirname(resolve(process.argv[1])))}`;",
          '  const eventRuntime = await createEventRuntimeServer({',
          '    artifactEpoch,',
          '    endpointId,',
          '    handle: async (request) => {',
          "      const nativeEvent = typeof request.native.hook_event_name === 'string' ? request.native.hook_event_name : request.event;",
          '      const controller = new AbortController();',
          '      const props = createCanonicalEventProps(request.event, request.native, target, nativeEvent, request.hostContractRevision, controller.signal);',
          '      const sessionId = typeof request.native.session_id === \'string\' ? request.native.session_id : typeof request.native.conversation_id === \'string\' ? request.native.conversation_id : undefined;',
          '      return runAgentRequest({',
          "        host: available({ name: target }, 'native'),",
          "        invocation: { artifactEpoch, hostContractRevision: request.hostContractRevision, kind: 'event', operationId: `event:${request.event}`, surface: request.event },",
          "        ...(sessionId === undefined ? {} : { session: available({ sessionId }, 'native') }),",
          '        signal: controller.signal,',
          "        ...(typeof request.native.cwd === 'string' ? { workspace: available({ root: request.native.cwd }, 'native') } : {}),",
          '      }, async () => {',
          "        const document = await dispatcher.dispatch({ invocation: { kind: 'event', props: { event: request.event, payload: { canonical: props.canonical, native: props.native } } }, signal: controller.signal });",
          '        return projectEventDocument(document, request.event, target, nativeEvent);',
          '      });',
          '    },',
          '  });',
        ]
      : []),
    ...routeRegistrations(routes),
    '  for (const app of mcpApps) {',
    '    server.registerResource(app.name, app.resourceUri, { ...(app._meta === undefined ? {} : { _meta: app._meta }), mimeType: app.mimeType }, async (uri) => ({ contents: [{ mimeType: app.mimeType, text: app.html, uri: uri.href }] }));',
    '  }',
    '  const close = server.close.bind(server);',
    `  server.close = async () => { ${hasEvents ? 'await eventRuntime.close(); ' : ''}await workerHost.close(); await close(); };`,
    '  return server;',
    '};',
    '',
    'export default createGeneratedRouteServer;',
    '',
  ].join('\n');
};
