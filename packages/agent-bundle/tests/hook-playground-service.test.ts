import { cp, mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { build } from '../src/build/build.ts';
import { normalizeProject } from '../src/config/normalize.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import type { AgentBundleConfig, NormalizationTargetRegistry } from '../src/core/types.ts';
import { EpochStore } from '../src/dev/epoch-store.ts';
import { HookPlaygroundService } from '../src/dev/hook-playground-service.ts';
import type { ArtifactEpoch } from '../src/dev/types.ts';

const registry: NormalizationTargetRegistry = {
  defaultTargetNames: () => ['codex', 'claude'],
  has: (name) => ['portable', 'codex', 'claude'].includes(name),
  supports: (name, capability) => capability === 'hooks' && name !== 'portable',
};

const loadedProject = (root: string, config: AgentBundleConfig): LoadedConfig => ({
  config,
  configPath: join(root, 'agent-bundle.config.ts'),
  context: {
    command: 'build',
    mode: 'production',
    projectRoot: root,
    selectedTargets: [],
  },
});

const epochFor = (root: string, id: string): ArtifactEpoch => ({
  configDigest: 'config-digest',
  createdAt: '2026-08-14T12:00:00.000Z',
  diagnostics: { errors: 0, infos: 0, warnings: 0 },
  id,
  manifestPath: join(root, '.agent-bundle', 'epochs', id, 'agent-bundle.manifest.json'),
  modelDigest: 'model-digest',
  projectRevision: 'project-revision',
  targetDigests: { claude: 'claude-digest', codex: 'codex-digest' },
});

interface PublishedHookEpoch {
  readonly epochStore: EpochStore;
  readonly hookId: string;
}

const publishHookEpoch = async (root: string, id: string, marker: string): Promise<PublishedHookEpoch> => {
  const sourceRoot = join(root, 'src', 'hooks');
  const artifact = join(root, `compiled-${id}`);
  await mkdir(sourceRoot, { recursive: true });
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(join(sourceRoot, 'check-command.ts'), [
      'export default (event: { toolInput?: { command?: string } }) => ({',
      "  additionalContext: 'checked:" + marker + "',",
      "  outcome: 'continue' as const,",
      "  updatedInput: { command: 'rewritten' },",
      '});',
      '',
    ].join('\n')),
  ]);
  const model = await normalizeProject(
    loadedProject(root, {
      hooks: { beforeTool: './src/hooks/check-command.ts' },
      plugin: { name: 'hook-playground-fixture', version: '1.0.0' },
      targets: ['codex', 'claude'],
    }),
    { skills: [] },
    registry,
  );
  await build({ model, outputRoot: artifact, projectRoot: root, registry: createDefaultRegistry() });

  const store = new EpochStore({ projectRoot: root });
  const staging = await store.createStagingEpoch({ epoch: epochFor(root, id), targets: ['codex', 'claude'] });
  await Promise.all((await readdir(artifact)).map((entry) => cp(join(artifact, entry), join(staging.root, entry), { recursive: true })));
  await staging.publish(async () => undefined);
  return { epochStore: store, hookId: model.hooks[0]!.id };
};

it('runs fixture and inline canonical input through the epoch-bound wrapper and preserves its replay epoch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hook-playground-'));
  try {
    const epochOne = await publishHookEpoch(root, 'epoch-1', 'one');
    await publishHookEpoch(root, 'epoch-2', 'two');
    const service = new HookPlaygroundService({ epochStore: epochOne.epochStore, projectRoot: root });
    const input = {
      cwd: '/workspace',
      sessionId: 'session-1',
      toolInput: { command: 'safe' },
      toolName: 'Bash',
      toolUseId: 'use-1',
      transcriptPath: '/workspace/transcript.json',
    };
    const options = {
      epochId: 'epoch-1',
      hook: epochOne.hookId,
      target: 'codex',
    } as const;

    const inline = await service.simulate({ ...options, input: { inline: input } });
    const fixture = await service.simulate({ ...options, input: { fixture: input } });

    expect(inline).toEqual({
      binding: options,
      canonicalResult: {
        additionalContext: 'checked:one',
        outcome: 'continue',
        updatedInput: { command: 'rewritten' },
      },
      hostMapping: { canonicalEvent: 'beforeTool', nativeEvent: 'PreToolUse', target: 'codex' },
      nativeInput: {
        cwd: '/workspace',
        hook_event_name: 'PreToolUse',
        session_id: 'session-1',
        tool_input: { command: 'safe' },
        tool_name: 'Bash',
        tool_use_id: 'use-1',
        transcript_path: '/workspace/transcript.json',
      },
      nativeOutput: {
        hookSpecificOutput: {
          additionalContext: 'checked:one',
          hookEventName: 'PreToolUse',
          permissionDecision: 'allow',
          updatedInput: { command: 'rewritten' },
        },
      },
      replay: { binding: options, input },
    });
    expect(fixture).toEqual(inline);
    await expect(service.replay(inline.replay)).resolves.toEqual(inline);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('returns a diagnostic for a target without a hook event mapping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hook-playground-diagnostic-'));
  try {
    const epochOne = await publishHookEpoch(root, 'epoch-1', 'one');
    const service = new HookPlaygroundService({ epochStore: epochOne.epochStore, projectRoot: root });

    await expect(service.simulate({
      epochId: 'epoch-1',
      hook: epochOne.hookId,
      input: {
        inline: {
          cwd: '/workspace',
          sessionId: 'session-1',
          toolInput: { command: 'safe' },
          toolName: 'Bash',
          toolUseId: 'use-1',
          transcriptPath: '/workspace/transcript.json',
        },
      },
      target: 'portable',
    })).resolves.toEqual({
      diagnostics: [{
        code: 'hook.playground.mapping.unsupported',
        message: 'Hook playground cannot map target "portable" to a native hook event.',
        severity: 'error',
        target: 'portable',
      }],
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);
