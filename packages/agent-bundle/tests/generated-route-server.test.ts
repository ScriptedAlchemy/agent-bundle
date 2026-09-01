import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, expect, it } from '@rstest/core';

import { build } from '../src/api.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const writeProjectFile = async (root: string, path: string, contents: string): Promise<void> => {
  const output = join(root, path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, contents);
};

it('lists and calls a generated filesystem tool through final-only Flight', { retry: 2, timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-generated-routes-'));
  roots.push(root);
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        '@modelcontextprotocol/server': '2.0.0',
        react: '19.2.8',
        zod: '4.4.3',
      },
      name: 'generated-routes-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      "export default defineConfig({ plugin: { name: 'generated-routes-fixture', version: '1.0.0' }, targets: ['portable'] });",
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/curator/resources/catalog.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { description: 'Read the catalog.', mimeType: 'application/json', uri: 'catalog://books' };",
      "export const inputSchema = z.object({ uri: z.string() }).strict();",
      "export const resultSchema = z.object({ contents: z.array(z.object({ mimeType: z.string(), text: z.string(), uri: z.string() })) }).strict();",
      'export default async function Catalog({ input }) {',
      "  const result = { contents: [{ mimeType: 'application/json', text: '{\"books\":1}', uri: input.uri }] };",
      "  return createElement(Agent.Result, { value: result }, createElement(Agent.Text, null, 'Catalog ready.'));",
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/curator/prompts/curate.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { description: 'Curate one genre.' };",
      "export const inputSchema = z.object({ genre: z.string() }).strict();",
      "export const resultSchema = z.object({ messages: z.array(z.object({ content: z.object({ text: z.string(), type: z.literal('text') }), role: z.literal('user') })) }).strict();",
      'export default async function Curate({ input }) {',
      "  const result = { messages: [{ content: { text: `Curate ${input.genre}`, type: 'text' }, role: 'user' }] };",
      "  return createElement(Agent.Result, { value: result }, createElement(Agent.Text, null, 'Prompt ready.'));",
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/curator/apps/dashboard.ts', [
      "export const config = { resourceUri: 'ui://curator/dashboard.html' };",
      "document.body.textContent = 'Curator dashboard';",
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/curator/tools/inspect.tsx', [
      "import { Agent, agent } from '@agent-bundle/runtime';",
      "import { createElement } from 'react';",
      "import { z } from 'zod';",
      "export const config = { annotations: { readOnlyHint: true }, description: 'Inspect one source.' };",
      "export const inputSchema = z.object({ source: z.string() }).strict();",
      "export const resultSchema = z.object({ invocationKind: z.literal('tool'), source: z.string() }).strict();",
      'export default async function Inspect({ input, signal }) {',
      "  if (signal.aborted) throw new DOMException('aborted', 'AbortError');",
      '  const context = await agent();',
      '  const result = { invocationKind: context.invocation.kind, source: input.source };',
      '  return createElement(Agent.Result, { value: result }, createElement(Agent.Markdown, null, `Inspected **${input.source}**.`));',
      '}',
      '',
    ].join('\n')),
  ]);

  const output = join(root, 'artifact');
  const compiled = await build({ output, root, targets: ['portable'] });
  const generatedTypes = await readFile(join(root, '.agent-bundle', 'routes.d.ts'), 'utf8');
  expect(generatedTypes).toContain('tool:curator/inspect');
  expect(generatedTypes).toContain('resource:curator/catalog');
  expect(generatedTypes).toContain('prompt:curator/curate');
  const server = compiled.model.mcpServers[0];
  expect(server).toMatchObject({ id: 'mcp:curator', name: 'curator' });
  const entry = join(output, 'portable', server!.args![0]!);
  const client = new Client({ name: 'generated-route-test', version: '0.0.0' });
  const transport = new StdioClientTransport({ args: [entry], command: process.execPath, stderr: 'pipe' });
  let diagnostics = '';
  transport.stderr?.on('data', (chunk) => { diagnostics += String(chunk); });
  try {
    try {
      await client.connect(transport);
    } catch (error) {
      throw new Error(`Generated route server failed to connect: ${diagnostics}`, { cause: error });
    }
    await expect(client.listTools()).resolves.toMatchObject({
      tools: [{ annotations: { readOnlyHint: true }, description: 'Inspect one source.', name: 'inspect' }],
    });
    await expect(client.callTool({ arguments: { source: 'library' }, name: 'inspect' }, { signal: AbortSignal.timeout(10_000) })).resolves.toMatchObject({
      content: [{ text: 'Inspected **library**.', type: 'text' }],
      structuredContent: { invocationKind: 'tool', source: 'library' },
    });
    await expect(client.listResources()).resolves.toMatchObject({ resources: [
      expect.objectContaining({ uri: 'catalog://books' }),
      expect.objectContaining({ uri: 'ui://curator/dashboard.html' }),
    ] });
    await expect(client.readResource({ uri: 'catalog://books' })).resolves.toEqual({
      contents: [{ mimeType: 'application/json', text: '{"books":1}', uri: 'catalog://books' }],
    });
    await expect(client.listPrompts()).resolves.toMatchObject({ prompts: [
      expect.objectContaining({ description: 'Curate one genre.', name: 'curate' }),
    ] });
    await expect(client.getPrompt({ arguments: { genre: 'mystery' }, name: 'curate' })).resolves.toEqual({
      messages: [{ content: { text: 'Curate mystery', type: 'text' }, role: 'user' }],
    });
  } finally {
    await client.close();
  }
});
