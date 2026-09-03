import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it } from '@rstest/core';

import codexCapabilityTable from '../src/adapters/capabilities/codex-0.147.0.json' with { type: 'json' };
import {
  validateCodexPlugin,
  type CodexPluginCommandRunner,
} from '../src/host-contracts/codex-plugin-validation.ts';

const generatedSchemaNames = Object.freeze(
  Object.keys(codexCapabilityTable.validation.pinnedGeneratedComparison.pinnedRepositorySha256).sort(),
);

const validDocuments = Object.freeze({
  '.agents/plugins/marketplace.json': {
    interface: { displayName: 'Fixture' },
    name: 'fixture-marketplace',
    plugins: [{
      category: 'Productivity',
      name: 'fixture',
      policy: { authentication: 'ON_INSTALL', installation: 'AVAILABLE' },
      source: { path: './', source: 'local' },
    }],
  },
  '.codex-plugin/plugin.json': {
    author: { name: 'Fixture' },
    description: 'A fixture plugin.',
    interface: {
      capabilities: ['hooks', 'mcp', 'skills'],
      category: 'Productivity',
      defaultPrompt: ['Use the fixture.'],
      developerName: 'Fixture',
      displayName: 'Fixture',
      longDescription: 'A fixture plugin.',
      shortDescription: 'A fixture plugin.',
    },
    hooks: './hooks/hooks.json',
    mcpServers: './.mcp.json',
    name: 'fixture',
    skills: './skills/',
    version: '1.0.0',
  },
  '.mcp.json': {
    mcpServers: {
      fixture: { command: 'node', type: 'stdio' },
    },
  },
  'hooks/hooks.json': {
    hooks: {
      Stop: [{
        hooks: [{ command: 'node ./hooks/stop.mjs', type: 'command' }],
      }],
    },
  },
});

const writeBundle = async (
  replacements: Readonly<Record<string, unknown>> = {},
): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), 'agent-bundle-codex-validation-'));
  for (const [relativePath, document] of Object.entries({ ...validDocuments, ...replacements })) {
    const path = join(directory, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  }
  return directory;
};

type GeneratedSchemaBehavior = 'app-server-only' | 'drift' | 'match' | 'missing-verb' | 'output-limit' | 'timed-out';

const runWith = (
  behavior: GeneratedSchemaBehavior,
): { readonly calls: unknown[]; readonly run: CodexPluginCommandRunner } => {
  const calls: unknown[] = [];
  return {
    calls,
    run: async (request) => {
      calls.push(request);
      if (request.args[0] === '--version') {
        return { exitCode: 0, signal: null, stderr: '', stdout: 'codex-cli 0.147.0\n' };
      }
      if (behavior === 'missing-verb') {
        return {
          exitCode: 2,
          signal: null,
          stderr: "error: unrecognized subcommand 'generate-json-schema'\n",
          stdout: '',
        };
      }
      if (behavior === 'output-limit') {
        return {
          exitCode: null,
          signal: 'SIGTERM',
          stderr: '',
          stdout: '',
          termination: 'output-limit',
        };
      }
      if (behavior === 'timed-out') {
        return {
          exitCode: null,
          signal: 'SIGTERM',
          stderr: '',
          stdout: '',
          termination: 'timed-out',
        };
      }
      const outIndex = request.args.indexOf('--out');
      const outputDirectory = request.args[outIndex + 1];
      if (outputDirectory === undefined) throw new Error('schema output directory was not provided');
      if (behavior === 'app-server-only') {
        await writeFile(join(outputDirectory, 'codex_app_server_protocol.schemas.json'), '{}\n', 'utf8');
        await writeFile(join(outputDirectory, 'codex_app_server_protocol.v2.schemas.json'), '{}\n', 'utf8');
        return { exitCode: 0, signal: null, stderr: '', stdout: '' };
      }
      const pinnedDirectory = new URL('../src/adapters/schemas/codex/generated/', import.meta.url);
      for (const name of generatedSchemaNames) {
        await copyFile(new URL(name, pinnedDirectory), join(outputDirectory, name));
      }
      if (behavior === 'drift') {
        await writeFile(join(outputDirectory, generatedSchemaNames[0]!), '{"type":"null"}\n', 'utf8');
      }
      return { exitCode: 0, signal: null, stderr: '', stdout: '' };
    },
  };
};

it('validates Codex bundle documents and matching generated schemas without shell interpolation', async () => {
  const pluginDirectory = await writeBundle();
  try {
    const fixture = runWith('match');
    const report = await validateCodexPlugin({
      pluginDirectory,
      run: fixture.run,
      target: 'codex',
    });

    expect(fixture.calls).toEqual([
      expect.objectContaining({ args: ['--version'], executable: 'codex' }),
      expect.objectContaining({
        args: ['app-server', 'generate-json-schema', '--out', expect.any(String)],
        executable: 'codex',
      }),
    ]);
    expect(report).toEqual({
      diagnostics: [expect.objectContaining({
        code: 'AB6030',
        message: expect.stringContaining('does not publish a plugin validation command'),
        severity: 'info',
        target: 'codex',
      })],
      host: 'codex',
      status: 'passed',
      target: 'codex',
      version: '0.147.0',
    });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.diagnostics)).toBe(true);
  } finally {
    await rm(pluginDirectory, { force: true, recursive: true });
  }
});

it('reports an honest informational skip when Codex is absent', async () => {
  const missing = Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' });
  const report = await validateCodexPlugin({
    pluginDirectory: '/tmp/plugin',
    run: async () => { throw missing; },
    target: 'codex',
  });

  expect(report).toEqual({
    diagnostics: [expect.objectContaining({
      code: 'AB6030',
      message: expect.stringContaining('not installed or is not on PATH'),
      severity: 'info',
      target: 'codex',
    })],
    host: 'codex',
    status: 'unavailable',
    target: 'codex',
  });
});

it('fails when the Codex version probe exits nonzero', async () => {
  const report = await validateCodexPlugin({
    pluginDirectory: '/tmp/plugin',
    run: async () => ({
      exitCode: 2,
      signal: null,
      stderr: 'version failed',
      stdout: '',
    }),
    target: 'codex',
  });

  expect(report).toMatchObject({
    diagnostics: [expect.objectContaining({
      code: 'AB6033',
      message: expect.stringContaining('version probe exited with code 2'),
      severity: 'error',
    })],
    status: 'failed',
  });
});

it('reports the missing schema generator verb honestly and still checks pinned documents', async () => {
  const pluginDirectory = await writeBundle();
  try {
    const report = await validateCodexPlugin({
      pluginDirectory,
      run: runWith('missing-verb').run,
      target: 'codex',
    });

    expect(report).toMatchObject({
      diagnostics: [
        expect.objectContaining({ code: 'AB6030', severity: 'info' }),
        expect.objectContaining({
          code: 'AB6031',
          message: expect.stringContaining('generate-json-schema verb is unavailable'),
          severity: 'info',
        }),
      ],
      status: 'passed',
      version: '0.147.0',
    });
  } finally {
    await rm(pluginDirectory, { force: true, recursive: true });
  }
});

it('warns when live generated schemas drift from the pinned revision', async () => {
  const pluginDirectory = await writeBundle();
  try {
    const report = await validateCodexPlugin({
      pluginDirectory,
      run: runWith('drift').run,
      target: 'codex',
    });

    expect(report).toMatchObject({
      diagnostics: [
        expect.objectContaining({ code: 'AB6030', severity: 'info' }),
        expect.objectContaining({
          code: 'AB6031',
          message: expect.stringContaining('live Codex 0.147.0'),
          severity: 'warning',
        }),
      ],
      status: 'warnings',
      version: '0.147.0',
    });
  } finally {
    await rm(pluginDirectory, { force: true, recursive: true });
  }
});

it('reports app-server-only schema output as unassessable information even in strict mode', async () => {
  const pluginDirectory = await writeBundle();
  try {
    const report = await validateCodexPlugin({
      pluginDirectory,
      run: runWith('app-server-only').run,
      strict: true,
      target: 'codex',
    });

    expect(report).toMatchObject({
      diagnostics: [
        expect.objectContaining({ code: 'AB6030', severity: 'info' }),
        expect.objectContaining({
          code: 'AB6031',
          message: expect.stringContaining(
            'live hook-schema drift is not assessable because the generator emits the app-server protocol surface',
          ),
          severity: 'info',
        }),
      ],
      status: 'passed',
      version: '0.147.0',
    });
  } finally {
    await rm(pluginDirectory, { force: true, recursive: true });
  }
});

it('rejects malformed fixtures for every locally validated Codex schema', async () => {
  const malformed = [
    ['.codex-plugin/plugin.json', { ...validDocuments['.codex-plugin/plugin.json'], name: 'Invalid Name' }],
    ['hooks/hooks.json', { hooks: { Stop: [{ hooks: [{ command: '', type: 'command' }] }] } }],
    ['.mcp.json', { mcpServers: { fixture: { type: 'streamable-http', url: 'not a uri' } } }],
    ['.agents/plugins/marketplace.json', {
      ...validDocuments['.agents/plugins/marketplace.json'],
      plugins: [],
    }],
  ] as const;

  for (const [relativePath, document] of malformed) {
    const pluginDirectory = await writeBundle({ [relativePath]: document });
    try {
      const report = await validateCodexPlugin({
        pluginDirectory,
        run: runWith('match').run,
        target: 'codex',
      });

      expect(report).toMatchObject({
        diagnostics: expect.arrayContaining([expect.objectContaining({
          code: 'AB6032',
          generatedPath: relativePath,
          severity: 'error',
        })]),
        status: 'failed',
      });
    } finally {
      await rm(pluginDirectory, { force: true, recursive: true });
    }
  }
});

it('maps schema-generation timeout and output-limit terminations to stable failures', async () => {
  const pluginDirectory = await writeBundle();
  try {
    for (const [behavior, message] of [
      ['timed-out', 'schema generation timed out'],
      ['output-limit', 'schema generation exceeded its output limit'],
    ] as const) {
      const report = await validateCodexPlugin({
        pluginDirectory,
        run: runWith(behavior).run,
        target: 'codex',
      });
      expect(report).toMatchObject({
        diagnostics: expect.arrayContaining([expect.objectContaining({
          code: 'AB6033',
          message: expect.stringContaining(message),
          severity: 'error',
        })]),
        status: 'failed',
      });
    }
  } finally {
    await rm(pluginDirectory, { force: true, recursive: true });
  }
});

it('fails when the Codex version probe exceeds its output limit or times out', async () => {
  for (const [termination, message] of [
    ['output-limit', 'version probe exceeded its output limit'],
    ['timed-out', 'version probe timed out'],
  ] as const) {
    const report = await validateCodexPlugin({
      pluginDirectory: '/tmp/plugin',
      run: async () => ({
        exitCode: null,
        signal: 'SIGTERM',
        stderr: '',
        stdout: '',
        termination,
      }),
      target: 'codex',
    });

    expect(report).toMatchObject({
      diagnostics: [expect.objectContaining({
        code: 'AB6033',
        message: expect.stringContaining(message),
        severity: 'error',
      })],
      status: 'failed',
    });
  }
});
