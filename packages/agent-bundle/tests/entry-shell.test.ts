import { access, readFile } from 'node:fs/promises';

import { describe, expect, it } from '@rstest/core';

import { scanEntryExportsSource, stripCommentsAndStrings } from '../src/build/entry-exports.ts';
import * as entryShellModule from '../src/build/entry-shell.ts';
import {
  generatedExecutableEntrySource,
  generatedStdioMcpEntrySource,
  mcpEntryRuntimePath,
  mcpEntryRuntimeSpecifier,
  mcpServerRuntimePath,
  mcpServerRuntimeSpecifier,
} from '../src/build/entry-shell.ts';

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

  it('generates a stdio entry that defers the consumer import behind the lifecycle', () => {
    const source = generatedStdioMcpEntrySource({ entrySource: '/proj/src/mcp/curator.ts', serverName: 'curator' });
    expect(source).toContain(`from ${JSON.stringify(mcpEntryRuntimeSpecifier)}`);
    expect(source).toContain('loadEntry: () => import("/proj/src/mcp/curator.ts")');
    expect(source).toContain('serverName: "curator"');
    // The consumer module must never be statically imported: the console
    // guard has to activate before its side effects can reach stdout.
    expect(source).not.toMatch(/^import[^\n]*curator\.ts/mu);
  });

  it('generates a process envelope that adopts numeric exit codes', () => {
    const source = generatedExecutableEntrySource({ entrySource: '/proj/src/cli.ts', exportName: 'main' });
    expect(source).toContain('import * as entry from "/proj/src/cli.ts"');
    expect(source).toContain('entry["main"]');
    expect(source).toContain('await main(process.argv.slice(2))');
    expect(source).toContain("if (typeof code === 'number') process.exitCode = code;");
    expect(generatedExecutableEntrySource({ entrySource: '/e.ts', exportName: 'default' })).toContain('entry["default"]');
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
    target: 'claude',
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
  expect(source).toContain('export default async () => createGeneratedRouteMcpServer(');
  // The event runtime's modules are aliased into the artifact, so the entry
  // imports them and hands them to the shared runtime; the wiring itself is
  // not re-templated here.
  expect(source).toContain('createEventRuntimeServer,');
  expect(source).toContain('projectEventDocument,');
  expect(source).toContain('endpointId: `${EVENT_ARTIFACT_EPOCH}:${EVENT_TARGET}:');
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
});
