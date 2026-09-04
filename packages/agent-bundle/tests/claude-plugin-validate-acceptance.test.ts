import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, expect, it } from '@rstest/core';

import { claudeAdapter } from '../src/adapters/claude.ts';
import { emitPlanEntries } from '../src/build/emit.ts';
import { pathTokens, type NormalizedHook, type NormalizedPlugin } from '../src/core/types.ts';
import { validateClaudePluginFiles } from '../src/host-contracts/claude-plugin-validation.ts';
import { claudePluginRowErrors } from '../src/install/install.ts';

const configPath = '/workspace/agent-bundle.config.ts';

const hook = (event: NormalizedHook['event'], name: string): NormalizedHook => ({
  event,
  id: `hook:${name}`,
  name,
  provenance: { kind: 'config', sourcePath: configPath },
  source: `/workspace/src/hooks/${name}.ts`,
  targets: ['claude'],
  tools: [],
});

/**
 * The shape ScriptedAlchemy/cargo-hauler#48 shipped: SessionStart, PreToolUse,
 * PostToolUse, and Stop hooks beside a stdio MCP server, built for the `claude`
 * target and installed through a marketplace. Claude Code 2.1.250–2.1.260
 * refused it while `.claude-plugin/plugin.json` named `./hooks/hooks.json`
 * under `hooks` (#462/#463, fixed in #470).
 */
const cargoHaulerShape: NormalizedPlugin = {
  extensions: {},
  hooks: [
    hook('sessionStart', 'session-start'),
    hook('beforeTool', 'before-tool'),
    hook('afterTool', 'after-tool'),
    hook('stop', 'stop'),
  ],
  marketplace: true,
  mcpServers: [{
    args: [`${pathTokens.pluginRoot}/mcp/mcp-hauler.mjs`],
    command: 'node',
    id: 'mcp:hauler',
    name: 'hauler',
    provenance: { kind: 'config', sourcePath: configPath },
    targets: ['claude'],
    transport: 'stdio',
  }],
  metadata: {
    description: 'Coalesce, schedule, and stream cargo so concurrent agent sessions share compiles instead of fighting locks.',
    id: 'plugin:cargo-hauler',
    name: 'cargo-hauler',
    provenance: { kind: 'config', sourcePath: configPath },
    version: '0.4.1',
  },
  runtime: { node: '22.12.0' },
  scripts: [],
  skills: [],
  targets: [{
    id: 'target:claude',
    name: 'claude',
    provenance: { kind: 'config', sourcePath: configPath },
  }],
};

const claudeVersionProbe = spawnSync('claude', ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 });
const claudeAvailable = claudeVersionProbe.status === 0;
const claudeIt = claudeAvailable ? it : it.skip;
const missingClaude = ' [missing evidence: claude binary unavailable on PATH]';

/** `claude --version` prints `<semver> (Claude Code)`; `plugin validate --json` exists from 2.1.259 (plugins reference, "plugin validate"). */
const claudeVersion = /(\d+)\.(\d+)\.(\d+)/u.exec(claudeVersionProbe.stdout ?? '')?.slice(1, 4).map(Number) ?? [0, 0, 0];
const claudeAtLeast = (major: number, minor: number, patch: number): boolean => {
  const [actualMajor = 0, actualMinor = 0, actualPatch = 0] = claudeVersion;
  return actualMajor !== major ? actualMajor > major : actualMinor !== minor ? actualMinor > minor : actualPatch >= patch;
};
const validateJsonSupported = claudeAtLeast(2, 1, 259);

let root: string;
let claudeConfigDir: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-bundle-claude-validate-acceptance-'));
  claudeConfigDir = join(root, 'claude-config');
  const plan = claudeAdapter.plan(cargoHaulerShape);
  expect(plan.diagnostics).toEqual([]);
  await emitPlanEntries({ entries: plan.entries, root: join(root, 'plugin') });
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

/** Runs the real Claude Code CLI against an isolated config dir so the user's plugin state is never read or written. */
const runClaude = (args: readonly string[]): string => {
  const result = spawnSync('claude', [...args], {
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeConfigDir },
    timeout: 60_000,
  });
  expect(result.error, `claude ${args.join(' ')} could not be started`).toBeUndefined();
  expect(result.status, `claude ${args.join(' ')} failed:\n${result.stderr}\n${result.stdout}`).toBe(0);
  return result.stdout;
};

const runClaudeJson = (args: readonly string[]): unknown => JSON.parse(runClaude(args)) as unknown;

it('emits the cargo-hauler shape at the default hook location with no manifest hooks key and a schema-valid manifest', async () => {
  const pluginRoot = join(root, 'plugin');
  const plan = claudeAdapter.plan(cargoHaulerShape);
  const documents = Object.fromEntries(plan.entries.flatMap((entry) =>
    entry.kind === 'write' ? [[entry.relativePath, entry.content]] : []));
  const manifest = JSON.parse(documents['.claude-plugin/plugin.json']!) as Record<string, unknown>;
  expect(manifest).toEqual({
    author: { name: 'cargo-hauler' },
    description: cargoHaulerShape.metadata.description,
    name: 'cargo-hauler',
    version: '0.4.1',
  });
  const hooks = JSON.parse(documents['hooks/hooks.json']!) as { readonly hooks: Record<string, unknown> };
  expect(Object.keys(hooks.hooks).sort()).toEqual(['PostToolUse', 'PreToolUse', 'SessionStart', 'Stop']);
  expect(JSON.parse(documents['.mcp.json']!)).toMatchObject({ mcpServers: { hauler: { command: 'node' } } });
  await expect(validateClaudePluginFiles({ pluginDirectory: pluginRoot, target: 'claude' })).resolves.toEqual([]);
});

// Acceptance gate for the published Claude contract (plugins reference, "Plugin validation" and
// "plugin list --json"): the emitted artifact must pass `claude plugin validate --strict --json` AND
// load without `errors` in `claude --plugin-dir <root> plugin list --json`. The second check is the
// one that matters for #462/#463: `plugin validate` accepted the duplicate-hooks manifest that Claude
// Code then refused at load time, so validation alone is not proof the plugin reaches a session.
// `--json` on `plugin validate` exists from Claude Code 2.1.259 and is the primary path on the pinned
// 2.1.260 the CI host-install job runs; an older binary (2.1.250 rejects the flag with "unknown option
// '--json'") takes the textual form and is held to its exit code and "Validation passed" line instead.
claudeIt(`passes claude plugin validate --strict and loads without errors for the emitted claude artifact${claudeAvailable ? '' : missingClaude}`, () => {
  const pluginRoot = join(root, 'plugin');

  if (validateJsonSupported) {
    const report = runClaudeJson(['plugin', 'validate', pluginRoot, '--strict', '--json']) as {
      readonly success: boolean;
      readonly strict: boolean;
      readonly manifest: { readonly errors: readonly unknown[]; readonly warnings: readonly unknown[] };
      readonly contents: readonly { readonly file: string; readonly errors: readonly unknown[] }[];
    };
    expect(report, JSON.stringify(report, null, 2)).toMatchObject({ strict: true, success: true });
    expect(report.manifest.errors).toEqual([]);
    expect(report.manifest.warnings).toEqual([]);
    expect(report.contents.flatMap((entry) => entry.errors)).toEqual([]);
  } else {
    const output = runClaude(['plugin', 'validate', pluginRoot, '--strict']);
    expect(output, `claude ${claudeVersion.join('.')} plugin validate --strict output:\n${output}`).toContain('Validation passed');
  }

  const rows = runClaudeJson(['--plugin-dir', pluginRoot, 'plugin', 'list', '--json']) as readonly Record<string, unknown>[];
  const row = rows.find((candidate) => candidate['id'] === 'cargo-hauler@inline');
  expect(row, JSON.stringify(rows, null, 2)).toBeDefined();
  expect(row).toMatchObject({ enabled: true, installPath: pluginRoot, version: '0.4.1' });
  expect(claudePluginRowErrors(row!)).toEqual([]);
  expect(row).not.toHaveProperty('errors');
});
