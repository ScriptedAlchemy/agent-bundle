import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, expect, it } from '@rstest/core';

import {
  validateClaudePlugin,
  validateClaudePluginFiles,
  type ClaudePluginCommandRunner,
} from '../src/host-contracts/claude-plugin-validation.ts';

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const pluginWithNumberOption = async (
  option: Readonly<Record<string, unknown>>,
  location: 'channel' | 'plugin' = 'plugin',
): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-validation-'));
  fixtureRoots.push(root);
  const pluginDirectory = join(root, '.claude-plugin');
  await mkdir(pluginDirectory, { recursive: true });
  const userConfig = {
    count: {
      description: 'Number of items.',
      title: 'Count',
      type: 'number',
      ...option,
    },
  };
  await writeFile(join(pluginDirectory, 'plugin.json'), `${JSON.stringify({
    author: { name: 'Fixture' },
    description: 'Fixture plugin.',
    name: 'fixture-plugin',
    version: '1.0.0',
    ...(location === 'plugin'
      ? { userConfig }
      : { channels: [{ server: 'fixture', userConfig }] }),
  }, null, 2)}\n`);
  return root;
};

const pluginWithHooksField = async (hooks: unknown): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-hooks-field-'));
  fixtureRoots.push(root);
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await mkdir(join(root, 'hooks'), { recursive: true });
  await writeFile(join(root, 'hooks', 'hooks.json'), `${JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ command: 'node "${CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"', type: 'command' }] }] },
  })}\n`);
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), `${JSON.stringify({
    author: { name: 'cargo-hauler' },
    description: 'Coalesce, schedule, and stream cargo.',
    ...(hooks === undefined ? {} : { hooks }),
    name: 'cargo-hauler',
    version: '0.4.1',
  })}\n`);
  return root;
};

// Claude Code loads `hooks/hooks.json` on its own; a manifest `hooks` that names it again is refused
// at load time ("Duplicate hooks file detected"), which `claude plugin validate` does not catch (#463).
it('rejects a manifest hooks field that names the auto-loaded hooks/hooks.json', async () => {
  const pluginDirectory = await pluginWithHooksField('./hooks/hooks.json');

  const findings = await validateClaudePluginFiles({ pluginDirectory, target: 'claude' });
  expect(findings.length).toBeGreaterThan(0);
  expect(findings.every((finding) => finding.code === 'AB6012')).toBe(true);
  expect(findings).toContainEqual(expect.objectContaining({
    message: expect.stringContaining('".claude-plugin/plugin.json" is invalid for schema "plugin" at /hooks: must NOT be valid'),
  }));
  const arrayFindings = await validateClaudePluginFiles({
    pluginDirectory: await pluginWithHooksField(['./hooks/hooks.json']),
    target: 'claude',
  });
  expect(arrayFindings).toContainEqual(expect.objectContaining({
    code: 'AB6012',
    message: expect.stringContaining('at /hooks/0: must NOT be valid'),
  }));
});

it('accepts the default-location hook document without a manifest hooks field', async () => {
  const pluginDirectory = await pluginWithHooksField(undefined);

  await expect(validateClaudePluginFiles({ pluginDirectory, target: 'claude' })).resolves.toEqual([]);
});

it('accepts the documented additional hook config forms on the manifest hooks field', async () => {
  for (const hooks of [
    './my-extra-hooks.json',
    ['./hooks/security-hooks.json', './hooks/extra.json'],
    { hooks: { Stop: [{ hooks: [{ command: 'echo done', type: 'command' }] }] } },
  ]) {
    await expect(validateClaudePluginFiles({
      pluginDirectory: await pluginWithHooksField(hooks),
      target: 'claude',
    })).resolves.toEqual([]);
  }
  await expect(validateClaudePluginFiles({
    pluginDirectory: await pluginWithHooksField('hooks/extra.json'),
    target: 'claude',
  })).resolves.toContainEqual(expect.objectContaining({
    code: 'AB6012',
    message: expect.stringContaining('at /hooks: must match pattern "^\\./"'),
  }));
});

it('rejects a numeric userConfig minimum greater than its maximum', async () => {
  const pluginDirectory = await pluginWithNumberOption({ max: 5, min: 10 });

  await expect(validateClaudePluginFiles({
    pluginDirectory,
    target: 'claude',
  })).resolves.toEqual([expect.objectContaining({
    code: 'AB6012',
    message: expect.stringContaining('minimum must be less than or equal to its maximum'),
  })]);
});

it('rejects a numeric userConfig default below its minimum', async () => {
  const pluginDirectory = await pluginWithNumberOption({ default: 4, min: 5 });

  await expect(validateClaudePluginFiles({
    pluginDirectory,
    target: 'claude',
  })).resolves.toEqual([expect.objectContaining({
    code: 'AB6012',
    message: expect.stringContaining('default must be greater than or equal to its minimum'),
  })]);
});

it('rejects a numeric channel userConfig default above its maximum', async () => {
  const pluginDirectory = await pluginWithNumberOption({ default: 11, max: 10 }, 'channel');

  await expect(validateClaudePluginFiles({
    pluginDirectory,
    target: 'claude',
  })).resolves.toEqual([expect.objectContaining({
    code: 'AB6012',
    message: expect.stringContaining('default must be less than or equal to its maximum'),
  })]);
});

it('accepts numeric userConfig defaults within declared bounds', async () => {
  const pluginDirectory = await pluginWithNumberOption({ default: 7, max: 10, min: 5 });

  await expect(validateClaudePluginFiles({
    pluginDirectory,
    target: 'claude',
  })).resolves.toEqual([]);
});

it('handles numeric userConfig declarations with only one bound', async () => {
  const minimumOnly = await pluginWithNumberOption({ default: 5, min: 5 });
  const maximumOnly = await pluginWithNumberOption({ default: 10, max: 10 });

  await expect(Promise.all([
    validateClaudePluginFiles({ pluginDirectory: minimumOnly, target: 'claude' }),
    validateClaudePluginFiles({ pluginDirectory: maximumOnly, target: 'claude' }),
  ])).resolves.toEqual([[], []]);
});

const runWith = (
  validation: Readonly<{ exitCode: number; stderr?: string; stdout: string }>,
): { readonly calls: unknown[]; readonly run: ClaudePluginCommandRunner } => {
  const calls: unknown[] = [];
  return {
    calls,
    run: async (request) => {
      calls.push(request);
      return request.args[0] === '--version'
        ? { exitCode: 0, signal: null, stderr: '', stdout: '2.1.251 (Claude Code)\n' }
        : { exitCode: validation.exitCode, signal: null, stderr: validation.stderr ?? '', stdout: validation.stdout };
    },
  };
};

it('runs the installed Claude validator without shell interpolation', async () => {
  const fixture = runWith({ exitCode: 0, stdout: '✔ Validation passed\n' });
  const report = await validateClaudePlugin({
    pluginDirectory: '/tmp/plugin with spaces; echo unsafe',
    run: fixture.run,
    target: 'claude',
  });

  expect(fixture.calls).toEqual([
    expect.objectContaining({ args: ['--version'], executable: 'claude' }),
    expect.objectContaining({
      args: ['plugin', 'validate', '/tmp/plugin with spaces; echo unsafe', '--strict'],
      executable: 'claude',
    }),
  ]);
  expect(report).toEqual({
    diagnostics: [],
    host: 'claude',
    status: 'passed',
    target: 'claude',
    version: '2.1.251',
  });
});

it('resolves a multi-segment relative plugin directory before invoking Claude', async () => {
  const fixture = runWith({ exitCode: 0, stdout: '✔ Validation passed\n' });
  const pluginDirectory = resolve('fixtures/plugin');
  await validateClaudePlugin({
    pluginDirectory: 'fixtures/plugin',
    run: fixture.run,
    target: 'claude',
  });

  expect(fixture.calls).toEqual([
    expect.objectContaining({ args: ['--version'], cwd: dirname(pluginDirectory) }),
    expect.objectContaining({
      args: ['plugin', 'validate', pluginDirectory, '--strict'],
      cwd: dirname(pluginDirectory),
    }),
  ]);
});

it('keeps host warnings as warnings unless framework strict mode is enabled', async () => {
  const output = [
    '⚠ Found 2 warnings:',
    '',
    "  ❯ displayNme: Unknown field 'displayNme' — did you mean 'displayName'?",
    '  ❯ author: No author information provided.',
    '',
    '✘ Validation failed (--strict treats warnings as errors)',
  ].join('\n');

  const normal = await validateClaudePlugin({
    pluginDirectory: '/tmp/plugin',
    run: runWith({ exitCode: 1, stdout: output }).run,
    target: 'plugin',
  });
  expect(normal.status).toBe('warnings');
  expect(normal.diagnostics).toEqual([
    expect.objectContaining({ code: 'AB6020', severity: 'warning', target: 'plugin' }),
    expect.objectContaining({ code: 'AB6020', severity: 'warning', target: 'plugin' }),
  ]);

  const strict = await validateClaudePlugin({
    pluginDirectory: '/tmp/plugin',
    run: runWith({ exitCode: 1, stdout: output }).run,
    strict: true,
    target: 'plugin',
  });
  expect(strict.status).toBe('failed');
  expect(strict.diagnostics.every((diagnostic) => diagnostic.severity === 'error')).toBe(true);
});

it('maps Claude validation errors and bounded-process failures to stable diagnostics', async () => {
  const invalid = await validateClaudePlugin({
    pluginDirectory: '/tmp/plugin',
    run: runWith({
      exitCode: 1,
      stdout: '✘ Found 1 error:\n\n  ❯ name: Invalid input: expected string, received undefined\n\n✘ Validation failed\n',
    }).run,
    target: 'claude',
  });
  expect(invalid).toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'AB6021', severity: 'error', target: 'claude' })],
    status: 'failed',
  });

  const timedOut = await validateClaudePlugin({
    pluginDirectory: '/tmp/plugin',
    run: async (request) => request.args[0] === '--version'
      ? { exitCode: 0, signal: null, stderr: '', stdout: '2.1.251\n' }
      : { exitCode: null, signal: 'SIGTERM', stderr: '', stdout: '', termination: 'timed-out' },
    target: 'claude',
  });
  expect(timedOut).toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'AB6022', severity: 'error' })],
    status: 'failed',
  });
});

it('reports an honest informational skip when Claude is absent', async () => {
  const missing = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
  const report = await validateClaudePlugin({
    pluginDirectory: '/tmp/plugin',
    run: async () => { throw missing; },
    target: 'claude',
  });

  expect(report).toEqual({
    diagnostics: [expect.objectContaining({
      code: 'AB6019',
      message: expect.stringContaining('not installed or is not on PATH'),
      severity: 'info',
      target: 'claude',
    })],
    host: 'claude',
    status: 'unavailable',
    target: 'claude',
  });
});

it('fails host validation when the Claude version probe times out', async () => {
  const report = await validateClaudePlugin({
    pluginDirectory: '/tmp/plugin',
    run: async () => ({
      exitCode: null,
      signal: 'SIGTERM',
      stderr: '',
      stdout: '',
      termination: 'timed-out',
    }),
    target: 'claude',
  });

  expect(report).toMatchObject({
    diagnostics: [expect.objectContaining({
      code: 'AB6022',
      message: expect.stringContaining('version probe timed out'),
      severity: 'error',
    })],
    status: 'failed',
  });
});

it('fails host validation when the Claude version probe exits nonzero', async () => {
  const report = await validateClaudePlugin({
    pluginDirectory: '/tmp/plugin',
    run: async () => ({
      exitCode: 2,
      signal: null,
      stderr: 'version failed',
      stdout: '',
    }),
    target: 'claude',
  });

  expect(report).toMatchObject({
    diagnostics: [expect.objectContaining({
      code: 'AB6022',
      message: expect.stringContaining('version probe exited with code 2'),
      severity: 'error',
    })],
    status: 'failed',
  });
});

it('fails host validation when the Claude version probe exceeds its output limit', async () => {
  const report = await validateClaudePlugin({
    pluginDirectory: '/tmp/plugin',
    run: async () => ({
      exitCode: null,
      signal: 'SIGTERM',
      stderr: '',
      stdout: '',
      termination: 'output-limit',
    }),
    target: 'claude',
  });

  expect(report).toMatchObject({
    diagnostics: [expect.objectContaining({
      code: 'AB6022',
      message: expect.stringContaining('version probe exceeded its output limit'),
      severity: 'error',
    })],
    status: 'failed',
  });
});

it('fails host validation when the Claude version probe cannot be spawned', async () => {
  const denied = Object.assign(new Error('spawn claude EACCES'), { code: 'EACCES' });
  const report = await validateClaudePlugin({
    pluginDirectory: '/tmp/plugin',
    run: async () => { throw denied; },
    target: 'claude',
  });

  expect(report).toMatchObject({
    diagnostics: [expect.objectContaining({
      code: 'AB6022',
      message: expect.stringContaining('version probe could not be started'),
      severity: 'error',
    })],
    status: 'failed',
  });
});
