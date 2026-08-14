import type { Diagnostic } from '../core/diagnostics.ts';
import type {
  CanonicalHookEvent,
  CanonicalHookTool,
  NormalizedNativeHook,
  NormalizedPlugin,
} from '../core/types.ts';
import type { TargetHookEntry } from './types.ts';

export interface HookTargetContract {
  readonly commandRoot: string;
  readonly eventNames: Readonly<Record<CanonicalHookEvent, string>>;
  readonly matchers: Readonly<Partial<Record<CanonicalHookTool, string>>>;
  readonly target: string;
}

export interface HookPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly document?: Record<string, unknown>;
  readonly hookEntries: readonly TargetHookEntry[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const nativeHooksFor = (
  model: NormalizedPlugin,
  target: 'codex' | 'claude',
): NormalizedNativeHook | undefined => model.nativeHooks?.find((nativeHooks) => nativeHooks.target === target);

export const mergeHookDocuments = (
  generated: Record<string, unknown> | undefined,
  native: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined => {
  if (generated === undefined && native === undefined) return undefined;
  const generatedGroups = isRecord(generated?.hooks) ? generated.hooks : {};
  const nativeGroups = isRecord(native?.hooks) ? native.hooks : {};
  const hooks: Record<string, unknown> = { ...generatedGroups };
  for (const [event, nativeGroupsForEvent] of Object.entries(nativeGroups)) {
    const generatedGroupsForEvent = hooks[event];
    hooks[event] = Array.isArray(generatedGroupsForEvent)
      ? [...generatedGroupsForEvent, ...(nativeGroupsForEvent as unknown[])]
      : nativeGroupsForEvent;
  }
  const description = native?.description ?? generated?.description;
  return {
    ...(typeof description === 'string' ? { description } : {}),
    hooks,
  };
};

const eventOrder: readonly CanonicalHookEvent[] = [
  'sessionStart',
  'beforeTool',
  'afterTool',
  'stop',
];

const eventIndex = new Map(eventOrder.map((event, index) => [event, index]));

const error = (target: string, code: string, message: string): Diagnostic => ({
  code,
  message,
  severity: 'error',
  target,
});

const matcherFor = (
  contract: HookTargetContract,
  tools: readonly CanonicalHookTool[],
  hookName: string,
  diagnostics: Diagnostic[],
): string | undefined => {
  const patterns: string[] = [];
  for (const tool of tools) {
    const matcher = contract.matchers[tool];
    if (matcher === undefined) {
      diagnostics.push(error(
        contract.target,
        `${contract.target}.hook.tool.${tool.replaceAll('.', '-')}`,
        `${contract.target} cannot map canonical hook tool ${JSON.stringify(tool)} for ${JSON.stringify(hookName)}.`,
      ));
      continue;
    }
    patterns.push(matcher);
  }
  if (patterns.length === 0) return undefined;
  return patterns.length === 1 ? patterns[0] : `(?:${patterns.join('|')})`;
};

export const planHooks = (
  model: NormalizedPlugin,
  contract: HookTargetContract,
): HookPlan => {
  const diagnostics: Diagnostic[] = [];
  const selected = model.hooks
    .filter((hook) => hook.targets.includes(contract.target))
    .slice()
    .sort((left, right) => {
      const eventComparison = (eventIndex.get(left.event) ?? 0) - (eventIndex.get(right.event) ?? 0);
      return eventComparison !== 0 ? eventComparison : left.id.localeCompare(right.id);
    });
  if (selected.length === 0) {
    return Object.freeze({ diagnostics: Object.freeze(diagnostics), hookEntries: Object.freeze([]) });
  }

  const groups: Record<string, unknown[]> = Object.create(null) as Record<string, unknown[]>;
  const hookEntries: TargetHookEntry[] = [];
  for (const hook of selected) {
    const nativeEvent = contract.eventNames[hook.event];
    const matcher = matcherFor(contract, hook.tools, hook.name, diagnostics);
    if (diagnostics.length > 0) continue;
    const relativePath = `hooks/${hook.name}.mjs`;
  const command = `node "${contract.commandRoot}/${relativePath}"`;
    const hookCommand = {
      command,
      ...(hook.timeout === undefined ? {} : { timeout: hook.timeout }),
      type: 'command',
    };
    const group = {
      hooks: [hookCommand],
      ...(matcher === undefined ? {} : { matcher }),
    };
    (groups[nativeEvent] ??= []).push(group);
    hookEntries.push({ event: hook.event, hook, relativePath, target: contract.target });
  }

  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    ...(Object.keys(groups).length === 0 ? {} : { document: { hooks: groups } }),
    hookEntries: Object.freeze(hookEntries),
  });
};
