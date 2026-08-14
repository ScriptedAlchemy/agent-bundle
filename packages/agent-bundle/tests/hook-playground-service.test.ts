import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { build } from '../src/build/build.ts';
import { listArtifactFiles } from '../src/build/emit.ts';
import { normalizeProject } from '../src/config/normalize.ts';
import { digest } from '../src/core/digest.ts';
import type { LoadedConfig } from '../src/config/load.ts';
import type { AgentBundleConfig, CanonicalHookEvent, NormalizationTargetRegistry } from '../src/core/types.ts';
import { EpochStore } from '../src/dev/epoch-store.ts';
import { HookPlaygroundService } from '../src/dev/hook-playground-service.ts';
import { HookService } from '../src/services/hook-service.ts';
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

const epochFor = (
  root: string,
  id: string,
  targetDigests: Readonly<Record<string, string>>,
): ArtifactEpoch => ({
  configDigest: 'config-digest',
  createdAt: '2026-08-14T12:00:00.000Z',
  diagnostics: { errors: 0, infos: 0, warnings: 0 },
  id,
  manifestPath: join(root, '.agent-bundle', 'epochs', id, 'agent-bundle.manifest.json'),
  modelDigest: 'model-digest',
  projectRevision: 'project-revision',
  targetDigests,
});

interface PublishedHookEpoch {
  readonly epochStore: EpochStore;
  readonly hooks: Readonly<Record<CanonicalHookEvent, Readonly<{ readonly id: string; readonly name: string }>>>;
}

const runNativeHook = async (
  wrapper: string,
  input: Record<string, unknown>,
): Promise<{ readonly code: number | null; readonly stderr: string; readonly stdout: string }> =>
  new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [wrapper], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code, stderr, stdout }));
    child.stdin.end(JSON.stringify(input));
  });

const publishHookEpoch = async (root: string, id: string, marker: string): Promise<PublishedHookEpoch> => {
  const sourceRoot = join(root, 'src', 'hooks');
  const artifact = join(root, `compiled-${id}`);
  await mkdir(sourceRoot, { recursive: true });
  await Promise.all([
    writeFile(join(root, 'package.json'), '{"type":"module"}\n'),
    writeFile(join(sourceRoot, 'session-start.ts'), [
      'export default (event: { source?: string }) => ({',
      "  additionalContext: 'session:" + marker + ":' + event.source,",
      "  outcome: 'continue' as const,",
      '});',
      '',
    ].join('\n')),
    writeFile(join(sourceRoot, 'check-command.ts'), [
      "import { rm, writeFile } from 'node:fs/promises';",
      '',
      'export default async (event: { toolInput?: { command?: string } }) => {',
      '  if (event.toolInput?.command === "hang") return new Promise(() => setInterval(() => undefined, 1_000));',
      '  if (event.toolInput?.command === "mutate") {',
      "    await writeFile('simulation-only.txt', process.cwd(), 'utf8');",
      "    await rm('agent-bundle.manifest.json');",
      '    return {',
      '      additionalContext: `mutated:${process.cwd()}`,',
      "      outcome: 'continue' as const,",
      "      updatedInput: { command: 'rewritten' },",
      '    };',
      '  }',
      '  return {',
      "    additionalContext: 'checked:" + marker + "',",
      "    outcome: 'continue' as const,",
      "    updatedInput: { command: 'rewritten' },",
      '  };',
      '};',
      '',
    ].join('\n')),
    writeFile(join(sourceRoot, 'record.ts'), [
      'export default () => ({',
      "  additionalContext: 'recorded:" + marker + "',",
      "  outcome: 'continue' as const,",
      '});',
      '',
    ].join('\n')),
    writeFile(join(sourceRoot, 'stop.ts'), [
      'export default () => ({',
      "  outcome: 'deny' as const,",
      "  reason: 'stopped:" + marker + "',",
      '});',
      '',
    ].join('\n')),
  ]);
  const model = await normalizeProject(
    loadedProject(root, {
      hooks: {
        afterTool: { handler: './src/hooks/record.ts', tools: ['file.write'] },
        beforeTool: { handler: './src/hooks/check-command.ts', timeout: 1, tools: ['shell'] },
        sessionStart: './src/hooks/session-start.ts',
        stop: './src/hooks/stop.ts',
      },
      plugin: { name: 'hook-playground-fixture', version: '1.0.0' },
      targets: ['codex', 'claude'],
    }),
    { skills: [] },
    registry,
  );
  await build({ model, outputRoot: artifact, projectRoot: root, registry: createDefaultRegistry() });

  const targetDigests = Object.freeze(Object.fromEntries(await Promise.all(
    ['claude', 'codex'].map(async (target) => [
      target,
      digest(await listArtifactFiles(join(artifact, target))),
    ]),
  )));
  const store = new EpochStore({ projectRoot: root });
  const staging = await store.createStagingEpoch({ epoch: epochFor(root, id, targetDigests), targets: ['codex', 'claude'] });
  await Promise.all((await readdir(artifact)).map((entry) => cp(join(artifact, entry), join(staging.root, entry), { recursive: true })));
  await staging.publish(async () => undefined);
  const hookFor = (event: CanonicalHookEvent): Readonly<{ readonly id: string; readonly name: string }> => {
    const hook = model.hooks.find((candidate) => candidate.event === event);
    if (hook === undefined) throw new Error(`Missing ${event} fixture hook.`);
    return Object.freeze({ id: hook.id, name: hook.name });
  };
  return Object.freeze({
    epochStore: store,
    hooks: Object.freeze({
      afterTool: hookFor('afterTool'),
      beforeTool: hookFor('beforeTool'),
      sessionStart: hookFor('sessionStart'),
      stop: hookFor('stop'),
    }),
  });
};

const inputFor = (event: CanonicalHookEvent): Record<string, unknown> => ({
  cwd: '/workspace',
  ...(event === 'afterTool' || event === 'beforeTool'
    ? {
      toolInput: { command: 'safe' },
      toolName: 'Bash',
      toolUseId: 'use-1',
      ...(event === 'afterTool' ? { toolResponse: { value: 'ok' } } : {}),
    }
    : event === 'sessionStart'
      ? { source: 'startup' }
      : { lastAssistantMessage: 'done', stopHookActive: false }),
  sessionId: 'session-1',
  transcriptPath: '/workspace/transcript.json',
});

it('runs fixture and inline canonical input through the epoch-bound wrapper and preserves its replay epoch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hook-playground-'));
  try {
    const epochOne = await publishHookEpoch(root, 'epoch-1', 'one');
    await publishHookEpoch(root, 'epoch-2', 'two');
    const service = new HookPlaygroundService({ epochStore: epochOne.epochStore });
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
      hook: epochOne.hooks.beforeTool.id,
      target: 'codex',
    } as const;

    const inline = await service.simulate({ ...options, input: { inline: input } });
    const fixture = await service.simulate({ ...options, input: { fixture: input } });

    expect(inline).toEqual({
      binding: options,
      canonicalIntent: {
        event: 'beforeTool',
        hook: epochOne.hooks.beforeTool.id,
        input,
      },
      canonicalResult: {
        additionalContext: 'checked:one',
        outcome: 'continue',
        updatedInput: { command: 'rewritten' },
      },
      hostMapping: {
        canonicalEvent: 'beforeTool',
        matcher: '^Bash$',
        nativeEvent: 'PreToolUse',
        nativeProjection: 'deterministic',
        nativeSelector: 'PreToolUse',
        target: 'codex',
        wrapperPath: `codex/hooks/${epochOne.hooks.beforeTool.name}.mjs`,
      },
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
    expect(Object.isFrozen(inline.canonicalIntent.input.toolInput)).toBe(true);
    expect(Object.isFrozen(inline.nativeInput.tool_input)).toBe(true);
    expect(Object.isFrozen((inline.nativeOutput?.hookSpecificOutput as Record<string, unknown>).updatedInput)).toBe(true);
    expect(Object.isFrozen(inline.replay.input.toolInput)).toBe(true);
    expect(inline.canonicalIntent.input.toolInput).not.toBe(input.toolInput);
    input.toolInput.command = 'mutated after simulation';
    expect(inline.canonicalIntent.input.toolInput).toEqual({ command: 'safe' });

    await expect(runNativeHook(
      join(root, '.agent-bundle', 'epochs', 'epoch-1', inline.hostMapping.wrapperPath),
      inline.nativeInput,
    )).resolves.toEqual({
      code: 0,
      stderr: '',
      stdout: JSON.stringify(inline.nativeOutput),
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('projects every emitted Codex and Claude event deterministically and exposes its native selector', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hook-playground-codecs-'));
  try {
    const epoch = await publishHookEpoch(root, 'epoch-1', 'one');
    const service = new HookPlaygroundService({ epochStore: epoch.epochStore });

    for (const target of ['codex', 'claude'] as const) {
      for (const event of ['sessionStart', 'beforeTool', 'afterTool', 'stop'] as const) {
        const trace = await service.simulate({
          epochId: 'epoch-1',
          hook: epoch.hooks[event].id,
          input: { inline: inputFor(event) },
          target,
        });
        expect(trace.hostMapping).toMatchObject({
          canonicalEvent: event,
          nativeProjection: 'deterministic',
          nativeSelector: trace.hostMapping.nativeEvent,
          target,
          wrapperPath: `${target}/hooks/${epoch.hooks[event].name}.mjs`,
        });
        await expect(runNativeHook(
          join(root, '.agent-bundle', 'epochs', 'epoch-1', trace.hostMapping.wrapperPath),
          trace.nativeInput,
        )).resolves.toEqual({
          code: 0,
          stderr: '',
          stdout: trace.nativeOutput === undefined ? '' : JSON.stringify(trace.nativeOutput),
        });
      }
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('isolates malicious relative writes from the referenced epoch and rejects coordinated target tampering', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hook-playground-concurrent-'));
  try {
    const epoch = await publishHookEpoch(root, 'epoch-1', 'one');
    const service = new HookPlaygroundService({ epochStore: epoch.epochStore });
    const request = {
      epochId: 'epoch-1',
      hook: epoch.hooks.beforeTool.id,
      input: { inline: { ...inputFor('beforeTool'), toolInput: { command: 'mutate' } } },
      target: 'codex' as const,
    };
    const epochRoot = join(root, '.agent-bundle', 'epochs', 'epoch-1');
    const manifestPath = join(epochRoot, 'agent-bundle.manifest.json');
    const manifestBefore = await readFile(manifestPath, 'utf8');

    const [first, second] = await Promise.all([service.simulate(request), service.simulate(request)]);
    expect(first.canonicalResult?.additionalContext).toMatch(/^mutated:/);
    expect(second.canonicalResult?.additionalContext).toMatch(/^mutated:/);
    expect(first.canonicalResult?.additionalContext).not.toEqual(second.canonicalResult?.additionalContext);
    await expect(readFile(manifestPath, 'utf8')).resolves.toBe(manifestBefore);
    await expect(access(join(epochRoot, 'simulation-only.txt'))).rejects.toMatchObject({ code: 'ENOENT' });

    const wrapperPath = `codex/hooks/${epoch.hooks.beforeTool.name}.mjs`;
    const wrapper = join(epochRoot, wrapperPath);
    const tamperedWrapper = "process.stdout.write('');\n";
    await writeFile(wrapper, tamperedWrapper);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as {
      readonly files: Array<{ bytes: number; path: string; sha256: string }>;
    };
    const manifestEntry = manifest.files.find((entry) => entry.path === wrapperPath);
    if (manifestEntry === undefined) throw new Error('Expected wrapper manifest entry.');
    manifestEntry.bytes = Buffer.byteLength(tamperedWrapper);
    manifestEntry.sha256 = createHash('sha256').update(tamperedWrapper).digest('hex');
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`);
    await expect(service.simulate(request)).rejects.toThrow(/stored digest/i);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('settles route cancellation and cleans the per-simulation clone before releasing its epoch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hook-playground-cancel-'));
  try {
    const epoch = await publishHookEpoch(root, 'epoch-1', 'one');
    const hooks = new HookService();
    let runnableArtifact: string | undefined;
    const service = new HookPlaygroundService({
      epochStore: epoch.epochStore,
      hookService: {
        list: (options) => hooks.list(options),
        simulate: (options) => {
          runnableArtifact = options.artifact;
          return hooks.simulate(options);
        },
      },
    });
    const controller = new AbortController();
    const pending = service.simulate({
      epochId: 'epoch-1',
      hook: epoch.hooks.beforeTool.id,
      input: { inline: { ...inputFor('beforeTool'), toolInput: { command: 'hang' } } },
      signal: controller.signal,
      target: 'codex',
    });
    setTimeout(() => controller.abort(), 25);

    await expect(pending).rejects.toThrow('Hook simulation aborted.');
    expect(runnableArtifact).toBeDefined();
    expect(runnableArtifact).not.toBe(join(root, '.agent-bundle', 'epochs', 'epoch-1'));
    await expect(access(runnableArtifact!)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('distinguishes an unsupported canonical event from an unsupported target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hook-playground-unsupported-event-'));
  try {
    const epoch = await publishHookEpoch(root, 'epoch-1', 'one');
    const service = new HookPlaygroundService({
      epochStore: epoch.epochStore,
      hookService: {
        list: async () => [{
          event: 'futureEvent',
          id: 'hook:future',
          name: 'future',
          path: 'codex/hooks/future.mjs',
          target: 'codex',
        }],
        simulate: async () => {
          throw new Error('Unsupported event must not execute a wrapper.');
        },
      },
    });

    await expect(service.simulate({
      epochId: 'epoch-1',
      hook: 'hook:future',
      input: { inline: inputFor('beforeTool') },
      target: 'codex',
    })).resolves.toEqual({
      diagnostics: [{
        code: 'hook.playground.event.unsupported',
        event: 'futureEvent',
        message: 'Hook playground target "codex" cannot map canonical event "futureEvent".',
        severity: 'error',
        target: 'codex',
      }],
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('returns a diagnostic for a target without a hook event mapping', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hook-playground-diagnostic-'));
  try {
    const epochOne = await publishHookEpoch(root, 'epoch-1', 'one');
    const service = new HookPlaygroundService({ epochStore: epochOne.epochStore });

    await expect(service.simulate({
      epochId: 'epoch-1',
      hook: epochOne.hooks.beforeTool.id,
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
        code: 'hook.playground.target.unsupported',
        event: 'beforeTool',
        message: 'Hook playground cannot map target "portable" for canonical event "beforeTool".',
        severity: 'error',
        target: 'portable',
      }],
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);
