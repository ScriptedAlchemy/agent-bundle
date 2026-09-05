import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import { layoutRouteName } from '../src/routes/layouts.ts';
import {
  mcpRouteProtocolKinds,
  mcpRouteProtocolName,
  parseMcpRouteProtocolId,
  type McpRouteProtocolKind,
} from '../src/routes/protocol-name.ts';

const namesByKind = {
  app: 'dashboard',
  prompt: 'brief',
  resource: 'notes',
  tool: 'hauler_status',
} as const satisfies Record<McpRouteProtocolKind, string>;

describe('mcpRouteProtocolKinds', () => {
  it('names every generated MCP route kind whose id is <kind>:<server>/<name>', () => {
    expect([...mcpRouteProtocolKinds]).toEqual(['app', 'prompt', 'resource', 'tool']);
    expect(Object.isFrozen(mcpRouteProtocolKinds)).toBe(true);
  });
});

describe('parseMcpRouteProtocolId', () => {
  it('parses every MCP kind into kind, server, and protocol name', () => {
    for (const kind of mcpRouteProtocolKinds) {
      expect(parseMcpRouteProtocolId(`${kind}:hauler/${namesByKind[kind]}`)).toEqual({
        kind,
        name: namesByKind[kind],
        server: 'hauler',
      });
    }
  });

  it('accepts inner ".", "_", and "-" in both identity segments', () => {
    expect(parseMcpRouteProtocolId('tool:notice-inbox/read_item.v2')).toEqual({
      kind: 'tool',
      name: 'read_item.v2',
      server: 'notice-inbox',
    });
  });

  it('accepts harness module-direct ids that keep a canonical shape', () => {
    expect(parseMcpRouteProtocolId('tool:harness/echo (module)')).toEqual({
      kind: 'tool',
      name: 'echo (module)',
      server: 'harness',
    });
  });

  it('rejects missing, extra, or empty id segments', () => {
    const rejected = [
      '',
      'inspect',
      'tool:inspect',
      'tool:/inspect',
      'tool:hauler/',
      'tool:hauler/inspect/extra',
      'tool:mcp:hauler/inspect',
      ':hauler/inspect',
      'cli:library/audit',
      'event:tool/after',
      'script:tooling-summary',
      'layout:mcp:hauler',
      '(module passed to renderRoute)',
    ];
    for (const routeId of rejected) {
      expect(parseMcpRouteProtocolId(routeId), routeId).toBeUndefined();
    }
  });
});

describe('mcpRouteProtocolName', () => {
  it('derives the wire name for every MCP kind', () => {
    for (const kind of mcpRouteProtocolKinds) {
      expect(mcpRouteProtocolName(`${kind}:hauler/${namesByKind[kind]}`)).toBe(namesByKind[kind]);
    }
  });

  it('derives reserved and hyphenated protocol names', () => {
    expect(mcpRouteProtocolName('tool:curator/notice-inbox')).toBe('notice-inbox');
    expect(mcpRouteProtocolName('app:curator/dashboard')).toBe('dashboard');
  });

  it('throws TypeError for a non-canonical id', () => {
    expect(() => mcpRouteProtocolName('cli:library/audit')).toThrow(TypeError);
    expect(() => mcpRouteProtocolName('tool:inspect')).toThrow(
      'Expected a canonical MCP route id (<kind>:<server>/<name>); got "tool:inspect".',
    );
    expect(() => mcpRouteProtocolName('(module passed to renderRoute)')).toThrow(TypeError);
  });
});

describe('layoutRouteName', () => {
  it('uses the MCP protocol name for tool, resource, prompt, and app routes', () => {
    expect(layoutRouteName({ id: 'tool:hauler/hauler_status', kind: 'tool' })).toBe('hauler_status');
    expect(layoutRouteName({ id: 'resource:hauler/notes', kind: 'resource' })).toBe('notes');
    expect(layoutRouteName({ id: 'prompt:hauler/brief', kind: 'prompt' })).toBe('brief');
    expect(layoutRouteName({ id: 'app:hauler/dashboard', kind: 'app' })).toBe('dashboard');
  });

  it('keeps CLI, script, and event identity rules off the MCP helper', () => {
    expect(layoutRouteName({ id: 'cli:library/audit', kind: 'cli' })).toBe('library audit');
    expect(layoutRouteName({ id: 'script:tooling-summary', kind: 'script' })).toBe('tooling-summary');
    expect(layoutRouteName({ id: 'event:tool/after', kind: 'event-route' })).toBe('tool/after');
  });
});

it('is a zero-import browser-safe leaf', async () => {
  const source = await readFile(
    join(process.cwd(), 'packages/agent-bundle/src/routes/protocol-name.ts'),
    'utf8',
  );
  expect(source).not.toMatch(/^import\b/mu);
});
