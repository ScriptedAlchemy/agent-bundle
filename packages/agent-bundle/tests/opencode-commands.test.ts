import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, it } from '@rstest/core';

import { openCodeAdapter, openCodePluginEntrySource } from '../src/adapters/opencode.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';
import { removeTree } from './support/remove-tree.ts';

const configPath = '/workspace/agent-bundle.config.ts';

const model = (): NormalizedPlugin => ({
  projectRoot: '/workspace',
  commands: [{
    body: '$1 / $10 / $ARGUMENTS',
    frontmatter: { description: 'Check positional expansion' },
    id: 'command:positionals',
    markdown: '$1 / $10 / $ARGUMENTS',
    name: 'positionals',
    provenance: { kind: 'conventional', sourcePath: '/workspace/src/commands/positionals.md' },
    source: '/workspace/src/commands/positionals.md',
    targets: ['opencode'],
  }],
  extensions: {},
  hooks: [],
  metadata: {
    id: 'plugin:commands',
    name: 'commands-fixture',
    provenance: { kind: 'config', sourcePath: configPath },
    version: '1.0.0',
  },
  mcpServers: [],
  runtime: { node: '22.19.0' },
  scripts: [],
  skills: [],
  targets: [{ id: 'target:opencode', name: 'opencode', provenance: { kind: 'config', sourcePath: configPath } }],
});

it('expands positional arguments in one literal pass without reprocessing argument text', async () => {
  const selected = model();
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-opencode-command-'));
  try {
    await mkdir(join(root, 'commands'), { recursive: true });
    await writeFile(join(root, 'commands', 'positionals.md'), '$1 / $10 / $ARGUMENTS');
    await writeFile(join(root, 'index.js'), openCodePluginEntrySource(selected, undefined, []));
    const plugin = await import(pathToFileURL(join(root, 'index.js')).href);
    const prompts: Record<string, unknown>[] = [];
    let registered: {
      readonly execute: (input: Record<string, unknown>) => Promise<void>;
    } | undefined;
    await plugin.default.setup({
      location: { directory: '/workspace' },
      command: {
        transform: async (apply: (editor: { add(definition: typeof registered): void }) => void) => {
          apply({ add: (definition) => { registered = definition; } });
          return { dispose: async () => undefined };
        },
      },
      session: {
        prompt: async (input: Record<string, unknown>) => { prompts.push(input); },
      },
    });
    expect(registered).toBeDefined();
    await registered!.execute({
      delivery: 'steer',
      prompt: { text: 'one two three four five six seven eight nine ten $& $$' },
      sessionID: 'session-1',
    });
    expect(prompts).toEqual([expect.objectContaining({
      sessionID: 'session-1',
      text: 'one / ten $& $$ / one two three four five six seven eight nine ten $& $$',
    })]);
  } finally {
    await removeTree(root);
  }
});
