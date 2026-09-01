import { expect, it } from '@rstest/core';

import {
  validateClaudePlugin,
  type ClaudePluginCommandRunner,
} from '../src/host-contracts/claude-plugin-validation.ts';

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
