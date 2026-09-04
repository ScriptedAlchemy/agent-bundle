import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { afterEach, expect, it } from '@rstest/core';

import {
  claudeSupportsJsonValidationReport,
  validateClaudePlugin,
  validateClaudePluginFiles,
  type ClaudePluginCommandRunner,
} from '../src/host-contracts/claude-plugin-validation.ts';

const fixtureRoots: string[] = [];

/** Reports recorded from the real Claude CLI on this machine; `/bundle/claude` stands in for the bundle path. */
const recordedReport = async (name: string, pluginDirectory: string): Promise<string> =>
  (await readFile(new URL(`./fixtures/claude-plugin-validate/${name}`, import.meta.url), 'utf8'))
    .replaceAll('/bundle/claude', pluginDirectory);

/** A bundle directory shaped like `agent-bundle build --target claude` output: both manifests side by side. */
const emittedClaudeBundle = async (withMarketplace = true): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-bundle-'));
  fixtureRoots.push(root);
  await mkdir(join(root, '.claude-plugin'), { recursive: true });
  await writeFile(join(root, '.claude-plugin', 'plugin.json'), '{"name":"fixture"}\n');
  if (withMarketplace) {
    await writeFile(join(root, '.claude-plugin', 'marketplace.json'), '{"name":"fixture","plugins":[]}\n');
  }
  return root;
};

/** A healthy `claude --plugin-dir <bundle> plugin list --json` row for the emitted fixture bundle. */
const loadedFixtureRow = (bundle: string, extra: Readonly<Record<string, unknown>> = {}): string => JSON.stringify([{
  enabled: true,
  id: 'fixture@inline',
  installPath: bundle,
  scope: 'inline',
  version: '0.0.0',
  ...extra,
}]);

const runByTarget = (
  responses: Readonly<Record<string, Readonly<{ exitCode: number; stderr?: string; stdout: string }>>>,
  version = '2.1.259',
): { readonly calls: readonly string[][]; readonly run: ClaudePluginCommandRunner } => {
  const calls: string[][] = [];
  return {
    calls,
    run: async (request) => {
      calls.push([...request.args]);
      if (request.args[0] === '--version') {
        return { exitCode: 0, signal: null, stderr: '', stdout: `${version} (Claude Code)\n` };
      }
      if (request.args[0] === '--plugin-dir') {
        // Load check (#476): answer with the recorded `load` response when the test provides one, else a loaded row.
        const load = responses['load'];
        return load === undefined
          ? { exitCode: 0, signal: null, stderr: '', stdout: loadedFixtureRow(request.args[1] ?? '') }
          : { exitCode: load.exitCode, signal: null, stderr: load.stderr ?? '', stdout: load.stdout };
      }
      const target = request.args[2] ?? '';
      const response = responses[target.endsWith('marketplace.json') ? 'marketplace' : 'plugin'];
      if (response === undefined) throw new Error(`unexpected validation target ${target}`);
      return { exitCode: response.exitCode, signal: null, stderr: response.stderr ?? '', stdout: response.stdout };
    },
  };
};

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
  // No `./` prefix, and every alias of the auto-loaded file that a literal exclusion would miss: the
  // pattern admits only normalized paths (no `.`/`..`/empty segments), so `./hooks/./hooks.json` and
  // `./hooks/../hooks/hooks.json` cannot pass the schema and then be refused by Claude Code.
  for (const alias of ['hooks/extra.json', './hooks/./hooks.json', './hooks/../hooks/hooks.json', './hooks//hooks.json', './hooks/hooks.json/']) {
    await expect(validateClaudePluginFiles({
      pluginDirectory: await pluginWithHooksField(alias),
      target: 'claude',
    }), alias).resolves.toContainEqual(expect.objectContaining({
      code: 'AB6012',
      message: expect.stringContaining('at /hooks: must match pattern'),
    }));
  }
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

it('asks for the --json report first and skips it only for a version known to predate Claude Code 2.1.259', () => {
  expect(claudeSupportsJsonValidationReport('2.1.250')).toBe(false);
  expect(claudeSupportsJsonValidationReport('2.1.258')).toBe(false);
  expect(claudeSupportsJsonValidationReport('2.1.259')).toBe(true);
  expect(claudeSupportsJsonValidationReport('2.1.260')).toBe(true);
  expect(claudeSupportsJsonValidationReport('2.1.300')).toBe(true);
  expect(claudeSupportsJsonValidationReport('2.2.0')).toBe(true);
  expect(claudeSupportsJsonValidationReport('3.0.0')).toBe(true);
  // Unknown versions take the primary path; the CLI's own `unknown option` answer selects the text fallback.
  expect(claudeSupportsJsonValidationReport(undefined)).toBe(true);
  expect(claudeSupportsJsonValidationReport('nightly')).toBe(true);
});

it('falls back to the text reporter for every run when a CLI of unknown version rejects --json', async () => {
  const bundle = await emittedClaudeBundle();
  const text = await recordedReport('2.1.250-plugin-strict-findings.txt', bundle);
  const calls: string[][] = [];
  const report = await validateClaudePlugin({
    pluginDirectory: bundle,
    run: async (request) => {
      calls.push([...request.args]);
      if (request.args[0] === '--version') return { exitCode: 0, signal: null, stderr: '', stdout: 'nightly (Claude Code)\n' };
      if (request.args[0] === '--plugin-dir') return { exitCode: 0, signal: null, stderr: '', stdout: loadedFixtureRow(request.args[1] ?? '') };
      if (request.args.includes('--json')) return { exitCode: 1, signal: null, stderr: "error: unknown option '--json'\n", stdout: '' };
      const target = request.args[2] ?? '';
      return target.endsWith('marketplace.json')
        ? { exitCode: 0, signal: null, stderr: '', stdout: `Validating marketplace manifest: ${target}\n\n✔ Validation passed\n` }
        : { exitCode: 1, signal: null, stderr: '', stdout: text };
    },
    target: 'claude',
  });

  const plugin = join(bundle, '.claude-plugin', 'plugin.json');
  const marketplace = join(bundle, '.claude-plugin', 'marketplace.json');
  expect(calls).toEqual([
    ['--version'],
    ['plugin', 'validate', plugin, '--strict', '--json'],
    ['plugin', 'validate', plugin, '--strict'],
    ['plugin', 'validate', marketplace, '--strict'],
    ['--plugin-dir', bundle, 'plugin', 'list', '--json'],
  ]);
  expect(report.status).toBe('failed');
  expect(report.version).toBeUndefined();
  expect(report.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(['AB6020', 'AB6020', 'AB6020', 'AB6021', 'AB6021']);
});

it('validates the plugin manifest and the marketplace manifest separately with --json on 2.1.259', async () => {
  const bundle = await emittedClaudeBundle();
  const fixture = runByTarget({
    marketplace: { exitCode: 0, stdout: await recordedReport('2.1.259-plugin-strict-passed.json', bundle) },
    plugin: { exitCode: 0, stdout: await recordedReport('2.1.259-plugin-strict-passed.json', bundle) },
  });
  const report = await validateClaudePlugin({ pluginDirectory: bundle, run: fixture.run, target: 'claude' });

  expect(fixture.calls).toEqual([
    ['--version'],
    ['plugin', 'validate', join(bundle, '.claude-plugin', 'plugin.json'), '--strict', '--json'],
    ['plugin', 'validate', join(bundle, '.claude-plugin', 'marketplace.json'), '--strict', '--json'],
    ['--plugin-dir', bundle, 'plugin', 'list', '--json'],
  ]);
  expect(report).toEqual({
    diagnostics: [],
    host: 'claude',
    load: { status: 'loaded' },
    status: 'passed',
    target: 'claude',
    version: '2.1.259',
  });
});

it('skips the marketplace run when the bundle emits no marketplace.json', async () => {
  const bundle = await emittedClaudeBundle(false);
  const fixture = runByTarget({
    plugin: { exitCode: 0, stdout: await recordedReport('2.1.259-plugin-strict-passed.json', bundle) },
  });
  await validateClaudePlugin({ pluginDirectory: bundle, run: fixture.run, target: 'claude' });
  expect(fixture.calls.map((call) => call[2])).toEqual([undefined, join(bundle, '.claude-plugin', 'plugin.json'), 'plugin']);
});

it('skips the load check on request and when the bundle has no manifest name to look up', async () => {
  const bundle = await emittedClaudeBundle(false);
  const passed = { exitCode: 0, stdout: await recordedReport('2.1.259-plugin-strict-passed.json', bundle) };
  const optedOut = runByTarget({ plugin: passed });
  const report = await validateClaudePlugin({ loadCheck: false, pluginDirectory: bundle, run: optedOut.run, target: 'claude' });
  expect(report.load).toBeUndefined();
  expect(optedOut.calls.some((call) => call[0] === '--plugin-dir')).toBe(false);

  await writeFile(join(bundle, '.claude-plugin', 'plugin.json'), '{"version":"1.0.0"}\n');
  const nameless = runByTarget({ plugin: passed });
  expect((await validateClaudePlugin({ pluginDirectory: bundle, run: nameless.run, target: 'claude' })).load).toBeUndefined();
  expect(nameless.calls.some((call) => call[0] === '--plugin-dir')).toBe(false);
});

it('reports AB7325 when Claude accepts the manifest under --strict but refuses to load it (#479 follow-up)', async () => {
  const bundle = await emittedClaudeBundle();
  const errors = [
    'Hook load failed: Duplicate hooks file detected: hooks/hooks.json is loaded automatically; remove it from the manifest.',
  ];
  const fixture = runByTarget({
    load: { exitCode: 0, stdout: loadedFixtureRow(bundle, { errors }) },
    marketplace: { exitCode: 0, stdout: await recordedReport('2.1.259-plugin-strict-passed.json', bundle) },
    plugin: { exitCode: 0, stdout: await recordedReport('2.1.259-plugin-strict-passed.json', bundle) },
  });
  const report = await validateClaudePlugin({ pluginDirectory: bundle, run: fixture.run, target: 'claude' });

  expect(report.status).toBe('failed');
  expect(report.load).toEqual({ errors, status: 'refused' });
  expect(report.diagnostics).toEqual([expect.objectContaining({
    code: 'AB7325',
    message: `Claude Code refused to load fixture@inline from ${JSON.stringify(bundle)} although ` +
      `\`plugin validate --strict\` accepted it; the host reported: ${errors[0]}`,
    recovery: expect.stringContaining('claude --plugin-dir <bundle-dir> plugin list --json'),
    severity: 'error',
    target: 'claude',
  })]);
});

it('reports a load refusal caused only by an uninstalled declared dependency as an AB7325 warning', async () => {
  const bundle = await emittedClaudeBundle(false);
  const errors = [
    'Dependency "audit-logger@acme-shared" is not installed — run `claude plugin install audit-logger@acme-shared`, ' +
      'or check that its marketplace is added',
  ];
  const passed = { exitCode: 0, stdout: await recordedReport('2.1.259-plugin-strict-passed.json', bundle) };
  const report = await validateClaudePlugin({
    pluginDirectory: bundle,
    run: runByTarget({ load: { exitCode: 0, stdout: loadedFixtureRow(bundle, { errors }) }, plugin: passed }).run,
    target: 'claude',
  });
  expect(report.status).toBe('warnings');
  expect(report.load).toEqual({ errors, status: 'refused' });
  expect(report.diagnostics).toEqual([expect.objectContaining({
    code: 'AB7325',
    message: expect.stringContaining('(a declared dependency is not installed on this machine)'),
    severity: 'warning',
  })]);

  const strict = await validateClaudePlugin({
    pluginDirectory: bundle,
    run: runByTarget({ load: { exitCode: 0, stdout: loadedFixtureRow(bundle, { errors }) }, plugin: passed }).run,
    strict: true,
    target: 'claude',
  });
  expect(strict.status).toBe('failed');
  expect(strict.diagnostics[0]?.severity).toBe('error');

  // Mixed with any other refusal the verdict stays an error.
  const mixed = await validateClaudePlugin({
    pluginDirectory: bundle,
    run: runByTarget({
      load: { exitCode: 0, stdout: loadedFixtureRow(bundle, { errors: [...errors, 'Hook load failed: Duplicate hooks file detected'] }) },
      plugin: passed,
    }).run,
    target: 'claude',
  });
  expect(mixed.status).toBe('failed');
  expect(mixed.diagnostics[0]?.message).not.toContain('declared dependency');
});

it('reports AB7311 when the --plugin-dir listing has no row for the bundle', async () => {
  const bundle = await emittedClaudeBundle(false);
  const fixture = runByTarget({
    load: { exitCode: 0, stdout: JSON.stringify([{ id: 'other@marketplace', installPath: '/elsewhere', scope: 'user' }]) },
    plugin: { exitCode: 0, stdout: await recordedReport('2.1.259-plugin-strict-passed.json', bundle) },
  });
  const report = await validateClaudePlugin({ pluginDirectory: bundle, run: fixture.run, target: 'claude' });

  expect(report.status).toBe('failed');
  expect(report.load).toEqual({ status: 'unregistered' });
  expect(report.diagnostics).toEqual([expect.objectContaining({
    code: 'AB7311',
    message: expect.stringContaining('did not register fixture@inline'),
    severity: 'error',
  })]);
});

it('reports AB6022 when the load check itself cannot be read', async () => {
  const bundle = await emittedClaudeBundle(false);
  const passed = { exitCode: 0, stdout: await recordedReport('2.1.259-plugin-strict-passed.json', bundle) };
  const nonzero = await validateClaudePlugin({
    pluginDirectory: bundle,
    run: runByTarget({ load: { exitCode: 1, stderr: 'boom', stdout: '' }, plugin: passed }).run,
    target: 'claude',
  });
  expect(nonzero).toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'AB6022', message: expect.stringContaining('exited with code 1: boom') })],
    load: { status: 'failed' },
    status: 'failed',
  });

  const notJson = await validateClaudePlugin({
    pluginDirectory: bundle,
    run: runByTarget({ load: { exitCode: 0, stdout: 'Installed plugins:\n' }, plugin: passed }).run,
    target: 'claude',
  });
  expect(notJson).toMatchObject({
    diagnostics: [expect.objectContaining({ code: 'AB6022', message: expect.stringContaining('did not return JSON') })],
    load: { status: 'failed' },
  });

  const notArray = await validateClaudePlugin({
    pluginDirectory: bundle,
    run: runByTarget({ load: { exitCode: 0, stdout: '{"plugins":[]}' }, plugin: passed }).run,
    target: 'claude',
  });
  expect(notArray.diagnostics).toEqual([expect.objectContaining({ message: expect.stringContaining('did not return a JSON array') })]);
});

it('attributes --json findings to their file and de-duplicates marketplace re-reports of manifest findings', async () => {
  const bundle = await emittedClaudeBundle();
  const fixture = runByTarget({
    marketplace: { exitCode: 1, stdout: await recordedReport('2.1.259-marketplace-strict-findings.json', bundle) },
    plugin: { exitCode: 1, stdout: await recordedReport('2.1.259-plugin-strict-findings.json', bundle) },
  });
  const report = await validateClaudePlugin({ pluginDirectory: bundle, run: fixture.run, target: 'claude' });

  expect(report.status).toBe('warnings');
  expect(report.diagnostics).toEqual([
    expect.objectContaining({
      code: 'AB6020',
      generatedPath: '.claude-plugin/plugin.json',
      message: "Claude plugin validation (plugin .claude-plugin/plugin.json): displayNme: Unknown field 'displayNme' " +
        "— did you mean 'displayName'? Claude Code ignores unrecognized fields at load time, so this field has no effect.",
      severity: 'warning',
    }),
    expect.objectContaining({
      code: 'AB6020',
      generatedPath: '.claude-plugin/plugin.json',
      message: expect.stringContaining("bogus: Unknown field 'bogus'"),
    }),
    expect.objectContaining({
      code: 'AB6020',
      generatedPath: 'agents/bad.md',
      message: expect.stringContaining('(agent agents/bad.md): description: No description in frontmatter'),
    }),
    expect.objectContaining({
      code: 'AB6020',
      generatedPath: 'hooks/hooks.json',
      message: expect.stringContaining('(hooks hooks/hooks.json): hooks: hooks.Stop.0.hooks.0: Unknown hook type "bogus"'),
    }),
    expect.objectContaining({
      code: 'AB6020',
      generatedPath: 'hooks/hooks.json',
      message: expect.stringContaining('hooks.postToolUse: unknown hook event'),
    }),
  ]);
  // The marketplace run's `plugins[0] plugin.json → …` copies of the two manifest warnings are dropped.
  expect(report.diagnostics.filter((entry) => entry.message.includes('plugins[0]'))).toEqual([]);

  const strict = await validateClaudePlugin({ pluginDirectory: bundle, run: fixture.run, strict: true, target: 'claude' });
  expect(strict.status).toBe('failed');
  expect(strict.diagnostics.every((entry) => entry.severity === 'error')).toBe(true);
});

it('keeps marketplace-only findings and maps JSON errors to AB6021', async () => {
  const bundle = await emittedClaudeBundle();
  const marketplace = JSON.stringify({
    contents: [],
    manifest: {
      errors: [{ code: null, message: 'Duplicate plugin name "fixture" found in marketplace', path: 'plugins' }],
      file: join(bundle, '.claude-plugin', 'marketplace.json'),
      notes: [{ code: null, message: 'Marketplace has one plugin.', path: null }],
      type: 'marketplace',
      warnings: [{ code: null, message: 'No marketplace description provided', path: 'description' }],
    },
    strict: true,
    success: false,
    target: join(bundle, '.claude-plugin', 'marketplace.json'),
  });
  const fixture = runByTarget({
    marketplace: { exitCode: 1, stdout: marketplace },
    plugin: { exitCode: 0, stdout: await recordedReport('2.1.259-plugin-strict-passed.json', bundle) },
  });
  const report = await validateClaudePlugin({ pluginDirectory: bundle, run: fixture.run, target: 'claude' });

  expect(report.status).toBe('failed');
  expect(report.diagnostics).toEqual([
    expect.objectContaining({
      code: 'AB6021',
      generatedPath: '.claude-plugin/marketplace.json',
      message: 'Claude plugin validation (marketplace .claude-plugin/marketplace.json): plugins: ' +
        'Duplicate plugin name "fixture" found in marketplace',
      severity: 'error',
    }),
    expect.objectContaining({ code: 'AB6020', severity: 'warning', message: expect.stringContaining('No marketplace description') }),
    expect.objectContaining({ code: 'AB6020', severity: 'info', message: expect.stringContaining('Marketplace has one plugin.') }),
  ]);
});

it('reports AB6022 when a 2.1.259 run returns no JSON report (exit 2 writes only to stderr)', async () => {
  const bundle = await emittedClaudeBundle(false);
  const fixture = runByTarget({
    plugin: { exitCode: 2, stderr: 'Error: EACCES: permission denied', stdout: '' },
  });
  const report = await validateClaudePlugin({ pluginDirectory: bundle, run: fixture.run, target: 'claude' });

  expect(report).toMatchObject({
    diagnostics: [expect.objectContaining({
      code: 'AB6022',
      message: 'Claude host artifact validation did not return a JSON report (exit code 2): Error: EACCES: permission denied.',
      severity: 'error',
    })],
    status: 'failed',
    version: '2.1.259',
  });
});

it('parses the text reporter with file attribution on Claude Code 2.1.250, which has no --json', async () => {
  const bundle = await emittedClaudeBundle();
  const text = await recordedReport('2.1.250-plugin-strict-findings.txt', bundle);
  const fixture = runByTarget({
    marketplace: { exitCode: 0, stdout: `Validating marketplace manifest: ${join(bundle, '.claude-plugin', 'marketplace.json')}\n\n✔ Validation passed\n` },
    plugin: { exitCode: 1, stdout: text },
  }, '2.1.250');
  const report = await validateClaudePlugin({ pluginDirectory: bundle, run: fixture.run, target: 'claude' });

  expect(fixture.calls[1]).toEqual(['plugin', 'validate', join(bundle, '.claude-plugin', 'plugin.json'), '--strict']);
  expect(fixture.calls[2]).toEqual(['plugin', 'validate', join(bundle, '.claude-plugin', 'marketplace.json'), '--strict']);
  expect(report.status).toBe('failed');
  expect(report.diagnostics).toEqual([
    expect.objectContaining({
      code: 'AB6020',
      generatedPath: '.claude-plugin/plugin.json',
      message: expect.stringContaining("(plugin .claude-plugin/plugin.json): displayNme: Unknown field 'displayNme'"),
    }),
    expect.objectContaining({ code: 'AB6020', generatedPath: '.claude-plugin/plugin.json' }),
    expect.objectContaining({
      code: 'AB6020',
      generatedPath: 'agents/bad.md',
      message: expect.stringContaining('(agent agents/bad.md): description: No description in frontmatter'),
    }),
    expect.objectContaining({
      code: 'AB6021',
      generatedPath: 'hooks/hooks.json',
      message: 'Claude plugin validation (hooks hooks/hooks.json): hooks.Stop.0.hooks.0.type: Invalid input',
      severity: 'error',
    }),
    expect.objectContaining({
      code: 'AB6021',
      generatedPath: 'hooks/hooks.json',
      message: 'Claude plugin validation (hooks hooks/hooks.json): hooks.postToolUse: Invalid key in record',
    }),
  ]);
});
