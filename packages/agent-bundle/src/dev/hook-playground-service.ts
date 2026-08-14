import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import claudeCapabilityTable from '../adapters/capabilities/claude-2.1.232.json' with { type: 'json' };
import codexCapabilityTable from '../adapters/capabilities/codex-0.147.0.json' with { type: 'json' };
import type { ArtifactHook } from '../build/emit.ts';
import { listArtifactFiles } from '../build/emit.ts';
import type { CanonicalHookEvent } from '../core/types.ts';
import { digest } from '../core/digest.ts';
import { HookService } from '../services/hook-service.ts';
import { EpochStore, type EpochReference } from './epoch-store.ts';

type HookPlaygroundTarget = 'claude' | 'codex';
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
  readonly target: HookPlaygroundTarget;
  readonly wrapperPath: string;
}

export interface HookPlaygroundCanonicalIntent {
  readonly event: CanonicalHookEvent;
  readonly hook: string;
  readonly input: CanonicalHookInput;
}

export interface HookPlaygroundReplay {
  readonly binding: Readonly<HookPlaygroundBinding & { readonly target: HookPlaygroundTarget }>;
  readonly input: CanonicalHookInput;
}

export interface HookPlaygroundSimulation {
  readonly binding: Readonly<HookPlaygroundBinding & { readonly target: HookPlaygroundTarget }>;
  readonly canonicalIntent: HookPlaygroundCanonicalIntent;
  readonly canonicalResult: CanonicalHookResult | undefined;
  readonly hostMapping: HookPlaygroundHostMapping;
  readonly nativeInput: NativeHookInput;
  readonly nativeOutput: NativeHookOutput | undefined;
  readonly replay: HookPlaygroundReplay;
}

export interface HookPlaygroundDiagnostic {
  readonly code: 'hook.playground.event.unsupported' | 'hook.playground.target.unsupported';
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
}

const hostEventNames = Object.freeze({
  claude: claudeCapabilityTable.hooks.events,
  codex: codexCapabilityTable.hooks.events,
}) satisfies Readonly<Record<HookPlaygroundTarget, Readonly<Record<CanonicalHookEvent, string>>>>;

const canonicalEvents: readonly CanonicalHookEvent[] = [
  'sessionStart',
  'beforeTool',
  'afterTool',
  'stop',
];
const epochStagingMarkerName = '.agent-bundle-epoch-stage.json';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const defined = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

const cloneAndFreeze = (value: unknown, seen = new WeakSet<object>()): unknown => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value !== 'object') throw new TypeError('Hook playground values must be JSON-compatible.');
  if (seen.has(value)) throw new TypeError('Hook playground values must not contain cycles.');
  seen.add(value);
  const cloned = Array.isArray(value)
    ? Object.freeze(value.map((item) => cloneAndFreeze(item, seen)))
    : isRecord(value)
      ? Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneAndFreeze(item, seen)])))
      : undefined;
  seen.delete(value);
  if (cloned === undefined) throw new TypeError('Hook playground values must be plain JSON objects.');
  return cloned;
};

const cloneRecord = <T extends object>(value: T): Readonly<T> =>
  cloneAndFreeze(value) as Readonly<T>;

const inputFor = (input: HookPlaygroundInput): CanonicalHookInput => {
  const candidates = [input.fixture, input.inline].filter((value): value is CanonicalHookInput => value !== undefined);
  if (candidates.length !== 1) {
    throw new Error('Hook playground simulation requires exactly one fixture or inline canonical input.');
  }
  const candidate = candidates[0]!;
  if (!isRecord(candidate)) throw new TypeError('Hook playground canonical input must be an object.');
  return cloneRecord(candidate);
};

const canonicalEventFor = (event: string): CanonicalHookEvent | undefined =>
  canonicalEvents.find((candidate) => candidate === event);

const unsupportedTarget = (target: string, event: string): HookPlaygroundDiagnosticResult => Object.freeze({
  diagnostics: Object.freeze([Object.freeze({
    code: 'hook.playground.target.unsupported',
    event,
    message: `Hook playground cannot map target ${JSON.stringify(target)} for canonical event ${JSON.stringify(event)}.`,
    severity: 'error',
    target,
  })]),
});

const unsupportedEvent = (target: HookPlaygroundTarget, event: string): HookPlaygroundDiagnosticResult => Object.freeze({
  diagnostics: Object.freeze([Object.freeze({
    code: 'hook.playground.event.unsupported',
    event,
    message: `Hook playground target ${JSON.stringify(target)} cannot map canonical event ${JSON.stringify(event)}.`,
    severity: 'error',
    target,
  })]),
});

const matcherFor = async (
  artifact: string,
  hook: ArtifactHook,
  nativeSelector: string,
): Promise<string | undefined> => {
  let document: unknown;
  try {
    document = JSON.parse(await readFile(join(artifact, hook.target, 'hooks', 'hooks.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (!isRecord(document) || !isRecord(document.hooks)) return undefined;
  const groups = document.hooks[nativeSelector];
  if (!Array.isArray(groups)) return undefined;
  const wrapperSuffix = `/hooks/${hook.name}.mjs`;
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
    const hasWrapper = group.hooks.some((entry) =>
      isRecord(entry) && typeof entry.command === 'string' && entry.command.includes(wrapperSuffix));
    if (hasWrapper) return typeof group.matcher === 'string' ? group.matcher : undefined;
  }
  return undefined;
};

const hostMappingFor = async (
  artifact: string,
  hook: ArtifactHook,
): Promise<HookPlaygroundHostMapping | HookPlaygroundDiagnosticResult> => {
  if (hook.target !== 'claude' && hook.target !== 'codex') return unsupportedTarget(hook.target, hook.event);
  const canonicalEvent = canonicalEventFor(hook.event);
  if (canonicalEvent === undefined) return unsupportedEvent(hook.target, hook.event);
  const nativeSelector = hostEventNames[hook.target][canonicalEvent];
  const matcher = await matcherFor(artifact, hook, nativeSelector);
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

const encodeNativeInput = (
  input: CanonicalHookInput,
  mapping: HookPlaygroundHostMapping,
): NativeHookInput => cloneRecord(defined({
  cwd: input.cwd,
  hook_event_name: mapping.nativeEvent,
  last_assistant_message: input.lastAssistantMessage,
  session_id: input.sessionId,
  source: input.source,
  stop_hook_active: input.stopHookActive,
  tool_input: input.toolInput,
  tool_name: input.toolName,
  tool_response: input.toolResponse,
  tool_use_id: input.toolUseId,
  transcript_path: input.transcriptPath,
}));

const encodeNativeOutput = (
  result: CanonicalHookResult | undefined,
  mapping: HookPlaygroundHostMapping,
): NativeHookOutput | undefined => {
  if (result === undefined) return undefined;
  if (mapping.canonicalEvent === 'stop') {
    return result.outcome === 'deny'
      ? cloneRecord(defined({ decision: 'block', reason: result.reason }))
      : undefined;
  }
  const output = defined({
    additionalContext: result.additionalContext,
    hookEventName: mapping.nativeEvent,
    permissionDecision: mapping.canonicalEvent === 'beforeTool'
      ? result.outcome === 'deny' ? 'deny' : 'allow'
      : undefined,
    permissionDecisionReason: mapping.canonicalEvent === 'beforeTool' && result.outcome === 'deny'
      ? result.reason
      : undefined,
    updatedInput: mapping.canonicalEvent === 'beforeTool' && result.outcome !== 'deny'
      ? result.updatedInput
      : undefined,
  });
  return Object.keys(output).length === 1 && output.hookEventName !== undefined
    ? undefined
    : cloneRecord({ hookSpecificOutput: output });
};

const canonicalResultFor = (value: unknown): CanonicalHookResult | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Generated hook wrapper returned a non-object canonical result.');
  return cloneRecord(value);
};

const storedTargetDigestFor = async (
  reference: EpochReference,
  target: HookPlaygroundTarget,
): Promise<string> => {
  const epochId = basename(reference.root);
  let document: unknown;
  try {
    document = JSON.parse(await readFile(join(dirname(reference.root), '.metadata', `${epochId}.json`), 'utf8'));
  } catch {
    throw new Error(`Referenced epoch ${JSON.stringify(epochId)} has unreadable persisted metadata.`);
  }
  if (!isRecord(document) || !isRecord(document.epoch) || document.epoch.id !== epochId || !isRecord(document.epoch.targetDigests)) {
    throw new Error(`Referenced epoch ${JSON.stringify(epochId)} has invalid persisted metadata.`);
  }
  const targetDigest = document.epoch.targetDigests[target];
  if (typeof targetDigest !== 'string') {
    throw new Error(`Referenced epoch ${JSON.stringify(epochId)} has no stored digest for target ${JSON.stringify(target)}.`);
  }
  return targetDigest;
};

const assertTargetDigest = async (
  artifact: string,
  target: HookPlaygroundTarget,
  expected: string,
): Promise<void> => {
  let actual: string;
  try {
    actual = digest(await listArtifactFiles(join(artifact, target)));
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

  constructor(options: HookPlaygroundServiceOptions) {
    this.#copy = options.copy ?? cp;
    this.#epochStore = options.epochStore;
    this.#hookService = options.hookService ?? new HookService();
  }

  async list(options: HookPlaygroundListOptions): Promise<readonly HookPlaygroundHook[]> {
    return this.#withEpoch(options.epochId, async (artifact) => {
      const hooks = await this.#hookService.list({
        allowEpochStagingMarker: true,
        artifact,
        ...(options.target === undefined ? {} : { target: options.target }),
      });
      return Object.freeze(hooks.map((hook) => Object.freeze({
        binding: Object.freeze({ epochId: options.epochId, hook: hook.id, target: hook.target }),
        hook: cloneRecord(hook),
      })));
    });
  }

  async simulate(
    options: HookPlaygroundSimulationOptions & { readonly target: HookPlaygroundTarget },
  ): Promise<HookPlaygroundSimulation>;
  async simulate(options: HookPlaygroundSimulationOptions): Promise<HookPlaygroundSimulation | HookPlaygroundDiagnosticResult>;
  async simulate(options: HookPlaygroundSimulationOptions): Promise<HookPlaygroundSimulation | HookPlaygroundDiagnosticResult> {
    return this.#withEpoch(options.epochId, async (artifact, reference) => {
      const hooks = await this.#hookService.list({ allowEpochStagingMarker: true, artifact });
      const matching = hooks.filter((hook) => hook.id === options.hook || hook.name === options.hook);
      if (matching.length === 0) throw new Error(`Expected one hook matching ${JSON.stringify(options.hook)}.`);
      const selected = matching.filter((hook) => hook.target === options.target);
      const example = matching[0]!;
      if (options.target !== 'claude' && options.target !== 'codex') return unsupportedTarget(options.target, example.event);
      if (selected.length !== 1) return unsupportedTarget(options.target, example.event);
      const target: HookPlaygroundTarget = options.target;
      const canonicalInput = inputFor(options.input);
      return this.#withSimulationArtifact(reference, target, async (simulationArtifact) => {
        const clonedHooks = await this.#hookService.list({ artifact: simulationArtifact, target });
        const clonedMatches = clonedHooks.filter((hook) => hook.id === options.hook || hook.name === options.hook);
        if (clonedMatches.length !== 1) {
          throw new Error(`Expected exactly one ${target} hook matching ${JSON.stringify(options.hook)} in the simulation clone.`);
        }
        const mapping = await hostMappingFor(simulationArtifact, clonedMatches[0]!);
        if ('diagnostics' in mapping) return mapping;

        const canonicalResult = canonicalResultFor(await this.#hookService.simulate({
          artifact: simulationArtifact,
          hook: options.hook,
          input: canonicalInput,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
          target,
        }));
        const binding = Object.freeze({ epochId: options.epochId, hook: options.hook, target });
        return Object.freeze({
          binding,
          canonicalIntent: Object.freeze({ event: mapping.canonicalEvent, hook: options.hook, input: cloneRecord(canonicalInput) }),
          canonicalResult,
          hostMapping: mapping,
          nativeInput: encodeNativeInput(canonicalInput, mapping),
          nativeOutput: encodeNativeOutput(canonicalResult, mapping),
          replay: Object.freeze({ binding: Object.freeze({ ...binding }), input: cloneRecord(canonicalInput) }),
        });
      });
    });
  }

  async replay(replay: HookPlaygroundReplay): Promise<HookPlaygroundSimulation> {
    return this.simulate({ ...replay.binding, input: { fixture: replay.input } });
  }

  async #withEpoch<T>(epochId: string, action: (artifact: string, reference: EpochReference) => Promise<T>): Promise<T> {
    const reference = await this.#epochStore.acquireEpochReference(epochId);
    try {
      return await action(reference.root, reference);
    } finally {
      await reference.close();
    }
  }

  async #withSimulationArtifact<T>(
    reference: EpochReference,
    target: HookPlaygroundTarget,
    action: (artifact: string) => Promise<T>,
  ): Promise<T> {
    const targetDigest = await storedTargetDigestFor(reference, target);
    await assertTargetDigest(reference.root, target, targetDigest);
    let artifact: string | undefined;
    try {
      artifact = await mkdtemp(join(tmpdir(), 'agent-bundle-hook-playground-'));
      for (const entry of await readdir(reference.root)) {
        if (entry === epochStagingMarkerName) continue;
        await this.#copy(join(reference.root, entry), join(artifact, entry), { recursive: true });
      }
      await assertTargetDigest(artifact, target, targetDigest);
      return await action(artifact);
    } finally {
      if (artifact !== undefined) await rm(artifact, { force: true, recursive: true });
    }
  }
}
