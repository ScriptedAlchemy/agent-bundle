import type {
  HookPlaygroundBinding,
  HookPlaygroundCanonicalIntent,
  HookPlaygroundDiagnosticResult,
  HookPlaygroundHook,
  HookPlaygroundHostMapping,
  HookPlaygroundSimulation,
} from '../../../agent-bundle/src/contracts/hooks.ts';
import type { JsonObject } from '../../../agent-bundle/src/contracts/runtime.ts';
import { deepFreeze } from '../freeze.ts';

export type HookPlaygroundResult = HookPlaygroundDiagnosticResult | HookPlaygroundSimulation | undefined;

export type CanonicalHookEvent = HookPlaygroundHook['hook']['event'];

export type CanonicalHookInput = JsonObject;

export interface HookDetailRow {
  readonly label: string;
  readonly value: string;
}

export interface HookOption {
  readonly binding: HookPlaygroundBinding;
  readonly event: string;
  readonly key: string;
  readonly label: string;
  readonly path: string;
  readonly timeout?: number;
}

const row = (label: string, value: string): HookDetailRow => Object.freeze({ label, value });

const readableHookLabel = (value: string): string => {
  const words = value.replace(/([a-z\d])([A-Z])/gu, '$1 $2').replace(/[-_]+/gu, ' ').trim();
  return `${words.charAt(0).toUpperCase()}${words.slice(1).toLowerCase()}`;
};

const canonicalHookInputs: Readonly<Record<CanonicalHookEvent, CanonicalHookInput>> = deepFreeze({
  afterTool: {
    cwd: '/workspace',
    sessionId: 'workbench-preview',
    toolInput: Object.freeze({}),
    toolName: 'shell',
    toolResponse: Object.freeze({}),
    toolUseId: 'workbench-preview-tool',
    transcriptPath: '/workspace/transcript.json',
  },
  beforeTool: {
    cwd: '/workspace',
    sessionId: 'workbench-preview',
    toolInput: Object.freeze({}),
    toolName: 'shell',
    toolUseId: 'workbench-preview-tool',
    transcriptPath: '/workspace/transcript.json',
  },
  sessionStart: {
    cwd: '/workspace',
    sessionId: 'workbench-preview',
    source: 'workbench',
    transcriptPath: '/workspace/transcript.json',
  },
  stop: {
    cwd: '/workspace',
    lastAssistantMessage: 'Workbench preview completed.',
    sessionId: 'workbench-preview',
    stopHookActive: false,
    transcriptPath: '/workspace/transcript.json',
  },
});

/** Provides one event-shaped document that can run a generated Hook without host-contract guesswork. */
export const canonicalHookInput = (event: CanonicalHookEvent): CanonicalHookInput => canonicalHookInputs[event];

/** Returns a runnable example only for the canonical Hook events understood by the Workbench. */
export const canonicalHookInputFor = (event: string): CanonicalHookInput | undefined =>
  Object.hasOwn(canonicalHookInputs, event) ? canonicalHookInputs[event as CanonicalHookEvent] : undefined;

export const hookOptionKeyFor = (binding: HookPlaygroundBinding): string => `${binding.target}/${binding.hook}`;

export const hookOptionsFor = (hooks: readonly HookPlaygroundHook[]): readonly HookOption[] => deepFreeze(
  hooks
    .map((entry): HookOption => ({
      binding: Object.freeze({ epochId: entry.binding.epochId, hook: entry.binding.hook, target: entry.binding.target }),
      event: entry.hook.event,
      key: hookOptionKeyFor(entry.binding),
      label: `${readableHookLabel(entry.hook.event)} · ${readableHookLabel(entry.binding.target)}`,
      path: entry.hook.path,
      ...(entry.hook.timeout === undefined ? {} : { timeout: entry.hook.timeout }),
    }))
    .sort((left, right) => left.key.localeCompare(right.key)),
);

export const canonicalIntentRowsFor = (intent: HookPlaygroundCanonicalIntent): readonly HookDetailRow[] => Object.freeze([
  row('Canonical event', intent.event),
  row('Hook', intent.hook),
]);

export const hostMappingRowsFor = (mapping: HookPlaygroundHostMapping): readonly HookDetailRow[] => Object.freeze([
  row('Target', mapping.target),
  row('Canonical event', mapping.canonicalEvent),
  row('Native event', mapping.nativeEvent),
  row('Native selector', mapping.nativeSelector),
  ...(mapping.matcher === undefined ? [] : [row('Matcher', mapping.matcher)]),
  row('Wrapper path', mapping.wrapperPath),
  row('Native projection', mapping.nativeProjection),
]);
