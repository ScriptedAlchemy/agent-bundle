/**
 * The check #591 demands of the framework's own output: no JavaScript the
 * framework generates loads anything by a bare package specifier through a
 * form the bundler cannot inline. Every generator that renders a module the
 * plugin build compiles or emits verbatim is rendered here with the smallest
 * arguments it accepts and scanned with the leaf scanner `AB6005` runs over
 * compiled host-pack modules (`build/module-loads.ts`): a `computed` load
 * (`require(name)`, `createRequire(…)(expr)`, `import.meta.resolve(expr)`),
 * a loader passed on as a value, or a `literal` load whose specifier is
 * neither a Node built-in nor relative (`./`, `../`) nor `file:` fails the
 * suite and prints the load.
 *
 * Coverage notes:
 * - `build/cli-bins.ts` produces no source of its own: `cliBinRslibEntries`
 *   delegates every entry to `generatedCliBinEntrySource` and
 *   `generatedRenderedRouteWorkerSource`, both rendered below.
 * - The composite plugin root's `bin/` and `mcp/` entries (#555 W1,
 *   PR #578) are planned from these same generators with
 *   `target: composite.identity`, so they are covered by the same templates
 *   and need no rendering of their own.
 * - The event-route wrapper source is module-private to
 *   `adapters/hook-contract.ts`; it is reached through `planHooks` with each
 *   adapter's real hook contract, and every planned `virtualSource` is
 *   scanned.
 */
import { isBuiltin } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import { createCursorHookContract } from '../src/adapters/cursor.ts';
import {
  cursorHookWrapperSource,
  nativeHookWrapperSource,
  planHooks,
  type TargetHookContract,
  type TargetHookWrapper,
} from '../src/adapters/hook-contract.ts';
import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { planMcpEntriesSurface } from '../src/build/entries.ts';
import {
  generatedCliBinEntrySource,
  generatedExecutableEntrySource,
  generatedInstallBinEntrySource,
  generatedRenderedRouteWorkerSource,
  generatedRenderedScriptEntrySource,
  generatedRouteFlightWorkerSource,
  generatedRouteMcpEntrySource,
  generatedStdioMcpEntrySource,
  stdioPreludeModuleSource,
} from '../src/build/entry-shell.ts';
import { operatorEnvLayerModuleSource } from '../src/build/launch-env-shell.ts';
import { generatedMetaModuleSource } from '../src/build/meta.ts';
import { type ModuleLoad, scanModuleLoads } from '../src/build/module-loads.ts';
import type {
  NormalizedHook,
  NormalizedNoticeRetentionPolicy,
  NormalizedPlugin,
  NormalizedStateDefinition,
  SourceProvenance,
} from '../src/core/types.ts';
import { type BuiltInTarget, installSurfaceEntries } from '../src/install/surface.ts';
import type { CompiledAgentRoute, CompiledCliCommand, CompiledLayout, CompiledProvider } from '../src/routes/types.ts';

/** A literal load the bundler inlines or Node serves itself: a built-in, a relative path, or a `file:` URL. */
const allowedLiteral = (specifier: string): boolean =>
  isBuiltin(specifier) || specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('file:');

/** Every load of `source` that AB6005 would refuse in a compiled host-pack module. */
const offendingLoads = (source: string): readonly ModuleLoad[] =>
  scanModuleLoads(source).filter((load) => load.kind !== 'literal' || !allowedLiteral(load.specifier));

const describeLoads = (loads: readonly ModuleLoad[]): string => loads
  .map((load) => `${load.kind} ${load.form} via ${load.loader}${load.kind === 'literal' ? ` ${JSON.stringify(load.specifier)}` : ''}`)
  .join('; ');

const expectNoBareLoads = (label: string, source: string): void => {
  expect(source.length, `${label} rendered nothing`).toBeGreaterThan(0);
  const offending = offendingLoads(source);
  expect(offending, `${label} loads by a bare package specifier: ${describeLoads(offending)}`).toEqual([]);
};

/** Narrows an optional adapter binding the fixture depends on, naming it when the adapter stops declaring it. */
const declared = <T>(value: T | undefined, label: string): T => {
  if (value === undefined) throw new Error(`${label} is not declared`);
  return value;
};

const configProvenance: SourceProvenance = { kind: 'config', sourcePath: '/project/agent-bundle.config.ts' };

const route = (
  id: string,
  kind: CompiledAgentRoute['kind'],
  source: string,
  extra: Partial<Pick<CompiledAgentRoute, 'config' | 'serverId'>> = {},
): CompiledAgentRoute => ({
  config: {},
  id,
  kind,
  provenance: { kind: 'conventional', relativePath: source.slice('/project/'.length) },
  source,
  ...extra,
});

const cliRoute = route('cli:report', 'cli', '/project/src/cli/report.ts');
const toolRoute = route('tool:curator/inspect', 'tool', '/project/src/mcp/curator/tools/inspect.tsx', { serverId: 'mcp:curator' });
const resourceRoute = route('resource:curator/catalog', 'resource', '/project/src/mcp/curator/resources/catalog.tsx', {
  config: { uri: 'catalog://books' },
  serverId: 'mcp:curator',
});
const scriptRoute = route('script:rebuild', 'script', '/project/src/scripts/rebuild.tsx');

const providers: readonly CompiledProvider[] = [{
  id: 'provider:zeta',
  name: 'zeta',
  provenance: { kind: 'conventional', relativePath: 'src/providers/zeta.ts' },
  source: '/project/src/providers/zeta.ts',
}];

const layouts: readonly CompiledLayout[] = [
  {
    id: 'layout:root',
    provenance: { kind: 'conventional', relativePath: 'src/layout.tsx' },
    scope: 'root',
    source: '/project/src/layout.tsx',
  },
  {
    id: 'layout:mcp:curator',
    provenance: { kind: 'conventional', relativePath: 'src/mcp/curator/layout.tsx' },
    scope: 'server',
    serverId: 'mcp:curator',
    source: '/project/src/mcp/curator/layout.tsx',
  },
];

const durableState: NormalizedStateDefinition = {
  id: 'project/tasks',
  lifetime: 'workspace-durable',
  provenance: { kind: 'conventional', sourcePath: '/project/src/state.ts' },
  source: '/project/src/state.ts',
};
const volatileState: NormalizedStateDefinition = { ...durableState, lifetime: 'process' };
const noticeRetention: NormalizedNoticeRetentionPolicy = { maxJournalBytes: 1024, maxTerminal: 3, terminalTtlMs: 60_000 };
const registry = createDefaultRegistry();
const noticeDelivery = declared(registry.noticeDelivery('claude'), 'the claude adapter notice delivery advertisement');

const plainCommand: CompiledCliCommand = {
  aliases: [],
  exitCode: 'zero',
  options: [],
  path: ['report'],
  rendered: false,
  routeId: 'cli:report',
};
const renderedCommand: CompiledCliCommand = {
  aliases: [],
  exitCode: 'zero',
  mcp: { confirm: false, server: 'curator', tool: 'inspect' },
  options: [],
  path: ['curator', 'inspect'],
  rendered: true,
  routeId: 'tool:curator/inspect',
};
const plugin = { name: 'fixture', version: '1.0.0' };

const hookTargets: readonly string[] = ['claude', 'codex', 'cursor', 'plugin'];

/** A config-declared hook: the wrapper the native (Claude/Codex/Universal) and Cursor codecs render directly. */
const configHook: NormalizedHook = {
  event: 'sessionStart',
  id: 'hook:sessionStart:probe',
  name: 'probe',
  provenance: configProvenance,
  source: '/project/src/hooks/probe.ts',
  targets: hookTargets,
  tools: [],
};

type HookEventRoute = NonNullable<NormalizedHook['eventRoute']>;

/** A filesystem event route: the wrapper only `planHooks` can render, in each runtime and fallback mode. */
const eventRouteHook = (event: NormalizedHook['event'], eventRoute: HookEventRoute): NormalizedHook => {
  const slug = `${eventRoute.event.replace('/', '-')}-${eventRoute.runtime}-${eventRoute.fallback}`;
  return {
    event,
    eventRoute,
    id: `hook:event-route:${slug}`,
    name: `event-route-${slug}`,
    provenance: { kind: 'conventional', sourcePath: `/project/src/events/${eventRoute.event}.tsx` },
    source: `/project/src/events/${eventRoute.event}.tsx`,
    targets: hookTargets,
    tools: [],
  };
};

const eventRouteHooks: readonly NormalizedHook[] = [
  eventRouteHook('afterTool', { event: 'tool/after', fallback: 'none', runtime: 'shared' }),
  eventRouteHook('afterTool', { event: 'tool/after', fallback: 'standalone', runtime: 'shared' }),
  eventRouteHook('sessionEnd', { event: 'session/end', fallback: 'none', runtime: 'standalone' }),
];

const model = (state?: NormalizedStateDefinition): NormalizedPlugin => ({
  extensions: {},
  hooks: [configHook, ...eventRouteHooks],
  mcpServers: [],
  metadata: {
    description: 'Renders every generated module for the AB6005 audit.',
    id: 'plugin:fixture',
    name: 'fixture',
    provenance: configProvenance,
    version: '1.0.0',
  },
  runtime: { node: '22.12.0' },
  scripts: [],
  skills: [],
  ...(state === undefined ? {} : { state }),
  targets: ['claude', 'codex', 'cursor', 'plugin', 'portable'].map((name) => ({
    id: `target:${name}`,
    name,
    provenance: configProvenance,
  })),
});

/**
 * Every hook contract the framework binds a `wrapperSource` to, with the
 * target name `planHooks` selects hooks by and, for the composite bundle's
 * Cursor half (`adapters/plugin.ts`), the concrete host the wrappers serve.
 */
const hookPlanners: ReadonlyArray<{
  readonly concreteEventTarget?: string;
  readonly contract: TargetHookContract;
  readonly label: string;
  readonly target: string;
}> = [
  // Intentionally enumerate the production hook list: Claude, Codex, Cursor,
  // Universal plugin, and its Cursor variant; portable declares hooks unavailable.
  ...registry.names().flatMap((target) => {
    const contract = registry.hookContract(target);
    return contract === undefined ? [] : [{ contract, label: target, target }];
  }),
  {
    concreteEventTarget: 'cursor',
    contract: createCursorHookContract({
      indexedWrappers: false,
      manifestPath: 'hooks/hooks-cursor.json',
      wrapperPath: (hook) => `hooks/${hook.name}.cursor.mjs`,
    }),
    label: 'plugin, cursor variant',
    target: 'plugin',
  },
];

describe('generated JavaScript loads nothing by a bare package specifier', () => {
  it('can fail: a createRequire load of a bare package is one offending load', () => {
    expect(() => {
      expectNoBareLoads(
        'negative control',
        'export const x = createRequire(import.meta.url)("left-pad");',
      );
    }).toThrow(/left-pad/u);
    // The allowed literal forms stay silent, so a passing suite means no bare load rather than no load.
    expect(offendingLoads([
      'const fs = require("node:fs");',
      'const path = require("path");',
      'require("./driver.cjs");',
      'import.meta.resolve("../worker.mjs");',
      'import.meta.resolve("file:///opt/worker.mjs");',
    ].join('\n'))).toEqual([]);
  });

  it('build/entry-shell: the stdio prelude and the stdio MCP entry', () => {
    expectNoBareLoads('stdioPreludeModuleSource()', stdioPreludeModuleSource());
    expectNoBareLoads('stdioPreludeModuleSource(env)', stdioPreludeModuleSource({ API_URL: 'https://api.example' }));
    expectNoBareLoads(
      'generatedStdioMcpEntrySource',
      generatedStdioMcpEntrySource({ entrySource: '/project/src/mcp/curator.ts', serverName: 'curator' }),
    );
  });

  it('build/entry-shell: the executable and install bin envelopes', () => {
    expectNoBareLoads(
      'generatedExecutableEntrySource(main, cli)',
      generatedExecutableEntrySource({ entrySource: '/project/src/cli.ts', exportName: 'main', hostSurface: 'cli' }),
    );
    expectNoBareLoads(
      'generatedExecutableEntrySource(default, script)',
      generatedExecutableEntrySource({ entrySource: '/project/src/scripts/export.ts', exportName: 'default', hostSurface: 'script' }),
    );
    expectNoBareLoads(
      'generatedExecutableEntrySource(default)',
      generatedExecutableEntrySource({ entrySource: '/project/src/scripts/export.ts', exportName: 'default' }),
    );
    expectNoBareLoads(
      'generatedInstallBinEntrySource',
      generatedInstallBinEntrySource({ artifactRelativeUrl: '../../artifact/', hosts: ['claude', 'codex', 'cursor'], name: 'installer' }),
    );
  });

  it('build/entry-shell: the routed CLI bin, its render worker, and the rendered script entry', () => {
    expectNoBareLoads(
      'generatedCliBinEntrySource(plain)',
      generatedCliBinEntrySource({ commands: [plainCommand], plugin, routes: [cliRoute] }),
    );
    expectNoBareLoads(
      'generatedCliBinEntrySource(providers, durable state, artifact fallback)',
      generatedCliBinEntrySource({
        commands: [plainCommand],
        plugin: { ...plugin, description: 'Routed fixture CLI.' },
        providers,
        routes: [cliRoute],
        state: durableState,
        stateFallback: 'artifact',
      }),
    );
    expectNoBareLoads(
      'generatedCliBinEntrySource(npm bin: durable state, no stateFallback, rendered MCP command)',
      generatedCliBinEntrySource({
        commands: [renderedCommand, plainCommand],
        noticeRetention,
        plugin,
        routes: [cliRoute, toolRoute],
        state: durableState,
        workerFile: 'fixture-flight.mjs',
      }),
    );
    expectNoBareLoads(
      'generatedCliBinEntrySource(volatile state)',
      generatedCliBinEntrySource({ commands: [plainCommand], plugin, routes: [cliRoute], state: volatileState }),
    );
    expectNoBareLoads(
      'generatedRenderedRouteWorkerSource(plain)',
      generatedRenderedRouteWorkerSource({ routes: [cliRoute] }),
    );
    expectNoBareLoads(
      'generatedRenderedRouteWorkerSource(layouts, providers, durable state, artifact fallback)',
      generatedRenderedRouteWorkerSource({
        layouts,
        noticeRetention,
        providers,
        routes: [cliRoute, toolRoute, scriptRoute],
        state: durableState,
        stateFallback: 'artifact',
      }),
    );
    expectNoBareLoads(
      'generatedRenderedRouteWorkerSource(volatile state)',
      generatedRenderedRouteWorkerSource({ routes: [scriptRoute], state: volatileState }),
    );
    expectNoBareLoads(
      'generatedRenderedScriptEntrySource',
      generatedRenderedScriptEntrySource({ name: 'rebuild', routeId: 'script:rebuild', workerFile: 'rebuild-flight.mjs' }),
    );
    expectNoBareLoads(
      'generatedRenderedScriptEntrySource(durable state)',
      generatedRenderedScriptEntrySource({
        name: 'rebuild',
        noticeRetention,
        routeId: 'script:rebuild',
        state: durableState,
        workerFile: 'rebuild-flight.mjs',
      }),
    );
  });

  it('build/entry-shell: the generated MCP server entry and its Flight worker', () => {
    expectNoBareLoads(
      'generatedRouteFlightWorkerSource(stateless)',
      generatedRouteFlightWorkerSource({ artifactEpoch: 'fixture@1.0.0', routes: [toolRoute], serverName: 'curator' }),
    );
    expectNoBareLoads(
      'generatedRouteFlightWorkerSource(event routes, layouts, providers, durable state, notices)',
      generatedRouteFlightWorkerSource({
        artifactEpoch: 'fixture@1.0.0',
        eventRoutes: eventRouteHooks,
        layouts,
        noticeDelivery,
        noticeRetention,
        providers,
        routes: [toolRoute, resourceRoute],
        serverName: 'curator',
        state: durableState,
      }),
    );
    expectNoBareLoads(
      'generatedRouteFlightWorkerSource(volatile state)',
      generatedRouteFlightWorkerSource({
        artifactEpoch: 'fixture@1.0.0',
        noticeDelivery,
        routes: [toolRoute],
        serverName: 'curator',
        state: volatileState,
      }),
    );
    expectNoBareLoads(
      'generatedRouteMcpEntrySource(stateless)',
      generatedRouteMcpEntrySource({ plugin, routes: [toolRoute], serverName: 'curator', workerFile: 'mcp-curator-flight.mjs' }),
    );
    expectNoBareLoads(
      'generatedRouteMcpEntrySource(event routes, durable state, notices, plugin target)',
      generatedRouteMcpEntrySource({
        artifactEpoch: 'fixture@1.0.0',
        eventRoutes: eventRouteHooks,
        noticeDelivery,
        noticeRetention,
        plugin,
        routes: [toolRoute, resourceRoute],
        serverName: 'curator',
        state: durableState,
        target: 'plugin',
        workerFile: 'mcp-curator-flight.mjs',
      }),
    );
    expectNoBareLoads(
      'generatedRouteMcpEntrySource(volatile state)',
      generatedRouteMcpEntrySource({
        noticeDelivery,
        plugin,
        routes: [toolRoute],
        serverName: 'curator',
        state: volatileState,
        workerFile: 'mcp-curator-flight.mjs',
      }),
    );
  });

  it('build/launch-env-shell: the operator env layer', () => {
    expectNoBareLoads('operatorEnvLayerModuleSource()', operatorEnvLayerModuleSource());
    expectNoBareLoads(
      'operatorEnvLayerModuleSource(env)',
      operatorEnvLayerModuleSource({ API_URL: 'https://api.example', LOG_LEVEL: 'info' }),
    );
  });

  it('build/meta and entries: the project identity and MCP Apps registry modules', async () => {
    expectNoBareLoads(
      'generatedMetaModuleSource',
      generatedMetaModuleSource({ name: 'fixture', packageName: '@fixture/plugin', packageVersion: '1.0.0', version: '1.0.0' }),
    );

    const surface = await planMcpEntriesSurface([{
      args: ['mcp/mcp-curator-12345678.mjs'],
      id: 'mcp:curator',
      name: 'curator',
      provenance: configProvenance,
      source: import.meta.filename,
      targets: ['plugin'],
      transport: 'stdio',
    }], {
      artifactEpoch: 'fixture@1',
      eventHooks: [],
      outDir: join(tmpdir(), 'agent-bundle-generated-module-loads'),
      plugin,
      target: 'plugin',
    });
    const mcpApps = declared(
      surface.entries
        .flatMap((entry) => entry.virtualModules ?? [])
        .find((module) => module.name === 'agent-bundle/mcp-apps'),
      'the generated agent-bundle/mcp-apps registry module',
    );
    expectNoBareLoads('planMcpEntriesSurface agent-bundle/mcp-apps', mcpApps.source);
  });

  it('adapters/hook-contract: the native and Cursor wrapper codecs', () => {
    const wrapper: TargetHookWrapper = {
      event: 'sessionStart',
      hook: configHook,
      nativeEvent: 'SessionStart',
      relativePath: 'hooks/probe.mjs',
      target: 'claude',
    };

    expectNoBareLoads('nativeHookWrapperSource(Claude)', nativeHookWrapperSource(wrapper, 'Claude'));
    expectNoBareLoads('nativeHookWrapperSource(Codex)', nativeHookWrapperSource({ ...wrapper, target: 'codex' }, 'Codex'));
    expectNoBareLoads('nativeHookWrapperSource(Universal)', nativeHookWrapperSource({ ...wrapper, target: 'plugin' }, 'Universal'));
    expectNoBareLoads(
      'cursorHookWrapperSource',
      cursorHookWrapperSource({ ...wrapper, nativeEvent: 'sessionStart', target: 'cursor' }),
    );
  });

  it('adapters/hook-contract: every wrapper planHooks renders through each adapter hook contract, including event routes', () => {
    for (const [stateLabel, state] of [['stateless', undefined], ['durable state', durableState]] as const) {
      for (const planner of hookPlanners) {
        const label = `planHooks(${planner.label}; ${stateLabel})`;
        const plan = planHooks(model(state), planner.target, planner.contract, planner.concreteEventTarget);

        expect(plan.diagnostics, `${label} diagnostics`).toEqual([]);
        expect(plan.hookEntries.length, `${label} planned no wrapper`).toBeGreaterThan(0);
        // The event-route wrapper is module-private; the plan is the only way to render it.
        expect(
          plan.hookEntries.some((entry) => entry.hook.eventRoute !== undefined),
          `${label} planned no event-route wrapper`,
        ).toBe(true);
        for (const entry of plan.hookEntries) {
          expectNoBareLoads(`${label} ${entry.relativePath}`, entry.virtualSource);
        }
      }
    }
  });

  it('install/surface: the verbatim installer of every target that emits one', () => {
    const targets: readonly BuiltInTarget[] = ['claude', 'codex', 'cursor', 'plugin', 'portable'];
    const emitting: string[] = [];
    for (const target of targets) {
      for (const entry of installSurfaceEntries(model(), target)) {
        if (!/\.(?:mjs|js)$/u.test(entry.relativePath)) continue;
        emitting.push(target);
        expectNoBareLoads(`installSurfaceEntries(${target}) ${entry.relativePath}`, entry.content);
      }
    }
    // install.mjs is emitted verbatim, never bundled, so it is scanned as written.
    expect(emitting).toEqual(expect.arrayContaining(['cursor', 'plugin', 'portable']));
  });
});
