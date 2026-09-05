import { access, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, FileSystem, PlatformError } from 'effect';
import { afterEach, describe, expect, it } from '@rstest/core';

import { runWithPlatform } from '../src/effect/platform.ts';
import { emptyCompiledRouteGraph } from '../src/routes/graph.ts';
import { generateRouteTypes, routeTypesRelativePath, writeRouteTypes, writeRouteTypesProgram } from '../src/routes/typegen.ts';
import type { CompiledRouteGraph } from '../src/routes/types.ts';

/**
 * `writeRouteTypes` publishes `.agent-bundle/routes.d.ts` with a
 * same-directory rename and never leaves its temporary file behind. The
 * real-filesystem cases pin the published bytes and the cleanup; the
 * `FileSystem.layerNoop` cases pin the call protocol around a failing
 * rename, where the temporary must still be removed and the caller must
 * still see the Node error.
 */
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const scratchRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-typegen-'));
  roots.push(root);
  return root;
};

const oneRouteGraph = (root: string): CompiledRouteGraph => ({
  ...emptyCompiledRouteGraph,
  servers: [{
    id: 'mcp:curator',
    mode: 'generated',
    name: 'curator',
    routes: [{
      config: {},
      id: 'tool:curator/inspect',
      kind: 'tool',
      provenance: { kind: 'conventional', relativePath: 'src/mcp/curator/tools/inspect.tsx' },
      serverId: 'mcp:curator',
      source: join(root, 'src/mcp/curator/tools/inspect.tsx'),
    }],
  }],
});

describe('writeRouteTypes', () => {
  it('publishes the generated declarations and leaves no temporary file', async () => {
    const root = await scratchRoot();
    const graph = oneRouteGraph(root);
    await expect(writeRouteTypes(root, graph)).resolves.toBe(routeTypesRelativePath);
    expect(await readFile(join(root, routeTypesRelativePath), 'utf8')).toBe(generateRouteTypes(graph));
    expect(await readdir(join(root, '.agent-bundle'))).toEqual(['routes.d.ts']);
  });

  it('publishes declarations only, registering the App tool subset exactly when a tool route exists', async () => {
    const root = await scratchRoot();
    await writeRouteTypes(root, oneRouteGraph(root));
    const withTool = await readFile(join(root, routeTypesRelativePath), 'utf8');
    // Every import is type-only, so the published file can never load a route module, Zod, or Node.
    expect(withTool.split('\n').filter((line) => line.startsWith('import'))).toEqual([
      'import type * as route0 from "../src/mcp/curator/tools/inspect.js";',
    ]);
    expect(withTool).toContain("declare module '@agent-bundle/runtime' {\n  interface Register {\n    readonly routes: AgentBundleRouteContracts;\n  }\n}");
    expect(withTool).toContain("declare module 'agent-bundle/app' {\n  interface AppRegister {\n    readonly routes: AgentBundleAppRouteContracts;\n  }\n}");
    expect(withTool.match(/declare module 'agent-bundle\/app'/gu)).toHaveLength(1);
    expect(withTool.match(/"tool:curator\/inspect"/gu)).toHaveLength(1);

    // A prompt is executable, so the file stays published, but it is not a `tools/call` target: the App
    // registration is gone while the runtime registration remains.
    const promptOnly: CompiledRouteGraph = {
      ...emptyCompiledRouteGraph,
      servers: [{
        id: 'mcp:curator',
        mode: 'generated',
        name: 'curator',
        routes: [{
          config: {},
          id: 'prompt:curator/brief',
          kind: 'prompt',
          provenance: { kind: 'conventional', relativePath: 'src/mcp/curator/prompts/brief.ts' },
          serverId: 'mcp:curator',
          source: join(root, 'src/mcp/curator/prompts/brief.ts'),
        }],
      }],
    };
    await expect(writeRouteTypes(root, promptOnly)).resolves.toBe(routeTypesRelativePath);
    const withoutTool = await readFile(join(root, routeTypesRelativePath), 'utf8');
    expect(withoutTool).toBe(generateRouteTypes(promptOnly));
    expect(withoutTool).toContain('"prompt:curator/brief": RouteContract<typeof route0.inputSchema, typeof route0.resultSchema>;');
    expect(withoutTool).toContain("declare module '@agent-bundle/runtime'");
    expect(withoutTool).not.toContain('agent-bundle/app');
    expect(withoutTool).not.toContain('AgentBundleAppRouteContracts');
    expect(await readdir(join(root, '.agent-bundle'))).toEqual(['routes.d.ts']);
  });

  it('removes a stale declaration file when the graph has nothing to type', async () => {
    const root = await scratchRoot();
    await writeRouteTypes(root, oneRouteGraph(root));
    await expect(writeRouteTypes(root, emptyCompiledRouteGraph)).resolves.toBe(routeTypesRelativePath);
    await expect(access(join(root, routeTypesRelativePath))).rejects.toMatchObject({ code: 'ENOENT' });
    // And again when there is nothing to remove.
    await expect(writeRouteTypes(root, emptyCompiledRouteGraph)).resolves.toBe(routeTypesRelativePath);
  });

  it('rejects with the Node error when the declarations directory cannot be created', async () => {
    const root = await scratchRoot();
    await writeFile(join(root, '.agent-bundle'), 'not a directory');
    await expect(writeRouteTypes(root, oneRouteGraph(root))).rejects.toMatchObject({
      code: expect.stringMatching(/^(EEXIST|ENOTDIR)$/u),
      syscall: 'mkdir',
    });
  });

  describe('over FileSystem.layerNoop', () => {
    const exdev: NodeJS.ErrnoException = new Error('EXDEV: cross-device link not permitted, rename');
    exdev.code = 'EXDEV';

    const recordingFileSystem = () => {
      const calls: string[] = [];
      const written = new Map<string, string>();
      const layer = FileSystem.layerNoop({
        makeDirectory: (path) => Effect.sync(() => { calls.push(`makeDirectory ${path}`); }),
        remove: (path, options) => Effect.sync(() => {
          calls.push(`remove ${path} force=${String(options?.force ?? false)} recursive=${String(options?.recursive ?? false)}`);
        }),
        rename: (from, to) => Effect.suspend(() => {
          calls.push(`rename ${from} -> ${to}`);
          return Effect.fail(PlatformError.systemError({
            _tag: 'Unknown',
            cause: exdev,
            method: 'rename',
            module: 'FileSystem',
            pathOrDescriptor: from,
          }));
        }),
        writeFileString: (path, data) => Effect.sync(() => {
          calls.push(`writeFile ${path}`);
          written.set(path, data);
        }),
      });
      return { calls, layer, written };
    };

    it('removes the temporary file and rethrows the Node error when the rename fails', async () => {
      const root = '/virtual/project';
      const graph = oneRouteGraph(root);
      const { calls, layer, written } = recordingFileSystem();
      await expect(runWithPlatform(writeRouteTypesProgram(root, graph).pipe(Effect.provide(layer)))).rejects.toBe(exdev);

      const output = join(root, routeTypesRelativePath);
      expect(calls[0]).toBe(`makeDirectory ${join(root, '.agent-bundle')}`);
      const temporary = calls[1]?.replace(/^writeFile /u, '');
      expect(temporary).toMatch(new RegExp(`^${output.replaceAll('.', '\\.')}\\.${String(process.pid)}\\.[0-9a-f-]{36}\\.tmp$`, 'u'));
      expect(calls.slice(2)).toEqual([
        `rename ${temporary} -> ${output}`,
        `remove ${temporary} force=true recursive=true`,
      ]);
      expect(written.get(temporary!)).toBe(generateRouteTypes(graph));
    });

    it('removes the declaration file, and nothing else, for an empty graph', async () => {
      const root = '/virtual/project';
      const { calls, layer } = recordingFileSystem();
      await expect(runWithPlatform(writeRouteTypesProgram(root, emptyCompiledRouteGraph).pipe(Effect.provide(layer))))
        .resolves.toBe(routeTypesRelativePath);
      expect(calls).toEqual([`remove ${join(root, routeTypesRelativePath)} force=true recursive=false`]);
    });
  });
});
