import { describe, expect, it } from '@rstest/core';

import type { McpAppJsonValue, McpAppToolDefinition } from '../src/dev/mcp-apps/mcp-app-binding-service.ts';
import {
  appNameOf,
  openApp,
  parseAppSelector,
  requireJsonObject,
  type AppSelectionSource,
} from '../src/web-host/select-app.ts';

const statusUri = 'ui://mcp-app-example/status.html';
const reportUri = 'ui://mcp-app-example/reports/status.html';
const dashboardUri = 'ui://mcp-app-example/dashboard.html';

const tool = (name: string, resourceUri?: string): McpAppToolDefinition => Object.freeze({
  ...(resourceUri === undefined ? {} : { _meta: { ui: { resourceUri } } }),
  description: `${name} tool`,
  inputSchema: { type: 'object' },
  name,
});

interface FakeSource extends AppSelectionSource {
  readonly calls: readonly Readonly<{ input: Readonly<Record<string, McpAppJsonValue>>; name: string }>[];
}

const sourceOf = (
  tools: readonly McpAppToolDefinition[],
  resourceUris: readonly string[],
  result: McpAppJsonValue = { structuredContent: { status: 'healthy' } },
): FakeSource => {
  const calls: Readonly<{ input: Readonly<Record<string, McpAppJsonValue>>; name: string }>[] = [];
  return {
    calls,
    callTool: async (name, input) => {
      calls.push({ input, name });
      return result;
    },
    listAppResourceUris: async () => resourceUris,
    listToolDefinitions: async () => tools,
  };
};

describe('parseAppSelector', () => {
  it('splits <server>/<app> and <server>/ui://... selectors', () => {
    expect(parseAppSelector('status/status')).toEqual({ name: 'status', server: 'status' });
    expect(parseAppSelector('  status/dashboard  ')).toEqual({ name: 'dashboard', server: 'status' });
    expect(parseAppSelector(`status/${reportUri}`)).toEqual({ resourceUri: reportUri, server: 'status' });
    expect(Object.isFrozen(parseAppSelector('status/status'))).toBe(true);
  });

  it('rejects anything that is not one server and one App', () => {
    expect(() => parseAppSelector('')).toThrow(/must be named as <server>\/<app> or a ui:\/\/ resource URI/u);
    expect(() => parseAppSelector('status')).toThrow(/"status" must be named as <server>\/<app>/u);
    expect(() => parseAppSelector('/status')).toThrow(/must be named as <server>\/<app>/u);
    expect(() => parseAppSelector('status/')).toThrow(/must be named as <server>\/<app>/u);
    expect(() => parseAppSelector('status/a/b')).toThrow(/MCP App name "a\/b" must not contain a slash/u);
  });
});

describe('appNameOf', () => {
  it('names an App by the last path segment of its ui:// URI, without the .html suffix', () => {
    expect(appNameOf(statusUri)).toBe('status');
    expect(appNameOf(reportUri)).toBe('status');
    expect(appNameOf('ui://example/Report.HTM')).toBe('Report');
    expect(appNameOf('ui://example/plain')).toBe('plain');
  });

  it('has no name for a non-App URI', () => {
    expect(appNameOf('https://example.com/status.html')).toBeUndefined();
    expect(appNameOf('not a url')).toBeUndefined();
    expect(appNameOf('ui://example')).toBeUndefined();
  });
});

describe('openApp', () => {
  it('resolves an App by name, picks its only opening tool, and calls it once with canonical input', async () => {
    const source = sourceOf([tool('show-status', statusUri), tool('unrelated')], [statusUri]);
    const selection = await openApp(source, { input: { service: 'compiler' }, name: 'status', server: 'status' });
    expect(selection).toEqual({
      input: { service: 'compiler' },
      resourceUri: statusUri,
      result: { structuredContent: { status: 'healthy' } },
      server: 'status',
      tool: tool('show-status', statusUri),
    });
    expect(Object.isFrozen(selection)).toBe(true);
    expect(source.calls).toEqual([{ input: { service: 'compiler' }, name: 'show-status' }]);
  });

  it('defaults the opening input to an empty object', async () => {
    const source = sourceOf([tool('show-status', statusUri)], [statusUri]);
    const selection = await openApp(source, { name: 'status', server: 'status' });
    expect(selection.input).toEqual({});
    expect(source.calls).toEqual([{ input: {}, name: 'show-status' }]);
  });

  it('takes a known resource URI without name matching, but only one the server serves', async () => {
    const source = sourceOf([tool('show-status', statusUri), tool('show-report', reportUri)], [statusUri, reportUri]);
    const selection = await openApp(source, { resourceUri: reportUri, server: 'status' });
    expect(selection.resourceUri).toBe(reportUri);
    expect(selection.tool.name).toBe('show-report');
    // The URI wins over a conflicting name.
    expect((await openApp(source, { name: 'dashboard', resourceUri: statusUri, server: 'status' })).resourceUri).toBe(statusUri);
    await expect(openApp(source, { resourceUri: dashboardUri, server: 'status' })).rejects.toThrow(
      `MCP server "status" serves no MCP App "${dashboardUri}"; available: status/status, status/status.`,
    );
    expect(source.calls).toHaveLength(2);
  });

  it('names the Apps the server serves when the requested one is missing, and says so when it serves none', async () => {
    await expect(openApp(sourceOf([tool('show-status', statusUri)], [statusUri]), { name: 'dashboard', server: 'status' }))
      .rejects.toThrow('MCP server "status" serves no MCP App "dashboard"; available: status/status.');
    await expect(openApp(sourceOf([tool('show-status', statusUri)], []), { name: 'status', server: 'status' }))
      .rejects.toThrow('MCP server "status" serves no MCP App "status" (it serves no MCP App resources).');
  });

  it('refuses an ambiguous name and points at the ui:// form', async () => {
    const source = sourceOf([tool('show-status', statusUri), tool('show-report', reportUri)], [statusUri, reportUri]);
    await expect(openApp(source, { name: 'status', server: 'status' })).rejects.toThrow(
      `MCP App "status" names 2 resources on server "status"; use status/<ui://...> to select one of: ${statusUri}, ${reportUri}.`,
    );
    expect(source.calls).toEqual([]);
  });

  it('requires a name or a resource URI', async () => {
    const source = sourceOf([tool('show-status', statusUri)], [statusUri]);
    await expect(openApp(source, { server: 'status' })).rejects.toThrow(/must be named as <server>\/<app> or a ui:\/\/ resource URI/u);
    expect(source.calls).toEqual([]);
  });

  describe('opening tool', () => {
    it('must be chosen when several tools open the App', async () => {
      const source = sourceOf([tool('show-status', statusUri), tool('refresh-status', statusUri)], [statusUri]);
      await expect(openApp(source, { name: 'status', server: 'status' })).rejects.toThrow(
        `Several tools open MCP App ${statusUri} (show-status, refresh-status); choose one with --tool.`,
      );
      const selection = await openApp(source, { name: 'status', server: 'status', tool: 'refresh-status' });
      expect(selection.tool.name).toBe('refresh-status');
      expect(source.calls).toEqual([{ input: {}, name: 'refresh-status' }]);
    });

    it('must exist when no tool declares the App', async () => {
      const source = sourceOf([tool('unrelated'), tool('other-app', dashboardUri)], [statusUri]);
      await expect(openApp(source, { name: 'status', server: 'status' })).rejects.toThrow(
        `No tool on server "status" declares _meta.ui.resourceUri ${statusUri}.`,
      );
      await expect(openApp(source, { name: 'status', server: 'status', tool: 'unrelated' })).rejects.toThrow(
        `Tool "unrelated" does not open MCP App ${statusUri}.`,
      );
    });

    it('must open this App when named explicitly', async () => {
      const source = sourceOf([tool('show-status', statusUri), tool('other-app', dashboardUri)], [statusUri, dashboardUri]);
      await expect(openApp(source, { name: 'status', server: 'status', tool: 'other-app' })).rejects.toThrow(
        `Tool "other-app" does not open MCP App ${statusUri}; tools that do: show-status.`,
      );
      await expect(openApp(source, { name: 'status', server: 'status', tool: 'missing-tool' })).rejects.toThrow(
        `Tool "missing-tool" does not open MCP App ${statusUri}; tools that do: show-status.`,
      );
      expect(source.calls).toEqual([]);
    });

    it('ignores a tool whose _meta.ui.resourceUri is not a ui:// URI', async () => {
      const source = sourceOf([tool('show-status', 'https://example.com/status.html'), tool('open-status', statusUri)], [statusUri]);
      expect((await openApp(source, { name: 'status', server: 'status' })).tool.name).toBe('open-status');
    });
  });

  it('rejects an opening input that is not a JSON object before calling anything', async () => {
    const source = sourceOf([tool('show-status', statusUri)], [statusUri]);
    await expect(openApp(source, { input: { when: new Date(0) } as unknown as Record<string, unknown>, name: 'status', server: 'status' }))
      .rejects.toThrow(TypeError);
    await expect(openApp(source, { input: { size: Number.NaN }, name: 'status', server: 'status' })).rejects.toThrow(TypeError);
    expect(source.calls).toEqual([]);
  });
});

describe('requireJsonObject', () => {
  it('returns a detached canonical object and names the offending label otherwise', () => {
    const input = { nested: { list: [1, 'two', null] } };
    const snapshot = requireJsonObject(input, 'MCP App tool input');
    expect(snapshot).toEqual(input);
    expect(snapshot).not.toBe(input);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => requireJsonObject([], 'MCP App tool input')).toThrow('MCP App tool input must be a JSON object.');
    expect(() => requireJsonObject('text', 'MCP App tool arguments')).toThrow('MCP App tool arguments must be a JSON object.');
    expect(() => requireJsonObject({ size: Number.POSITIVE_INFINITY }, 'MCP App tool input'))
      .toThrow('MCP App tool input must contain only ordinary finite JSON values.');
  });
});
