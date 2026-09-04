import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import type { AgentBundleConfig } from '../src/core/types.ts';
import { compileRouteGraph } from '../src/routes/graph.ts';
import { routeTaskSupport, toolTaskSupportValues } from '../src/routes/task-support.ts';

/**
 * `config.execution.taskSupport` (#369): the compiler validates the value once
 * per MCP tool route (`AB4836`), and the generated server reads the compiled
 * config through `routeTaskSupport`, treating anything else as the wire
 * default `forbidden`.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const createRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-task-support-')));
  roots.push(root);
  return root;
};

const writeTree = async (root: string, files: Readonly<Record<string, string>>): Promise<void> => {
  for (const [path, contents] of Object.entries(files)) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
  }
};

const config: AgentBundleConfig = { plugin: { name: 'task-support-fixture', version: '1.0.0' } };

const toolModule = (routeConfig?: string): string => [
  "import { z } from 'zod';",
  ...(routeConfig === undefined ? [] : [`export const config = ${routeConfig};`]),
  'export const inputSchema = z.object({});',
  'export const resultSchema = z.object({ ok: z.boolean() });',
  'export default async function Tool() { return undefined; }',
  '',
].join('\n');

const resourceModule = (routeConfig: string): string => [
  "import { z } from 'zod';",
  `export const config = ${routeConfig};`,
  'export const inputSchema = z.object({ uri: z.string() });',
  'export const resultSchema = z.string();',
  'export default async function Resource() { return undefined; }',
  '',
].join('\n');

const codesOf = (diagnostics: readonly { readonly code: string }[]): string[] =>
  diagnostics.map((diagnostic) => diagnostic.code);

describe('config.execution.taskSupport (#369)', () => {
  it('compiles every accepted value and keeps it on the route config the generated server reads', async () => {
    const root = await createRoot();
    await writeTree(root, {
      'src/mcp/alpha/tools/explicit.tsx': toolModule("{ execution: { taskSupport: 'forbidden' } }"),
      'src/mcp/alpha/tools/needed.tsx': toolModule("{ execution: { taskSupport: 'required' } }"),
      'src/mcp/alpha/tools/optional.tsx': toolModule("{ execution: { taskSupport: 'optional' }, title: 'Optional' }"),
      'src/mcp/alpha/tools/plain.tsx': toolModule('{ title: "Plain" }'),
      'src/mcp/alpha/tools/unset.tsx': toolModule('{ execution: {} }'),
    });

    const graph = await compileRouteGraph(root, config);

    expect(graph.diagnostics).toEqual([]);
    const byId = new Map(graph.servers[0]!.routes.map((route) => [route.id, route]));
    expect(routeTaskSupport(byId.get('tool:alpha/explicit')!.config)).toBe('forbidden');
    expect(routeTaskSupport(byId.get('tool:alpha/needed')!.config)).toBe('required');
    expect(routeTaskSupport(byId.get('tool:alpha/optional')!.config)).toBe('optional');
    expect(routeTaskSupport(byId.get('tool:alpha/plain')!.config)).toBe('forbidden');
    expect(routeTaskSupport(byId.get('tool:alpha/unset')!.config)).toBe('forbidden');
    expect(byId.get('tool:alpha/optional')!.config).toEqual({ execution: { taskSupport: 'optional' }, title: 'Optional' });
  });

  it('errors with AB4836 on a malformed declaration, an unknown value, or one outside a tool route', async () => {
    const root = await createRoot();
    await writeTree(root, {
      'src/mcp/alpha/resources/notes.tsx': resourceModule("{ execution: { taskSupport: 'optional' }, uri: 'alpha://notes' }"),
      'src/mcp/alpha/tools/shape.tsx': toolModule("{ execution: 'optional' }"),
      'src/mcp/alpha/tools/unknown-key.tsx': toolModule("{ execution: { taskSupport: 'optional', timeoutMs: 5 } }"),
      'src/mcp/alpha/tools/value.tsx': toolModule("{ execution: { taskSupport: 'always' } }"),
    });

    const graph = await compileRouteGraph(root, config);

    expect(codesOf(graph.diagnostics)).toEqual(['AB4836', 'AB4836', 'AB4836', 'AB4836']);
    expect(graph.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      expect.stringContaining('MCP route src/mcp/alpha/resources/notes.tsx declares config.execution, which only tool routes accept'),
      expect.stringContaining('MCP route src/mcp/alpha/tools/shape.tsx config.execution must be an object'),
      expect.stringContaining('MCP route src/mcp/alpha/tools/unknown-key.tsx config.execution declares unknown key "timeoutMs"; only taskSupport is accepted'),
      expect.stringContaining('MCP route src/mcp/alpha/tools/value.tsx config.execution.taskSupport must be one of "forbidden", "optional", "required"; got "always"'),
    ]);
    for (const diagnostic of graph.diagnostics) {
      expect(diagnostic.severity).toBe('error');
      expect(diagnostic.recovery).toContain("taskSupport: 'forbidden' | 'optional' | 'required'");
    }
    expect(graph.diagnostics[1]!.sourcePath).toBe(join(root, 'src/mcp/alpha/tools/shape.tsx'));
  });

  it('reads only a well-formed compiled value at run time', () => {
    expect(toolTaskSupportValues).toEqual(['forbidden', 'optional', 'required']);
    expect(routeTaskSupport({})).toBe('forbidden');
    expect(routeTaskSupport({ execution: null })).toBe('forbidden');
    expect(routeTaskSupport({ execution: { taskSupport: 'sometimes' } })).toBe('forbidden');
    expect(routeTaskSupport({ execution: { taskSupport: 'required' } })).toBe('required');
  });
});
