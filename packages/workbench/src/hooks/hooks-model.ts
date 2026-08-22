import type {
  HookPlaygroundBinding,
  HookPlaygroundCanonicalIntent,
  HookPlaygroundDiagnostic,
  HookPlaygroundDiagnosticResult,
  HookPlaygroundHook,
  HookPlaygroundHostMapping,
  HookPlaygroundReplay,
  HookPlaygroundSimulation,
} from '../../../agent-bundle/src/dev/hook-playground-service.ts';
import { deeplyFrozenHookValue } from './hook-client.ts';

export type HookPlaygroundResult = HookPlaygroundDiagnosticResult | HookPlaygroundSimulation | undefined;

export type HookListState = 'error' | 'loading' | 'ready';

export type HookPlaygroundState = 'diagnostics' | 'empty' | 'list-error' | 'loading' | 'no-epoch' | 'ready' | 'simulated';

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

export interface HookPlaygroundViewOptions {
  readonly epochId: string | undefined;
  readonly hooks: readonly HookPlaygroundHook[];
  readonly listState?: HookListState;
  readonly result: HookPlaygroundResult;
  readonly selectedKey: string | undefined;
}

export interface HookPlaygroundView {
  readonly canonicalInput: Readonly<Record<string, unknown>> | undefined;
  readonly canonicalResult: Readonly<Record<string, unknown>> | undefined;
  readonly diagnostics: readonly HookPlaygroundDiagnostic[];
  readonly hooks: readonly HookOption[];
  readonly intent: readonly HookDetailRow[];
  readonly mapping: readonly HookDetailRow[];
  readonly nativeInput: Readonly<Record<string, unknown>> | undefined;
  readonly nativeOutput: Readonly<Record<string, unknown>> | undefined;
  readonly replay: HookPlaygroundReplay | undefined;
  readonly selected: HookOption | undefined;
  readonly state: HookPlaygroundState;
  readonly summary: string;
}

const noRows: readonly HookDetailRow[] = Object.freeze([]);

const noDiagnostics: readonly HookPlaygroundDiagnostic[] = Object.freeze([]);

const row = (label: string, value: string): HookDetailRow => Object.freeze({ label, value });

export const hookOptionKeyFor = (binding: HookPlaygroundBinding): string => `${binding.target}/${binding.hook}`;

export const hookOptionsFor = (hooks: readonly HookPlaygroundHook[]): readonly HookOption[] => Object.freeze(
  hooks
    .map((entry): HookOption => Object.freeze({
      binding: Object.freeze({ epochId: entry.binding.epochId, hook: entry.binding.hook, target: entry.binding.target }),
      event: entry.hook.event,
      key: hookOptionKeyFor(entry.binding),
      label: `${entry.hook.name} · ${entry.hook.event} · ${entry.binding.target}`,
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

const summaryFor = (state: HookPlaygroundState, simulation: HookPlaygroundSimulation | undefined): string => {
  if (state === 'no-epoch') return 'No artifact epoch is active, so no generated hook can be simulated.';
  if (state === 'loading') return 'Loading generated hooks for this artifact epoch.';
  if (state === 'list-error') return 'Generated hooks could not be loaded for this artifact epoch.';
  if (state === 'empty') return 'This artifact epoch has no generated hooks.';
  if (state === 'diagnostics') return 'The hook playground returned diagnostics instead of a simulation.';
  if (state === 'simulated' && simulation !== undefined) {
    return `Simulated ${simulation.canonicalIntent.hook} on ${simulation.binding.target} from epoch ${simulation.binding.epochId}.`;
  }
  return 'Select a generated hook and run a simulation to see its canonical and native trace.';
};

/** Derives every Hook page section from the listed hooks and the latest simulation or diagnostics. */
export const hookPlaygroundViewFor = (options: HookPlaygroundViewOptions): HookPlaygroundView => {
  const detached = deeplyFrozenHookValue(options) as HookPlaygroundViewOptions;
  const hooks = hookOptionsFor(detached.hooks);
  const result = detached.result;
  const simulation = result === undefined || 'diagnostics' in result ? undefined : result;
  const diagnostics = result !== undefined && 'diagnostics' in result ? result.diagnostics : noDiagnostics;
  const listState = detached.listState ?? 'ready';
  const state: HookPlaygroundState = detached.epochId === undefined ? 'no-epoch'
    : listState === 'loading' ? 'loading'
      : listState === 'error' ? 'list-error'
        : hooks.length === 0 ? 'empty'
          : simulation !== undefined ? 'simulated'
            : diagnostics.length > 0 ? 'diagnostics'
              : 'ready';
  return Object.freeze({
    canonicalInput: simulation?.canonicalIntent.input,
    canonicalResult: simulation?.canonicalResult,
    diagnostics,
    hooks,
    intent: simulation === undefined ? noRows : canonicalIntentRowsFor(simulation.canonicalIntent),
    mapping: simulation === undefined ? noRows : hostMappingRowsFor(simulation.hostMapping),
    nativeInput: simulation?.nativeInput,
    nativeOutput: simulation?.nativeOutput,
    replay: simulation?.replay,
    selected: hooks.find((option) => option.key === detached.selectedKey) ?? hooks[0],
    state,
    summary: summaryFor(state, simulation),
  });
};
