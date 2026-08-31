import { describe, expect, it } from '@rstest/core';
import { createElement } from 'react';
import { z } from 'zod';

import { createRscMcpServer, defineOperation, defineRscApplication } from '../src/index.js';

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
