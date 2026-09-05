import { cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, FileSystem } from 'effect';

import { canonicalHookEventFor, type TargetHookContract } from '../../adapters/hook-contract.ts';
import { createDefaultRegistry, TargetRegistry } from '../../adapters/registry.ts';
import type { ArtifactHook } from '../../build/hook-index.ts';
import type { CanonicalHookEvent } from '../../core/types.ts';
import { isErrno } from '../../core/errors.ts';
import { isRecord, snapshotStrictJsonValue } from '../../core/strict-json.ts';
import { HookService } from '../../services/hook-service.ts';
import { projectionDigests } from '../artifacts/projection-digest.ts';
import { EpochStore, type EpochReference } from '../epoch-store.ts';
import type { DevLogKindFor, DevLogSink } from '../logs/dev-log-service.ts';
import { deepFreeze } from '../../core/freeze.ts';
import { liftPromise } from '../../effect/lift.ts';
import { readFileString, withTempDirectory, type PlatformRun } from '../../effect/platform.ts';
import { platformRunOf } from '../platform-run.ts';
import type { DevPlatformRuntime } from '../platform-runtime.ts';


type CanonicalHookInput = Readonly<Record<string, unknown>>;
type CanonicalHookResult = Readonly<Record<string, unknown>>;
type NativeHookInput = Readonly<Record<string, unknown>>;
type NativeHookOutput = Readonly<Record<string, unknown>>;

export interface HookPlaygroundBinding {
  readonly epochId: string;
  readonly hook: string;
  readonly target: string;
}

export interface HookPlaygroundHostMapping {
  readonly canonicalEvent: CanonicalHookEvent;
  readonly matcher?: string;
  readonly nativeEvent: string;
  /** Projection is deterministic and verified against the emitted wrapper in focused tests. */
  readonly nativeProjection: 'deterministic';
  readonly nativeSelector: string;
  readonly target: string;
  readonly wrapperPath: string;
}

export interface HookPlaygroundCanonicalIntent {
  readonly event: CanonicalHookEvent;
  readonly hook: string;
  readonly input: CanonicalHookInput;
}

export interface HookPlaygroundReplay {
  readonly binding: Readonly<HookPlaygroundBinding>;
  readonly input: CanonicalHookInput;
}

export interface HookPlaygroundSimulation {
  readonly binding: Readonly<HookPlaygroundBinding>;
  readonly canonicalIntent: HookPlaygroundCanonicalIntent;
  readonly canonicalResult: CanonicalHookResult | undefined;
  readonly hostMapping: HookPlaygroundHostMapping;
  readonly nativeInput: NativeHookInput;
  readonly nativeOutput: NativeHookOutput | undefined;
  readonly replay: HookPlaygroundReplay;
}

export interface HookPlaygroundDiagnostic {
  readonly code:
    | 'hook.playground.event.unsupported'
    | 'hook.playground.manifest.missing'
    | 'hook.playground.target.unsupported';
  readonly event: string;
  readonly message: string;
  readonly severity: 'error';
  readonly target: string;
}

export interface HookPlaygroundDiagnosticResult {
  readonly diagnostics: readonly HookPlaygroundDiagnostic[];
}

export interface HookPlaygroundListOptions {
  readonly epochId: string;
  readonly target?: string;
}

export interface HookPlaygroundHook {
  readonly binding: HookPlaygroundBinding;
  readonly hook: ArtifactHook;
}

export interface HookPlaygroundInput {
  readonly fixture?: CanonicalHookInput;
  readonly inline?: CanonicalHookInput;
}

export interface HookPlaygroundSimulationOptions extends HookPlaygroundBinding {
  readonly input: HookPlaygroundInput;
  readonly signal?: AbortSignal;
}

export interface HookPlaygroundServiceOptions {
  /** Internal test seam; production clone population defaults to fs.cp. */
  readonly copy?: typeof cp;
  readonly epochStore: EpochStore;
  readonly hookService?: Pick<HookService, 'list' | 'simulate'>;
  /** Optional non-throwing producer-wide diagnostics sink. */
  readonly logger?: DevLogSink;
  readonly registry?: TargetRegistry;
  /** The dev server's session runtime; absent, each program runs on its own `platformLayer`. */
  readonly platformRuntime?: DevPlatformRuntime;
}
const epochStagingMarkerName = '.agent-bundle-epoch-stage.json';

/** Detaches and freezes a strict-JSON tree; hostile accessors and exotic values are rejected. */
const cloneRecord = <T extends object>(value: T): Readonly<T> =>
  snapshotStrictJsonValue(value) as Readonly<T>;

const inputFor = (input: HookPlaygroundInput): CanonicalHookInput => {
  const candidates = [input.fixture, input.inline].filter((value): value is CanonicalHookInput => value !== undefined);
  if (candidates.length !== 1) {
    throw new Error('Hook playground simulation requires exactly one fixture or inline canonical input.');
  }
  const candidate = candidates[0]!;
  if (!isRecord(candidate)) throw new TypeError('Hook playground canonical input must be an object.');
  return cloneRecord(candidate);
};

const unsupportedTarget = (target: string, event: string): HookPlaygroundDiagnosticResult => deepFreeze({
  diagnostics: [Object.freeze({
    code: 'hook.playground.target.unsupported',
    event,
    message: `Hook playground cannot map target ${JSON.stringify(target)} for canonical event ${JSON.stringify(event)}.`,
    severity: 'error',
    target,
  })],
});

const unsupportedEvent = (target: string, event: string): HookPlaygroundDiagnosticResult => deepFreeze({
  diagnostics: [Object.freeze({
    code: 'hook.playground.event.unsupported',
    event,
    message: `Hook playground target ${JSON.stringify(target)} cannot map canonical event ${JSON.stringify(event)}.`,
    severity: 'error',
    target,
  })],
});

const missingManifest = (target: string, event: string, manifestPath: string): HookPlaygroundDiagnosticResult => deepFreeze({
  diagnostics: [Object.freeze({
    code: 'hook.playground.manifest.missing',
    event,
    message: `Hook playground target ${JSON.stringify(target)} is missing hook manifest ${JSON.stringify(manifestPath)} for canonical event ${JSON.stringify(event)}.`,
    severity: 'error',
    target,
  })],
});

const matcherFor = async (
  artifact: string,
  hook: ArtifactHook,
  contract: TargetHookContract,
  nativeSelector: string,
  run: PlatformRun,
): Promise<string | undefined | HookPlaygroundDiagnosticResult> => {
  let document: unknown;
  try {
    document = JSON.parse(await run(readFileString(join(artifact, contract.manifestPath))));
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return missingManifest(hook.target, hook.event, contract.manifestPath);
    return undefined;
  }
  if (!isRecord(document) || !isRecord(document.hooks)) return undefined;
  const groups = document.hooks[nativeSelector];
  if (!Array.isArray(groups)) return undefined;
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
    const hasWrapper = group.hooks.some((entry) =>
      isRecord(entry) && typeof entry.command === 'string' && entry.command.includes(hook.path));
    if (hasWrapper) return typeof group.matcher === 'string' ? group.matcher : undefined;
  }
  return undefined;
};

const hostMappingFor = async (
  artifact: string,
  hook: ArtifactHook,
  contract: TargetHookContract,
  run: PlatformRun,
): Promise<HookPlaygroundHostMapping | HookPlaygroundDiagnosticResult> => {
  const canonicalEvent = canonicalHookEventFor(hook.event);
  if (canonicalEvent === undefined) return unsupportedEvent(hook.target, hook.event);
  const nativeSelector = contract.eventNames[canonicalEvent];
  if (typeof nativeSelector !== 'string' || nativeSelector.trim().length === 0) {
    return unsupportedEvent(hook.target, hook.event);
  }
  const matcher = await matcherFor(artifact, hook, contract, nativeSelector, run);
  if (typeof matcher === 'object' && matcher !== null) return matcher;
  return Object.freeze({
    canonicalEvent,
    ...(matcher === undefined ? {} : { matcher }),
    nativeEvent: nativeSelector,
    nativeProjection: 'deterministic',
    nativeSelector,
    target: hook.target,
    wrapperPath: hook.path,
  });
};

const canonicalResultFor = (value: unknown): CanonicalHookResult | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Generated hook wrapper returned a non-object canonical result.');
  return cloneRecord(value);
};

/** The lease's `epoch` already carries the store-validated metadata for the pinned epoch. */
const storedTargetDigestFor = (reference: EpochReference, target: string): string => {
  const targetDigest = reference.epoch.targetDigests[target];
  if (typeof targetDigest !== 'string') {
    throw new Error(`Referenced epoch ${JSON.stringify(reference.epoch.id)} has no stored digest for target ${JSON.stringify(target)}.`);
  }
  return targetDigest;
};

const assertTargetDigest = async (
  artifact: string,
  target: string,
  expected: string,
): Promise<void> => {
  let actual: string;
  try {
    actual = (await projectionDigests(artifact, [target]))[target]!;
  } catch {
    throw new Error(`Hook playground target ${JSON.stringify(target)} cannot be verified against its stored digest.`);
  }
  if (actual !== expected) {
    throw new Error(`Hook playground target ${JSON.stringify(target)} does not match its stored digest.`);
  }
};

/**
 * Runs emitted hook wrappers from immutable epochs and records their canonical/native codec trace.
 * The only executor is HookService, which invokes the generated target wrapper.
 */
export class HookPlaygroundService {
  readonly #copy: typeof cp;
  readonly #epochStore: EpochStore;
  readonly #hookService: Pick<HookService, 'list' | 'simulate'>;
  readonly #logger: DevLogSink | undefined;
  readonly #registry: TargetRegistry;
  readonly #run: PlatformRun;

  constructor(options: HookPlaygroundServiceOptions) {
    this.#copy = options.copy ?? cp;
    this.#run = platformRunOf(options.platformRuntime);
    this.#epochStore = options.epochStore;
    this.#registry = options.registry ?? createDefaultRegistry();
    this.#hookService = options.hookService ?? new HookService({ registry: this.#registry });
    this.#logger = options.logger;
  }

  async list(options: HookPlaygroundListOptions): Promise<readonly HookPlaygroundHook[]> {
    return this.#withEpoch(options.epochId, async (artifact) => {
      const hooks = await this.#hookService.list({
        allowEpochStagingMarker: true,
        artifact,
        ...(options.target === undefined ? {} : { target: options.target }),
      });
      return deepFreeze(hooks.map((hook) => ({
        binding: Object.freeze({ epochId: options.epochId, hook: hook.id, target: hook.target }),
        hook: cloneRecord(hook),
      })));
    });
  }

  async simulate(options: HookPlaygroundSimulationOptions): Promise<HookPlaygroundSimulation | HookPlaygroundDiagnosticResult> {
    this.#log('hook.simulate.started', 'info', 'Hook playground simulation started.', options, {});
    try {
      const result = await this.#withEpoch(options.epochId, async (artifact, reference) => {
      const hooks = await this.#hookService.list({ allowEpochStagingMarker: true, artifact });
      const matching = hooks.filter((hook) => hook.id === options.hook || hook.name === options.hook);
      if (matching.length === 0) throw new Error(`Expected one hook matching ${JSON.stringify(options.hook)}.`);
      const selected = matching.filter((hook) => hook.target === options.target);
      const example = matching[0]!;
      if (!this.#registry.has(options.target)) return unsupportedTarget(options.target, example.event);
      const contract = this.#registry.hookContract(options.target);
      if (contract === undefined) return unsupportedTarget(options.target, example.event);
      if (selected.length !== 1) return unsupportedTarget(options.target, example.event);
      const target = options.target;
      const canonicalInput = inputFor(options.input);
      return this.#withSimulationArtifact(reference, target, async (simulationArtifact) => {
        const clonedHooks = await this.#hookService.list({ artifact: simulationArtifact, target });
        const clonedMatches = clonedHooks.filter((hook) => hook.id === options.hook || hook.name === options.hook);
        if (clonedMatches.length !== 1) {
          throw new Error(`Expected exactly one ${target} hook matching ${JSON.stringify(options.hook)} in the simulation clone.`);
        }
        const mapping = await hostMappingFor(simulationArtifact, clonedMatches[0]!, contract, this.#run);
        if ('diagnostics' in mapping) return mapping;

        const canonicalResult = canonicalResultFor(await this.#hookService.simulate({
          artifact: simulationArtifact,
          hook: options.hook,
          input: canonicalInput,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          target,
        }));
        const nativeOutput = contract.encodePlaygroundOutput(
          canonicalResult,
          mapping.canonicalEvent,
          mapping.nativeEvent,
        );
        const binding = Object.freeze({ epochId: options.epochId, hook: options.hook, target });
        return Object.freeze({
          binding,
          canonicalIntent: Object.freeze({ event: mapping.canonicalEvent, hook: options.hook, input: cloneRecord(canonicalInput) }),
          canonicalResult,
          hostMapping: mapping,
          nativeInput: cloneRecord(contract.encodePlaygroundInput(canonicalInput, mapping.nativeEvent)),
          nativeOutput: nativeOutput === undefined ? undefined : cloneRecord(nativeOutput),
          replay: Object.freeze({ binding: Object.freeze({ ...binding }), input: cloneRecord(canonicalInput) }),
        });
      });
      });
      this.#log(
        'hook.simulate.completed',
        'info',
        'Hook playground simulation completed.',
        options,
        'diagnostics' in result ? { diagnostics: result.diagnostics } : { outcome: result.canonicalResult },
      );
      return result;
    } catch (error) {
      this.#log('hook.simulate.failed', 'error', 'Hook playground simulation failed.', options, {
        failure: 'unavailable',
      });
      throw error;
    }
  }

  async replay(
    replay: HookPlaygroundReplay,
    options?: { readonly signal?: AbortSignal },
  ): Promise<HookPlaygroundSimulation | HookPlaygroundDiagnosticResult> {
    return this.simulate({
      ...replay.binding,
      input: { fixture: replay.input },
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
    });
  }

  async #withEpoch<T>(epochId: string, action: (artifact: string, reference: EpochReference) => Promise<T>): Promise<T> {
    const reference = await this.#epochStore.acquireEpochReference(epochId);
    try {
      return await action(reference.root, reference);
    } finally {
      await reference.close();
    }
  }

  #log(
    kind: DevLogKindFor<'hook'>,
    level: 'error' | 'info',
    summary: string,
    options: HookPlaygroundSimulationOptions,
    details: unknown,
  ): void {
    try {
      this.#logger?.log({
        context: { epochId: options.epochId, hookId: options.hook, target: options.target },
        details,
        kind,
        level,
        producer: 'hook',
        summary,
      });
    } catch { /* Diagnostics cannot affect hook execution. */ }
  }

  async #withSimulationArtifact<T>(
    reference: EpochReference,
    target: string,
    action: (artifact: string) => Promise<T>,
  ): Promise<T> {
    const targetDigest = storedTargetDigestFor(reference, target);
    await assertTargetDigest(reference.root, target, targetDigest);
    // The simulation artifact lives exactly as long as the action: the
    // `mkdtemp` + `finally rm` bracket. The clone copy stays on the injectable
    // `fs.cp` (a test seam), sequential so a failed copy settles before the
    // directory is released.
    return this.#run(withTempDirectory(
      { directory: tmpdir(), prefix: 'agent-bundle-hook-playground-' },
      (artifact) => Effect.flatMap(
        Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readDirectory(reference.root)),
        (entries) => liftPromise(async () => {
          for (const entry of entries) {
            if (entry === epochStagingMarkerName) continue;
            await this.#copy(join(reference.root, entry), join(artifact, entry), { recursive: true });
          }
          await assertTargetDigest(artifact, target, targetDigest);
          return action(artifact);
        }),
      ),
    ));
  }
}
