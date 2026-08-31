import { describe, expect, it } from '@rstest/core';
import { createElement } from 'react';
import { z } from 'zod';

import { createRscMcpServer, defineOperation, defineRscApplication, runRscCli } from '../src/index.js';

const operation = (id: string, overrides: { readonly cliName?: string; readonly mcpName?: string } = {}) =>
  defineOperation({
    cli: {
      name: overrides.cliName ?? id,
      parse: () => ({}),
      summary: `${id} summary.`,
      usage: id,
    },
    execute: async () => ({ ok: true }),
    id,
    inputSchema: z.object({}).strict(),
    mcp: {
      description: `${id} tool.`,
      name: overrides.mcpName ?? id,
      readOnly: true,
      server: 'demo',
    },
    render: () => createElement('mcp-result', null, createElement('mcp-text', null, 'ok')),
    resultSchema: z.object({ ok: z.boolean() }).strict(),
  });

describe('defineRscApplication', () => {
  it('returns a frozen application carrying identity and operations', () => {
    const status = operation('status');
    const application = defineRscApplication({
      description: 'Demo application.',
      name: 'demo-app',
      operations: [status],
      version: '1.0.0',
    });

    expect(application).toEqual({
      description: 'Demo application.',
      name: 'demo-app',
      operations: [status],
      version: '1.0.0',
    });
    expect(Object.isFrozen(application)).toBe(true);
    expect(Object.isFrozen(application.operations)).toBe(true);
    expect(Object.hasOwn(defineRscApplication({ name: 'demo-app', operations: [], version: '1.0.0' }), 'description')).toBe(false);
  });

  it('rejects malformed identity fields', () => {
    expect(() => defineRscApplication({ name: 'Demo App', operations: [], version: '1.0.0' }))
      .toThrow('RSC application name must be a canonical lowercase identifier');
    expect(() => defineRscApplication({ name: 'demo-app', operations: [], version: '  ' }))
      .toThrow('RSC application version must be non-empty');
    expect(() => defineRscApplication({ description: ' ', name: 'demo-app', operations: [], version: '1.0.0' }))
      .toThrow('RSC application description must be non-empty when present');
  });

  it('rejects duplicate operation ids, CLI commands, and MCP tools', () => {
    expect(() => defineRscApplication({
      name: 'demo-app',
      operations: [operation('status'), operation('status', { cliName: 'other', mcpName: 'other' })],
      version: '1.0.0',
    })).toThrow('RSC application contains a duplicate operation id');
    expect(() => defineRscApplication({
      name: 'demo-app',
      operations: [operation('status'), operation('other', { cliName: 'status' })],
      version: '1.0.0',
    })).toThrow('RSC application contains a duplicate CLI command');
    expect(() => defineRscApplication({
      name: 'demo-app',
      operations: [operation('status'), operation('other', { mcpName: 'status' })],
      version: '1.0.0',
    })).toThrow('RSC application contains a duplicate MCP tool');
  });

  it('rejects operations not built by defineOperation', () => {
    expect(() => defineRscApplication({
      name: 'demo-app',
      operations: [{ ...operation('status') }],
      version: '1.0.0',
    })).toThrow('RSC application operations must come from defineOperation');
  });
});

describe('runRscCli', () => {
  it('runs root help, command help, and execution from the shared operation', async () => {
    const status = defineOperation({
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
    const application = defineRscApplication({
      description: 'Curate audiobooks.',
      name: 'audiobook-curator',
      operations: [status],
      version: '1.0.0',
    });
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
});

describe('defineOperation MCP extras', () => {
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
});

describe('createRscMcpServer selection', () => {
  it('rejects a server name no operation references', () => {
    const application = defineRscApplication({
      name: 'demo-app',
      operations: [operation('status')],
      version: '1.0.0',
    });
    expect(() => createRscMcpServer(application, 'ghost')).toThrow('Unknown RSC MCP server: ghost');
  });
});
