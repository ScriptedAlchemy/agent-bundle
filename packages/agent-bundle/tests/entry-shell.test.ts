import { execFile as executeFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { describe, expect, it } from '@rstest/core';
import ts from 'typescript-5';

import { claudeAdapter } from '../src/adapters/claude.ts';
import { cursorHookWrapperSource, nativeHookWrapperSource, type TargetHookWrapper } from '../src/adapters/hook-contract.ts';
import type { NoticeDeliveryAdvertisement } from '../src/adapters/notice-delivery.ts';
import { scanEntryExportsSource, stripCommentsAndStrings } from '../src/build/entry-exports.ts';
import * as entryShellModule from '../src/build/entry-shell.ts';
import { launchEnvLayerSpecifier, operatorEnvLayerImport, operatorEnvLayerModuleSource, operatorEnvLayerVirtualModule } from '../src/build/launch-env-shell.ts';
import { stableJson } from '../src/core/digest.ts';
import {
  generatedExecutableEntrySource,
  generatedRenderedScriptEntrySource,
  generatedStdioMcpEntrySource,
  mcpEntryRuntimePath,
  mcpEntryRuntimeSpecifier,
  mcpServerRuntimePath,
  mcpServerRuntimeSpecifier,
  stdioPreludeImport,
  stdioPreludeModuleSource,
  stdioPreludeSpecifier,
  stdioPreludeVirtualModule,
} from '../src/build/entry-shell.ts';
import {
  executeProviders,
  orderedProviders,
  providerFactoryMissingMessage,
  providerFailedMessage,
} from '../src/routes/provider-execution.ts';

const execFile = promisify(executeFile);

describe('entry export scanning', () => {
  it('detects declaration-form main exports', () => {
    expect(scanEntryExportsSource('export const main = async () => 0;')).toEqual({
      hasDefaultExport: false,
      hasMainExport: true,
    });
    expect(scanEntryExportsSource('export async function main(argv) { return 0; }').hasMainExport).toBe(true);
    expect(scanEntryExportsSource('export function main() {}').hasMainExport).toBe(true);
    expect(scanEntryExportsSource('export let main = 1;\n').hasMainExport).toBe(true);
  });

  it('detects brace-clause exports with renames', () => {
    expect(scanEntryExportsSource('const run = 1; export { run as main };').hasMainExport).toBe(true);
    expect(scanEntryExportsSource('const main = 1; export { main };').hasMainExport).toBe(true);
    expect(scanEntryExportsSource('const main = 1; export { main as other };').hasMainExport).toBe(false);
    expect(scanEntryExportsSource("export { factory as default } from './server.ts';").hasDefaultExport).toBe(true);
  });

  it('detects default exports and ignores type-only clauses', () => {
    expect(scanEntryExportsSource('export default () => ({});').hasDefaultExport).toBe(true);
    expect(scanEntryExportsSource('const f = 1;\nexport default f;').hasDefaultExport).toBe(true);
    expect(scanEntryExportsSource("export type { Thing as default } from './types.ts';").hasDefaultExport).toBe(false);
    expect(scanEntryExportsSource('export type { main } from "./types.ts";').hasMainExport).toBe(false);
  });

  it('never matches inside comments, strings, or template literals', () => {
    expect(scanEntryExportsSource('// export default nothing\nconst a = 1;').hasDefaultExport).toBe(false);
    expect(scanEntryExportsSource('/* export const main = 1 */ const a = 1;').hasMainExport).toBe(false);
    expect(scanEntryExportsSource("const s = 'export default x';").hasDefaultExport).toBe(false);
    expect(scanEntryExportsSource('const s = `export const main = ${1}`;').hasMainExport).toBe(false);
    expect(scanEntryExportsSource('const t = `a ${`b ${1} export default c`} d`;').hasDefaultExport).toBe(false);
  });

  it('survives regex literals containing slashes', () => {
    const source = "const re = /https:\\/\\//u; export default re;";
    expect(scanEntryExportsSource(source).hasDefaultExport).toBe(true);
    expect(stripCommentsAndStrings('const division = a / b / c; export const main = 1;')).toContain('export const main');
  });

  it('handles TypeScript syntax the JS lexers cannot parse', () => {
    const source = [
      "import type { Widget } from './types.ts';",
      'export interface CliOptions { readonly write?: (value: string) => void }',
      'export const main = async (argv: readonly string[]): Promise<void> => {},',
    ].join('\n');
    expect(scanEntryExportsSource(source)).toEqual({ hasDefaultExport: false, hasMainExport: true });
  });
});

describe('generated entry templates', () => {
  it('locates the on-disk mcp-entry runtime module for bundler aliasing', async () => {
    const path = mcpEntryRuntimePath();
    await expect(access(path)).resolves.toBeUndefined();
    expect(path.endsWith('mcp-entry.ts') || path.endsWith('mcp-entry.js')).toBe(true);
  });

  it('generates a stdio entry whose first import is the prelude — stdout guard, then the operator .env layer — ahead of the server module (#469)', () => {
    const source = generatedStdioMcpEntrySource({ entrySource: '/proj/src/mcp/curator.ts', serverName: 'curator' });
    expect(source).toContain(`from ${JSON.stringify(mcpEntryRuntimeSpecifier)}`);
    expect(source).toContain('serverName: "curator"');
    // The prelude is the shell's first import and the server module a static
    // import after it: the bundler inlines every module ahead of the entry
    // body and a dynamic import's target ahead of the static ones, so only
    // static import order puts the guard and the layer before the server
    // module's own top level (pinned end to end by tests/mcp.test.ts).
    expect(source.startsWith(`${stdioPreludeImport}\n`)).toBe(true);
    expect(stdioPreludeImport).toBe('import "agent-bundle/stdio-prelude";');
    expect(source.indexOf(stdioPreludeImport)).toBeLessThan(source.indexOf('import * as serverModule from "/proj/src/mcp/curator.ts";'));
    // The stdio shell never imports the env-only layer: stdout is its wire.
    expect(source).not.toContain(launchEnvLayerSpecifier);
    expect(source).toContain('loadEntry: async () => serverModule,');
    expect(source).not.toContain('import(');
    expect(source).not.toContain('applyOperatorEnv');
    expect(source).not.toContain('redirectConsoleToStderr');
  });

  it('generates the stdio prelude module: the mcp-entry guard installed first, then the layer with the manifest env defaults (#469)', () => {
    const source = stdioPreludeModuleSource({ API_URL: 'https://api.example' });
    const lines = source.split('\n');
    expect(lines.slice(0, 3)).toEqual([
      "import { fileURLToPath } from 'node:url';",
      'import { applyOperatorEnv, operatorEnvPluginRoot } from "agent-bundle/launch-env";',
      'import { redirectConsoleToStderr } from "agent-bundle/mcp-entry";',
    ]);
    // One guard implementation: the prelude calls the export the lifecycle
    // adopts, and calls it before the layer so nothing after the first
    // statement can reach stdout.
    expect(lines.indexOf('redirectConsoleToStderr();')).toBeLessThan(lines.findIndex((line) => line.startsWith('applyOperatorEnv(')));
    expect(source).toContain(
      'applyOperatorEnv({ manifestEnv: {"API_URL":"https://api.example"}, '
      + "pluginRoot: operatorEnvPluginRoot(fileURLToPath(new URL('..', import.meta.url))) });",
    );
    expect(stdioPreludeVirtualModule({ API_URL: 'https://api.example' })).toEqual({ name: stdioPreludeSpecifier, source });
    expect(stdioPreludeSpecifier).toBe('agent-bundle/stdio-prelude');
  });

  it('gives hook wrappers the env-only layer, never the stdio prelude: stdout is the host envelope there (#469)', () => {
    const entry: TargetHookWrapper = {
      event: 'sessionStart',
      hook: {
        event: 'sessionStart',
        id: 'hook:sessionStart:probe:00000000',
        name: 'probe',
        provenance: { kind: 'config', sourcePath: '/project/agent-bundle.config.ts' },
        source: '/project/src/hooks/probe.ts',
        targets: ['claude'],
        tools: [],
      },
      nativeEvent: 'SessionStart',
      relativePath: 'hooks/sessionStart.mjs',
      target: 'claude',
    };
    for (const source of [
      nativeHookWrapperSource(entry, 'Claude'),
      cursorHookWrapperSource({ ...entry, nativeEvent: 'sessionStart', target: 'cursor' }),
    ]) {
      expect(source.startsWith(`${operatorEnvLayerImport}\n`)).toBe(true);
      expect(source).not.toContain(stdioPreludeSpecifier);
      expect(source).not.toContain('redirectConsoleToStderr');
    }
  });

  it('generates the operator .env layer module with the manifest env defaults it must recognise (#469)', () => {
    // The anchor is the artifact root (the parent of `mcp/`, `hooks/`, `bin/`)
    // unless the host set AGENT_BUNDLE_PLUGIN_ROOT; without manifest env the
    // layer reserves every variable the host set.
    const bare = operatorEnvLayerModuleSource();
    expect(bare).toContain("import { fileURLToPath } from 'node:url';");
    expect(bare).toContain('import { applyOperatorEnv, operatorEnvPluginRoot } from "agent-bundle/launch-env";');
    expect(bare).toContain("applyOperatorEnv({ pluginRoot: operatorEnvPluginRoot(fileURLToPath(new URL('..', import.meta.url))) });");
    expect(operatorEnvLayerModuleSource({})).toBe(bare);
    // A stdio shell's layer embeds its server's manifest `env` block as sorted
    // literals so a passed-through default is told from a host export; path
    // tokens stay unexpanded (the host expands them, so they never match).
    expect(operatorEnvLayerModuleSource({ ZED: 'last', API_URL: 'https://api.example', DATA_DIR: 'agent-bundle:path:plugin-root/data' }))
      .toContain(
        'applyOperatorEnv({ manifestEnv: {"API_URL":"https://api.example","DATA_DIR":"agent-bundle:path:plugin-root/data","ZED":"last"}, '
        + "pluginRoot: operatorEnvPluginRoot(fileURLToPath(new URL('..', import.meta.url))) });",
      );
    expect(operatorEnvLayerVirtualModule({ API_URL: 'x' })).toEqual({
      name: launchEnvLayerSpecifier,
      source: operatorEnvLayerModuleSource({ API_URL: 'x' }),
    });
    expect(operatorEnvLayerImport).toBe('import "agent-bundle/launch-env-layer";');
  });

  it('applies the operator .env layer in every artifact shell that runs plugin code, and only there (#469)', () => {
    const route = {
      config: {},
      id: 'cli:report',
      kind: 'cli' as const,
      provenance: { kind: 'conventional' as const, relativePath: 'src/cli/report.ts' },
      source: '/project/src/cli/report.ts',
    };
    const command = { aliases: [], exitCode: 'zero' as const, options: [], path: ['report'], rendered: false, routeId: 'cli:report' };
    const artifactBin = entryShellModule.generatedCliBinEntrySource({
      commands: [command],
      plugin: { name: 'fixture', version: '1.0.0' },
      routes: [route],
      stateFallback: 'artifact',
    });
    // The env-only layer is the first import, ahead of the route, provider,
    // and state modules, so a module-level `process.env` read in any of them
    // sees the composed environment; the consumer imports themselves stay
    // static. Never the stdio prelude: a CLI bin owns its stdout.
    expect(artifactBin.startsWith(`${operatorEnvLayerImport}\n`)).toBe(true);
    expect(artifactBin).not.toContain(stdioPreludeSpecifier);
    expect(artifactBin).not.toContain('applyOperatorEnv');
    expect(artifactBin).toContain('import * as route0 from "/project/src/cli/report.ts";');
    const durableBin = entryShellModule.generatedCliBinEntrySource({
      commands: [command],
      plugin: { name: 'fixture', version: '1.0.0' },
      providers: [{
        id: 'provider:project-auth',
        name: 'project-auth',
        provenance: { kind: 'conventional', relativePath: 'src/providers/project-auth.ts' },
        source: '/project/src/providers/project-auth.ts',
      }],
      routes: [route],
      state: {
        id: 'project/tasks',
        lifetime: 'workspace-durable',
        provenance: { kind: 'conventional', sourcePath: '/project/src/state.ts' },
        source: '/project/src/state.ts',
      },
      stateFallback: 'artifact',
    });
    expect(durableBin.startsWith(`${operatorEnvLayerImport}\n`)).toBe(true);
    for (const consumer of [
      'import stateDefinition from "/project/src/state.ts";',
      'import * as route0 from "/project/src/cli/report.ts";',
      'import * as provider0 from "/project/src/providers/project-auth.ts";',
    ]) {
      expect(durableBin).toContain(consumer);
    }
    // The npm package bin runs from the operator's own shell and reads no pack file.
    const npmBin = entryShellModule.generatedCliBinEntrySource({
      commands: [command],
      plugin: { name: 'fixture', version: '1.0.0' },
      routes: [route],
    });
    expect(npmBin).not.toContain('agent-bundle/launch-env');
    expect(npmBin).not.toContain('applyOperatorEnv');
  });

  it('conditionally wires the generated web command without changing non-web entry bytes', () => {
    const route = {
      config: {},
      id: 'cli:status',
      kind: 'cli' as const,
      provenance: { kind: 'conventional' as const, relativePath: 'src/cli/status.ts' },
      source: '/project/src/cli/status.ts',
    };
    const command = {
      aliases: [],
      exitCode: 'zero' as const,
      options: [],
      path: ['status'],
      rendered: false,
      routeId: route.id,
    };
    const web = {
      manifestRelativeUrl: '../agent-bundle.manifest.json',
      pluginRootRelativeUrl: '../',
    };
    const routed = entryShellModule.generatedCliBinEntrySource({
      commands: [command],
      plugin: { name: 'fixture', version: '1.0.0' },
      routes: [route],
      stateFallback: 'artifact',
      web,
    });
    expect(routed).toContain('import { runWebCommand } from "agent-bundle/web-host";');
    expect(routed).toContain("import webHostPage from 'agent-bundle/web-host-page';");
    expect(routed).toContain(
      "const pluginRoot = resolvePluginRoot({ fallback: fileURLToPath(new URL(\"../\", import.meta.url)) });",
    );
    expect(routed).toContain('const artifactRoot = fileURLToPath(new URL("../", import.meta.url));');
    expect(routed).toContain([
      '  web: Object.freeze({',
      '    run: (argv, context) => runWebCommand({',
      '      argv,',
      '      manifestPath: fileURLToPath(new URL("../agent-bundle.manifest.json", import.meta.url)),',
      '      pageScript: webHostPage,',
      '      pluginRoot: artifactRoot,',
      '      ...context,',
      '    }),',
      '  }),',
    ].join('\n'));

    const webOnly = entryShellModule.generatedCliBinEntrySource({
      commands: [],
      plugin: { name: 'fixture', version: '1.0.0' },
      routes: [],
      stateFallback: 'artifact',
      web,
    });
    expect(webOnly).toContain('const commands = Object.freeze([]);');
    expect(webOnly).toContain('web: Object.freeze({');
    expect(webOnly).not.toContain('import * as route0');
    // A web-only plugin owes no `@agent-bundle/runtime`: nothing opens a request scope.
    expect(webOnly).not.toContain('@agent-bundle/runtime');
    expect(webOnly).not.toContain('resolvePluginRoot');
    expect(webOnly).toContain('const artifactRoot = fileURLToPath(new URL("../", import.meta.url));');
    expect(routed).toContain('@agent-bundle/runtime');

    // A project's state and providers belong to its request scope; a bin with
    // no command opens none, so the web-only bin mounts neither and their
    // modules cannot keep `<plugin> web` from starting.
    const webOnlyWithState = entryShellModule.generatedCliBinEntrySource({
      commands: [],
      plugin: { name: 'fixture', version: '1.0.0' },
      providers: [{
        id: 'provider:project-auth',
        name: 'project-auth',
        provenance: { kind: 'conventional', relativePath: 'src/providers/project-auth.ts' },
        source: '/project/src/providers/project-auth.ts',
      }],
      routes: [],
      state: {
        id: 'project/tasks',
        lifetime: 'workspace-durable',
        provenance: { kind: 'conventional', sourcePath: '/project/src/state.ts' },
        source: '/project/src/state.ts',
      },
      stateFallback: 'artifact',
      web,
    });
    expect(webOnlyWithState).toBe(webOnly);

    // A routed bin without `web` carries no web wiring: its bytes are those of
    // the generator without #564 (hash of the same input on this commit's
    // `entry-shell.ts`; #596's projection steps and `kind: 'cli'` request
    // moved the pin from the pre-#564 value).
    const withoutWeb = entryShellModule.generatedCliBinEntrySource({
      commands: [command],
      plugin: { name: 'fixture', version: '1.0.0' },
      routes: [route],
      stateFallback: 'artifact',
    });
    expect(createHash('sha256').update(withoutWeb).digest('hex'))
      .toBe('b177c34fc9ef98e972b5f5db1296c01219634572a455796fcae30bfaf070ba72');
    expect(withoutWeb).not.toContain('agent-bundle/web-host');
    expect(withoutWeb).not.toContain('web: Object.freeze({');
  });

  it('generates a process envelope that adopts numeric exit codes and hands main the terminal capability (#511)', () => {
    const source = generatedExecutableEntrySource({ entrySource: '/proj/src/cli.ts', exportName: 'main', hostSurface: 'cli' });
    expect(source).toContain('import * as entry from "/proj/src/cli.ts"');
    expect(source).toContain(`import { detectProcessTerminal } from ${JSON.stringify(entryShellModule.terminalCapabilityRuntimeSpecifier)}`);
    expect(source).toContain('entry["main"]');
    expect(source).toContain('await main(process.argv.slice(2), Object.freeze({ terminal: detectProcessTerminal("cli") }))');
    expect(source).toContain("if (typeof code === 'number') process.exitCode = code;");
    // Artifact scripts default to the `script` surface; the envelope never loads the runtime.
    const script = generatedExecutableEntrySource({ entrySource: '/e.ts', exportName: 'default' });
    expect(script).toContain('entry["default"]');
    expect(script).toContain('detectProcessTerminal("script")');
    expect(script).not.toContain('@agent-bundle/runtime');
  });

  it('locates the dependency-free terminal probe the envelope aliases in', async () => {
    const path = entryShellModule.terminalCapabilityRuntimePath();
    await expect(access(path)).resolves.toBeUndefined();
    expect(path.endsWith('terminal-capability.ts') || path.endsWith('terminal-capability.js')).toBe(true);
  });

  it('routes a rejected progress report into the generated request failure path', async () => {
    const generated = generatedRenderedScriptEntrySource({
      name: 'report',
      routeId: 'script:report',
      workerFile: 'report-flight.mjs',
    });
    const factoryStart = generated.indexOf('const openRenderedSession');
    const factoryEnd = generated.indexOf('\nawait runGeneratedRenderedScriptProcess');
    const factory = generated.slice(factoryStart, factoryEnd)
      .replaceAll('import.meta.url', JSON.stringify(import.meta.url));
    const harness = [
      "import { EventEmitter } from 'node:events';",
      factory,
      'class FakeWorker extends EventEmitter {',
      '  stdout = new EventEmitter();',
      '  stderr = new EventEmitter();',
      '  postMessage(message) {',
      "    if (message.type === 'render') queueMicrotask(() => this.emit('message', { id: message.id, type: 'progress', update: { completed: 1 } }));",
      '  }',
      '  async terminate() { return 0; }',
      '}',
      'const Worker = FakeWorker;',
      'const createAgentRenderDispatcher = (host) => ({',
      '  stream: ({ signal }) => new ReadableStream({',
      '    async start(controller) {',
      '      try {',
      "        const flight = await host.execute({ progress: { report: async () => { throw new Error('progress rejected'); } }, signal });",
      '        await flight.getReader().read();',
      '        controller.close();',
      '      } catch (error) { controller.error(error); }',
      '    },',
      '  }),',
      '});',
      "process.on('unhandledRejection', (error) => process.stderr.write(`UNHANDLED:${error instanceof Error ? error.message : String(error)}\\n`));",
      'const signal = new AbortController().signal;',
      "const session = openRenderedSession({ invocation: {}, props: {}, request: {}, routeId: 'script:report', signal, validate: (value) => value });",
      'try {',
      '  await Promise.race([',
      '    session.events().getReader().read(),',
      "    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 100)),",
      '  ]);',
      "  process.stdout.write('RESOLVED\\n');",
      '} catch (error) {',
      "  process.stdout.write(`REJECTED:${error instanceof Error ? error.message : String(error)}\\n`);",
      '} finally {',
      '  await session.close();',
      '  await new Promise((resolve) => setImmediate(resolve));',
      '}',
    ].join('\n');

    const result = await execFile(process.execPath, ['--input-type=module', '--eval', harness]);
    expect(result).toMatchObject({ stderr: '', stdout: 'REJECTED:progress rejected\n' });
  });
});


it('generates one final-only Flight MCP factory from filesystem routes', () => {
  const generate = (entryShellModule as unknown as {
    readonly generatedRouteMcpEntrySource?: (options: Readonly<Record<string, unknown>>) => string;
  }).generatedRouteMcpEntrySource;
  expect(typeof generate).toBe('function');
  if (generate === undefined) return;

  const source = generate({
    artifactEpoch: 'epoch-1',
    eventRoutes: [{
      event: 'afterTool',
      eventRoute: { event: 'tool/after', fallback: 'none', runtime: 'shared' },
      id: 'hook:event-route:tool-after',
      name: 'event-route-tool-after',
      provenance: { kind: 'conventional', sourcePath: '/project/src/events/tool/after.tsx' },
      source: '/project/src/events/tool/after.tsx',
      targets: ['claude'],
      tools: [],
    }],
    plugin: { name: 'route-fixture', version: '1.2.3' },
    routes: [
      {
        config: { annotations: { readOnlyHint: true }, description: 'Inspect sources.' },
        id: 'tool:curator/inspect',
        kind: 'tool',
        source: '/project/src/mcp/curator/tools/inspect.tsx',
      },
      {
        config: { description: 'Catalog.', mimeType: 'application/json', uri: 'catalog://books' },
        id: 'resource:curator/catalog',
        kind: 'resource',
        source: '/project/src/mcp/curator/resources/catalog.tsx',
      },
      {
        config: { description: 'Curate books.' },
        id: 'prompt:curator/curate',
        kind: 'prompt',
        source: '/project/src/mcp/curator/prompts/curate.tsx',
      },
    ],
    serverName: 'curator',
    allowedTargets: ['claude', 'codex'],
    hosts: ['claude'],
    workerFile: 'mcp-curator-flight.mjs',
  });

  // The entry is the compiled data — route table, App registry, worker URL,
  // artifact epoch — handed to the shared server runtime. Registration,
  // projection, and the warm host live in agent-bundle/mcp-server-runtime so
  // the in-memory projection proof level exercises this artifact's code
  // rather than a second copy of it (#103 stage 2).
  expect(source).toContain(`from ${JSON.stringify(mcpServerRuntimeSpecifier)}`);
  expect(source).toContain("from 'agent-bundle/mcp-apps'");
  expect(source).toContain('import * as route0 from "/project/src/mcp/curator/tools/inspect.tsx"');
  expect(source).toContain('const ARTIFACT_EPOCH = "route-fixture@1.2.3"');
  expect(source).toContain('"tool:curator/inspect": Object.freeze({ config: {"annotations":{"readOnlyHint":true}');
  expect(source).toContain('"resource:curator/catalog"');
  expect(source).toContain('"prompt:curator/curate"');
  expect(source).toContain('createFlightWorkerHost(new URL("./mcp-curator-flight.mjs", import.meta.url), ARTIFACT_EPOCH)');
  expect(source).toContain('artifactEpoch: ARTIFACT_EPOCH');
  expect(source).toContain('plugin: {"name":"route-fixture","version":"1.2.3"}');
  expect(source).toContain('export default async () => {');
  expect(source).toContain('return createGeneratedRouteMcpServer({');
  // The lineage registry journals through the sqlite kernel beside project
  // state and degrades to memory when the store cannot open (#host-lineage).
  expect(source).toContain("from '@agent-bundle/runtime/lineage'");
  expect(source).toContain('lineage: lineage.registry,');
  expect(source).toContain('disposeLineage: lineage.dispose,');
  // A project without workspace-durable state keeps a process-lifetime
  // registry: no sqlite import, no `state/` directory inside the artifact.
  expect(source).not.toContain('node:sqlite');
  expect(source).not.toContain('createSqliteStateDriver');
  // The event runtime's modules are aliased into the artifact, so the entry
  // imports them and hands them to the shared runtime; the wiring itself is
  // not re-templated here.
  expect(source).toContain('createEventRuntimeServer,');
  expect(source).toContain('projectEventDocument,');
  // The endpoint is the artifact's identity alone (epoch + root); the hosts
  // that may deliver events ride separately as the allowed set (#592).
  expect(source).toContain('endpointId: `${EVENT_ARTIFACT_EPOCH}:${dirname(dirname(resolve(process.argv[1])))}`');
  // The hosts whose wrappers the shared runtime accepts and the hosts that can
  // have launched this entry are two sets: a Claude-only server in a
  // Claude+Codex root hosts the runtime for both, yet only Claude spawns it.
  expect(source).toContain('const EVENT_ALLOWED_TARGETS = Object.freeze(["claude","codex"]);');
  expect(source).toContain('const EVENT_HOSTS = Object.freeze(["claude"]);');
  expect(source).toContain('  hosts: EVENT_HOSTS,');
  expect(source).not.toContain('EVENT_TARGET ');
  expect(source).toContain('events,');
  // Nothing else the shared runtime owns may be re-templated here.
  expect(source).not.toContain('server.register');
  expect(source).not.toContain('projectMcpRenderStream');
  expect(source).not.toContain('new Worker(');
  expect(source).not.toContain("kind: 'event'");
  expect(source).not.toContain('lowerMcpResult');
});

it('keeps the generated server behaviour in the shared runtime module the entry aliases', async () => {
  const runtime = await readFile(mcpServerRuntimePath(), 'utf8');

  expect(runtime).toContain('createWarmFlightHost');
  expect(runtime).toContain('projectMcpRenderStream');
  expect(runtime).toContain('attachMcpStructuredContent');
  expect(runtime).toContain('runAgentRequest');
  expect(runtime).toContain('notifications/progress');
  expect(runtime).toContain('{ stderr: true, stdout: true }');
  expect(runtime).toContain('server.registerTool');
  expect(runtime).toContain('server.registerResource');
  expect(runtime).toContain('server.registerPrompt');
  expect(runtime).toContain('createEventRuntimeServer(');
  expect(runtime).toContain('projectEventDocument(');
  expect(runtime).toContain('requestInvocation: context.invocation');
  expect(runtime).toContain('host: context.host');
  expect(runtime).toContain('workspace: context.workspace');
});

it('fails the build on an MCP route the generated server cannot register', () => {
  const generate = entryShellModule.generatedRouteMcpEntrySource;
  const entry = (routes: readonly Readonly<Record<string, unknown>>[]): string => generate({
    plugin: { name: 'route-fixture', version: '1.2.3' },
    routes: routes as never,
    serverName: 'curator',
    workerFile: 'mcp-curator-flight.mjs',
  });

  expect(() => entry([{
    config: {},
    id: 'resource:curator/catalog',
    kind: 'resource',
    source: '/project/src/mcp/curator/resources/catalog.tsx',
  }])).toThrow('non-empty static config.uri');
  expect(() => entry([{
    config: {},
    id: 'cli:migrate',
    kind: 'cli',
    source: '/project/src/cli/migrate.tsx',
  }])).toThrow('non-MCP route');
  expect(() => generate({
    plugin: { name: 'route-fixture', version: '1.2.3' },
    routes: [{
      config: {},
      id: 'tool:curator/notice-inbox',
      kind: 'tool',
      provenance: { kind: 'conventional', relativePath: 'src/mcp/curator/tools/notice-inbox.tsx' },
      source: '/project/src/mcp/curator/tools/notice-inbox.tsx',
    }],
    serverName: 'curator',
    state: {
      id: 'project/tasks',
      lifetime: 'process',
      provenance: { kind: 'conventional', sourcePath: '/project/src/state.ts' },
      source: '/project/src/state.ts',
    },
    workerFile: 'mcp-curator-flight.mjs',
  })).toThrow('reserved protocol name');
  expect(() => generate({
    plugin: { name: 'route-fixture', version: '1.2.3' },
    routes: [{
      config: { uri: 'agent-bundle://notices/inbox' },
      id: 'resource:curator/other',
      kind: 'resource',
      provenance: { kind: 'conventional', relativePath: 'src/mcp/curator/resources/other.tsx' },
      source: '/project/src/mcp/curator/resources/other.tsx',
    }],
    serverName: 'curator',
    state: {
      id: 'project/tasks',
      lifetime: 'process',
      provenance: { kind: 'conventional', sourcePath: '/project/src/state.ts' },
      source: '/project/src/state.ts',
    },
    workerFile: 'mcp-curator-flight.mjs',
  })).toThrow('reserved URI');
});


it('journals the lineage registry through sqlite only for workspace-durable projects', () => {
  const source = entryShellModule.generatedRouteMcpEntrySource({
    plugin: { name: 'route-fixture', version: '1.2.3' },
    routes: [{
      config: {},
      id: 'tool:curator/inspect',
      kind: 'tool',
      provenance: { kind: 'conventional', relativePath: 'src/mcp/curator/tools/inspect.tsx' },
      source: '/project/src/mcp/curator/tools/inspect.tsx',
    }],
    serverName: 'curator',
    state: {
      id: 'project/tasks',
      lifetime: 'workspace-durable',
      provenance: { kind: 'conventional', sourcePath: '/project/src/state.ts' },
      source: '/project/src/state.ts',
    },
    workerFile: 'mcp-curator-flight.mjs',
  });
  expect(source).toContain("import { agentLineageStateDefinition, createAgentLineageRegistry } from '@agent-bundle/runtime/lineage'");
  expect(source).toContain("import { createSqliteStateDriver } from '@agent-bundle/runtime/state/sqlite'");
  // One anchor per process (#468): the lineage journal opens on the same
  // `pluginRoot` the server publishes as `request.plugin` and mounts state on.
  expect(source).toContain("const pluginRoot = resolvePluginRoot({ fallback: fileURLToPath(new URL('..', import.meta.url)) });");
  expect(source).toContain('createSqliteStateDriver({ root: pluginRoot.stateRoot })');
  expect(source).toContain('    pluginRoot: pluginRoot.identity,');
  expect(source).not.toContain('AGENT_BUNDLE_PLUGIN_ROOT');
  expect(source).toContain('agent-bundle lineage registry is in-memory only');
  expect(source).toContain('disposeLineage: lineage.dispose,');
});

it('generates the warm react-server Flight worker separately from the MCP dispatcher', () => {
  const generate = (entryShellModule as unknown as {
    readonly generatedRouteFlightWorkerSource?: (options: Readonly<Record<string, unknown>>) => string;
  }).generatedRouteFlightWorkerSource;
  expect(typeof generate).toBe('function');
  if (generate === undefined) return;
  const source = generate({
    artifactEpoch: 'route-fixture@1.2.3',
    eventRoutes: [{
      event: 'afterTool',
      eventRoute: { event: 'tool/after', fallback: 'none', runtime: 'shared' },
      id: 'hook:event-route:tool-after',
      name: 'event-route-tool-after',
      provenance: { kind: 'conventional', sourcePath: '/project/src/events/tool/after.tsx' },
      source: '/project/src/events/tool/after.tsx',
      targets: ['claude'],
      tools: [],
    }],
    routes: [{
      config: {},
      id: 'tool:curator/inspect',
      kind: 'tool',
      source: '/project/src/mcp/curator/tools/inspect.tsx',
    }],
    serverName: 'curator',
  });
  expect(source).toContain("from '@agent-bundle/runtime/flight/server'");
  expect(source).toContain("from 'node:worker_threads'");
  expect(source).toContain('runAgentRequest');
  expect(source).toContain('processLifetime');
  expect(source).toContain('route-fixture@1.2.3');
  expect(source).toContain('/project/src/mcp/curator/tools/inspect.tsx');
  expect(source).toContain('/project/src/events/tool/after.tsx');
  expect(source).toContain("message.invocation.kind === 'event'");
  // The worker resolves the event route by its hook identity but mounts the
  // compiled route id as `operationId`, the same id the hook shell, the
  // lifecycle replay, and the test harness use for that route.
  expect(source).toContain(
    '"hook:event-route:tool-after": Object.freeze({ event: "tool/after", id: "event:tool/after", kind: \'event-route\'',
  );
  expect(source).toContain("lineage: message.lineage ?? unavailable('not-provided'),");
  expect(source).toContain("terminal: message.terminal ?? unavailable('not-provided'),");
  expect(createHash('sha256').update(source).digest('hex')).toBe(
    '93cdfe64b98e0add920ed3f4daa3916620a3f750ec9dbcefc6be6419efab38e5',
  );
  expect(generate({
    artifactEpoch: 'route-fixture@1.2.3',
    eventRoutes: [{
      event: 'afterTool',
      eventRoute: { event: 'tool/after', fallback: 'none', runtime: 'shared' },
      id: 'hook:event-route:tool-after',
      name: 'event-route-tool-after',
      provenance: { kind: 'conventional', sourcePath: '/project/src/events/tool/after.tsx' },
      source: '/project/src/events/tool/after.tsx',
      targets: ['claude'],
      tools: [],
    }],
    providers: [],
    routes: [{
      config: {},
      id: 'tool:curator/inspect',
      kind: 'tool',
      source: '/project/src/mcp/curator/tools/inspect.tsx',
    }],
    serverName: 'curator',
  })).toBe(source);
});

it('generates bulk-projected MCP commands with the CLI invocation and preserves the tool route layout', () => {
  const route = {
    config: { annotations: { readOnlyHint: true } },
    id: 'tool:curator/read_item',
    kind: 'tool' as const,
    provenance: { kind: 'conventional' as const, relativePath: 'src/mcp/curator/tools/read_item.tsx' },
    serverId: 'mcp:curator',
    source: '/project/src/mcp/curator/tools/read_item.tsx',
  };
  const source = entryShellModule.generatedCliBinEntrySource({
    commands: [{
      aliases: [],
      exitCode: 'zero',
      mcp: { confirm: false, server: 'curator', tool: 'read_item' },
      options: [{
        description: 'Tool input as one JSON object.',
        key: 'input',
        kind: 'string',
        option: 'input',
        repeated: false,
        required: false,
      }],
      path: ['curator', 'read_item'],
      rendered: true,
      routeId: route.id,
    }],
    plugin: { name: 'route-fixture', version: '1.2.3' },
    routes: [route],
    workerFile: 'route-fixture-flight.mjs',
  });

  expect(source).toContain('import * as route0 from "/project/src/mcp/curator/tools/read_item.tsx"');
  expect(source).toContain("invocation: { kind: 'cli', props: { args: context.args, command: command.path.join(' ') } }");
  expect(source).toContain("request: { kind: 'cli', operationId: command.routeId, surface: command.path.join(' ') }");
  expect(source).toContain('props: { input: parsed }');
  // The worker mounts providers from `message.invocation`, so the render
  // message must carry the dispatched invocation (#319 review) and the
  // executable's probed terminal (#511).
  expect(source).toContain("worker.postMessage({ id, invocation, props, request, routeId, terminal, type: 'render' })");
  expect(source).toContain('terminal: context.terminal,');
});

it('imports explicit CLI projections and maps their input before canonical validation', () => {
  const route = {
    config: {},
    id: 'tool:curator/submit',
    kind: 'tool' as const,
    provenance: { kind: 'conventional' as const, relativePath: 'src/mcp/curator/tools/submit.tsx' },
    serverId: 'mcp:curator',
    source: '/project/src/mcp/curator/tools/submit.tsx',
  };
  const source = entryShellModule.generatedCliBinEntrySource({
    commands: [{
      aliases: [],
      exitCode: 'zero',
      mcp: { confirm: true, server: 'curator', tool: 'submit' },
      options: [
        {
          defaultValue: '.',
          key: 'cwd',
          kind: 'string',
          option: 'cwd',
          repeated: false,
          required: false,
        },
        {
          defaultValue: 'main',
          key: 'laneKey',
          kind: 'string',
          option: 'lane',
          repeated: false,
          required: false,
        },
        {
          key: 'yes',
          kind: 'boolean',
          option: 'yes',
          repeated: false,
          required: false,
        },
      ],
      path: ['submit'],
      projection: {
        defaults: { laneKey: 'main' },
        mapInput: true,
        module: 'src/mcp/curator/tools/submit.cli.ts',
        relaxed: ['laneKey'],
      },
      rendered: true,
      routeId: route.id,
    }],
    plugin: { name: 'route-fixture', version: '1.2.3' },
    projectionSources: {
      [route.id]: '/project/src/mcp/curator/tools/submit.cli.ts',
    },
    routes: [route],
    workerFile: 'route-fixture-flight.mjs',
  });

  expect(source).toContain('import * as projection0 from "/project/src/mcp/curator/tools/submit.cli.ts";');
  expect(source).toContain(
    '"tool:curator/submit": Object.freeze({ module: route0, projection: projection0 })',
  );
  const defaults = source.indexOf('for (const [key, value] of Object.entries(command.projection.defaults))');
  const mapping = source.indexOf('mapped = route.projection.mapInput(mapped)');
  const validation = source.indexOf('return route.module.inputSchema.parse(mapped)');
  expect(source).not.toContain('command.mcp?.confirm');
  expect(source).not.toContain('confirmationRequiredMessage');
  expect(source).not.toContain('delete mapped.yes');
  expect(defaults).toBeGreaterThan(-1);
  expect(defaults).toBeLessThan(mapping);
  expect(mapping).toBeLessThan(validation);
  expect(source).toContain('if (!Object.hasOwn(mapped, key)) mapped[key] = value;');
  expect(source).not.toContain("Object.hasOwn(option, 'defaultValue')");
  expect(source).toContain("throw new TypeError(`CLI projection ${command.projection.module} for ${command.routeId} must export a mapInput function.`)");
  expect(source).toContain('throw new CliInputError(error instanceof Error ? error.message : String(error));');
  expect(source).toContain(
    "invocation: { kind: 'cli', props: { args: context.args, command: command.path.join(' ') } }",
  );
  expect(source).toContain(
    "request: { kind: 'cli', operationId: command.routeId, surface: command.path.join(' ') }",
  );
});

it('mounts the shell-probed terminal on every routed-CLI surface and forwards it under MCP and hooks (#511)', () => {
  const plainRoute = {
    config: {},
    id: 'cli:doctor',
    kind: 'cli' as const,
    provenance: { kind: 'conventional' as const, relativePath: 'src/cli/doctor.ts' },
    source: '/project/src/cli/doctor.ts',
  };
  const bin = entryShellModule.generatedCliBinEntrySource({
    commands: [{ aliases: [], exitCode: 'zero', options: [], path: ['doctor'], rendered: false, routeId: plainRoute.id }],
    plugin: { name: 'route-fixture', version: '1.2.3' },
    routes: [plainRoute],
  });
  // Plain commands run in the executable itself: the shell's probe is the value.
  expect(bin).toContain("terminal: available(context.terminal, 'native'),");

  const worker = entryShellModule.generatedRenderedRouteWorkerSource({ routes: [plainRoute] });
  // A worker thread's own streams are pipes to the parent; it must never probe them.
  expect(worker).toContain("terminal: message.terminal === undefined ? unavailable('not-provided') : available(message.terminal, 'native'),");
  expect(worker).not.toContain('detectProcessTerminal');

  const flightWorker = entryShellModule.generatedRouteFlightWorkerSource({
    artifactEpoch: 'route-fixture@1.2.3',
    routes: [],
    serverName: 'curator',
  });
  // The MCP host scope says `none`; the Flight worker forwards rather than guesses.
  expect(flightWorker).toContain("terminal: message.terminal ?? unavailable('not-provided'),");
  expect(flightWorker).not.toContain('process.stdout.isTTY');
});

it('forwards the dispatched invocation to the rendered worker in every rendered surface', async () => {
  const generated = generatedRenderedScriptEntrySource({
    name: 'report',
    routeId: 'script:report',
    workerFile: 'report-flight.mjs',
  });
  expect(generated).toContain("worker.postMessage({ id, invocation, props, request, routeId, terminal, type: 'render' })");
  expect(generated).toContain('terminal: context.terminal,');
  const factoryStart = generated.indexOf('const openRenderedSession');
  const factoryEnd = generated.indexOf('\nawait runGeneratedRenderedScriptProcess');
  const factory = generated.slice(factoryStart, factoryEnd)
    .replaceAll('import.meta.url', JSON.stringify(import.meta.url));
  const harness = [
    "import { EventEmitter } from 'node:events';",
    factory,
    'class FakeWorker extends EventEmitter {',
    '  stdout = new EventEmitter();',
    '  stderr = new EventEmitter();',
    '  postMessage(message) {',
    "    if (message.type !== 'render') return;",
    "    process.stdout.write(`POSTED:${JSON.stringify(message.invocation)}\\n`);",
    "    queueMicrotask(() => this.emit('message', { id: message.id, type: 'end' }));",
    '  }',
    '  async terminate() { return 0; }',
    '}',
    'const Worker = FakeWorker;',
    // The real dispatcher hands host.execute the invocation from stream().
    'const createAgentRenderDispatcher = (host) => ({',
    '  stream: ({ invocation, signal }) => new ReadableStream({',
    '    async start(controller) {',
    '      try {',
    '        const flight = await host.execute({ invocation, progress: undefined, signal });',
    '        await flight.getReader().read();',
    '        controller.close();',
    '      } catch (error) { controller.error(error); }',
    '    },',
    '  }),',
    '});',
    'const signal = new AbortController().signal;',
    "const session = openRenderedSession({ invocation: { kind: 'script', props: { input: ['a'], name: 'report' } }, props: {}, request: {}, routeId: 'script:report', signal, validate: (value) => value });",
    'await session.events().getReader().read();',
    'await session.close();',
  ].join('\n');

  const result = await execFile(process.execPath, ['--input-type=module', '--eval', harness]);
  expect(result).toMatchObject({
    stderr: '',
    stdout: 'POSTED:{"kind":"script","props":{"input":["a"],"name":"report"}}\n',
  });
});

it('generates deterministic per-request provider execution in the shared Flight worker', () => {
  const source = entryShellModule.generatedRouteFlightWorkerSource({
    artifactEpoch: 'route-fixture@1.2.3',
    providers: [
      {
        id: 'provider:zeta',
        name: 'zeta',
        provenance: { kind: 'conventional', relativePath: 'src/providers/zeta.ts' },
        source: '/project/src/providers/zeta.ts',
      },
      {
        id: 'provider:alpha-value',
        name: 'alpha-value',
        provenance: { kind: 'conventional', relativePath: 'src/providers/alpha-value.ts' },
        source: '/project/src/providers/alpha-value.ts',
      },
    ],
    routes: [{
      config: {},
      id: 'tool:curator/inspect',
      kind: 'tool',
      provenance: { kind: 'conventional', relativePath: 'src/mcp/curator/tools/inspect.tsx' },
      source: '/project/src/mcp/curator/tools/inspect.tsx',
    }],
    serverName: 'curator',
  });

  expect(source).toContain('import * as provider0 from "/project/src/providers/alpha-value.ts"');
  expect(source).toContain('import * as provider1 from "/project/src/providers/zeta.ts"');
  expect(source.indexOf('/project/src/providers/alpha-value.ts')).toBeLessThan(
    source.indexOf('/project/src/providers/zeta.ts'),
  );
  expect(source).toContain('key: "alphaValue"');
  expect(source).toContain('await provider.module.default({ ...request, invocation: message.invocation })');
  // The server's observed anchor rides each render message; the worker's own
  // resolution backs it, and the request view hands the same value to providers.
  expect(source).toContain('const plugin = message.plugin ?? pluginRoot.identity;');
  expect(source).toContain('Context provider "');
  expect(source).toContain('provider.source');
  expect(source).toContain('providers: async (request) => {');
  expect(source).toContain('return providerValues;');
});

it('imports only the deterministic union selected by event routes and emits per-route provider lists', () => {
  const providers = [
    {
      id: 'provider:zeta',
      name: 'zeta',
      provenance: { kind: 'conventional' as const, relativePath: 'src/providers/zeta.ts' },
      source: '/project/src/providers/zeta.ts',
    },
    {
      id: 'provider:beta',
      name: 'beta',
      provenance: { kind: 'conventional' as const, relativePath: 'src/providers/beta.ts' },
      source: '/project/src/providers/beta.ts',
    },
    {
      id: 'provider:alpha-value',
      name: 'alpha-value',
      provenance: { kind: 'conventional' as const, relativePath: 'src/providers/alpha-value.ts' },
      source: '/project/src/providers/alpha-value.ts',
    },
  ];
  const source = entryShellModule.generatedRouteFlightWorkerSource({
    artifactEpoch: 'route-fixture@1.2.3',
    eventRoutes: [
      {
        event: 'afterTool',
        eventRoute: {
          event: 'tool/after',
          fallback: 'none',
          providers: ['alphaValue'],
          runtime: 'shared',
        },
        id: 'hook:event-route:tool-after',
        name: 'event-route-tool-after',
        provenance: { kind: 'conventional', sourcePath: '/project/src/events/tool/after.tsx' },
        source: '/project/src/events/tool/after.tsx',
        targets: ['claude'],
        tools: [],
      },
      {
        event: 'sessionStart',
        eventRoute: {
          event: 'session/start',
          fallback: 'none',
          providers: [],
          runtime: 'shared',
        },
        id: 'hook:event-route:session-start',
        name: 'event-route-session-start',
        provenance: { kind: 'conventional', sourcePath: '/project/src/events/session/start.tsx' },
        source: '/project/src/events/session/start.tsx',
        targets: ['claude'],
        tools: [],
      },
    ],
    providers,
    routes: [],
    serverName: 'curator',
  });

  expect(source).toContain('import * as provider0 from "/project/src/providers/alpha-value.ts"');
  expect(source).not.toContain('/project/src/providers/beta.ts');
  expect(source).not.toContain('/project/src/providers/zeta.ts');
  expect(source).toContain(
    '"hook:event-route:tool-after": Object.freeze({ event: "tool/after", id: "event:tool/after", kind: \'event-route\', module: route0, name: "tool/after", providers: Object.freeze([providers[0]]) })',
  );
  expect(source).toContain(
    '"hook:event-route:session-start": Object.freeze({ event: "session/start", id: "event:session/start", kind: \'event-route\', module: route1, name: "session/start", providers: Object.freeze([]) })',
  );
  expect(source).toContain('for (const provider of route.providers ?? providers)');
});

it('keeps all-provider compatibility for MCP and undeclared event routes beside selected events', () => {
  const providers = [
    {
      id: 'provider:zeta',
      name: 'zeta',
      provenance: { kind: 'conventional' as const, relativePath: 'src/providers/zeta.ts' },
      source: '/project/src/providers/zeta.ts',
    },
    {
      id: 'provider:alpha-value',
      name: 'alpha-value',
      provenance: { kind: 'conventional' as const, relativePath: 'src/providers/alpha-value.ts' },
      source: '/project/src/providers/alpha-value.ts',
    },
  ];
  const eventRoute = {
    event: 'afterTool' as const,
    eventRoute: {
      event: 'tool/after' as const,
      fallback: 'none' as const,
      providers: ['zeta'],
      runtime: 'shared' as const,
    },
    id: 'hook:event-route:tool-after',
    name: 'event-route-tool-after',
    provenance: { kind: 'conventional' as const, sourcePath: '/project/src/events/tool/after.tsx' },
    source: '/project/src/events/tool/after.tsx',
    targets: ['claude'],
    tools: [],
  };
  const source = entryShellModule.generatedRouteFlightWorkerSource({
    artifactEpoch: 'route-fixture@1.2.3',
    eventRoutes: [
      eventRoute,
      {
        ...eventRoute,
        event: 'sessionStart',
        eventRoute: { event: 'session/start', fallback: 'none', runtime: 'shared' },
        id: 'hook:event-route:session-start',
        name: 'event-route-session-start',
        source: '/project/src/events/session/start.tsx',
      },
    ],
    providers,
    routes: [{
      config: {},
      id: 'tool:curator/inspect',
      kind: 'tool',
      provenance: { kind: 'conventional', relativePath: 'src/mcp/curator/tools/inspect.tsx' },
      source: '/project/src/mcp/curator/tools/inspect.tsx',
    }],
    serverName: 'curator',
  });

  expect(source).toContain('import * as provider0 from "/project/src/providers/alpha-value.ts"');
  expect(source).toContain('import * as provider1 from "/project/src/providers/zeta.ts"');
  expect(source).toContain('name: "tool/after", providers: Object.freeze([providers[1]])');
  expect(source).not.toContain('name: "session/start", providers:');
  expect(source).toContain('for (const provider of route.providers ?? providers)');

  const inboxSource = entryShellModule.generatedRouteFlightWorkerSource({
    artifactEpoch: 'route-fixture@1.2.3',
    eventRoutes: [eventRoute],
    noticeDelivery: claudeAdapter.noticeDelivery!,
    providers,
    routes: [],
    serverName: 'curator',
    state: {
      id: 'project/tasks',
      lifetime: 'process',
      provenance: { kind: 'conventional', sourcePath: '/project/src/state.ts' },
      source: '/project/src/state.ts',
    },
  });
  expect(inboxSource).toContain('import * as provider0 from "/project/src/providers/alpha-value.ts"');
  expect(inboxSource).toContain('import * as provider1 from "/project/src/providers/zeta.ts"');

  expect(() => entryShellModule.generatedRouteFlightWorkerSource({
    artifactEpoch: 'route-fixture@1.2.3',
    eventRoutes: [{
      ...eventRoute,
      eventRoute: { ...eventRoute.eventRoute, providers: ['missing'] },
    }],
    providers,
    routes: [],
    serverName: 'curator',
  })).toThrow('invalid provider selection');
});

it('mounts deterministic per-request providers for plain routed CLI commands (#313)', () => {
  const route = {
    config: {},
    id: 'cli:doctor',
    kind: 'cli' as const,
    provenance: { kind: 'conventional' as const, relativePath: 'src/cli/doctor.ts' },
    source: '/project/src/cli/doctor.ts',
  };
  const command = {
    aliases: [],
    exitCode: 'zero' as const,
    options: [],
    path: ['doctor'],
    rendered: false,
    routeId: route.id,
  };
  const withProviders = entryShellModule.generatedCliBinEntrySource({
    commands: [command],
    plugin: { name: 'route-fixture', version: '1.2.3' },
    providers: [
      {
        id: 'provider:zeta',
        name: 'zeta',
        provenance: { kind: 'conventional', relativePath: 'src/providers/zeta.ts' },
        source: '/project/src/providers/zeta.ts',
      },
      {
        id: 'provider:alpha-value',
        name: 'alpha-value',
        provenance: { kind: 'conventional', relativePath: 'src/providers/alpha-value.ts' },
        source: '/project/src/providers/alpha-value.ts',
      },
    ],
    routes: [route],
  });

  // Same registry, ordering, invocation contract, and fail-closed wrapping as the Flight workers.
  expect(withProviders).toContain('import * as provider0 from "/project/src/providers/alpha-value.ts"');
  expect(withProviders).toContain('import * as provider1 from "/project/src/providers/zeta.ts"');
  expect(withProviders.indexOf('/project/src/providers/alpha-value.ts')).toBeLessThan(
    withProviders.indexOf('/project/src/providers/zeta.ts'),
  );
  expect(withProviders).toContain('key: "alphaValue"');
  expect(withProviders).toContain(
    "await provider.module.default({ ...request, invocation: { kind: 'cli', props: { args: context.args, command: command.path.join(' ') } } })",
  );
  expect(withProviders).toContain('must default-export a factory.');
  expect(withProviders).toContain('failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error })');
  // Providers run once per request as the request's own resolver (#459): the
  // loop is the `providers` field of the `runAgentRequest` init, so the runtime
  // runs it after the identity axes are frozen and the notice lease is open.
  expect(withProviders).toContain('providers: async (request) => {');
  expect(withProviders.indexOf('const result = await runAgentRequest({')).toBeLessThan(
    withProviders.indexOf('for (const provider of providers)'),
  );
  expect(withProviders.indexOf('for (const provider of providers)')).toBeLessThan(
    withProviders.indexOf('}, async () => route.module.default('),
  );
  // The request's hit is claimed and snapshotted in one synchronous step
  // before any await, so concurrent requests cannot move each other's value.
  expect(withProviders).toContain(
    'processLifetime.hits += 1;\n  const processHit = { hits: processLifetime.hits, instanceId: processLifetime.instanceId, pid: processLifetime.pid };',
  );
  expect(withProviders).toContain('const providerValues = { processLifetime: processHit };');

  // A project without providers still mounts only the framework-owned process identity.
  const withoutProviders = entryShellModule.generatedCliBinEntrySource({
    commands: [command],
    plugin: { name: 'route-fixture', version: '1.2.3' },
    routes: [route],
  });
  expect(withoutProviders).not.toContain('const providers = Object.freeze([');
  expect(withoutProviders).toContain('providers: { processLifetime: processHit },');
  expect(withoutProviders).not.toContain('import * as provider0');
});

it('mounts deterministic per-request providers in rendered route workers', () => {
  const source = entryShellModule.generatedRenderedRouteWorkerSource({
    providers: [
      {
        id: 'provider:zeta',
        name: 'zeta',
        provenance: { kind: 'conventional', relativePath: 'src/providers/zeta.ts' },
        source: '/project/src/providers/zeta.ts',
      },
      {
        id: 'provider:alpha-value',
        name: 'alpha-value',
        provenance: { kind: 'conventional', relativePath: 'src/providers/alpha-value.ts' },
        source: '/project/src/providers/alpha-value.ts',
      },
    ],
    routes: [{
      config: {},
      id: 'tool:curator/inspect',
      kind: 'tool',
      provenance: { kind: 'conventional', relativePath: 'src/mcp/curator/tools/inspect.tsx' },
      source: '/project/src/mcp/curator/tools/inspect.tsx',
    }],
  });

  expect(source).toContain('import * as provider0 from "/project/src/providers/alpha-value.ts"');
  expect(source).toContain('import * as provider1 from "/project/src/providers/zeta.ts"');
  expect(source.indexOf('/project/src/providers/alpha-value.ts')).toBeLessThan(
    source.indexOf('/project/src/providers/zeta.ts'),
  );
  expect(source).toContain('await provider.module.default({ ...request, invocation: message.invocation })');
  expect(source).toContain('providers: async (request) => {');
  expect(source).toContain('processLifetime');

  // The rendered-session bridge must post the invocation the worker's
  // providers read; without it every rendered provider saw `undefined` (#313).
  const bridge = entryShellModule.generatedRenderedScriptEntrySource({
    name: 'report',
    routeId: 'script:report',
    workerFile: 'report-flight.mjs',
  });
  expect(bridge).toContain("worker.postMessage({ id, invocation, props, request, routeId, terminal, type: 'render' })");
});

it('keeps the generated provider loop and the in-process execution helper identical', async () => {
  const providers = [
    {
      id: 'provider:zeta',
      name: 'zeta',
      provenance: { kind: 'conventional' as const, relativePath: 'src/providers/zeta.ts' },
      source: '/project/src/providers/zeta.ts',
    },
    {
      id: 'provider:alpha-value',
      name: 'alpha-value',
      provenance: { kind: 'conventional' as const, relativePath: 'src/providers/alpha-value.ts' },
      source: '/project/src/providers/alpha-value.ts',
    },
  ];
  const source = entryShellModule.generatedRenderedRouteWorkerSource({
    providers,
    routes: [{
      config: {},
      id: 'cli:report',
      kind: 'cli',
      provenance: { kind: 'conventional', relativePath: 'src/cli/report.tsx' },
      source: '/project/src/cli/report.tsx',
    }],
  });

  // Ordering: the harness manifest and the generated registry sort identically.
  expect(orderedProviders(providers).map((provider) => provider.name)).toEqual(['alpha-value', 'zeta']);
  expect(source.indexOf('key: "alphaValue"')).toBeLessThan(source.indexOf('key: "zeta"'));

  // Messages: the generated template literals evaluate to the helper's text.
  const evaluate = (template: string, bindings: Record<string, string>): string =>
    template.replaceAll(/\$\{([^}]+)\}/gu, (_match, expression: string) => bindings[expression] ?? `<${expression}>`);
  const missing = /throw new TypeError\(`([^`]+)`\)/u.exec(source)?.[1];
  const failed = /throw new Error\(`([^`]+)`, \{ cause: error \}\)/u.exec(source)?.[1];
  expect(missing).toBeDefined();
  expect(failed).toBeDefined();
  expect(evaluate(missing!, { 'provider.key': 'alphaValue', 'provider.source': 'src/providers/alpha-value.ts' }))
    .toBe(providerFactoryMissingMessage('alphaValue', 'src/providers/alpha-value.ts'));
  expect(evaluate(failed!, {
    'error instanceof Error ? error.message : String(error)': 'boom',
    'provider.key': 'alphaValue',
    'provider.source': 'src/providers/alpha-value.ts',
  })).toBe(providerFailedMessage('alphaValue', 'src/providers/alpha-value.ts', new Error('boom')));

  // Behavior: processLifetime seeded first, deterministic order, fail-closed on both defects,
  // and the request view spread onto the factory context beside the surface invocation (#459).
  const lifetime = { hits: 3, instanceId: 'instance-1', pid: 42 };
  const signal = new AbortController().signal;
  // The runtime omits `notices`/`state` when the request mounted none; here state is mounted, notices not.
  const plugin = { source: 'derived', state: 'available', value: { root: '/plugin', stateRoot: '/plugin/state' } } as const;
  const request = {
    host: { source: 'native', state: 'available', value: { name: 'claude' } },
    lineage: { reason: 'not-provided', state: 'unavailable' },
    plugin,
    session: { reason: 'not-provided', state: 'unavailable' },
    signal,
    state: { lifetime: 'request', read: async () => ({ revision: 0, state: {} }) },
    workspace: { source: 'derived', state: 'available', value: { root: '/w' } },
  } as const;
  const calls: string[] = [];
  const values = await executeProviders({
    invocation: { kind: 'cli', props: { args: [], command: 'report' } },
    processLifetime: lifetime,
    providers: [
      { key: 'alphaValue', module: { default: (context: { invocation: unknown; plugin: unknown }) => { calls.push('alphaValue'); return [context.invocation, context.plugin]; } }, source: 'src/providers/alpha-value.ts' },
      { key: 'zeta', module: { default: async (context: Record<string, unknown>) => { calls.push('zeta'); return Object.keys(context).sort(); } }, source: 'src/providers/zeta.ts' },
    ],
    request,
  });
  expect(Object.keys(values)).toEqual(['processLifetime', 'alphaValue', 'zeta']);
  // Providers receive the invocation and, through the request view, the observed
  // plugin root (#468) — the same value the request scope publishes.
  expect(values).toEqual({
    alphaValue: [{ kind: 'cli', props: { args: [], command: 'report' } }, plugin],
    processLifetime: { hits: 3, instanceId: 'instance-1', pid: 42 },
    zeta: ['host', 'invocation', 'lineage', 'plugin', 'session', 'signal', 'state', 'workspace'],
  });
  expect(source).toContain('await provider.module.default({ ...request, invocation: message.invocation })');
  expect(calls).toEqual(['alphaValue', 'zeta']);
  await expect(executeProviders({
    invocation: undefined,
    processLifetime: lifetime,
    providers: [{ key: 'zeta', module: {}, source: 'src/providers/zeta.ts' }],
    request,
  })).rejects.toThrow('Context provider "zeta" (src/providers/zeta.ts) must default-export a factory.');
  await expect(executeProviders({
    invocation: undefined,
    processLifetime: lifetime,
    providers: [{ key: 'zeta', module: { default: () => { throw new Error('boom'); } }, source: 'src/providers/zeta.ts' }],
    request,
  })).rejects.toThrow('Context provider "zeta" (src/providers/zeta.ts) failed: boom');
});

const layoutFixtures = [
  {
    id: 'layout:mcp:curator',
    provenance: { kind: 'conventional' as const, relativePath: 'src/mcp/curator/layout.tsx' },
    scope: 'server' as const,
    serverId: 'mcp:curator',
    source: '/project/src/mcp/curator/layout.tsx',
  },
  {
    id: 'layout:root',
    provenance: { kind: 'conventional' as const, relativePath: 'src/layout.tsx' },
    scope: 'root' as const,
    source: '/project/src/layout.tsx',
  },
];

it('composes the root and server layout chain around generated MCP routes and never around event routes', () => {
  const source = entryShellModule.generatedRouteFlightWorkerSource({
    artifactEpoch: 'route-fixture@1.2.3',
    eventRoutes: [{
      event: 'afterTool',
      eventRoute: { event: 'tool/after', fallback: 'none', runtime: 'shared' },
      id: 'hook:event-route:tool-after',
      name: 'event-route-tool-after',
      provenance: { kind: 'conventional', sourcePath: '/project/src/events/tool/after.tsx' },
      source: '/project/src/events/tool/after.tsx',
      targets: ['claude'],
      tools: [],
    }],
    layouts: layoutFixtures,
    routes: [
      {
        config: {},
        id: 'tool:curator/inspect',
        kind: 'tool',
        provenance: { kind: 'conventional', relativePath: 'src/mcp/curator/tools/inspect.tsx' },
        serverId: 'mcp:curator',
        source: '/project/src/mcp/curator/tools/inspect.tsx',
      },
      {
        config: { uri: 'curator://catalog' },
        id: 'resource:other/catalog',
        kind: 'resource',
        provenance: { kind: 'conventional', relativePath: 'src/mcp/other/resources/catalog.tsx' },
        serverId: 'mcp:other',
        source: '/project/src/mcp/other/resources/catalog.tsx',
      },
    ],
    serverName: 'curator',
  });

  // Layout imports are ordered by id so the emitted worker is deterministic.
  expect(source).toContain('import * as layout0 from "/project/src/mcp/curator/layout.tsx"');
  expect(source).toContain('import * as layout1 from "/project/src/layout.tsx"');
  // Root first, then the owning server's layout — the outer-to-inner chain.
  expect(source).toContain('id: "tool:curator/inspect", kind: "tool", layouts: Object.freeze([1,0])');
  expect(source).toContain('serverId: "mcp:curator"');
  // A route of another server takes only the root layout.
  expect(source).toContain('id: "resource:other/catalog", kind: "resource", layouts: Object.freeze([1])');
  // Event routes carry no layout chain.
  expect(source).toMatch(/"hook:event-route:tool-after": Object\.freeze\(\{ event: "tool\/after", id: "event:tool\/after", kind: 'event-route', module: route2, name: "tool\/after" \}\)/u);
  expect(source).toContain('composed = createElement(layout.module.default, { children: composed, route: { id: route.id, kind: route.kind, name: route.name, ...(route.serverId === undefined ? {} : { serverId: route.serverId }) }, signal })');
  expect(source).toContain('must default-export a function component');
  // The route element is awaited by one root component before wrapping, so a
  // throwing route still rejects the Flight root exactly as it does without a layout.
  expect(source).toContain('let composed = await route.module.default(props);');
  expect(source).toContain('if (chain.length === 0) return createElement(route.module.default, props);');
  expect(source).toContain('renderAgentFlight(composeLayouts(route, props, controller.signal)');
});

it('imports only the layouts some route of the worker composes through, never another server\'s layout', () => {
  // The rendered CLI/script worker carries the whole project layout list but
  // only root layouts apply to its routes; the curator server layout must not
  // be evaluated in that process at all.
  const rendered = entryShellModule.generatedRenderedRouteWorkerSource({
    layouts: layoutFixtures,
    routes: [
      {
        config: {},
        id: 'cli:library/audit',
        kind: 'cli',
        provenance: { kind: 'conventional', relativePath: 'src/cli/library/audit.tsx' },
        source: '/project/src/cli/library/audit.tsx',
      },
      {
        config: {},
        id: 'script:rebuild-index',
        kind: 'script',
        provenance: { kind: 'conventional', relativePath: 'src/scripts/rebuild-index.tsx' },
        source: '/project/src/scripts/rebuild-index.tsx',
      },
    ],
  });
  expect(rendered).toContain('import * as layout0 from "/project/src/layout.tsx"');
  expect(rendered).not.toContain('/project/src/mcp/curator/layout.tsx');
  expect(rendered).toContain('"cli:library/audit": Object.freeze({ id: "cli:library/audit", kind: "cli", name: "library audit", module: route0, layouts: Object.freeze([0]) })');
  expect(rendered).toContain('"script:rebuild-index": Object.freeze({ id: "script:rebuild-index", kind: "script", name: "rebuild-index", module: route1, layouts: Object.freeze([0]) })');

  // Another generated server's worker likewise skips the curator layout.
  const otherServer = entryShellModule.generatedRouteFlightWorkerSource({
    artifactEpoch: 'route-fixture@1.2.3',
    layouts: layoutFixtures,
    routes: [{
      config: { uri: 'other://catalog' },
      id: 'resource:other/catalog',
      kind: 'resource',
      provenance: { kind: 'conventional', relativePath: 'src/mcp/other/resources/catalog.tsx' },
      serverId: 'mcp:other',
      source: '/project/src/mcp/other/resources/catalog.tsx',
    }],
    serverName: 'other',
  });
  expect(otherServer).toContain('import * as layout0 from "/project/src/layout.tsx"');
  expect(otherServer).not.toContain('/project/src/mcp/curator/layout.tsx');
  expect(otherServer).toContain('id: "resource:other/catalog", kind: "resource", layouts: Object.freeze([0])');

  // A server layout alone, for a worker whose routes never take it, leaves the
  // worker byte-identical to a layout-free build.
  const serverOnly = layoutFixtures.filter((layout) => layout.scope === 'server');
  const cliRoutes = [{
    config: {},
    id: 'cli:library/audit',
    kind: 'cli' as const,
    provenance: { kind: 'conventional' as const, relativePath: 'src/cli/library/audit.tsx' },
    source: '/project/src/cli/library/audit.tsx',
  }];
  expect(entryShellModule.generatedRenderedRouteWorkerSource({ layouts: serverOnly, routes: cliRoutes }))
    .toBe(entryShellModule.generatedRenderedRouteWorkerSource({ routes: cliRoutes }));
});

it('emits an identity composition when no layout exists so layout-free workers render exactly the route element', () => {
  const source = entryShellModule.generatedRouteFlightWorkerSource({
    artifactEpoch: 'route-fixture@1.2.3',
    routes: [{
      config: {},
      id: 'tool:curator/inspect',
      kind: 'tool',
      provenance: { kind: 'conventional', relativePath: 'src/mcp/curator/tools/inspect.tsx' },
      serverId: 'mcp:curator',
      source: '/project/src/mcp/curator/tools/inspect.tsx',
    }],
    serverName: 'curator',
  });

  expect(source).toContain('const composeLayouts = (route, props) => createElement(route.module.default, props);');
  expect(source).not.toContain('import * as layout0');
  expect(source).not.toContain('layouts: Object.freeze(');
});

it('hands rendered CLI, projected MCP, and script routes their layout chain and protocol-facing name', () => {
  const source = entryShellModule.generatedRenderedRouteWorkerSource({
    layouts: layoutFixtures,
    routes: [
      {
        config: {},
        id: 'cli:library/audit',
        kind: 'cli',
        provenance: { kind: 'conventional', relativePath: 'src/cli/library/audit.tsx' },
        source: '/project/src/cli/library/audit.tsx',
      },
      {
        config: {},
        id: 'tool:curator/inspect',
        kind: 'tool',
        provenance: { kind: 'conventional', relativePath: 'src/mcp/curator/tools/inspect.tsx' },
        serverId: 'mcp:curator',
        source: '/project/src/mcp/curator/tools/inspect.tsx',
      },
      {
        config: {},
        id: 'script:rebuild-index',
        kind: 'script',
        provenance: { kind: 'conventional', relativePath: 'src/scripts/rebuild-index.tsx' },
        source: '/project/src/scripts/rebuild-index.tsx',
      },
    ],
  });

  expect(source).toContain('"cli:library/audit": Object.freeze({ id: "cli:library/audit", kind: "cli", name: "library audit", module: route0, layouts: Object.freeze([1]) })');
  expect(source).toContain('"tool:curator/inspect": Object.freeze({ id: "tool:curator/inspect", kind: "tool", name: "inspect", serverId: "mcp:curator", module: route1, layouts: Object.freeze([1,0]) })');
  expect(source).toContain('"script:rebuild-index": Object.freeze({ id: "script:rebuild-index", kind: "script", name: "rebuild-index", module: route2, layouts: Object.freeze([1]) })');
  expect(source).toContain('renderAgentFlight(composeLayouts(route, { ...message.props, signal: controller.signal }, controller.signal)');
});

it('conditionally emits generated state mounting without leaking sqlite into volatile or stateless entries', () => {
  const route = {
    config: {},
    id: 'tool:curator/inspect',
    kind: 'tool',
    provenance: { kind: 'conventional', relativePath: 'src/mcp/curator/tools/inspect.tsx' },
    source: '/project/src/mcp/curator/tools/inspect.tsx',
  } as const;
  const state = (lifetime: 'process' | 'request' | 'workspace-durable') => ({
    id: 'project/tasks',
    lifetime,
    provenance: { kind: 'conventional' as const, sourcePath: '/project/src/state.ts' },
    source: '/project/src/state.ts',
  });
  const base = {
    artifactEpoch: 'route-fixture@1.2.3',
    routes: [route],
    serverName: 'curator',
  };
  const stateless = entryShellModule.generatedRouteFlightWorkerSource(base);
  for (const identifier of [
    '@agent-bundle/runtime/mount',
    '@agent-bundle/runtime/state',
    'noticeLedger',
    'createGeneratedRuntimeState',
    'createSqliteStateDriver',
  ]) {
    expect(stateless).not.toContain(identifier);
  }

  const volatile = entryShellModule.generatedRouteFlightWorkerSource({
    ...base,
    noticeDelivery: claudeAdapter.noticeDelivery!,
    state: state('process'),
  });
  expect(volatile).toContain('import stateDefinition from "/project/src/state.ts"');
  expect(volatile).toContain("createGeneratedRuntimeState");
  expect(volatile).toContain('createMemoryStateDriver({ lifetime: "process" })');
  expect(volatile).toContain('noticeLedger');
  expect(volatile).toContain('import * as noticeInboxRoute from "@agent-bundle/runtime/notices/inbox-route"');
  expect(volatile).toContain('noticeInboxRoute.noticeInboxRouteRecord(noticeInboxRoute)');
  expect(volatile).not.toContain('@agent-bundle/runtime/state/sqlite');
  expect(volatile).not.toContain('createSqliteStateDriver');
  expect(stateless).not.toContain('@agent-bundle/runtime/notices/inbox-route');
  expect(stateless).not.toContain('agent-bundle:notice-inbox');

  const statelessEntry = entryShellModule.generatedRouteMcpEntrySource({
    plugin: { name: 'route-fixture', version: '1.2.3' },
    routes: [route],
    serverName: 'curator',
    workerFile: 'mcp-curator-flight.mjs',
  });
  expect(statelessEntry).not.toContain('@agent-bundle/runtime/notices/inbox-route');
  expect(statelessEntry).not.toContain('agent-bundle:notice-inbox');
  const volatileEntry = entryShellModule.generatedRouteMcpEntrySource({
    noticeDelivery: claudeAdapter.noticeDelivery!,
    plugin: { name: 'route-fixture', version: '1.2.3' },
    routes: [route],
    serverName: 'curator',
    state: state('process'),
    workerFile: 'mcp-curator-flight.mjs',
  });
  expect(volatileEntry).toContain('import * as noticeInboxRoute from "@agent-bundle/runtime/notices/inbox-route"');
  expect(volatileEntry).toContain('noticeInboxRoute.noticeInboxRouteRecord(noticeInboxRoute)');
  // Volatile stores live in the worker's heap: the server process has no
  // handle on them, so it must not advertise inbox subscriptions.
  for (const generated of [statelessEntry, volatileEntry]) {
    for (const identifier of [
      'createGeneratedNoticeRuntime',
      'createNoticeInboxSignaller',
      '@agent-bundle/runtime/notices\'',
      '@agent-bundle/runtime/state/sqlite',
      'notices: noticeDelivery',
    ]) {
      expect(generated).not.toContain(identifier);
    }
  }

  const durableEntry = entryShellModule.generatedRouteMcpEntrySource({
    noticeDelivery: claudeAdapter.noticeDelivery!,
    plugin: { name: 'route-fixture', version: '1.2.3' },
    routes: [route],
    serverName: 'curator',
    state: state('workspace-durable'),
    workerFile: 'mcp-curator-flight.mjs',
  });
  expect(durableEntry).toContain("import { createGeneratedNoticeRuntime } from '@agent-bundle/runtime/mount';");
  expect(durableEntry).toContain("import { createNoticeInboxSignaller } from '@agent-bundle/runtime/notices';");
  expect(durableEntry).toContain("import { createSqliteStateDriver } from '@agent-bundle/runtime/state/sqlite';");
  expect(durableEntry).toContain("const pluginRoot = resolvePluginRoot({ fallback: fileURLToPath(new URL('..', import.meta.url)) });");
  // The host's advertisement is declared once and handed to both the ledger
  // (whose sensitivity ceilings it carries) and the signaller (#99 item 7).
  expect(durableEntry).toContain(`const noticeDeliveryAdvertisement = Object.freeze(${stableJson(claudeAdapter.noticeDelivery)});`);
  expect(durableEntry).toContain("createNoticeInboxSignaller({ delivery: noticeDeliveryAdvertisement, store: createGeneratedNoticeRuntime({ driver: createSqliteStateDriver({ root: pluginRoot.stateRoot }), lifetime: 'workspace-durable', noticeDelivery: noticeDeliveryAdvertisement }) })");
  expect(durableEntry).not.toContain('noticeRetentionPolicy');
  expect(durableEntry).toContain('  notices: noticeDelivery,');
  // A declared `notices.retention` travels as one frozen literal too.
  const retainingEntry = entryShellModule.generatedRouteMcpEntrySource({
    noticeDelivery: claudeAdapter.noticeDelivery!,
    noticeRetention: { maxJournalBytes: 1024, maxTerminal: 3, terminalTtlMs: 60_000 },
    plugin: { name: 'route-fixture', version: '1.2.3' },
    routes: [route],
    serverName: 'curator',
    state: state('workspace-durable'),
    workerFile: 'mcp-curator-flight.mjs',
  });
  expect(retainingEntry).toContain('const noticeRetentionPolicy = Object.freeze({"maxJournalBytes":1024,"maxTerminal":3,"terminalTtlMs":60000});');
  expect(retainingEntry).toContain("lifetime: 'workspace-durable', noticeDelivery: noticeDeliveryAdvertisement, noticeRetention: noticeRetentionPolicy })");
  // The server process never evaluates the project's own state definition.
  expect(durableEntry).not.toContain('import stateDefinition from');
  expect(durableEntry).not.toContain('createGeneratedRuntimeState');

  // Each route is selected from its own advertised state: a durable store alone
  // is not enough. A host whose pinned table marks `mcp-resource-updated`
  // unavailable keeps the inbox but wires no subscription signal.
  const withoutResourceUpdated: NoticeDeliveryAdvertisement = Object.freeze({
    ...claudeAdapter.noticeDelivery!,
    'mcp-resource-updated': Object.freeze({
      reason: '2026-09-02: fixture host does not forward resources/updated.',
      state: 'unavailable' as const,
    }),
  });
  const unsupportedEntry = entryShellModule.generatedRouteMcpEntrySource({
    noticeDelivery: withoutResourceUpdated,
    plugin: { name: 'route-fixture', version: '1.2.3' },
    routes: [route],
    serverName: 'curator',
    state: state('workspace-durable'),
    workerFile: 'mcp-curator-flight.mjs',
  });
  expect(unsupportedEntry).toContain('noticeInboxRoute.noticeInboxRouteRecord(noticeInboxRoute)');
  // The sqlite driver itself stays: a workspace-durable project journals its
  // lineage registry through it regardless of notice delivery. Only the notice
  // runtime and its own durable store must be absent.
  for (const identifier of [
    'createGeneratedNoticeRuntime',
    'createNoticeInboxSignaller',
    'notices: noticeDelivery',
  ]) {
    expect(unsupportedEntry).not.toContain(identifier);
  }
  expect(unsupportedEntry).toContain('agentLineageStateDefinition');

  // The inbox is a route of its own: a host that marks `mcp-inbox` unavailable,
  // or a target with no advertisement at all, exposes no inbox resource — and
  // therefore no subscription signal about it — in the server or its worker,
  // however durable the store is.
  const withoutInbox: NoticeDeliveryAdvertisement = Object.freeze({
    ...claudeAdapter.noticeDelivery!,
    'mcp-inbox': Object.freeze({
      reason: '2026-09-02: fixture host does not list MCP resources.',
      state: 'unavailable' as const,
    }),
  });
  const unadvertisedEntry = entryShellModule.generatedRouteMcpEntrySource({
    plugin: { name: 'route-fixture', version: '1.2.3' },
    routes: [route],
    serverName: 'curator',
    state: state('workspace-durable'),
    workerFile: 'mcp-curator-flight.mjs',
  });
  const noInboxEntry = entryShellModule.generatedRouteMcpEntrySource({
    noticeDelivery: withoutInbox,
    plugin: { name: 'route-fixture', version: '1.2.3' },
    routes: [route],
    serverName: 'curator',
    state: state('workspace-durable'),
    workerFile: 'mcp-curator-flight.mjs',
  });
  const unadvertisedWorker = entryShellModule.generatedRouteFlightWorkerSource({
    ...base,
    state: state('workspace-durable'),
  });
  const noInboxWorker = entryShellModule.generatedRouteFlightWorkerSource({
    ...base,
    noticeDelivery: withoutInbox,
    state: state('workspace-durable'),
  });
  for (const generated of [unadvertisedEntry, noInboxEntry, unadvertisedWorker, noInboxWorker]) {
    for (const identifier of [
      '@agent-bundle/runtime/notices/inbox-route',
      'noticeInboxRoute',
      'createGeneratedNoticeRuntime',
      'createNoticeInboxSignaller',
      'notices: noticeDelivery',
    ]) {
      expect(generated).not.toContain(identifier);
    }
  }
  // The worker still mounts the durable ledger (routes publish into it); only
  // the unadvertised read surface is withheld.
  for (const generated of [unadvertisedWorker, noInboxWorker]) {
    expect(generated).toContain('noticeLedger');
    expect(generated).toContain('createSqliteStateDriver');
  }
  // The reserved inbox name stays reserved so a host that later advertises the
  // route cannot collide with an authored one.
  expect(() => entryShellModule.generatedRouteMcpEntrySource({
    noticeDelivery: withoutInbox,
    plugin: { name: 'route-fixture', version: '1.2.3' },
    routes: [{ ...route, config: { uri: 'agent-bundle://notices/inbox' }, id: 'resource:curator/inbox', kind: 'resource' }],
    serverName: 'curator',
    state: state('workspace-durable'),
    workerFile: 'mcp-curator-flight.mjs',
  })).toThrow(/reserved URI/u);

  const durable = entryShellModule.generatedRouteFlightWorkerSource({
    ...base,
    noticeDelivery: claudeAdapter.noticeDelivery!,
    state: state('workspace-durable'),
  });
  expect(durable).toContain("from '@agent-bundle/runtime/state/sqlite'");
  expect(durable).toContain("const pluginRoot = resolvePluginRoot({ fallback: fileURLToPath(new URL('..', import.meta.url)) });");
  expect(durable).toContain('createSqliteStateDriver({ root: pluginRoot.stateRoot })');
  expect(durable).not.toContain('AGENT_BUNDLE_PLUGIN_ROOT');

  const renderedWorker = entryShellModule.generatedRenderedRouteWorkerSource({
    routes: [{ ...route, id: 'script:report', kind: 'script' }],
    state: state('workspace-durable'),
  });
  expect(renderedWorker).toContain("from '@agent-bundle/runtime/state/sqlite'");
  expect(renderedWorker).toContain('noticeLedger: bindings.noticeLedger');
  expect(renderedWorker).toContain('state: bindings.state');

  const command = {
    aliases: [],
    exitCode: 'zero',
    options: [],
    path: ['inspect'],
    rendered: false,
    routeId: 'cli:inspect',
  } as const;
  const cliRoute = { ...route, id: command.routeId, kind: 'cli' as const };
  const statelessCli = entryShellModule.generatedCliBinEntrySource({
    commands: [command],
    plugin: { name: 'fixture', version: '1.0.0' },
    routes: [cliRoute],
  });
  expect(statelessCli).not.toContain('@agent-bundle/runtime/mount');
  expect(statelessCli).not.toContain('noticeLedger');
  const volatileCli = entryShellModule.generatedCliBinEntrySource({
    commands: [command],
    plugin: { name: 'fixture', version: '1.0.0' },
    routes: [cliRoute],
    state: state('request'),
  });
  expect(volatileCli).toContain('createMemoryStateDriver({ lifetime: "request" })');
  expect(volatileCli).not.toContain('@agent-bundle/runtime/state/sqlite');
  expect(volatileCli).toContain('await bindings.close()');

  for (const generated of [
    stateless,
    volatile,
    statelessEntry,
    volatileEntry,
    durableEntry,
    durable,
    renderedWorker,
    statelessCli,
    volatileCli,
  ]) {
    const transpiled = ts.transpileModule(generated, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      reportDiagnostics: true,
    });
    expect(transpiled.diagnostics ?? []).toEqual([]);
  }
});
