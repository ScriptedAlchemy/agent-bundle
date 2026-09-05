import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AGENT_STATE_DEFAULT_BUDGETS } from '@agent-bundle/runtime/state';
import { expect, it } from '@rstest/core';

import { runCli } from '../src/cli.ts';
import { agentStateDefaultBudgets } from '../src/core/state-inspection.ts';
import { captureCliTerminal } from './support/cli-terminal.ts';

it('keeps static inspection defaults aligned with the runtime package', () => {
  expect(agentStateDefaultBudgets).toEqual({
    maxCommitMs: 5_000,
    maxEventBytes: 262_144,
    maxRevisions: 100_000,
    maxStateBytes: 1_048_576,
  });
  expect(agentStateDefaultBudgets).toEqual(AGENT_STATE_DEFAULT_BUDGETS);
  expect(Object.isFrozen(agentStateDefaultBudgets)).toBe(true);
});

const createProject = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-inspect-state-'));
  await Promise.all([
    mkdir(join(root, 'src'), { recursive: true }),
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(join(root, 'agent-bundle.config.ts'), [
      'export default {',
      "  plugin: { name: 'state-fixture', version: '1.0.0' },",
      "  targets: ['portable'],",
      '};',
      '',
    ].join('\n')),
  ]);
  return root;
};

const inspectCli = async (
  root: string,
  args: readonly string[],
): Promise<{ readonly code: number; readonly stderr: string; readonly stdout: string }> => {
  const terminal = captureCliTerminal();
  const code = await runCli(['inspect', '--root', root, ...args], terminal.output);
  return { code, stderr: terminal.stderr(), stdout: terminal.stdout() };
};

it('inspects volatile and workspace-durable state without inventing runtime paths', async () => {
  const root = await createProject();
  const stateSource = join(root, 'src', 'state.ts');
  try {
    await writeFile(stateSource, [
      'export default defineState({',
      "  id: 'fixture/process-state',",
      "  lifetime: 'process',",
      '});',
      '',
    ].join('\n'));

    const volatile = await inspectCli(root, ['--state', '--json']);
    expect(volatile).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(volatile.stdout)).toMatchObject({
      selected: {
        state: {
          budgets: {
            resolved: {
              maxCommitMs: 5_000,
              maxEventBytes: 262_144,
              maxRevisions: 100_000,
              maxStateBytes: 1_048_576,
            },
            source: 'defaults',
          },
          declared: true,
          driver: 'memory',
          id: 'fixture/process-state',
          lifetime: 'process',
          // Retention is static policy: the runtime defaults until `notices.retention` says otherwise.
          noticeRetention: {
            resolved: { maxJournalBytes: 16_777_216, maxTerminal: 500, terminalTtlMs: 604_800_000 },
            source: 'defaults',
          },
          notices: [
            expect.stringContaining('@agent-bundle/runtime/agent-notice-ledger/v1'),
            expect.stringContaining('AgentNoticeLedger.inspect()'),
          ],
          provenance: { kind: 'conventional', sourcePath: stateSource },
          source: stateSource,
        },
      },
      state: 'ready',
    });
    expect(JSON.parse(volatile.stdout).selected.state).not.toHaveProperty('durableLocation');

    await writeFile(stateSource, [
      'export default defineState({',
      "  id: 'fixture/durable-state',",
      "  lifetime: 'workspace-durable',",
      '  budgets: { maxStateBytes: 2048 },',
      '});',
      '',
    ].join('\n'));
    const durable = await inspectCli(root, ['--state', '--json']);
    expect(durable).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(durable.stdout)).toMatchObject({
      selected: {
        state: {
          budgets: {
            resolved: {
              ...AGENT_STATE_DEFAULT_BUDGETS,
              maxStateBytes: 2048,
            },
            source: 'declared',
          },
          declared: true,
          driver: 'sqlite',
          durableLocation: '$AGENT_BUNDLE_PLUGIN_ROOT/state (falls back to the artifact root or ./.agent-bundle/state for CLI bins)',
          id: 'fixture/durable-state',
          lifetime: 'workspace-durable',
        },
      },
    });

    const humanFocus = await inspectCli(root, ['--state']);
    expect(JSON.parse(humanFocus.stdout)).toMatchObject({
      declared: true,
      id: 'fixture/durable-state',
    });

    const humanDefault = await inspectCli(root, []);
    expect(humanDefault.stdout).toContain(
      'state: fixture/durable-state (workspace-durable, sqlite driver)',
    );
    expect(humanDefault.stdout).not.toContain('Built manifest:');
    expect(JSON.parse((await inspectCli(root, ['--json'])).stdout).output.manifest).toBeUndefined();

    await writeFile(stateSource, [
      'export default defineState({',
      "  id: 'fixture/dynamic-state',",
      "  lifetime: 'request',",
      '  budgets: { maxCommitMs: MAX_COMMIT_MS },',
      '});',
      '',
    ].join('\n'));
    const dynamic = await inspectCli(root, ['--state', '--json']);
    expect(JSON.parse(dynamic.stdout)).toMatchObject({
      selected: {
        state: {
          budgets: { source: 'dynamic' },
          declared: true,
          driver: 'memory',
          id: 'fixture/dynamic-state',
          lifetime: 'request',
        },
      },
    });
    expect(JSON.parse(dynamic.stdout).selected.state.budgets).not.toHaveProperty('resolved');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('reports the declared notice retention policy and rejects a malformed one as AB4833', { timeout: 20_000 }, async () => {
  const root = await createProject();
  try {
    await writeFile(join(root, 'src', 'state.ts'), [
      'export default defineState({',
      "  id: 'fixture/retained-state',",
      "  lifetime: 'workspace-durable',",
      '});',
      '',
    ].join('\n'));
    // A declared `notices.retention` resolves over the defaults and is reported as declared.
    await writeFile(join(root, 'agent-bundle.config.ts'), [
      'export default {',
      "  notices: { retention: { maxTerminal: 12, terminalTtl: '2d' } },",
      "  plugin: { name: 'state-fixture', version: '1.0.0' },",
      "  targets: ['portable'],",
      '};',
      '',
    ].join('\n'));
    const retaining = await inspectCli(root, ['--state', '--json']);
    expect(retaining).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(retaining.stdout).selected.state.noticeRetention).toEqual({
      resolved: { maxJournalBytes: 16_777_216, maxTerminal: 12, terminalTtlMs: 172_800_000 },
      source: 'declared',
    });

    // A malformed policy is an AB4833 source error, never a silently defaulted one.
    await writeFile(join(root, 'agent-bundle.config.ts'), [
      'export default {',
      "  notices: { retention: { terminalTtl: 'soon' } },",
      "  plugin: { name: 'state-fixture', version: '1.0.0' },",
      "  targets: ['portable'],",
      '};',
      '',
    ].join('\n'));
    const malformed = await inspectCli(root, ['--state', '--json']);
    expect(malformed.code).not.toBe(0);
    expect(`${malformed.stdout}${malformed.stderr}`).toContain('AB4833');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('reports an invalid built manifest on inspect without treating it as missing', async () => {
  const root = await createProject();
  try {
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'dist', 'agent-bundle.manifest.json'), '{not-json');
    const json = await inspectCli(root, ['--json']);
    expect(json).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(json.stdout).output.manifest).toMatchObject({ status: 'invalid' });
    expect(typeof JSON.parse(json.stdout).output.manifest.detail).toBe('string');
    const human = await inspectCli(root, []);
    expect(human.stdout).toContain('Built manifest: invalid');
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('reports stateless inspection and rejects competing state focuses', async () => {
  const root = await createProject();
  try {
    const stateless = await inspectCli(root, ['--state', '--json']);
    expect(stateless).toMatchObject({ code: 0, stderr: '' });
    expect(JSON.parse(stateless.stdout)).toMatchObject({
      selected: { state: { declared: false } },
      state: 'ready',
    });

    await writeFile(join(root, 'src', 'state.ts'), [
      'export default defineState({',
      "  id: 'fixture/disabled-state',",
      "  lifetime: 'process',",
      '});',
      '',
    ].join('\n'));
    await writeFile(join(root, 'agent-bundle.config.ts'), [
      'export default {',
      "  plugin: { name: 'state-fixture', version: '1.0.0' },",
      "  targets: ['portable'],",
      '  state: false,',
      '};',
      '',
    ].join('\n'));
    const disabled = await inspectCli(root, ['--state', '--json']);
    expect(JSON.parse(disabled.stdout)).toMatchObject({
      selected: { state: { declared: false } },
      state: 'ready',
    });

    const ambiguous = await inspectCli(root, ['--state', '--routes']);
    expect(ambiguous.code).toBe(1);
    expect(JSON.parse(ambiguous.stderr)).toMatchObject([{ code: 'AB5000', severity: 'error' }]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
