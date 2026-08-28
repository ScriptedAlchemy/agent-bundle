import { describe, expect, it } from '@rstest/core';
import { createElement } from 'react';
import { z } from 'zod';

import {
  AgentBundle,
  McpServer,
  Operation,
  Script,
  Skill,
  defineOperation,
  defineRscAgentBundle,
  runRscCli,
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
