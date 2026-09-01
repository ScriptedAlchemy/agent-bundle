import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { stableJson } from '../core/digest.ts';
import type { CompiledAgentRoute } from '../routes/types.ts';

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


export interface GeneratedRouteMcpEntryOptions {
  readonly plugin: { readonly name: string; readonly version: string };
  readonly routes: readonly CompiledAgentRoute[];
  readonly serverName: string;
  readonly workerFile: string;
}

export interface GeneratedRouteFlightWorkerOptions {
  readonly routes: readonly CompiledAgentRoute[];
  readonly serverName: string;
}

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

/** The long-lived react-server worker used by one generated MCP process. */
export const generatedRouteFlightWorkerSource = (options: GeneratedRouteFlightWorkerOptions): string => {
  const routes = executableMcpRoutes(options.routes);
  return [
    "import { parentPort } from 'node:worker_threads';",
    "import { createElement } from 'react';",
    "import { renderAgentFlight } from '@agent-bundle/runtime/flight/server';",
    "import { runAgentRequest } from '@agent-bundle/runtime';",
    ...routeImports(routes),
    '',
    '// Generated routes contain only intrinsic Agent protocol elements, so no client references exist.',
    'globalThis.__rspack_rsc_manifest__ ??= Object.freeze({ clientManifest: Object.freeze({}) });',
    "if (parentPort === null) throw new Error('Generated Flight worker requires a parent port.');",
    'const routes = Object.freeze({',
    ...routeRecords(routes),
    '});',
    'const requests = new Map();',
    '',
    'const render = async (message) => {',
    '  const route = routes[message.invocation.props.operationId];',
    "  if (route === undefined || typeof route.module.default !== 'function') throw new TypeError('Generated MCP route must default-export an async Server Component.');",
    '  const controller = new AbortController();',
    '  requests.set(message.id, controller);',
    '  try {',
    '    const bytes = await runAgentRequest({',
    '      ...(message.actor === undefined ? {} : { actor: message.actor }),',
    '      invocation: { kind: \'tool\', operationId: route.id, surface: route.name },',
    '      ...(message.session === undefined ? {} : { session: message.session }),',
    '      signal: controller.signal,',
    '    }, async () => {',
    '      const flight = renderAgentFlight(createElement(route.module.default, { input: message.invocation.props.input, signal: controller.signal }), { signal: controller.signal });',
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
          `  }, async (input, context) => projectToolResult(await renderRoute(dispatcher, ${access}, input, context)));`,
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
 * The generated MCP entry owns the final-only dispatcher and one warm Flight
 * worker. The worker is split only to satisfy React's react-server condition;
 * it is reused for every request until the MCP server closes.
 */
export const generatedRouteMcpEntrySource = (options: GeneratedRouteMcpEntryOptions): string => {
  const routes = executableMcpRoutes(options.routes);
  return [
    "import { Worker } from 'node:worker_threads';",
    "import { McpServer } from '@modelcontextprotocol/server';",
    "import { agent, available, createAgentRenderDispatcher, runAgentRequest } from '@agent-bundle/runtime';",
    "import mcpApps from 'agent-bundle/mcp-apps';",
    ...routeImports(routes),
    '',
    'const routes = Object.freeze({',
    ...routeRecords(routes),
    '});',
    '',
    'const createWorkerHost = () => {',
    `  const worker = new Worker(new URL(${JSON.stringify(`./${options.workerFile}`)}, import.meta.url));`,
    '  const pending = new Map();',
    '  let sequence = 0;',
    '  const failPending = (error) => { for (const request of pending.values()) request.reject(error); pending.clear(); };',
    '  worker.on(\'error\', failPending);',
    '  worker.on(\'exit\', (code) => { if (code !== 0) failPending(new Error(`Generated Flight worker exited with code ${String(code)}.`)); });',
    '  worker.on(\'message\', (message) => {',
    '    const request = pending.get(message.id);',
    '    if (request === undefined) return;',
    '    pending.delete(message.id);',
    '    request.signal.removeEventListener(\'abort\', request.abort);',
    "    if (message.type === 'error') { request.reject(new Error(message.message)); return; }",
    '    request.resolve(new ReadableStream({ start(controller) { controller.enqueue(message.bytes); controller.close(); } }));',
    '  });',
    '  return Object.freeze({',
    '    close: async () => { await worker.terminate(); },',
    '    execute: async ({ invocation, signal }) => {',
    '      const context = await agent();',
    '      const id = ++sequence;',
    '      return new Promise((resolve, reject) => {',
    "        const abort = () => { worker.postMessage({ id, type: 'cancel' }); pending.delete(id); reject(new DOMException('Agent render was aborted', 'AbortError')); };",
    '        pending.set(id, { abort, reject, resolve, signal });',
    "        signal.addEventListener('abort', abort, { once: true });",
    '        if (signal.aborted) { abort(); return; }',
    "        worker.postMessage({ actor: context.actor, id, invocation, session: context.session, type: 'render' });",
    '      });',
    '    },',
    '  });',
    '};',
    '',
    'const requestIdentity = (context) => ({',
    '  ...(context.http?.authInfo?.clientId === undefined ? {} : { actor: available({ id: context.http.authInfo.clientId }, \'native\') }),',
    "  ...(typeof context.sessionId === 'string' && context.sessionId.trim() !== '' ? { session: available({ sessionId: context.sessionId }, 'native') } : {}),",
    '});',
    '',
    'const renderRoute = async (dispatcher, route, input, context) => runAgentRequest({',
    '  ...requestIdentity(context),',
    "  invocation: { kind: 'tool', operationId: route.id, surface: route.name },",
    '  signal: context.mcpReq.signal,',
    '}, async () => {',
    '  const document = await dispatcher.dispatch({ invocation: { kind: \'tool\', props: { input, operationId: route.id } }, signal: context.mcpReq.signal });',
    '  return { document, result: route.module.resultSchema.parse(document.value) };',
    '});',
    '',
    'const appendNode = (node, content) => {',
    '  switch (node.kind) {',
    "    case 'result': for (const child of node.children) appendNode(child, content); break;",
    "    case 'markdown':",
    "    case 'text': content.push({ text: node.text, type: 'text' }); break;",
    "    case 'json': content.push({ text: JSON.stringify(node.value), type: 'text' }); break;",
    "    case 'progress': content.push({ text: node.message ?? `Progress: ${node.completed}${node.total === undefined ? '' : `/${node.total}`}`, type: 'text' }); break;",
    "    case 'image': content.push({ data: node.data, mimeType: node.mimeType, type: 'image' }); break;",
    "    case 'audio': content.push({ data: node.data, mimeType: node.mimeType, type: 'audio' }); break;",
    "    case 'resource': content.push({ ...(node.mimeType === undefined ? {} : { mimeType: node.mimeType }), name: node.name, type: 'resource_link', uri: node.uri }); break;",
    "    case 'error': content.push({ text: `[${node.code}] ${node.message}`, type: 'text' }); break;",
    "    default: throw new TypeError(`Unsupported Agent Document node: ${String(node.kind)}`);",
    '  }',
    '};',
    '',
    'const projectToolResult = ({ document, result }) => {',
    '  const content = [];',
    '  appendNode(document.root, content);',
    '  return { content, ...(document.status === \'represented-error\' ? { isError: true } : {}), ...(result !== null && typeof result === \'object\' && !Array.isArray(result) ? { structuredContent: result } : {}) };',
    '};',
    '',
    'const createGeneratedRouteServer = () => {',
    `  const server = new McpServer(${stableJson(options.plugin)});`,
    '  const workerHost = createWorkerHost();',
    '  const dispatcher = createAgentRenderDispatcher(workerHost);',
    ...routeRegistrations(routes),
    '  for (const app of mcpApps) {',
    '    server.registerResource(app.name, app.resourceUri, { ...(app._meta === undefined ? {} : { _meta: app._meta }), mimeType: app.mimeType }, async (uri) => ({ contents: [{ mimeType: app.mimeType, text: app.html, uri: uri.href }] }));',
    '  }',
    '  const close = server.close.bind(server);',
    '  server.close = async () => { await workerHost.close(); await close(); };',
    '  return server;',
    '};',
    '',
    'export default createGeneratedRouteServer;',
    '',
  ].join('\n');
};
