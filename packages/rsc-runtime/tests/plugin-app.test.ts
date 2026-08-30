import { describe, expect, it } from '@rstest/core';
import { createElement } from 'react';
import { z } from 'zod';

import {
  AgentBundle,
  McpApp,
  McpServer,
  Operation,
  Script,
  Skill,
  defineOperation,
  defineRscAgentBundle,
  runRscCli,
  type McpAppProps,
} from '../src/index.js';

const statusOperation = defineOperation({
  cli: {
    name: 'status',
    parse: (argv) => ({ subject: argv[0] ?? 'library' }),
    summary: 'Read curator status.',
    usage: 'status [subject]',
  },
  execute: async (input: { readonly subject: string }) => ({
    message: `${input.subject} ready`,
    operation: 'status' as const,
  }),
  id: 'status',
  inputSchema: z.object({ subject: z.string().min(1) }).strict(),
  mcp: {
    description: 'Read curator status.',
    name: 'curator_status',
    readOnly: true,
    server: 'curator',
  },
  render: (result) => createElement(
    'mcp-result',
    { structuredContent: result },
    createElement('mcp-text', null, result.message),
  ),
  resultSchema: z.object({
    message: z.string(),
    operation: z.literal('status'),
  }).strict(),
});

const applicationNode = () => createElement(
  AgentBundle,
  {
    description: 'Curate audiobooks.',
    name: 'audiobook-curator',
    targets: ['claude', 'codex'],
    version: '1.0.0',
  },
  createElement(Skill, { source: './skills/curate-audiobooks' }),
  createElement(Script, { entry: './src/cli-entry.ts', name: 'audiobook-curator' }),
  createElement(McpServer, { entry: './src/mcp-server.ts', name: 'curator' }),
  createElement(Operation, { definition: statusOperation }),
);

describe('RSC plugin applications', () => {
  it('lowers one tree into an exact Agent Bundle config and operation registry', () => {
    const application = defineRscAgentBundle(applicationNode());

    expect(application.config).toEqual({
      mcp: {
        servers: {
          curator: {
            entry: './src/mcp-server.ts',
            targets: ['claude', 'codex'],
          },
        },
      },
      plugin: {
        description: 'Curate audiobooks.',
        name: 'audiobook-curator',
        version: '1.0.0',
      },
      scripts: {
        'audiobook-curator': {
          entry: './src/cli-entry.ts',
          targets: ['claude', 'codex'],
        },
      },
      skills: ['./skills/curate-audiobooks'],
      targets: ['claude', 'codex'],
    });
    expect(application.operations).toEqual([statusOperation]);
    expect(Object.isFrozen(application)).toBe(true);
    expect(Object.isFrozen(application.config)).toBe(true);
    expect(Object.isFrozen(application.operations)).toBe(true);
  });

  it('runs root help, command help, and execution from the shared operation', async () => {
    const application = defineRscAgentBundle(applicationNode());
    const output: string[] = [];

    await expect(runRscCli(application, ['--help'], { write: (value) => output.push(value) })).resolves.toBe(0);
    expect(output.join('')).toContain('status [subject]');

    output.length = 0;
    await expect(runRscCli(application, ['status', '--help'], { write: (value) => output.push(value) })).resolves.toBe(0);
    expect(output.join('')).toContain('Read curator status.');

    output.length = 0;
    await expect(runRscCli(application, ['status', 'collection'], { write: (value) => output.push(value) })).resolves.toBe(0);
    expect(JSON.parse(output.join(''))).toEqual({ message: 'collection ready', operation: 'status' });
  });

  it('rejects duplicate operation, script, server, and skill ownership', () => {
    const duplicates = [
      createElement(Operation, { definition: statusOperation }),
      createElement(Script, { entry: './src/other.ts', name: 'audiobook-curator' }),
      createElement(McpServer, { entry: './src/other-server.ts', name: 'curator' }),
      createElement(Skill, { source: './skills/curate-audiobooks' }),
    ];

    for (const duplicate of duplicates) {
      expect(() => defineRscAgentBundle(
        createElement(
          AgentBundle,
          { name: 'audiobook-curator', targets: ['claude'], version: '1.0.0' },
          ...applicationNode().props.children,
          duplicate,
        ),
      )).toThrow(/duplicate/iu);
    }
  });

  it('lowers McpApp children into the owning server apps record', () => {
    const application = defineRscAgentBundle(createElement(
      AgentBundle,
      { name: 'widget-host', targets: ['claude', 'codex'], version: '1.0.0' },
      createElement(
        McpServer,
        { entry: './src/mcp-server.ts', name: 'library' },
        createElement(McpApp, {
          _meta: { ui: { prefersBorder: true } },
          entry: './views/widget.ts',
          name: 'widget',
          resourceUri: 'ui://widget-host/widget.html',
          targets: ['claude'],
          template: './views/widget.html',
        }),
      ),
    ));

    expect(application.config.mcp).toEqual({
      servers: {
        library: {
          apps: {
            widget: {
              _meta: { ui: { prefersBorder: true } },
              entry: './views/widget.ts',
              resourceUri: 'ui://widget-host/widget.html',
              targets: ['claude'],
              template: './views/widget.html',
            },
          },
          entry: './src/mcp-server.ts',
          targets: ['claude', 'codex'],
        },
      },
    });
    const apps = application.config.mcp?.servers['library']?.apps;
    expect(Object.isFrozen(apps)).toBe(true);
    expect(Object.isFrozen(apps?.['widget'])).toBe(true);
    expect(Object.isFrozen(apps?.['widget']?._meta)).toBe(true);
  });

  it('shares one identical app across servers and rejects conflicting redeclarations', () => {
    const widget = (overrides: Partial<McpAppProps> = {}) => createElement(McpApp, {
      entry: './views/widget.ts',
      name: 'widget',
      resourceUri: 'ui://widget-host/widget.html',
      ...overrides,
    });
    const bundle = (...serverChildren: readonly (readonly [string, ReturnType<typeof widget>])[]) =>
      defineRscAgentBundle(createElement(
        AgentBundle,
        { name: 'widget-host', targets: ['claude'], version: '1.0.0' },
        ...serverChildren.map(([name, app]) => createElement(McpServer, { entry: `./src/${name}.ts`, name }, app)),
      ));

    const shared = bundle(['library', widget()], ['public', widget()]);
    expect(shared.config.mcp?.servers['library']?.apps?.['widget']).toEqual(
      shared.config.mcp?.servers['public']?.apps?.['widget'],
    );

    expect(() => bundle(['library', widget()], ['public', widget({ entry: './views/other.ts' })])).toThrow(
      'MCP app widget on server public does not match its declaration on another server',
    );
    expect(() => bundle(['library', widget()], ['public', widget({ name: 'copycat' })])).toThrow(
      'MCP app resource URI ui://widget-host/widget.html is already declared by app widget',
    );
  });

  it('rejects malformed app declarations at lowering time', () => {
    const appHost = (...children: readonly ReturnType<typeof createElement>[]) => () => defineRscAgentBundle(createElement(
      AgentBundle,
      { name: 'widget-host', targets: ['claude'], version: '1.0.0' },
      createElement(McpServer, { entry: './src/mcp-server.ts', name: 'library' }, ...children),
    ));
    const app = (overrides: Partial<McpAppProps>) => createElement(McpApp, {
      entry: './views/widget.ts',
      name: 'widget',
      resourceUri: 'ui://widget-host/widget.html',
      ...overrides,
    });

    expect(appHost(app({}), app({ resourceUri: 'ui://widget-host/other.html' }))).toThrow(
      'RSC plugin definition contains a duplicate MCP app name on server library',
    );
    expect(appHost(createElement(Skill, { source: './skills/misplaced' }))).toThrow(
      'MCP server library contains unsupported child rsc-agent-skill',
    );
    expect(appHost(app({ name: 'Widget' }))).toThrow(
      'MCP server library app name must be a stable lowercase kebab-case identifier',
    );
    expect(appHost(app({ resourceUri: 'https://example.test/widget.html' }))).toThrow(
      'MCP app widget resourceUri must use ui:// with a nonempty host',
    );
    expect(appHost(app({ targets: ['codex'] }))).toThrow('MCP app widget targets selects an undeclared target');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(appHost(app({ _meta: cyclic }))).toThrow(
      'MCP app widget _meta must be JSON-serializable (cyclic value at self)',
    );
    expect(appHost(app({ entry: '../views/widget.ts' }))).toThrow(
      'MCP app widget entry must be a contained project-relative path',
    );
  });

  it('preserves listing title and _meta on the frozen MCP definition without sharing the caller object', () => {
    const metadata: Record<string, unknown> = { ui: { resourceUri: 'ui://curator/widget.html' } };
    const withExtras = (mcp: Record<string, unknown>) => defineOperation({
      execute: async () => ({ ok: true }),
      id: 'extras',
      inputSchema: z.object({}).strict(),
      mcp: {
        description: 'Extras probe.',
        name: 'extras',
        readOnly: true,
        server: 'curator',
        ...mcp,
      },
      render: () => createElement('mcp-result', null, createElement('mcp-text', null, 'ok')),
      resultSchema: z.object({ ok: z.boolean() }).strict(),
    });

    const operation = withExtras({ _meta: metadata, title: 'Extras' });
    (metadata.ui as Record<string, unknown>).resourceUri = 'ui://curator/changed.html';
    expect(operation.mcp?.title).toBe('Extras');
    expect(operation.mcp?._meta).toEqual({ ui: { resourceUri: 'ui://curator/widget.html' } });
    expect(Object.isFrozen(operation.mcp?._meta)).toBe(true);
    expect(Object.isFrozen(operation.mcp?._meta?.ui)).toBe(true);

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => withExtras({ _meta: cyclic })).toThrow(
      'Operation extras MCP _meta must be JSON-serializable (cyclic value at self)',
    );
    expect(() => withExtras({ title: '   ' })).toThrow('Operation extras MCP title must be non-empty and bounded');
  });

  it('rejects operations whose MCP owner does not exist', () => {
    expect(() => defineRscAgentBundle(
      createElement(
        AgentBundle,
        { name: 'audiobook-curator', targets: ['claude'], version: '1.0.0' },
        createElement(Operation, { definition: statusOperation }),
      ),
    )).toThrow('Operation status references unknown MCP server curator');
  });
});
