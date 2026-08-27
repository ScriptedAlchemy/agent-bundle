import { access, cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { expect, it } from '@rstest/core';

import type { TargetHookContract } from '../src/adapters/hook-contract.ts';
import { createDefaultRegistry, TargetRegistry } from '../src/adapters/registry.ts';
import type { TargetAdapter } from '../src/adapters/types.ts';
import { build } from './support/build.ts';
import { loadedProject } from './support/loaded-project.ts';
import { runNodeScript } from './support/run-node-script.ts';
import { listArtifactFiles } from '../src/build/emit.ts';
import { normalizeProject } from '../src/config/normalize.ts';
import { digest, sha256Hex } from '../src/core/digest.ts';

import type { CanonicalHookEvent, NormalizationTargetRegistry } from '../src/core/types.ts';
import { EpochStore } from '../src/dev/epoch-store.ts';
import {
  HookPlaygroundService,
  type HookPlaygroundDiagnosticResult,
  type HookPlaygroundSimulation,
} from '../src/dev/playground/hook-playground-service.ts';
import { HookService } from '../src/services/hook-service.ts';
import type { ArtifactEpoch } from '../src/dev/types.ts';

const registry: NormalizationTargetRegistry = {
  configExtensions: () => [],
  defaultTargetNames: () => ['codex', 'claude'],
  has: (name) => ['portable', 'codex', 'claude'].includes(name),
  supports: (name, capability) => capability === 'hooks' && name !== 'portable',
};

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

type IsExact<Left, Right> =
  (<Type>() => Type extends Left ? 1 : 2) extends
  (<Type>() => Type extends Right ? 1 : 2)
    ? true
    : false;

const requireSimulation = (
  result: HookPlaygroundSimulation | HookPlaygroundDiagnosticResult,
): HookPlaygroundSimulation => {
  if ('diagnostics' in result) {
    throw new Error(`Expected a hook playground simulation, received diagnostics: ${JSON.stringify(result.diagnostics)}.`);
  }
  return result;
};

class CopyFailureEpochStore extends EpochStore {
  readonly #copyWorkSettled: () => boolean;
  cloneRoot: string | undefined;
  cloneRootExistsBeforeRelease: boolean | undefined;
  copyWorkSettledBeforeRelease: boolean | undefined;

  constructor(projectRoot: string, copyWorkSettled: () => boolean) {
    super({ projectRoot });
    this.#copyWorkSettled = copyWorkSettled;
  }

  override async releaseEpochReference(epochId: string): Promise<void> {
    this.copyWorkSettledBeforeRelease = this.#copyWorkSettled();
    if (this.cloneRoot !== undefined) {
      try {
        await access(this.cloneRoot);
        this.cloneRootExistsBeforeRelease = true;
      } catch {
        this.cloneRootExistsBeforeRelease = false;
      }
    }
    await super.releaseEpochReference(epochId);
  }
}

const runNativeHook = async (wrapper: string, input: Record<string, unknown>) =>
  runNodeScript({ args: [wrapper], input: JSON.stringify(input) });

const publishHookEpoch = async (
  root: string,
  id: string,
  marker: string,
  epochStore = new EpochStore({ projectRoot: root }),
): Promise<PublishedHookEpoch> => {
  const sourceRoot = join(root, 'src', 'hooks');
  const artifact = join(root, `compiled-${id}`);
  await mkdir(sourceRoot, { recursive: true });
  await Promise.all([
    writeFile(join(root, 'agent-bundle.config.ts'), 'export default {};\n'),
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
  const store = epochStore;
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

it('preserves a hostile original simulation failure when Dev Log reporting is enabled', async () => {
  const hostile = Object.freeze({
    [Symbol.toPrimitive]: () => { throw new Error('hostile failure was stringified'); },
  });
  const service = new HookPlaygroundService({
    epochStore: {
      acquireEpochReference: async () => { throw hostile; },
    } as unknown as EpochStore,
    logger: { log: () => undefined },
  });

  await expect(service.simulate({
    epochId: 'epoch-1',
    hook: 'hook-1',
    input: { inline: { source: 'startup' } },
    target: 'claude',
  })).rejects.toBe(hostile);
});

it('uses the injected adapter hook contract for custom manifests, mappings, matchers, and codecs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hook-playground-synthetic-'));
  const sourceArtifact = join(root, 'synthetic-artifact');
  const manifestPath = 'registrations/hook-events.json';
  const hook = Object.freeze({
    event: 'beforeTool',
    id: 'hook:synthetic',
    name: 'synthetic',
    path: 'runtime/synthetic.mjs',
    target: 'synthetic',
  });
  const contract = Object.freeze({
    commandRoot: '${SYNTHETIC_PLUGIN_ROOT}',
    encodePlaygroundInput: (input, nativeEvent) => ({
      native_event: nativeEvent,
      payload: input.payload,
    }),
    encodePlaygroundOutput: (result, canonicalEvent, nativeEvent) => result === undefined
      ? undefined
      : {
        canonical_event: canonicalEvent,
        native_event: nativeEvent,
        simulated_outcome: result.outcome,
      },
    eventNames: {
      afterTool: 'SyntheticAfter',
      beforeTool: 'SyntheticBefore',
      sessionStart: 'SyntheticStart',
      stop: 'SyntheticStop',
    },
    manifestPath,
    matchers: { shell: '^SyntheticShell$' },
    wrapperPath: (selectedHook) => `runtime/${selectedHook.name}.mjs`,
    wrapperSource: () => 'export default undefined;\n',
  } satisfies TargetHookContract);
  const adapter: TargetAdapter = {
    capabilities: { hooks: true },
    hookContract: contract,
    metadata: {
      adapterRevision: 'test',
      capabilityRevision: 'test',
      capabilitySha256: '0'.repeat(64),
      observedVersion: 'test',
      schemas: [],
    },
    name: 'synthetic',
    plan: () => ({ diagnostics: [], entries: [] }),
  };
  try {
    await Promise.all([
      mkdir(dirname(join(sourceArtifact, manifestPath)), { recursive: true }),
      mkdir(dirname(join(sourceArtifact, hook.path)), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(sourceArtifact, manifestPath), `${JSON.stringify({
        hooks: {
          SyntheticBefore: [{
            hooks: [{ command: 'node "${SYNTHETIC_PLUGIN_ROOT}/runtime/synthetic.mjs"', type: 'command' }],
            matcher: '^SyntheticShell$',
          }],
        },
      })}\n`),
      writeFile(join(sourceArtifact, hook.path), 'export default undefined;\n'),
    ]);
    const epochStore = new EpochStore({ projectRoot: root });
    const staging = await epochStore.createStagingEpoch({
      epoch: epochFor(root, 'epoch-1', { synthetic: digest(await listArtifactFiles(sourceArtifact)) }),
      targets: ['synthetic'],
    });
    await Promise.all([
      cp(sourceArtifact, join(staging.root, 'synthetic'), { recursive: true }),
      writeFile(join(staging.root, 'agent-bundle.manifest.json'), '{}\n'),
    ]);
    await staging.publish(async () => undefined);

    const hookService = {
      list: async () => [hook],
      simulate: async () => ({ additionalContext: 'simulated', outcome: 'continue' }),
    };
    const request = {
      epochId: 'epoch-1',
      hook: hook.id,
      input: { inline: { payload: { value: 'custom' } } },
      target: 'synthetic',
    } as const;
    const service = new HookPlaygroundService({
      epochStore,
      hookService,
      registry: new TargetRegistry().register(adapter),
    });

    await expect(service.simulate(request)).resolves.toEqual({
      binding: { epochId: 'epoch-1', hook: hook.id, target: 'synthetic' },
      canonicalIntent: {
        event: 'beforeTool',
        hook: hook.id,
        input: { payload: { value: 'custom' } },
      },
      canonicalResult: { additionalContext: 'simulated', outcome: 'continue' },
      hostMapping: {
        canonicalEvent: 'beforeTool',
        matcher: '^SyntheticShell$',
        nativeEvent: 'SyntheticBefore',
        nativeProjection: 'deterministic',
        nativeSelector: 'SyntheticBefore',
        target: 'synthetic',
        wrapperPath: hook.path,
      },
      nativeInput: {
        native_event: 'SyntheticBefore',
        payload: { value: 'custom' },
      },
      nativeOutput: {
        canonical_event: 'beforeTool',
        native_event: 'SyntheticBefore',
        simulated_outcome: 'continue',
      },
      replay: {
        binding: { epochId: 'epoch-1', hook: hook.id, target: 'synthetic' },
        input: { payload: { value: 'custom' } },
      },
    });
    const missingManifestAdapter: TargetAdapter = {
      ...adapter,
      hookContract: { ...contract, manifestPath: 'registrations/missing.json' },
    };
    const missingManifestService = new HookPlaygroundService({
      epochStore,
      hookService,
      registry: new TargetRegistry().register(missingManifestAdapter),
    });

    await expect(missingManifestService.simulate(request)).resolves.toEqual({
      diagnostics: [{
        code: 'hook.playground.manifest.missing',
        event: 'beforeTool',
        message: 'Hook playground target "synthetic" is missing hook manifest "registrations/missing.json" for canonical event "beforeTool".',
        severity: 'error',
        target: 'synthetic',
      }],
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

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

    const inline = requireSimulation(await service.simulate({ ...options, input: { inline: input } }));
    const fixture = requireSimulation(await service.simulate({ ...options, input: { fixture: input } }));

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
    const nativeHookOutput = inline.nativeOutput?.hookSpecificOutput;
    if (
      nativeHookOutput === null ||
      typeof nativeHookOutput !== 'object' ||
      Array.isArray(nativeHookOutput) ||
      !('updatedInput' in nativeHookOutput)
    ) {
      throw new Error('Expected hook-specific native output with updated input.');
    }
    expect(Object.isFrozen(nativeHookOutput.updatedInput)).toBe(true);
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

it('returns target diagnostics from simulation and replay for an unknown string target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hook-playground-unknown-target-'));
  try {
    const epoch = await publishHookEpoch(root, 'epoch-1', 'one');
    const service = new HookPlaygroundService({ epochStore: epoch.epochStore });
    const target: string = 'unknown';
    const input = inputFor('beforeTool');
    const request = {
      epochId: 'epoch-1',
      hook: epoch.hooks.beforeTool.id,
      input: { inline: input },
      target,
    };
    const simulation = service.simulate(request);
    const replay = service.replay({
      binding: { epochId: 'epoch-1', hook: epoch.hooks.beforeTool.id, target },
      input,
    });
    const expectedType: IsExact<
      typeof simulation,
      Promise<HookPlaygroundSimulation | HookPlaygroundDiagnosticResult>
    > = true;
    const expectedReplayType: IsExact<
      typeof replay,
      Promise<HookPlaygroundSimulation | HookPlaygroundDiagnosticResult>
    > = true;

    expect(expectedType).toBe(true);
    expect(expectedReplayType).toBe(true);
    await expect(simulation).resolves.toEqual({
      diagnostics: [{
        code: 'hook.playground.target.unsupported',
        event: 'beforeTool',
        message: 'Hook playground cannot map target "unknown" for canonical event "beforeTool".',
        severity: 'error',
        target,
      }],
    });
    await expect(replay).resolves.toEqual({
      diagnostics: [{
        code: 'hook.playground.target.unsupported',
        event: 'beforeTool',
        message: 'Hook playground cannot map target "unknown" for canonical event "beforeTool".',
        severity: 'error',
        target,
      }],
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
        const trace = requireSimulation(await service.simulate({
          epochId: 'epoch-1',
          hook: epoch.hooks[event].id,
          input: { inline: inputFor(event) },
          target,
        }));
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

    const [firstResult, secondResult] = await Promise.all([service.simulate(request), service.simulate(request)]);
    const first = requireSimulation(firstResult);
    const second = requireSimulation(secondResult);
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
    manifestEntry.sha256 = sha256Hex(tamperedWrapper);
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
    await expect(pending).rejects.toMatchObject({ code: 'hook.simulation.aborted', name: 'AbortError' });
    if (runnableArtifact === undefined) throw new Error('Expected a runnable simulation artifact.');
    expect(runnableArtifact).not.toBe(join(root, '.agent-bundle', 'epochs', 'epoch-1'));
    await expect(access(runnableArtifact)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
}, 30_000);

it('settles clone copies before cleanup and reference release when an injected copy fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-hook-playground-copy-failure-'));
  const copies = { settled: 0, started: 0 };
  const store = new CopyFailureEpochStore(root, () => copies.started === copies.settled);
  try {
    const epoch = await publishHookEpoch(root, 'epoch-1', 'one', store);
    const service = new HookPlaygroundService({
      copy: async (_source, destination) => {
        if (typeof destination !== 'string') throw new Error('Expected clone destination path.');
        store.cloneRoot = dirname(destination);
        copies.started += 1;
        try {
          if (copies.started === 1) throw new Error('Injected clone copy failure.');
          await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 50); });
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, 'late clone copy', 'utf8');
        } finally {
          copies.settled += 1;
        }
      },
      epochStore: epoch.epochStore,
    });

    await expect(service.simulate({
      epochId: 'epoch-1',
      hook: epoch.hooks.beforeTool.id,
      input: { inline: inputFor('beforeTool') },
      target: 'codex',
    })).rejects.toThrow('Injected clone copy failure.');
    expect(copies).toEqual({ settled: 1, started: 1 });
    expect(store.copyWorkSettledBeforeRelease).toBe(true);
    expect(store.cloneRootExistsBeforeRelease).toBe(false);
    if (store.cloneRoot === undefined) throw new Error('Expected the injected copy destination.');
    await expect(access(store.cloneRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 75); });
    if (store.cloneRoot !== undefined) await rm(store.cloneRoot, { force: true, recursive: true });
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
