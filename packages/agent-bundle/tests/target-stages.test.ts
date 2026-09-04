import { rspack } from '@rslib/core';
import { describe, expect, it } from '@rstest/core';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generatedMetaModulePath, metaModuleSpecifier } from '../src/build/meta.ts';
import { buildRslibSurfaces, compileRslibSurfaces, entryLibId, settledRslibSurface, type RslibEntry } from '../src/build/rslib.ts';
import { planTargetStages } from '../src/build/target-stages.ts';
import type { AgentBundleMeta } from '../src/meta.ts';

const meta: AgentBundleMeta = Object.freeze({
  name: 'stages-fixture',
  packageName: undefined,
  packageVersion: undefined,
  version: '1.0.0',
});

const root = '/staged/claude';

describe('planTargetStages', () => {
  const nodeOutputs = {
    compiledCliBins: [{ output: `${root}/bin/tool.mjs`, workerOutput: `${root}/bin/tool-flight.mjs` }],
    compiledEntries: [
      { output: `${root}/scripts/report.mjs`, outputKind: 'bundle' as const, workerOutput: `${root}/scripts/report-flight.mjs` },
      { output: `${root}/scripts/notes.md`, outputKind: 'copy' as const },
    ],
    compiledHooks: [
      { output: `${root}/hooks/event-route-stop.mjs`, workerOutput: `${root}/hooks/hooks-flight.mjs` },
      { output: `${root}/hooks/event-route-tool-before.mjs` },
    ],
    compiledMcpEntries: [{ output: `${root}/mcp/server.mjs`, workerOutput: `${root}/mcp/server-flight.mjs` }],
  };

  it('skips the browser stage entirely for a target without MCP Apps and lowers every host surface in one node stage', () => {
    const stages = planTargetStages({ ...nodeOutputs, compiledMcpApps: [] });
    expect(stages.map((stage) => stage.kind)).toEqual(['node-surfaces']);
    expect(stages[0]!.outputs).toEqual([
      `${root}/bin/tool.mjs`,
      `${root}/bin/tool-flight.mjs`,
      `${root}/scripts/report.mjs`,
      `${root}/scripts/report-flight.mjs`,
      `${root}/hooks/event-route-stop.mjs`,
      `${root}/hooks/hooks-flight.mjs`,
      `${root}/hooks/event-route-tool-before.mjs`,
      `${root}/mcp/server.mjs`,
      `${root}/mcp/server-flight.mjs`,
    ]);
  });

  it('runs the browser stage before the node stage only when the target declares MCP Apps', () => {
    const stages = planTargetStages({
      ...nodeOutputs,
      compiledMcpApps: [{ output: `${root}/mcp-apps/dashboard.html` }],
    });
    expect(stages.map((stage) => stage.kind)).toEqual(['mcp-apps', 'node-surfaces']);
    expect(stages[0]!.outputs).toEqual([`${root}/mcp-apps/dashboard.html`]);
    // Copied scripts are emitted, not compiled: they belong to no stage.
    expect(stages[1]!.outputs).not.toContain(`${root}/scripts/notes.md`);
  });

  it('keeps each react-server Flight worker in the same stage as the host surface that spawns it', () => {
    const [stage] = planTargetStages({ ...nodeOutputs, compiledMcpApps: [] });
    for (const [host, worker] of [
      [`${root}/bin/tool.mjs`, `${root}/bin/tool-flight.mjs`],
      [`${root}/scripts/report.mjs`, `${root}/scripts/report-flight.mjs`],
      [`${root}/hooks/event-route-stop.mjs`, `${root}/hooks/hooks-flight.mjs`],
      [`${root}/mcp/server.mjs`, `${root}/mcp/server-flight.mjs`],
    ]) {
      expect(stage!.outputs).toContain(host);
      expect(stage!.outputs).toContain(worker);
    }
  });

  it('plans an empty node stage for a target with nothing to compile', () => {
    expect(planTargetStages({
      compiledCliBins: [],
      compiledEntries: [],
      compiledHooks: [],
      compiledMcpApps: [],
      compiledMcpEntries: [],
    })).toEqual([{ kind: 'node-surfaces', outputs: [] }]);
  });
});

/**
 * A stubbed Rslib resolution carrying what a real one would for every
 * generated executable: the virtual-module plugin instance and the exact
 * match alias of the framework identity module.
 */
const resolvedEnvironment = (projectRoot: string, outputRoot: string, entry: RslibEntry) => ({
  bundler: {
    name: entryLibId(entry),
    output: { asyncChunks: false, path: outputRoot },
    plugins: [new rspack.experiments.VirtualModulesPlugin({})],
    resolve: { alias: { [`${metaModuleSpecifier}$`]: generatedMetaModulePath(projectRoot) } },
    target: 'node',
  },
  environment: { output: { cleanDistPath: false } },
});

const surfaceEntry = (name: string, outputRelativePath: string, source: string): RslibEntry => ({
  name,
  outputRelativePath,
  source,
  sourceInputs: [source],
});

describe('buildRslibSurfaces', () => {
  it('lowers every surface of a target through one Rslib instance and hands each surface its own evidence', async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-target-stages-'));
    const project = '/project';
    const surfaces = [
      { entries: [surfaceEntry('bin-tool', 'bin/tool.mjs', `${project}/src/cli/index.ts`)], ignoredSourcePaths: [`${project}/runtime/cli`] },
      { entries: [surfaceEntry('report', 'scripts/report.mjs', `${project}/src/scripts/report.ts`)] },
      {
        entries: [
          surfaceEntry('hooks-event-route-stop', 'hooks/event-route-stop.mjs', `${project}/src/hooks/stop.ts`),
          surfaceEntry('hooks-flight', 'hooks/hooks-flight.mjs', `${project}/src/hooks/stop.ts`),
        ],
        ignoredSourcePaths: [`${project}/runtime/events`],
        logLevel: 'silent' as const,
      },
      { entries: [surfaceEntry('mcp-server', 'mcp/server.mjs', `${project}/src/mcp/server.ts`)], logLevel: 'error' as const },
    ];
    const entries = surfaces.flatMap((surface) => surface.entries);
    const instances: { readonly config: { readonly lib: readonly { readonly id?: string }[]; readonly logLevel?: string } }[] = [];
    const rslib = {
      build: async () => ({
        close: async () => undefined,
        stats: {
          toJson: () => ({
            // One child compilation per environment, exactly as a multi-compiler reports.
            children: entries.map((entry) => ({
              assets: [{ chunks: [entry.name], name: entry.outputRelativePath }],
              modules: [
                { chunks: [entry.name], nameForCondition: entry.source },
                // Runtime modules inlined into some surfaces but not others:
                // each surface's own exclusion decides whether they count.
                { chunks: [entry.name], nameForCondition: `${project}/runtime/cli/shell.ts` },
                { chunks: [entry.name], nameForCondition: `${project}/runtime/events/ipc.ts` },
              ],
            })),
          }),
        },
      }),
      inspectConfig: async () => ({
        origin: {
          bundlerConfigs: entries.map((entry) => resolvedEnvironment(project, outputRoot, entry).bundler),
          environmentConfigs: Object.fromEntries(entries.map((entry) => [
            entryLibId(entry),
            resolvedEnvironment(project, outputRoot, entry).environment,
          ])),
        },
      }),
    };
    try {
      for (const entry of entries) {
        await mkdir(join(outputRoot, entry.outputRelativePath, '..'), { recursive: true });
        await writeFile(join(outputRoot, entry.outputRelativePath), 'export default undefined;\n');
      }
      const evidence = await buildRslibSurfaces({ cwd: project, meta, outputRoot }, surfaces, {
        createRslib: async (options) => {
          instances.push(options as never);
          return rslib as never;
        },
      });

      // One instance, one environment per entry across all four surfaces,
      // reporting at the most verbose level any surface asked for.
      expect(instances).toHaveLength(1);
      expect(instances[0]!.config.lib.map((lib) => lib.id)).toEqual(entries.map(entryLibId));
      expect(instances[0]!.config.logLevel).toBe('error');

      // Evidence comes back per surface, and each surface's exclusions apply
      // only to its own outputs.
      expect(evidence).toEqual([
        [{ path: 'bin/tool.mjs', sourceInputs: [`${project}/runtime/events/ipc.ts`, `${project}/src/cli/index.ts`] }],
        [{
          path: 'scripts/report.mjs',
          sourceInputs: [`${project}/runtime/cli/shell.ts`, `${project}/runtime/events/ipc.ts`, `${project}/src/scripts/report.ts`],
        }],
        [
          { path: 'hooks/event-route-stop.mjs', sourceInputs: [`${project}/runtime/cli/shell.ts`, `${project}/src/hooks/stop.ts`] },
          { path: 'hooks/hooks-flight.mjs', sourceInputs: [`${project}/runtime/cli/shell.ts`, `${project}/src/hooks/stop.ts`] },
        ],
        [{ path: 'mcp/server.mjs', sourceInputs: [`${project}/runtime/cli/shell.ts`, `${project}/runtime/events/ipc.ts`, `${project}/src/mcp/server.ts`] }],
      ]);
    } finally {
      await rm(outputRoot, { force: true, recursive: true });
    }
  });

  it('creates no instance when no surface has entries and settles surfaces with nothing to compile', async () => {
    let created = 0;
    const [bins, evidence] = await Promise.all([
      compileRslibSurfaces({ cwd: '/project', meta, outputRoot: '/staged/claude' }, [settledRslibSurface(['settled'])]),
      buildRslibSurfaces({ cwd: '/project', meta, outputRoot: '/staged/claude' }, [{ entries: [] }, { entries: [] }], {
        createRslib: async () => {
          created += 1;
          throw new Error('unreachable');
        },
      }),
    ]);
    expect(created).toBe(0);
    expect(bins).toEqual([['settled']]);
    expect(evidence).toEqual([[], []]);
  });

  it('lets two surfaces reuse an entry name because lib ids derive from destinations, and refuses a shared destination', async () => {
    const createRslib = async () => { throw new Error('unreachable'); };
    // A script authored as `hooks-flight` beside the hook surface's standalone
    // worker: distinct destinations, distinct ids, one run.
    expect(entryLibId(surfaceEntry('hooks-flight', 'scripts/hooks-flight.mjs', '/project/src/scripts/hooks-flight.ts')))
      .toBe('agent-bundle-scripts-hooks-flight');
    expect(entryLibId(surfaceEntry('hooks-flight', 'hooks/hooks-flight.mjs', '/project/src/hooks/stop.ts')))
      .toBe('agent-bundle-hooks-hooks-flight');
    expect(entryLibId(surfaceEntry('index', 'lib/index.js', '/project/src/index.ts'))).toBe('agent-bundle-lib-index');
    await expect(buildRslibSurfaces({ cwd: '/project', meta, outputRoot: '/staged/claude' }, [
      { entries: [surfaceEntry('tool', 'scripts/tool.mjs', '/project/src/tool.ts')] },
      { entries: [surfaceEntry('other', 'scripts/tool.mjs', '/project/src/hooks/tool.ts')] },
    ], { createRslib }))
      .rejects.toThrow(/same lib id "agent-bundle-scripts-tool" for "scripts\/tool.mjs" and "scripts\/tool.mjs"/u);
  });
});
