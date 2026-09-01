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
 * The shared server runtime a generated route entry delegates to: warm Flight
 * host, route registration, projection. Aliased rather than imported so the
 * emitted artifact stays self-contained, and shared rather than templated so
 * `agent-bundle/test`'s in-memory projection level exercises this exact code.
 */
export const mcpServerRuntimeSpecifier = 'agent-bundle/mcp-server-runtime';

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

export interface GeneratedCliBinEntryOptions {
  readonly commands: readonly CompiledCliCommand[];
  readonly plugin: { readonly description?: string; readonly name: string; readonly version: string };
  readonly routes: readonly CompiledAgentRoute[];
}

/**
 * The generated routed-CLI executable (#102 stage 2): the compiled command
 * graph rides the bundle as data, the cli-entry shell owns argv parsing,
 * help, exit codes, and signals, and every command executes inside the typed
 * Agent request context. Input validation failures are usage failures
 * (`CliInputError`, exit 2); the route module's zod schemas stay the
 * runtime validation boundary.
 */
export const generatedCliBinEntrySource = (options: GeneratedCliBinEntryOptions): string => {
  const commandRoutes = options.routes.filter((route) =>
    options.commands.some((command) => command.routeId === route.id));
  return [
    `import { CliInputError, runGeneratedCliProcess } from ${JSON.stringify(cliEntryRuntimeSpecifier)};`,
    "import { available, runAgentRequest, unavailable } from '@agent-bundle/runtime';",
    ...routeImports(commandRoutes),
    '',
    'const routes = Object.freeze({',
    ...commandRoutes.map((route, index) =>
      `  ${JSON.stringify(route.id)}: Object.freeze({ module: route${String(index)} }),`),
    '});',
    '',
    `const commands = Object.freeze(${stableJson(options.commands)});`,
    '',
    'const execute = async (command, input, context) => {',
    '  const route = routes[command.routeId];',
    "  if (route === undefined || typeof route.module.default !== 'function') throw new TypeError('Generated CLI route must default-export an async function.');",
    '  let parsed;',
    '  try {',
    '    parsed = route.module.inputSchema.parse(input);',
    '  } catch (error) {',
    '    throw new CliInputError(error instanceof Error ? error.message : String(error));',
    '  }',
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
    'await runGeneratedCliProcess({',
    '  commands,',
    ...(options.plugin.description === undefined ? [] : [`  description: ${JSON.stringify(options.plugin.description)},`]),
    '  execute,',
    `  name: ${JSON.stringify(options.plugin.name)},`,
    `  version: ${JSON.stringify(options.plugin.version)},`,
    '});',
    '',
  ].join('\n');
};

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

/**
 * Build-time validation of the MCP route kinds a generated server registers.
 * Registration itself is data-driven at runtime (`registerGeneratedRoutes` in
 * `agent-bundle/mcp-server-runtime`), but a resource without a static
 * `config.uri` and a non-MCP route inside an MCP server are compile-time
 * defects: they must fail the build, not the first request.
 */
const assertRegistrableMcpRoutes = (routes: readonly CompiledAgentRoute[]): void => {
  for (const route of routes) {
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
  assertRegistrableMcpRoutes(routes);
  const artifactEpoch = generatedRouteArtifactEpoch(options.plugin);
  const hasEvents = (options.eventRoutes?.length ?? 0) > 0;
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
    ...routeImports(routes),
    '',
    `const ARTIFACT_EPOCH = ${JSON.stringify(artifactEpoch)};`,
    'const routes = Object.freeze({',
    ...routeRecords(routes),
    '});',
    '',
    ...(hasEvents
      ? [
          // The endpoint identity is artifact-location dependent, so it stays
          // in the artifact rather than the shared runtime.
          `const EVENT_ARTIFACT_EPOCH = ${JSON.stringify(options.artifactEpoch ?? 'unknown')};`,
          `const EVENT_TARGET = ${JSON.stringify(options.target ?? 'unknown')};`,
          'const events = Object.freeze({',
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
