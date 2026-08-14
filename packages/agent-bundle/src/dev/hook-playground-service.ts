import { cp, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import type { ArtifactHook } from '../build/emit.ts';
import { assertInside } from '../core/paths.ts';
import type { CanonicalHookEvent } from '../core/types.ts';
import { HookService } from '../services/hook-service.ts';
import { EpochStore } from './epoch-store.ts';

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
  readonly nativeEvent: string;
  readonly target: HookPlaygroundTarget;
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
  readonly code: 'hook.playground.mapping.unsupported';
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
}

export interface HookPlaygroundServiceOptions {
  readonly epochStore: EpochStore;
  readonly hookService?: Pick<HookService, 'list' | 'simulate'>;
  readonly projectRoot: string;
}

const hostEventNames: Readonly<Record<HookPlaygroundTarget, Readonly<Record<CanonicalHookEvent, string>>>> = Object.freeze({
  claude: Object.freeze({
    afterTool: 'PostToolUse',
    beforeTool: 'PreToolUse',
    sessionStart: 'SessionStart',
    stop: 'Stop',
  }),
  codex: Object.freeze({
    afterTool: 'PostToolUse',
    beforeTool: 'PreToolUse',
    sessionStart: 'SessionStart',
    stop: 'Stop',
  }),
});

const canonicalEvents: readonly CanonicalHookEvent[] = [
  'sessionStart',
  'beforeTool',
  'afterTool',
  'stop',
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const defined = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

const cloneRecord = (value: Record<string, unknown>): Readonly<Record<string, unknown>> =>
  Object.freeze({ ...value });

const inputFor = (input: HookPlaygroundInput): CanonicalHookInput => {
  const candidates = [input.fixture, input.inline].filter((value): value is CanonicalHookInput => value !== undefined);
  if (candidates.length !== 1) {
    throw new Error('Hook playground simulation requires exactly one fixture or inline canonical input.');
  }
  const candidate = candidates[0]!;
  if (!isRecord(candidate)) throw new TypeError('Hook playground canonical input must be an object.');
  return cloneRecord(candidate);
};

const mappingFor = (target: string, event: string): HookPlaygroundHostMapping | undefined => {
  if (target !== 'claude' && target !== 'codex' || !canonicalEvents.includes(event as CanonicalHookEvent)) return undefined;
  const canonicalEvent = event as CanonicalHookEvent;
  return Object.freeze({ canonicalEvent, nativeEvent: hostEventNames[target][canonicalEvent], target });
};

const unsupportedMapping = (target: string): HookPlaygroundDiagnosticResult => Object.freeze({
  diagnostics: Object.freeze([Object.freeze({
    code: 'hook.playground.mapping.unsupported',
    message: `Hook playground cannot map target ${JSON.stringify(target)} to a native hook event.`,
    severity: 'error',
    target,
  })]),
});

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

/**
 * Runs emitted hook wrappers from immutable epochs and records their canonical/native codec trace.
 * The only executor is HookService, which invokes the generated target wrapper.
 */
export class HookPlaygroundService {
  readonly #epochStore: EpochStore;
  readonly #hookService: Pick<HookService, 'list' | 'simulate'>;
  readonly #projectRoot: string;

  constructor(options: HookPlaygroundServiceOptions) {
    this.#epochStore = options.epochStore;
    this.#hookService = options.hookService ?? new HookService();
    this.#projectRoot = resolve(options.projectRoot);
  }

  async list(options: HookPlaygroundListOptions): Promise<readonly HookPlaygroundHook[]> {
    return this.#withEpoch(options.epochId, async (artifact) => {
      const hooks = await this.#hookService.list({ artifact, ...(options.target === undefined ? {} : { target: options.target }) });
      return Object.freeze(hooks.map((hook) => Object.freeze({
        binding: Object.freeze({ epochId: options.epochId, hook: hook.id, target: hook.target }),
        hook: Object.freeze({ ...hook }),
      })));
    });
  }

  async simulate(
    options: HookPlaygroundSimulationOptions & { readonly target: HookPlaygroundTarget },
  ): Promise<HookPlaygroundSimulation>;
  async simulate(options: HookPlaygroundSimulationOptions): Promise<HookPlaygroundSimulation | HookPlaygroundDiagnosticResult>;
  async simulate(options: HookPlaygroundSimulationOptions): Promise<HookPlaygroundSimulation | HookPlaygroundDiagnosticResult> {
    return this.#withEpoch(options.epochId, async (artifact) => {
      if (options.target !== 'claude' && options.target !== 'codex') return unsupportedMapping(options.target);
      const hooks = await this.#hookService.list({ artifact, target: options.target });
      const matching = hooks.filter((hook) => hook.id === options.hook || hook.name === options.hook);
      if (matching.length !== 1) {
        throw new Error(`Expected exactly one ${options.target} hook matching ${JSON.stringify(options.hook)}.`);
      }
      const hook = matching[0]!;
      const mapping = mappingFor(options.target, hook.event);
      if (mapping === undefined) return unsupportedMapping(options.target);

      const canonicalInput = inputFor(options.input);
      const canonicalResult = canonicalResultFor(await this.#hookService.simulate({
        artifact,
        hook: options.hook,
        input: canonicalInput,
        target: options.target,
      }));
      const binding = Object.freeze({ epochId: options.epochId, hook: options.hook, target: options.target });
      return Object.freeze({
        binding,
        canonicalIntent: Object.freeze({ event: mapping.canonicalEvent, hook: options.hook, input: canonicalInput }),
        canonicalResult,
        hostMapping: mapping,
        nativeInput: encodeNativeInput(canonicalInput, mapping),
        nativeOutput: encodeNativeOutput(canonicalResult, mapping),
        replay: Object.freeze({ binding, input: canonicalInput }),
      });
    });
  }

  async replay(replay: HookPlaygroundReplay): Promise<HookPlaygroundSimulation> {
    return this.simulate({ ...replay.binding, input: { fixture: replay.input } });
  }

  async #withEpoch<T>(epochId: string, action: (artifact: string) => Promise<T>): Promise<T> {
    const reference = await this.#epochStore.acquireEpochReference(epochId);
    let runnableArtifact: string | undefined;
    try {
      const epochArtifact = assertInside(this.#projectRoot, resolve(this.#projectRoot, '.agent-bundle', 'epochs', epochId));
      runnableArtifact = await mkdtemp(join(tmpdir(), 'agent-bundle-hook-epoch-'));
      await Promise.all((await readdir(epochArtifact))
        .filter((entry) => entry !== '.agent-bundle-epoch-stage.json')
        .map((entry) => cp(join(epochArtifact, entry), join(runnableArtifact!, entry), { recursive: true })));
      return await action(runnableArtifact);
    } finally {
      try {
        if (runnableArtifact !== undefined) await rm(runnableArtifact, { force: true, recursive: true });
      } finally {
        await reference.close();
      }
    }
  }
}
