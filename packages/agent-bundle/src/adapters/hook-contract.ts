import type { Diagnostic } from '../core/diagnostics.ts';
import type {
  CanonicalHookEvent,
  CanonicalHookTool,
  NormalizedHook,
  NormalizedNativeHook,
  NormalizedPlugin,
} from '../core/types.ts';
import type { TargetHookEntry, TargetHookWrapper } from './types.ts';

export interface TargetHookContract {
  readonly commandRoot: string;
  readonly encodePlaygroundInput: (
    input: Readonly<Record<string, unknown>>,
    nativeEvent: string,
  ) => Readonly<Record<string, unknown>>;
  readonly encodePlaygroundOutput: (
    result: Readonly<Record<string, unknown>> | undefined,
    canonicalEvent: CanonicalHookEvent,
    nativeEvent: string,
  ) => Readonly<Record<string, unknown>> | undefined;
  readonly eventNames: Readonly<Record<CanonicalHookEvent, string>>;
  readonly manifestPath: string;
  readonly matchers: Readonly<Partial<Record<CanonicalHookTool, string>>>;
  readonly wrapperPath: (hook: NormalizedHook) => string;
  readonly wrapperSource: (entry: TargetHookWrapper) => string;
}

const nativeHookInputFields = Object.freeze([
  Object.freeze({ canonical: 'cwd', native: 'cwd' }),
  Object.freeze({ canonical: 'hookEventName', native: 'hook_event_name' }),
  Object.freeze({ canonical: 'lastAssistantMessage', native: 'last_assistant_message' }),
  Object.freeze({ canonical: 'sessionId', native: 'session_id' }),
  Object.freeze({ canonical: 'source', native: 'source' }),
  Object.freeze({ canonical: 'stopHookActive', native: 'stop_hook_active' }),
  Object.freeze({ canonical: 'toolInput', native: 'tool_input' }),
  Object.freeze({ canonical: 'toolName', native: 'tool_name' }),
  Object.freeze({ canonical: 'toolResponse', native: 'tool_response' }),
  Object.freeze({ canonical: 'toolUseId', native: 'tool_use_id' }),
  Object.freeze({ canonical: 'transcriptPath', native: 'transcript_path' }),
]);

const defined = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

const canonicalEventOrder: readonly CanonicalHookEvent[] = [
  'sessionStart',
  'beforeTool',
  'afterTool',
  'stop',
];

export const canonicalHookEventFor = (event: string): CanonicalHookEvent | undefined =>
  canonicalEventOrder.find((candidate) => candidate === event);

export const encodeNativeHookPlaygroundInput = (
  input: Readonly<Record<string, unknown>>,
  nativeEvent: string,
): Readonly<Record<string, unknown>> => defined(Object.fromEntries([
  ['hook_event_name', nativeEvent],
  ...nativeHookInputFields
    .filter((field) => field.canonical !== 'hookEventName')
    .map((field) => [field.native, input[field.canonical]]),
]));

export const encodeNativeHookPlaygroundOutput = (
  result: Readonly<Record<string, unknown>> | undefined,
  canonicalEvent: CanonicalHookEvent,
  nativeEvent: string,
): Readonly<Record<string, unknown>> | undefined => {
  if (result === undefined) return undefined;
  if (canonicalEvent === 'stop') {
    return result.outcome === 'deny'
      ? defined({ decision: 'block', reason: result.reason })
      : undefined;
  }
  const beforeTool = canonicalEvent === 'beforeTool';
  const denied = result.outcome === 'deny';
  const output = defined({
    additionalContext: result.additionalContext,
    hookEventName: nativeEvent,
    permissionDecision: beforeTool ? (denied ? 'deny' : 'allow') : undefined,
    permissionDecisionReason: beforeTool && denied ? result.reason : undefined,
    updatedInput: beforeTool && !denied ? result.updatedInput : undefined,
  });
  return Object.keys(output).length === 1 && output.hookEventName !== undefined
    ? undefined
    : { hookSpecificOutput: output };
};

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

const eventIndex = new Map(canonicalEventOrder.map((event, index) => [event, index]));

const error = (target: string, code: string, message: string): Diagnostic => ({
  code,
  message,
  severity: 'error',
  target,
});

const matcherFor = (
  target: string,
  contract: TargetHookContract,
  tools: readonly CanonicalHookTool[],
  hookName: string,
  diagnostics: Diagnostic[],
): string | undefined => {
  const patterns: string[] = [];
  for (const tool of tools) {
    const matcher = contract.matchers[tool];
    if (matcher === undefined) {
      diagnostics.push(error(
        target,
        `${target}.hook.tool.${tool.replaceAll('.', '-')}`,
        `${target} cannot map canonical hook tool ${JSON.stringify(tool)} for ${JSON.stringify(hookName)}.`,
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
  target: string,
  contract: TargetHookContract,
): HookPlan => {
  const diagnostics: Diagnostic[] = [];
  const selected = model.hooks
    .filter((hook) => hook.targets.includes(target))
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
    if (typeof nativeEvent !== 'string' || nativeEvent.trim().length === 0) {
      diagnostics.push(error(
        target,
        `${target}.hook.event.${hook.event.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`,
        `${target} cannot map canonical hook event ${JSON.stringify(hook.event)}.`,
      ));
      continue;
    }
    const diagnosticCount = diagnostics.length;
    const matcher = matcherFor(target, contract, hook.tools, hook.name, diagnostics);
    if (diagnostics.length > diagnosticCount) continue;
    const relativePath = contract.wrapperPath(hook);
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
    const wrapper: TargetHookWrapper = { event: hook.event, hook, nativeEvent, relativePath, target };
    hookEntries.push({ ...wrapper, virtualSource: contract.wrapperSource(wrapper) });
  }

  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    ...(Object.keys(groups).length === 0 ? {} : { document: { hooks: groups } }),
    hookEntries: Object.freeze(hookEntries),
  });
};

export const nativeHookWrapperSource = (
  entry: TargetHookWrapper,
  codecName: 'Claude' | 'Codex',
): string => {
  const nativeEvent = entry.nativeEvent;
  const decoderFields = nativeHookInputFields.map((field) =>
    `  ${field.canonical}: nativeInput.${field.native},`);
  const encoderFields = nativeHookInputFields
    .filter((field) => field.canonical !== 'hookEventName')
    .map((field) => `  ${field.native}: canonicalInput.${field.canonical},`);

  return [
    `import * as handlerModule from ${JSON.stringify(entry.hook.source)};`,
    `const target = ${JSON.stringify(entry.target)};`,
    `const canonicalEvent = ${JSON.stringify(entry.event)};`,
    `const nativeEvent = ${JSON.stringify(nativeEvent)};`,
    '',
    'const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);',
    'const defined = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));',
    `const decode${codecName}Native = (nativeInput) => ({`,
    ...decoderFields,
    '});',
    `const encode${codecName}Native = (canonicalInput) => defined({`,
    '  hook_event_name: nativeEvent,',
    ...encoderFields,
    '});',
    `const decodeNative = decode${codecName}Native;`,
    `const encodeNative = encode${codecName}Native;`,
    'const fail = (message) => { throw new Error(`Agent Bundle hook error: ${message}`); };',
    'const validateResult = (result) => {',
    '  if (result === undefined) return undefined;',
    '  if (!isRecord(result)) fail("handler must return void or a result object");',
    '  const allowed = new Set(["outcome", "reason", "updatedInput", "additionalContext"]);',
    '  for (const key of Object.keys(result)) if (!allowed.has(key)) fail(`handler result has unsupported field ${key}`);',
    '  if (result.outcome !== undefined && !["continue", "deny", "stop"].includes(result.outcome)) fail("handler result outcome is invalid");',
    '  if (result.reason !== undefined && typeof result.reason !== "string") fail("handler result reason must be a string");',
    '  if (result.additionalContext !== undefined && typeof result.additionalContext !== "string") fail("handler result additionalContext must be a string");',
    '  if (result.updatedInput !== undefined && !isRecord(result.updatedInput)) fail("handler result updatedInput must be an object");',
    '  if (result.reason !== undefined && !(result.outcome === "deny" && (canonicalEvent === "beforeTool" || canonicalEvent === "stop"))) fail("reason is only valid for a denied beforeTool or stop hook");',
    '  if (result.outcome === "deny" && (canonicalEvent === "beforeTool" || canonicalEvent === "stop") && (typeof result.reason !== "string" || result.reason.trim().length === 0)) fail(`denied ${canonicalEvent} hook requires a nonempty reason`);',
    '  if ((canonicalEvent === "sessionStart" || canonicalEvent === "afterTool") && (result.outcome === "deny" || result.outcome === "stop" || result.updatedInput !== undefined)) fail(`${canonicalEvent} cannot deny, stop, or replace input`);',
    '  if (canonicalEvent === "beforeTool" && (result.outcome === "stop" || (result.outcome === "deny" && result.updatedInput !== undefined))) fail("beforeTool cannot stop or replace input while denying");',
    '  if (canonicalEvent === "stop" && (result.outcome === "stop" || result.updatedInput !== undefined || result.additionalContext !== undefined)) fail("stop only accepts continue or deny with a reason");',
    '  return result;',
    '};',
    'const encodeOutput = (result) => {',
    '  if (result === undefined) return undefined;',
    '  if (canonicalEvent === "stop") return result.outcome === "deny" ? defined({ decision: "block", reason: result.reason }) : undefined;',
    '  const output = defined({',
    '    additionalContext: result.additionalContext,',
    '    hookEventName: nativeEvent,',
    '    permissionDecision: canonicalEvent === "beforeTool" ? (result.outcome === "deny" ? "deny" : "allow") : undefined,',
    '    permissionDecisionReason: canonicalEvent === "beforeTool" && result.outcome === "deny" ? result.reason : undefined,',
    '    updatedInput: canonicalEvent === "beforeTool" && result.outcome !== "deny" ? result.updatedInput : undefined,',
    '  });',
    '  return Object.keys(output).length === 1 && output.hookEventName !== undefined ? undefined : { hookSpecificOutput: output };',
    '};',
    'const decodeOutput = (nativeOutput) => {',
    '  if (nativeOutput === undefined) return undefined;',
    '  if (canonicalEvent === "stop") return nativeOutput.decision === "block" ? defined({ outcome: "deny", reason: nativeOutput.reason }) : undefined;',
    '  const output = nativeOutput.hookSpecificOutput;',
    '  if (!isRecord(output)) fail("native hook output is malformed");',
    '  return defined({',
    '    additionalContext: output.additionalContext,',
    '    outcome: output.permissionDecision === "deny" ? "deny" : "continue",',
    '    reason: output.permissionDecisionReason,',
    '    updatedInput: output.updatedInput,',
    '  });',
    '};',
    'const requireString = (input, field) => {',
    '  if (typeof input[field] !== "string") fail(`native ${field} must be a string`);',
    '};',
    'const validateNativeInput = (input) => {',
    '  requireString(input, "session_id");',
    '  requireString(input, "transcript_path");',
    '  requireString(input, "cwd");',
    '  if (input.hook_event_name !== nativeEvent) fail(`native hook_event_name must equal ${nativeEvent}`);',
    '  if (canonicalEvent === "sessionStart") { requireString(input, "source"); return; }',
    '  if (canonicalEvent === "beforeTool" || canonicalEvent === "afterTool") {',
    '    requireString(input, "tool_name");',
    '    if (!isRecord(input.tool_input)) fail(`native ${nativeEvent} tool_input must be an object`);',
    '    requireString(input, "tool_use_id");',
    '    if (canonicalEvent === "afterTool" && !isRecord(input.tool_response)) fail("native PostToolUse tool_response must be an object");',
    '    return;',
    '  }',
    '  if (typeof input.stop_hook_active !== "boolean") fail("native Stop stop_hook_active must be a boolean");',
    '  requireString(input, "last_assistant_message");',
    '};',
    'const run = async () => {',
    '  const handler = Reflect.get(handlerModule, "default");',
    '  if (typeof handler !== "function") fail("default export must be a function");',
    '  let raw = "";',
    '  for await (const chunk of process.stdin) raw += chunk;',
    '  if (raw.trim().length === 0) fail("stdin must contain exactly one JSON value");',
    '  let input;',
    '  try { input = JSON.parse(raw); } catch { fail("stdin must contain exactly one JSON value"); }',
    '  if (!isRecord(input)) fail("stdin JSON value must be an object");',
    '  const simulation = process.env.AGENT_BUNDLE_HOOK_SIMULATION === "1";',
    '  const nativeInput = simulation ? encodeNative(input) : input;',
    '  validateNativeInput(nativeInput);',
    '  const event = decodeNative(nativeInput);',
    '  const result = validateResult(await handler(event, { nativeEvent, nativeInput, target }));',
    '  const nativeOutput = encodeOutput(result);',
    '  const output = simulation ? decodeOutput(nativeOutput) : nativeOutput;',
    '  if (output !== undefined) process.stdout.write(JSON.stringify(output));',
    '};',
    'if (import.meta.main) {',
    '  await run().catch((error) => {',
    '    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\\n`);',
    '    process.exitCode = 1;',
    '  });',
    '}',
    '',
  ].join('\n');
};
