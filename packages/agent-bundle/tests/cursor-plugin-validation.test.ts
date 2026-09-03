import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, expect, it } from '@rstest/core';

import {
  validateCursorPlugin,
  type CursorPluginCommandRunner,
} from '../src/host-contracts/cursor-plugin-validation.ts';

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const createFixtureRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-cursor-validation-'));
  fixtureRoots.push(root);
  return root;
};

const writeJson = async (root: string, path: string, value: unknown): Promise<void> => {
  const file = join(root, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
};

const createBundle = async (
  documents: Readonly<Record<string, unknown>> = {
    '.cursor-plugin/plugin.json': { name: 'fixture-plugin' },
  },
): Promise<string> => {
  const root = await createFixtureRoot();
  await Promise.all(Object.entries(documents).map(([path, value]) => writeJson(root, path, value)));
  return root;
};

const versionRunner = (): { readonly calls: unknown[]; readonly run: CursorPluginCommandRunner } => {
  const calls: unknown[] = [];
  return {
    calls,
    run: async (request) => {
      calls.push(request);
      return {
        exitCode: 0,
        signal: null,
        stderr: '',
        stdout: '2026.08.31-4057e58\n',
      };
    },
  };
};

it('records the Cursor version and always discloses local pinned-schema validation', async () => {
  const pluginDirectory = await createBundle();
  const fixture = versionRunner();

  const report = await validateCursorPlugin({
    pluginDirectory,
    run: fixture.run,
    target: 'cursor',
  });

  expect(fixture.calls).toEqual([
    expect.objectContaining({
      args: ['--version'],
      executable: 'cursor-agent',
    }),
  ]);
  expect(report).toEqual({
    diagnostics: [expect.objectContaining({
      code: 'AB6026',
      message: expect.stringContaining('070189284e702e8a4d2e3cc8913994b204c5337a'),
      severity: 'info',
      target: 'cursor',
    })],
    host: 'cursor',
    status: 'passed',
    target: 'cursor',
    version: '2026.08.31-4057e58',
  });
  expect(Object.isFrozen(report)).toBe(true);
  expect(Object.isFrozen(report.diagnostics)).toBe(true);
});

it('keeps local validation active when cursor-agent is absent', async () => {
  const validPluginDirectory = await createBundle();
  const invalidPluginDirectory = await createBundle({
    '.cursor-plugin/plugin.json': {
      name: 'fixture-plugin',
      unknownField: true,
    },
  });
  const missing = Object.assign(new Error('spawn cursor-agent ENOENT'), { code: 'ENOENT' });

  const unavailable = await validateCursorPlugin({
    pluginDirectory: validPluginDirectory,
    run: async () => { throw missing; },
    target: 'cursor',
  });
  expect(unavailable).toMatchObject({
    diagnostics: expect.arrayContaining([
      expect.objectContaining({ code: 'AB6026', severity: 'info' }),
      expect.objectContaining({ code: 'AB6029', severity: 'info' }),
    ]),
    status: 'unavailable',
  });

  const failed = await validateCursorPlugin({
    pluginDirectory: invalidPluginDirectory,
    run: async () => { throw missing; },
    target: 'cursor',
  });
  expect(failed.status).toBe('failed');
  expect(failed.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'AB6026', severity: 'info' }),
    expect.objectContaining({
      code: 'AB6027',
      message: expect.stringContaining('additional properties'),
      severity: 'error',
    }),
    expect.objectContaining({
      code: 'AB6029',
      message: expect.stringContaining('not installed or is not on PATH'),
      severity: 'info',
    }),
  ]));
});

it('accepts valid bytes for every vendored Cursor schema', async () => {
  const pluginDirectory = await createBundle({
    '.cursor-plugin/marketplace.json': {
      name: 'fixture-marketplace',
      plugins: [{ name: 'fixture-plugin', source: './' }],
    },
    '.cursor-plugin/plugin.json': {
      hooks: './hooks/hooks.json',
      mcpServers: './mcp.json',
      name: 'fixture-plugin',
    },
    'hooks/hooks.json': {
      hooks: {
        stop: [{ command: 'node ${CURSOR_PLUGIN_ROOT}/hooks/stop.mjs' }],
      },
      version: 1,
    },
    'mcp.json': {
      mcpServers: {
        fixture: {
          args: ['${CURSOR_PLUGIN_ROOT}/mcp/server.mjs'],
          command: 'node',
          env: { PLUGIN_ROOT: '${CURSOR_PLUGIN_ROOT}' },
        },
      },
    },
  });

  const report = await validateCursorPlugin({
    pluginDirectory,
    run: versionRunner().run,
    target: 'cursor',
  });

  expect(report.status).toBe('passed');
  expect(report.diagnostics).toEqual([
    expect.objectContaining({ code: 'AB6026', severity: 'info' }),
  ]);
});

it('allows CURSOR_PLUGIN_ROOT in remote MCP URLs and headers', async () => {
  const pluginDirectory = await createBundle({
    '.cursor-plugin/plugin.json': {
      mcpServers: './mcp.json',
      name: 'fixture-plugin',
    },
    'mcp.json': {
      mcpServers: {
        remote: {
          headers: {
            Authorization: 'Bearer ${CURSOR_PLUGIN_ROOT}',
          },
          type: 'streamable-http',
          url: '${CURSOR_PLUGIN_ROOT}/mcp',
        },
      },
    },
  });

  const report = await validateCursorPlugin({
    pluginDirectory,
    run: versionRunner().run,
    target: 'cursor',
  });

  expect(report.diagnostics.filter((entry) => entry.code === 'AB6028')).toEqual([]);
});

it('rejects an unknown plugin manifest property under the strict pinned schema', async () => {
  const pluginDirectory = await createBundle({
    '.cursor-plugin/plugin.json': { name: 'fixture-plugin', surprise: true },
  });

  const report = await validateCursorPlugin({
    pluginDirectory,
    run: versionRunner().run,
    target: 'cursor',
  });

  expect(report).toMatchObject({
    diagnostics: expect.arrayContaining([
      expect.objectContaining({
        code: 'AB6027',
        message: expect.stringContaining('.cursor-plugin/plugin.json'),
      }),
    ]),
    status: 'failed',
  });
});

it('rejects malformed MCP bytes under the pinned schema', async () => {
  const pluginDirectory = await createBundle({
    '.cursor-plugin/plugin.json': { mcpServers: './mcp.json', name: 'fixture-plugin' },
    'mcp.json': { mcpServers: { fixture: { command: 'node', unknown: true } } },
  });

  const report = await validateCursorPlugin({
    pluginDirectory,
    run: versionRunner().run,
    target: 'cursor',
  });

  expect(report.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: 'AB6027',
      message: expect.stringContaining('mcp.json'),
    }),
  ]));
  expect(report.status).toBe('failed');
});

it('rejects malformed hook bytes under the pinned schema', async () => {
  const pluginDirectory = await createBundle({
    '.cursor-plugin/plugin.json': { hooks: './hooks/hooks.json', name: 'fixture-plugin' },
    'hooks/hooks.json': { hooks: { inventedEvent: [{ command: 'true' }] } },
  });

  const report = await validateCursorPlugin({
    pluginDirectory,
    run: versionRunner().run,
    target: 'cursor',
  });

  expect(report.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: 'AB6027',
      message: expect.stringContaining('hooks/hooks.json'),
    }),
  ]));
  expect(report.status).toBe('failed');
});

const claudeFormatHooks = Object.freeze({
  hooks: {
    PreToolUse: [{ hooks: [{ command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/before-tool.mjs"', type: 'command' }], matcher: 'Bash' }],
    Stop: [{ hooks: [{ command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/stop.mjs"', type: 'command' }] }],
  },
});

const cursorFormatHooks = Object.freeze({
  hooks: {
    preToolUse: [{ command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/before-tool.cursor.mjs"', matcher: '^Shell$' }],
    stop: [{ command: 'node "${CURSOR_PLUGIN_ROOT}/hooks/stop.cursor.mjs"' }],
  },
  version: 1,
});

// #438: the unified `plugin` bundle lays the Claude/Codex hooks document at the Cursor folder-discovery
// default while its Cursor manifest points at `hooks/hooks-cursor.json`; only the named file counts.
it('validates the hooks document the manifest names, not the folder-discovery default', async () => {
  const pluginDirectory = await createBundle({
    '.cursor-plugin/plugin.json': { hooks: './hooks/hooks-cursor.json', name: 'fixture-plugin' },
    'hooks/hooks-cursor.json': cursorFormatHooks,
    'hooks/hooks.json': claudeFormatHooks,
  });

  const report = await validateCursorPlugin({
    pluginDirectory,
    run: versionRunner().run,
    target: 'cursor',
  });

  expect(report.diagnostics).toEqual([
    expect.objectContaining({ code: 'AB6026', severity: 'info' }),
  ]);
  expect(report.status).toBe('passed');
});

it('reports a manifest-named hooks document under its own path with the Cursor hooks schema', async () => {
  const pluginDirectory = await createBundle({
    '.cursor-plugin/plugin.json': { hooks: './hooks/hooks-cursor.json', name: 'fixture-plugin' },
    'hooks/hooks-cursor.json': claudeFormatHooks,
    'hooks/hooks.json': cursorFormatHooks,
  });

  const report = await validateCursorPlugin({
    pluginDirectory,
    run: versionRunner().run,
    target: 'cursor',
  });

  const hookErrors = report.diagnostics.filter((entry) => entry.code === 'AB6027');
  expect(hookErrors.length).toBeGreaterThan(0);
  for (const entry of hookErrors) {
    expect(entry.message).toContain('hooks/hooks-cursor.json');
    expect(entry.message).not.toContain('hooks/hooks.json');
  }
  expect(report.status).toBe('failed');
});

it('reports a manifest-named hooks document that is missing as AB6027', async () => {
  const pluginDirectory = await createBundle({
    '.cursor-plugin/plugin.json': { hooks: './hooks/hooks-cursor.json', name: 'fixture-plugin' },
    'hooks/hooks.json': cursorFormatHooks,
  });

  const report = await validateCursorPlugin({
    pluginDirectory,
    run: versionRunner().run,
    target: 'cursor',
  });

  expect(report.diagnostics.filter((entry) => entry.code === 'AB6027')).toEqual([
    expect.objectContaining({
      message: '.cursor-plugin/plugin.json declares hooks at "./hooks/hooks-cursor.json" but hooks/hooks-cursor.json is missing from the Cursor bundle; Cursor would load no hooks for it.',
      severity: 'error',
    }),
  ]);
  expect(report.status).toBe('failed');
});

it('rejects a manifest hooks path that leaves the plugin root', async () => {
  for (const declared of ['../outside/hooks.json', '/etc/hooks.json']) {
    const pluginDirectory = await createBundle({
      '.cursor-plugin/plugin.json': { hooks: declared, name: 'fixture-plugin' },
    });

    const report = await validateCursorPlugin({
      pluginDirectory,
      run: versionRunner().run,
      target: 'cursor',
    });

    expect(report.diagnostics.filter((entry) => entry.code === 'AB6027')).toEqual([
      expect.objectContaining({
        message: expect.stringContaining(`declares hooks at ${JSON.stringify(declared)}, which does not resolve inside the plugin root`),
        severity: 'error',
      }),
    ]);
    expect(report.status).toBe('failed');
  }
});

it('validates an inline manifest hooks object with the Cursor hooks schema and token rules', async () => {
  const valid = await createBundle({
    '.cursor-plugin/plugin.json': { hooks: cursorFormatHooks, name: 'fixture-plugin' },
    'hooks/hooks.json': claudeFormatHooks,
  });
  const invalid = await createBundle({
    '.cursor-plugin/plugin.json': { hooks: claudeFormatHooks, name: 'fixture-plugin' },
  });

  const validReport = await validateCursorPlugin({ pluginDirectory: valid, run: versionRunner().run, target: 'cursor' });
  expect(validReport.diagnostics).toEqual([expect.objectContaining({ code: 'AB6026', severity: 'info' })]);
  expect(validReport.status).toBe('passed');

  const invalidReport = await validateCursorPlugin({ pluginDirectory: invalid, run: versionRunner().run, target: 'cursor' });
  const errors = invalidReport.diagnostics.filter((entry) => entry.code === 'AB6027');
  expect(errors.length).toBeGreaterThan(0);
  for (const entry of errors) expect(entry.message).toContain('.cursor-plugin/plugin.json#/hooks');
  expect(invalidReport.status).toBe('failed');
});

it('falls back to hooks/hooks.json folder discovery only when the manifest declares no hooks field', async () => {
  const discovered = await createBundle({
    '.cursor-plugin/plugin.json': { name: 'fixture-plugin' },
    'hooks/hooks.json': claudeFormatHooks,
  });

  const report = await validateCursorPlugin({ pluginDirectory: discovered, run: versionRunner().run, target: 'cursor' });

  expect(report.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ code: 'AB6027', message: expect.stringContaining('hooks/hooks.json/hooks') }),
  ]));
  expect(report.status).toBe('failed');
});

it('rejects malformed marketplace bytes under the pinned schema', async () => {
  const pluginDirectory = await createBundle({
    '.cursor-plugin/marketplace.json': {
      name: 'fixture-marketplace',
      plugins: [{ name: 'fixture-plugin', source: './', unknown: true }],
    },
    '.cursor-plugin/plugin.json': { name: 'fixture-plugin' },
  });

  const report = await validateCursorPlugin({
    pluginDirectory,
    run: versionRunner().run,
    target: 'cursor',
  });

  expect(report.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: 'AB6027',
      message: expect.stringContaining('.cursor-plugin/marketplace.json'),
    }),
  ]));
  expect(report.status).toBe('failed');
});

it('requires the generated Cursor manifest while leaving optional documents optional', async () => {
  const pluginDirectory = await createBundle({});

  const report = await validateCursorPlugin({
    pluginDirectory,
    run: versionRunner().run,
    target: 'cursor',
  });

  expect(report).toMatchObject({
    diagnostics: expect.arrayContaining([
      expect.objectContaining({
        code: 'AB6027',
        message: expect.stringContaining('.cursor-plugin/plugin.json is required'),
      }),
    ]),
    status: 'failed',
  });
});

it('reports which fallback manifest the pinned loader precedence would select', async () => {
  const pluginDirectory = await createBundle({
    '.claude-plugin/plugin.json': { name: 'claude-fallback' },
    'plugin.json': { name: 'portable-fallback' },
  });

  const report = await validateCursorPlugin({
    pluginDirectory,
    run: versionRunner().run,
    target: 'cursor',
  });

  expect(report.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: 'AB6028',
      message: expect.stringContaining('.claude-plugin/plugin.json'),
    }),
  ]));
  expect(report.status).toBe('failed');
});

it('reports escaping symlinks in stable path order', async () => {
  const pluginDirectory = await createBundle();
  const outsideRoot = await createFixtureRoot();
  const firstOutsideFile = join(outsideRoot, 'first.json');
  const secondOutsideFile = join(outsideRoot, 'second.json');
  await Promise.all([
    writeFile(firstOutsideFile, '{}\n'),
    writeFile(secondOutsideFile, '{}\n'),
  ]);
  await symlink(secondOutsideFile, join(pluginDirectory, 'z-outside.json'));
  await symlink(firstOutsideFile, join(pluginDirectory, 'a-outside.json'));

  const report = await validateCursorPlugin({
    pluginDirectory,
    run: versionRunner().run,
    target: 'cursor',
  });

  expect(report.diagnostics
    .filter((entry) => entry.code === 'AB6028')
    .map((entry) => entry.message))
    .toEqual([
      'a-outside.json is a symlink whose real target escapes the Cursor bundle directory.',
      'z-outside.json is a symlink whose real target escapes the Cursor bundle directory.',
    ]);
  expect(report.status).toBe('failed');
});

it('rejects CURSOR_PLUGIN_ROOT outside loader-substituted fields', async () => {
  const pluginDirectory = await createBundle({
    '.cursor-plugin/plugin.json': {
      description: 'Unsupported here: ${CURSOR_PLUGIN_ROOT}',
      name: 'fixture-plugin',
    },
  });

  const report = await validateCursorPlugin({
    pluginDirectory,
    run: versionRunner().run,
    target: 'cursor',
  });

  expect(report.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({
      code: 'AB6028',
      message: expect.stringContaining('does not substitute CURSOR_PLUGIN_ROOT'),
    }),
  ]));
  expect(report.status).toBe('failed');
});
