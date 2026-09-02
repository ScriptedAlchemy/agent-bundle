import type { Diagnostic } from '../core/diagnostics.ts';
import { dataArrayValues, hasDataKeys, isPlainDataRecord, isRecord, ownDataValue } from '../core/strict-json.ts';
import { escapeRegExp } from '../core/strings.ts';
import type { CanonicalAgentEvent } from '../routes/public.ts';
import type {
  CanonicalHookEvent,
  CanonicalHookTool,
  NormalizedHook,
  NormalizedNativeHook,
  NormalizedPlugin,
} from '../core/types.ts';
import { deepFreeze } from '../core/freeze.ts';


export interface TargetHookWrapper {
  readonly event: CanonicalHookEvent;
  readonly hook: NormalizedHook;
  /** False when this wrapper is a host-document variant of an indexed hook rather than its canonical entry. */
  readonly indexed?: false;
  readonly nativeEvent: string;
  /** The computed native tool matcher, absent when the host applies the hook unconditionally. */
  readonly nativeMatcher?: string;
  readonly relativePath: string;
  readonly target: string;
}

export interface TargetHookEntry extends TargetHookWrapper {
  /** Timeout projected into the native host's seconds unit. */
  readonly timeout?: number;
  readonly virtualSource: string;
}

export interface TargetNativeHookCommand {
  readonly command: string;
}

export type TargetNativeHookCommandsReadResult =
  | Readonly<{ readonly commands: readonly TargetNativeHookCommand[]; readonly status: 'found' }>
  | Readonly<{ readonly status: 'invalid' }>;

export interface TargetHookDocumentEntryInput {
  readonly command: string;
  readonly matcher?: string;
  readonly timeout?: number;
}

export interface TargetHookContract {
  readonly hostContractRevision?: string;
  readonly commandRoot: string;
  /**
   * Shapes one generated hook command into the host's per-event array entry.
   * Defaults to the Claude/Codex grouped shape; Cursor's document keeps flat
   * `{ command, matcher?, timeout? }` entries.
   */
  readonly documentEntry?: (input: TargetHookDocumentEntryInput) => Record<string, unknown>;
  /** Wraps the per-event groups into the host's document root; defaults to `{ hooks }`. */
  readonly documentEnvelope?: (hooks: Record<string, unknown[]>) => Record<string, unknown>;
  readonly encodePlaygroundInput: (
    input: Readonly<Record<string, unknown>>,
    nativeEvent: string,
  ) => Readonly<Record<string, unknown>>;
  readonly encodePlaygroundOutput: (
    result: Readonly<Record<string, unknown>> | undefined,
    canonicalEvent: CanonicalHookEvent,
    nativeEvent: string,
  ) => Readonly<Record<string, unknown>> | undefined;
  readonly eventNames: Readonly<Partial<Record<CanonicalHookEvent, string>>>;
  readonly eventRouteNames?: Readonly<Partial<Record<CanonicalAgentEvent, string>>>;
  /**
   * False when this contract plans host-document wrapper variants of hooks
   * whose canonical wrappers another contract already indexes; the canonical
   * hook index keeps exactly one entry per hook and target.
   */
  readonly indexedWrappers?: false;
  readonly manifestPath: string;
  readonly matchers: Readonly<Partial<Record<CanonicalHookTool, string>>>;
  /** Minimal checked-in host envelope for semantic lifecycle replay. */
  readonly nativeEventStarter?: (
    canonicalEvent: CanonicalAgentEvent,
  ) => Readonly<Record<string, unknown>> | undefined;
  readonly readNativeCommands?: (document: unknown) => TargetNativeHookCommandsReadResult;
  readonly wrapperPath: (hook: NormalizedHook) => string;
  readonly wrapperSource: (entry: TargetHookWrapper) => string;
}

export type NativeEventStarterTarget = 'claude' | 'codex' | 'cursor';

/** Creates only fields required by the shared native event envelope validator. */
export const createNativeEventStarter = (
  target: NativeEventStarterTarget,
  canonicalEvent: CanonicalAgentEvent,
  nativeEvent: string,
): Readonly<Record<string, unknown>> => {
  const base = target === 'cursor'
    ? {
        hook_event_name: nativeEvent,
        session_id: 'lifecycle-replay',
      }
    : {
        cwd: '/tmp',
        hook_event_name: nativeEvent,
        session_id: 'lifecycle-replay',
        transcript_path: target === 'codex' ? null : '/tmp/agent-bundle-lifecycle-replay-transcript.jsonl',
      };
  const toolInput = target === 'codex'
    ? { command: '*** Begin Patch\n*** Add File: lifecycle-replay.txt\n+Lifecycle replay\n*** End Patch' }
    : { file_path: 'lifecycle-replay.txt' };
  const toolName = target === 'codex' ? 'apply_patch' : 'Write';
  switch (canonicalEvent) {
    case 'session/start':
      return deepFreeze(target === 'cursor' ? base : { ...base, source: 'startup' });
    case 'tool/before':
      return deepFreeze({
        ...base,
        tool_input: toolInput,
        tool_name: toolName,
        tool_use_id: 'lifecycle-replay-tool',
      });
    case 'tool/after':
      return deepFreeze({
        ...base,
        tool_input: toolInput,
        tool_name: toolName,
        ...(target === 'cursor' ? { tool_output: '{}' } : { tool_response: {} }),
        tool_use_id: 'lifecycle-replay-tool',
      });
    case 'stop':
      return deepFreeze(target === 'cursor'
        ? { ...base, loop_count: 0 }
        : { ...base, last_assistant_message: 'Lifecycle replay stopped.', stop_hook_active: false });
    case 'agent/start':
      return deepFreeze(target === 'cursor'
        ? base
        : {
            ...base,
            agent_id: 'lifecycle-replay-agent',
            agent_type: 'general-purpose',
            ...(target === 'codex'
              ? { model: 'default', permission_mode: 'default', turn_id: 'lifecycle-replay-turn' }
              : {}),
          });
    case 'agent/stop':
      return deepFreeze(target === 'cursor'
        ? base
        : {
            ...base,
            agent_id: 'lifecycle-replay-agent',
            agent_transcript_path: null,
            agent_type: 'general-purpose',
            last_assistant_message: null,
            ...(target === 'codex'
              ? { model: 'default', permission_mode: 'default', turn_id: 'lifecycle-replay-turn' }
              : {}),
            stop_hook_active: false,
          });
    case 'workspace/open':
      return deepFreeze(base);
    default: {
      const exhaustive: never = canonicalEvent;
      return exhaustive;
    }
  }
};

const snapshotNativeHookCommands = (value: unknown): readonly TargetNativeHookCommand[] | undefined => {
  const candidates = dataArrayValues(value);
  if (candidates === undefined) return undefined;
  const commands: TargetNativeHookCommand[] = [];
  for (const candidate of candidates) {
    if (!hasDataKeys(candidate, ['command'])) return undefined;
    const command = ownDataValue(candidate, 'command');
    if (command === undefined || !command.found || typeof command.value !== 'string') return undefined;
    commands.push(Object.freeze({ command: command.value }));
  }
  return Object.freeze(commands);
};

const snapshotNativeHookCommandResult = (value: unknown): TargetNativeHookCommandsReadResult | undefined => {
  if (!isPlainDataRecord(value)) return undefined;
  const status = ownDataValue(value, 'status');
  if (status === undefined || !status.found || typeof status.value !== 'string') return undefined;
  if (status.value === 'invalid') return hasDataKeys(value, ['status']) ? Object.freeze({ status: 'invalid' }) : undefined;
  if (status.value !== 'found') return undefined;
  if (!hasDataKeys(value, ['commands', 'status'])) return undefined;
  const commands = ownDataValue(value, 'commands');
  if (commands === undefined || !commands.found) return undefined;
  const snapshot = snapshotNativeHookCommands(commands.value);
  return snapshot === undefined ? undefined : Object.freeze({ commands: snapshot, status: 'found' });
};

/** Safely invokes and snapshots a target-native hook command reader. */
export const readTargetNativeHookCommands = (
  contract: TargetHookContract,
  document: unknown,
): TargetNativeHookCommandsReadResult => {
  try {
    const reader = contract.readNativeCommands;
    if (typeof reader !== 'function') return Object.freeze({ status: 'invalid' });
    return snapshotNativeHookCommandResult(reader(document)) ?? Object.freeze({ status: 'invalid' });
  } catch {
    // Target command readers are untrusted; a throw is an invalid document.
    return Object.freeze({ status: 'invalid' });
  }
};

/** Enumerates commands from the native Claude/Codex hook document shape. */
export const readStandardNativeHookCommands = (document: unknown): TargetNativeHookCommandsReadResult => {
  if (!isPlainDataRecord(document)) return Object.freeze({ status: 'invalid' });
  const hooks = ownDataValue(document, 'hooks');
  if (hooks === undefined || !hooks.found || !isPlainDataRecord(hooks.value)) return Object.freeze({ status: 'invalid' });
  const commands: TargetNativeHookCommand[] = [];
  for (const groups of Object.values(hooks.value)) {
    const entries = dataArrayValues(groups);
    if (entries === undefined) return Object.freeze({ status: 'invalid' });
    for (const group of entries) {
      if (!isPlainDataRecord(group)) return Object.freeze({ status: 'invalid' });
      const nativeHooks = ownDataValue(group, 'hooks');
      if (nativeHooks === undefined || !nativeHooks.found) return Object.freeze({ status: 'invalid' });
      const hooksInGroup = dataArrayValues(nativeHooks.value);
      if (hooksInGroup === undefined) return Object.freeze({ status: 'invalid' });
      for (const hook of hooksInGroup) {
        if (!isPlainDataRecord(hook)) return Object.freeze({ status: 'invalid' });
        const command = ownDataValue(hook, 'command');
        const type = ownDataValue(hook, 'type');
        if (command === undefined || type === undefined || !type.found || type.value !== 'command') {
          return Object.freeze({ status: 'invalid' });
        }
        if (command.found && typeof command.value === 'string') {
          commands.push(Object.freeze({ command: command.value }));
        } else {
          return Object.freeze({ status: 'invalid' });
        }
      }
    }
  }
  return Object.freeze({ commands: Object.freeze(commands), status: 'found' });
};

/** Enumerates commands from Cursor's flat `{ version, hooks: { event: [{ command }] } }` document. */
export const readCursorNativeHookCommands = (document: unknown): TargetNativeHookCommandsReadResult => {
  if (!isPlainDataRecord(document)) return Object.freeze({ status: 'invalid' });
  const hooks = ownDataValue(document, 'hooks');
  if (hooks === undefined || !hooks.found || !isPlainDataRecord(hooks.value)) return Object.freeze({ status: 'invalid' });
  const commands: TargetNativeHookCommand[] = [];
  for (const entries of Object.values(hooks.value)) {
    const hooksForEvent = dataArrayValues(entries);
    if (hooksForEvent === undefined) return Object.freeze({ status: 'invalid' });
    for (const hook of hooksForEvent) {
      if (!isPlainDataRecord(hook)) return Object.freeze({ status: 'invalid' });
      const command = ownDataValue(hook, 'command');
      if (command === undefined || !command.found || typeof command.value !== 'string') {
        return Object.freeze({ status: 'invalid' });
      }
      commands.push(Object.freeze({ command: command.value }));
    }
  }
  return Object.freeze({ commands: Object.freeze(commands), status: 'found' });
};

const nativeHookInputFields = deepFreeze([
  { canonical: 'agentId', native: 'agent_id' },
  { canonical: 'agentTranscriptPath', native: 'agent_transcript_path' },
  { canonical: 'agentType', native: 'agent_type' },
  { canonical: 'cwd', native: 'cwd' },
  { canonical: 'effort', native: 'effort' },
  { canonical: 'hookEventName', native: 'hook_event_name' },
  { canonical: 'lastAssistantMessage', native: 'last_assistant_message' },
  { canonical: 'model', native: 'model' },
  { canonical: 'permissionMode', native: 'permission_mode' },
  { canonical: 'promptId', native: 'prompt_id' },
  { canonical: 'sessionId', native: 'session_id' },
  { canonical: 'source', native: 'source' },
  { canonical: 'stopHookActive', native: 'stop_hook_active' },
  { canonical: 'toolInput', native: 'tool_input' },
  { canonical: 'toolName', native: 'tool_name' },
  { canonical: 'toolResponse', native: 'tool_response' },
  { canonical: 'toolUseId', native: 'tool_use_id' },
  { canonical: 'transcriptPath', native: 'transcript_path' },
  { canonical: 'turnId', native: 'turn_id' },
]);

const defined = (value: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));

const canonicalEventOrder: readonly CanonicalHookEvent[] = [
  'sessionStart',
  'beforeTool',
  'afterTool',
  'stop',
  'agentStart',
  'agentStop',
  'workspaceOpen',
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
  target?: 'claude' | 'codex',
): Readonly<Record<string, unknown>> | undefined => {
  if (result === undefined) return undefined;
  if (canonicalEvent === 'stop' || canonicalEvent === 'agentStop') {
    if (canonicalEvent === 'agentStop' && target === 'claude' && result.outcome !== 'deny') {
      return result.additionalContext === undefined
        ? undefined
        : {
            hookSpecificOutput: defined({
              additionalContext: result.additionalContext,
              hookEventName: nativeEvent,
            }),
          };
    }
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

/**
 * Cursor's hook envelope differs from the shared Claude/Codex format: input
 * carries `conversation_id` plus per-event fields (`tool_output` is a
 * JSON-stringified record, `stop` carries `loop_count`/`status` instead of
 * `stop_hook_active`/`last_assistant_message`), and output uses the
 * documented per-event shapes (`additional_context`, `permission` with
 * `user_message`/`agent_message`, `updated_input`, `followup_message`).
 * Observed at https://cursor.com/docs/agent/hooks (2026-08-28) and against
 * installed plugins that ship working Cursor hooks. A denied `stop` maps to
 * `followup_message`, Cursor's loop-continuation channel. `additionalContext`
 * from an allowed `beforeTool` handler has no Cursor output channel and is
 * dropped; inject context from `afterTool` instead.
 */
export const encodeCursorPlaygroundInput = (
  input: Readonly<Record<string, unknown>>,
  nativeEvent: string,
): Readonly<Record<string, unknown>> => defined({
  conversation_id: input.sessionId,
  cwd: input.cwd,
  hook_event_name: nativeEvent,
  ...(nativeEvent === 'stop'
    ? { loop_count: input.stopHookActive === true ? 1 : 0, status: 'completed' }
    : {}),
  session_id: input.sessionId,
  tool_input: input.toolInput,
  tool_name: input.toolName,
  ...(nativeEvent === 'postToolUse' && input.toolResponse !== undefined
    ? { tool_output: JSON.stringify(input.toolResponse) }
    : {}),
  tool_use_id: input.toolUseId,
  transcript_path: input.transcriptPath,
});

export const encodeCursorPlaygroundOutput = (
  result: Readonly<Record<string, unknown>> | undefined,
  canonicalEvent: CanonicalHookEvent,
): Readonly<Record<string, unknown>> | undefined => {
  if (result === undefined) return undefined;
  if (canonicalEvent === 'stop') {
    return result.outcome === 'deny' ? defined({ followup_message: result.reason }) : undefined;
  }
  if (canonicalEvent === 'beforeTool') {
    if (result.outcome === 'deny') {
      return defined({ agent_message: result.reason, permission: 'deny', user_message: result.reason });
    }
    return result.updatedInput === undefined
      ? undefined
      : { permission: 'allow', updated_input: result.updatedInput };
  }
  return result.additionalContext === undefined
    ? undefined
    : { additional_context: result.additionalContext };
};

export const eventIpcRuntimeSpecifier = 'agent-bundle/event-ipc';
export const eventProjectRuntimeSpecifier = 'agent-bundle/event-project';
export const eventArtifactEpochToken = '__AGENT_BUNDLE_EVENT_ARTIFACT_EPOCH__';

const eventRouteHookWrapperSource = (
  entry: TargetHookWrapper,
  hostContractRevision: string,
): string => {
  const route = entry.hook.eventRoute!;
  const standalone = route.runtime === 'standalone' || route.fallback === 'standalone';
  const targetSource = entry.target === 'plugin'
    ? [
        'const declaredHost = process.env.AGENT_BUNDLE_HOOK_HOST;',
        'const target = declaredHost === "claude" || declaredHost === "codex"',
        '  ? declaredHost',
        '  : process.env.PLUGIN_ROOT === undefined ? "claude" : "codex";',
      ]
    : ['const target = artifactTarget;'];
  return [
    "import { dirname, resolve } from 'node:path';",
    `import { EventRuntimeTransportError, requestEventRuntime } from ${JSON.stringify(eventIpcRuntimeSpecifier)};`,
    `import { ${standalone ? 'createCanonicalEventProps, projectEventDocument, renderStandaloneEventRoute, ' : ''}validateNativeEventEnvelope } from ${JSON.stringify(eventProjectRuntimeSpecifier)};`,
    ...(standalone
      ? [
          `import * as routeModule from ${JSON.stringify(entry.hook.source)};`,
        ]
      : []),
    '',
    `const artifactEpoch = ${JSON.stringify(eventArtifactEpochToken)};`,
    `const canonicalEvent = ${JSON.stringify(route.event)};`,
    `const capabilityRevision = ${JSON.stringify(hostContractRevision)};`,
    `const nativeEvent = ${JSON.stringify(entry.nativeEvent)};`,
    `const artifactTarget = ${JSON.stringify(entry.target)};`,
    ...targetSource,
    `const runtimeMode = ${JSON.stringify(route.runtime)};`,
    `const fallbackMode = ${JSON.stringify(route.fallback)};`,
    `const timeoutMs = ${String(entry.hook.timeoutMs ?? 5_000)};`,
    "const endpointId = `${artifactEpoch}:${artifactTarget}:${dirname(dirname(resolve(process.argv[1])))}`;",
    '',
    'const fail = (message) => { throw new Error(`Agent Bundle event route error: ${message}`); };',
    ...(standalone
      ? [
          'const runStandalone = async (native, signal) => {',
          '  const component = Reflect.get(routeModule, "default");',
          '  if (typeof component !== "function") fail("default export must be an async Server Component");',
          '  const props = createCanonicalEventProps(canonicalEvent, native, target, nativeEvent, capabilityRevision, signal);',
          '  return projectEventDocument(await renderStandaloneEventRoute(component, props), canonicalEvent, target, nativeEvent);',
          '};',
        ]
      : []),
    'const run = async () => {',
    '  const chunks = [];',
    '  let bytes = 0;',
    '  for await (const chunk of process.stdin) {',
    '    bytes += chunk.length;',
    '    if (bytes > 1024 * 1024) fail("stdin exceeds the 1 MiB native-payload limit");',
    '    chunks.push(chunk);',
    '  }',
    '  let parsed;',
    '  try { parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { fail("stdin must contain exactly one JSON value"); }',
    '  const native = validateNativeEventEnvelope(parsed, { canonicalEvent, nativeEvent, target });',
    '  const controller = new AbortController();',
    '  let output;',
    '  if (runtimeMode === "standalone") {',
    ...(standalone ? ['    output = await runStandalone(native, controller.signal);'] : ['    fail("standalone runtime was not compiled");']),
    '  } else {',
    '    try {',
    '      output = await requestEventRuntime({ artifactEpoch, endpointId, event: canonicalEvent, hostContractRevision: capabilityRevision, native, signal: controller.signal, target, timeoutMs });',
    '    } catch (error) {',
    ...(standalone
      ? [
          '      if (!(fallbackMode === "standalone" && error instanceof EventRuntimeTransportError && error.code === "runtime-unavailable")) throw error;',
          '      output = await runStandalone(native, controller.signal);',
        ]
      : ['      throw error;']),
    '    }',
    '  }',
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

/** Emits the published Cursor hook wrapper source; see encodeCursorPlaygroundInput for the envelope contract. */
export const cursorHookWrapperSource = (entry: TargetHookWrapper): string => [
  `import * as handlerModule from ${JSON.stringify(entry.hook.source)};`,
  'const target = "cursor";',
  `const canonicalEvent = ${JSON.stringify(entry.event)};`,
  `const nativeEvent = ${JSON.stringify(entry.nativeEvent)};`,
  '',
  'const isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);',
  'const defined = (value) => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));',
  'const fail = (message) => { throw new Error(`Agent Bundle hook error: ${message}`); };',
  'const parsedToolOutput = (nativeInput) => {',
  '  if (canonicalEvent !== "afterTool") return undefined;',
  '  let parsed;',
  '  try { parsed = JSON.parse(nativeInput.tool_output); } catch { fail("native tool_output must be a JSON string"); }',
  '  if (!isRecord(parsed)) fail("native tool_output must encode an object");',
  '  return parsed;',
  '};',
  'const decodeCursorNative = (nativeInput) => defined({',
  '  cwd: nativeInput.cwd,',
  '  hookEventName: nativeInput.hook_event_name,',
  '  sessionId: nativeInput.session_id ?? nativeInput.conversation_id,',
  '  stopHookActive: canonicalEvent === "stop" ? nativeInput.loop_count > 0 : undefined,',
  '  toolInput: nativeInput.tool_input,',
  '  toolName: nativeInput.tool_name,',
  '  toolResponse: parsedToolOutput(nativeInput),',
  '  toolUseId: nativeInput.tool_use_id,',
  '  transcriptPath: nativeInput.transcript_path ?? undefined,',
  '});',
  'const encodeCursorNative = (canonicalInput) => defined({',
  '  conversation_id: canonicalInput.sessionId,',
  '  cwd: canonicalInput.cwd,',
  '  hook_event_name: nativeEvent,',
  '  ...(canonicalEvent === "stop" ? { loop_count: canonicalInput.stopHookActive === true ? 1 : 0, status: "completed" } : {}),',
  '  session_id: canonicalInput.sessionId,',
  '  tool_input: canonicalInput.toolInput,',
  '  tool_name: canonicalInput.toolName,',
  '  ...(canonicalEvent === "afterTool" && canonicalInput.toolResponse !== undefined ? { tool_output: JSON.stringify(canonicalInput.toolResponse) } : {}),',
  '  tool_use_id: canonicalInput.toolUseId,',
  '  transcript_path: canonicalInput.transcriptPath,',
  '});',
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
  '  if (canonicalEvent === "stop") return result.outcome === "deny" ? defined({ followup_message: result.reason }) : undefined;',
  '  if (canonicalEvent === "beforeTool") {',
  '    if (result.outcome === "deny") return defined({ agent_message: result.reason, permission: "deny", user_message: result.reason });',
  '    return result.updatedInput === undefined ? undefined : { permission: "allow", updated_input: result.updatedInput };',
  '  }',
  '  return result.additionalContext === undefined ? undefined : { additional_context: result.additionalContext };',
  '};',
  'const decodeOutput = (nativeOutput) => {',
  '  if (nativeOutput === undefined) return undefined;',
  '  if (canonicalEvent === "stop") return typeof nativeOutput.followup_message === "string" ? { outcome: "deny", reason: nativeOutput.followup_message } : undefined;',
  '  if (canonicalEvent === "beforeTool") {',
  '    if (nativeOutput.permission === "deny") return defined({ outcome: "deny", reason: nativeOutput.agent_message });',
  '    return defined({ outcome: "continue", updatedInput: nativeOutput.updated_input });',
  '  }',
  '  return defined({ additionalContext: nativeOutput.additional_context, outcome: "continue" });',
  '};',
  'const requireString = (input, field) => {',
  '  if (typeof input[field] !== "string") fail(`native ${field} must be a string`);',
  '};',
  'const validateNativeInput = (input) => {',
  '  if (input.hook_event_name !== nativeEvent) fail(`native hook_event_name must equal ${nativeEvent}`);',
  '  if (typeof input.session_id !== "string" && typeof input.conversation_id !== "string") fail("native session_id or conversation_id must be a string");',
  '  if (input.transcript_path !== undefined && input.transcript_path !== null && typeof input.transcript_path !== "string") fail("native transcript_path must be a string or null");',
  '  if (canonicalEvent === "sessionStart") return;',
  '  if (canonicalEvent === "beforeTool" || canonicalEvent === "afterTool") {',
  '    requireString(input, "tool_name");',
  '    if (!isRecord(input.tool_input)) fail(`native ${nativeEvent} tool_input must be an object`);',
  '    requireString(input, "tool_use_id");',
  '    if (canonicalEvent === "afterTool") requireString(input, "tool_output");',
  '    return;',
  '  }',
  '  if (typeof input.loop_count !== "number") fail("native stop loop_count must be a number");',
  '  requireString(input, "status");',
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
  '  const nativeInput = simulation ? encodeCursorNative(input) : input;',
  '  validateNativeInput(nativeInput);',
  '  const event = decodeCursorNative(nativeInput);',
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

export interface HookPlan {
  readonly diagnostics: readonly Diagnostic[];
  readonly document?: Record<string, unknown>;
  readonly hookEntries: readonly TargetHookEntry[];
}

export const nativeHooksFor = (
  model: NormalizedPlugin,
  target: 'codex' | 'claude',
): NormalizedNativeHook | undefined => model.nativeHooks?.find((nativeHooks) => nativeHooks.target === target);

interface NativeHookSchemaValidator {
  (document: unknown): boolean;
  readonly errors?: readonly { readonly instancePath: string; readonly message?: string }[] | null;
}

export interface NativeHookDocumentValidation {
  readonly diagnostics: readonly Diagnostic[];
  readonly document?: Record<string, unknown>;
}

/** Validates a target's authored native-hook document; a diagnostic never yields a document. */
export const validatedNativeHookDocument = (
  model: NormalizedPlugin,
  target: 'codex' | 'claude',
  label: string,
  validate: NativeHookSchemaValidator,
  errorDiagnostic: (code: string, message: string) => Diagnostic,
): NativeHookDocumentValidation => {
  const nativeHooks = nativeHooksFor(model, target);
  if (nativeHooks?.issue === 'missing' || nativeHooks?.issue === 'parse') {
    return {
      diagnostics: [errorDiagnostic(
        `${target}.native-hooks.${nativeHooks.issue}`,
        `${label} native hooks file ${JSON.stringify(nativeHooks.source)} could not be ${nativeHooks.issue === 'missing' ? 'found' : 'parsed'}.`,
      )],
    };
  }
  if (nativeHooks?.document === undefined) return { diagnostics: [] };
  if (!validate(nativeHooks.document)) {
    return {
      diagnostics: [errorDiagnostic(
        `${target}.native-hooks.schema`,
        `${label} native hooks file ${JSON.stringify(nativeHooks.source)} is invalid: ${(validate.errors ?? [])
          .map((error) => `${error.instancePath || '/'}: ${error.message ?? 'schema validation failed'}`)
          .join('; ') || 'schema validation failed'}.`,
      )],
    };
  }
  return { diagnostics: [], document: nativeHooks.document as Record<string, unknown> };
};

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

export const generatedHookCommand = (
  contract: TargetHookContract,
  relativePath: string,
  args: readonly string[] = [],
): string => [`node "${contract.commandRoot}/${relativePath}"`, ...args].join(' ');

export const compilerHookWrapperPath = (
  contract: TargetHookContract,
  command: string,
): string | undefined => {
  const prefix = `node "${contract.commandRoot}/`;
  if (!command.startsWith(prefix) || !command.endsWith('"')) return undefined;
  const relativePath = command.slice(prefix.length, -1);
  return relativePath.length === 0 || relativePath.includes('"') ? undefined : relativePath;
};

const error = (target: string, code: string, message: string): Diagnostic => ({
  code,
  message,
  severity: 'error',
  target,
});

const matcherFor = (
  target: string,
  contract: TargetHookContract,
  hook: NormalizedHook,
  diagnostics: Diagnostic[],
): string | undefined => {
  const diagnosticCount = diagnostics.length;
  const patterns: string[] = [];
  for (const tool of hook.tools) {
    const matcher = contract.matchers[tool];
    if (matcher === undefined) {
      diagnostics.push(error(
        target,
        `${target}.hook.tool.${tool.replaceAll('.', '-')}`,
        `${target} cannot map canonical hook tool ${JSON.stringify(tool)} for ${JSON.stringify(hook.name)}.`,
      ));
      continue;
    }
    patterns.push(matcher);
  }
  const nativeTools = hook.nativeTools ?? [];
  for (const nativeTool of nativeTools) {
    if (nativeTool.target !== target) continue;
    patterns.push(`^${escapeRegExp(nativeTool.name)}$`);
  }
  if (patterns.length === 0) {
    if (nativeTools.length > 0 && diagnostics.length === diagnosticCount) {
      diagnostics.push(error(
        target,
        `${target}.hook.tool.unselected`,
        `${target} receives no tool selector from hook ${JSON.stringify(hook.name)}; add a canonical or ${target}-scoped native selector, or restrict the hook's targets.`,
      ));
    }
    return undefined;
  }
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
    return deepFreeze({ diagnostics: diagnostics, hookEntries: [] });
  }

  const groups: Record<string, unknown[]> = Object.create(null) as Record<string, unknown[]>;
  const hookEntries: TargetHookEntry[] = [];
  for (const hook of selected) {
    const nativeEvent = hook.eventRoute === undefined
      ? contract.eventNames[hook.event]
      : contract.eventRouteNames?.[hook.eventRoute.event];
    if (typeof nativeEvent !== 'string' || nativeEvent.trim().length === 0) {
      diagnostics.push(error(
        target,
        `${target}.hook.event.${hook.event.replaceAll(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)}`,
        `${target} cannot map canonical hook event ${JSON.stringify(hook.event)}.`,
      ));
      continue;
    }
    const diagnosticCount = diagnostics.length;
    const matcher = matcherFor(target, contract, hook, diagnostics);
    if (diagnostics.length > diagnosticCount) continue;
    // A prebuilt hook points the native command at its payload-stable path
    // (plus its declared arguments) instead of a compiled wrapper: the
    // document entry is generated, but nothing is compiled or indexed.
    const prebuilt = hook.prebuiltPath !== undefined;
    const relativePath = hook.prebuiltPath ?? contract.wrapperPath(hook);
    const command = generatedHookCommand(contract, relativePath, prebuilt ? hook.args ?? [] : []);
    const timeout = hook.timeoutMs === undefined ? undefined : Math.ceil(hook.timeoutMs / 1_000);
    const entryInput: TargetHookDocumentEntryInput = {
      command,
      ...(matcher === undefined ? {} : { matcher }),
      ...(timeout === undefined ? {} : { timeout }),
    };
    const group = contract.documentEntry === undefined
      ? {
          hooks: [{
            command,
            ...(timeout === undefined ? {} : { timeout }),
            type: 'command',
          }],
          ...(matcher === undefined ? {} : { matcher }),
        }
      : contract.documentEntry(entryInput);
    (groups[nativeEvent] ??= []).push(group);
    if (prebuilt) continue;
    const wrapper: TargetHookWrapper = {
      event: hook.event,
      hook,
      ...(contract.indexedWrappers === false ? { indexed: false as const } : {}),
      nativeEvent,
      ...(matcher === undefined ? {} : { nativeMatcher: matcher }),
      relativePath,
      target,
      ...(timeout === undefined ? {} : { timeout }),
    };
    hookEntries.push({
      ...wrapper,
      virtualSource: hook.eventRoute === undefined
        ? contract.wrapperSource(wrapper)
        : eventRouteHookWrapperSource(wrapper, contract.hostContractRevision ?? target),
    });
  }

  return Object.freeze({
    diagnostics: Object.freeze(diagnostics),
    ...(Object.keys(groups).length === 0
      ? {}
      : { document: contract.documentEnvelope === undefined ? { hooks: groups } : contract.documentEnvelope(groups) }),
    hookEntries: Object.freeze(hookEntries),
  });
};

/**
 * Emits the published hook wrapper source for one target.
 *
 * Invariant: the `'Claude'` and `'Codex'` codec bodies must stay
 * byte-identical apart from the codec token baked into identifier names
 * (`decode${codecName}Native`/`encode${codecName}Native`) and the baked
 * `const target = ...` line. Decode fields, output validation, output
 * encoding, and exit behavior are shared and must not diverge between the
 * two. This is what makes the `'Universal'` codec sound: it serves one
 * wrapper body to every host, so any Claude/Codex divergence beyond those
 * two spots would make the universal wrapper wrong for whichever host it
 * was not modeled on. The 'keeps the Claude and Codex native wrapper codecs
 * byte-identical...' test in tests/hooks.test.ts guards this invariant —
 * update it alongside any deliberate change to the shared body.
 */
export const nativeHookWrapperSource = (
  entry: TargetHookWrapper,
  codecName: 'Claude' | 'Codex' | 'Universal',
): string => {
  const nativeEvent = entry.nativeEvent;
  const decoderFields = nativeHookInputFields.map((field) =>
    `  ${field.canonical}: nativeInput.${field.native},`);
  const encoderFields = nativeHookInputFields
    .filter((field) => field.canonical !== 'hookEventName')
    .map((field) => `  ${field.native}: canonicalInput.${field.canonical},`);

  // The universal codec serves one wrapper to every host: Codex documents
  // exporting PLUGIN_ROOT into hook processes and Claude does not, so its
  // presence discriminates the calling host at runtime; the simulation
  // harness can pin a host explicitly through AGENT_BUNDLE_HOOK_HOST. This
  // host-detection block is the only source difference the Universal codec
  // is allowed from the shared Claude/Codex body below it (see the parity
  // invariant documented on nativeHookWrapperSource above).
  const targetSource = codecName === 'Universal'
    ? [
        'const declaredHost = process.env.AGENT_BUNDLE_HOOK_HOST;',
        'const target = declaredHost === "claude" || declaredHost === "codex"',
        '  ? declaredHost',
        '  : process.env.PLUGIN_ROOT === undefined ? "claude" : "codex";',
      ]
    : [`const target = ${JSON.stringify(entry.target)};`];
  return [
    `import * as handlerModule from ${JSON.stringify(entry.hook.source)};`,
    ...targetSource,
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
    '  const supportsDeniedReason = canonicalEvent === "beforeTool" || canonicalEvent === "stop" || canonicalEvent === "agentStop";',
    '  if (result.reason !== undefined && !(result.outcome === "deny" && supportsDeniedReason)) fail("reason is only valid for a denied beforeTool, stop, or agentStop hook");',
    '  if (result.outcome === "deny" && supportsDeniedReason && (typeof result.reason !== "string" || result.reason.trim().length === 0)) fail(`denied ${canonicalEvent} hook requires a nonempty reason`);',
    '  if ((canonicalEvent === "sessionStart" || canonicalEvent === "afterTool" || canonicalEvent === "agentStart") && (result.outcome === "deny" || result.outcome === "stop" || result.updatedInput !== undefined)) fail(`${canonicalEvent} cannot deny, stop, or replace input`);',
    '  if (canonicalEvent === "beforeTool" && (result.outcome === "stop" || (result.outcome === "deny" && result.updatedInput !== undefined))) fail("beforeTool cannot stop or replace input while denying");',
    '  if (canonicalEvent === "stop" && (result.outcome === "stop" || result.updatedInput !== undefined || result.additionalContext !== undefined)) fail("stop only accepts continue or deny with a reason");',
    '  if (canonicalEvent === "agentStop" && (result.outcome === "stop" || result.updatedInput !== undefined)) fail("agentStop cannot stop the parent flow or replace input");',
    '  if (canonicalEvent === "agentStop" && target === "codex" && result.additionalContext !== undefined) fail("Codex SubagentStop does not support additionalContext");',
    '  return result;',
    '};',
    'const encodeOutput = (result) => {',
    '  if (result === undefined) return undefined;',
    '  if (canonicalEvent === "stop" || canonicalEvent === "agentStop") {',
    '    if (result.outcome === "deny") return defined({ decision: "block", reason: result.reason });',
    '    if (canonicalEvent === "agentStop" && target === "claude" && result.additionalContext !== undefined) return { hookSpecificOutput: { additionalContext: result.additionalContext, hookEventName: nativeEvent } };',
    '    return undefined;',
    '  }',
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
    '  if (canonicalEvent === "stop" || canonicalEvent === "agentStop") {',
    '    if (nativeOutput.decision === "block") return defined({ outcome: "deny", reason: nativeOutput.reason });',
    '    if (canonicalEvent === "agentStop" && target === "claude" && isRecord(nativeOutput.hookSpecificOutput)) return defined({ additionalContext: nativeOutput.hookSpecificOutput.additionalContext, outcome: "continue" });',
    '    return undefined;',
    '  }',
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
    'const requireNullableString = (input, field) => {',
    '  if (input[field] !== null && typeof input[field] !== "string") fail(`native ${field} must be a string or null`);',
    '};',
    'const validateNativeInput = (input) => {',
    '  requireString(input, "session_id");',
    '  if (target === "codex") requireNullableString(input, "transcript_path"); else requireString(input, "transcript_path");',
    '  requireString(input, "cwd");',
    '  if (input.hook_event_name !== nativeEvent) fail(`native hook_event_name must equal ${nativeEvent}`);',
    '  if (input.prompt_id !== undefined) requireString(input, "prompt_id");',
    '  if (input.permission_mode !== undefined) requireString(input, "permission_mode");',
    '  if (input.model !== undefined) requireString(input, "model");',
    '  if (canonicalEvent === "sessionStart") { requireString(input, "source"); return; }',
    '  if (canonicalEvent === "beforeTool" || canonicalEvent === "afterTool") {',
    '    requireString(input, "tool_name");',
    '    if (!isRecord(input.tool_input)) fail(`native ${nativeEvent} tool_input must be an object`);',
    '    requireString(input, "tool_use_id");',
    '    if (canonicalEvent === "afterTool" && !isRecord(input.tool_response)) fail("native PostToolUse tool_response must be an object");',
    '    return;',
    '  }',
    '  if (canonicalEvent === "agentStart" || canonicalEvent === "agentStop") {',
    '    requireString(input, "agent_id");',
    '    requireString(input, "agent_type");',
    '    if (target === "codex") {',
    '      requireString(input, "turn_id");',
    '      requireString(input, "model");',
    '      requireString(input, "permission_mode");',
    '      if (!["default", "acceptEdits", "plan", "dontAsk", "bypassPermissions"].includes(input.permission_mode)) fail("native permission_mode is invalid");',
    '    }',
    '    if (canonicalEvent === "agentStart") return;',
    '    if (typeof input.stop_hook_active !== "boolean") fail("native SubagentStop stop_hook_active must be a boolean");',
    '    requireNullableString(input, "agent_transcript_path");',
    '    requireNullableString(input, "last_assistant_message");',
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
