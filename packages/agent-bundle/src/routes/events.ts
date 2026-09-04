import type { JsonValue } from '../core/strict-json.ts';

/** The event-route families admitted by the recorded #97 v1/G10 decision. */
export const canonicalAgentEvents = Object.freeze([
  'session/start',
  'tool/before',
  'tool/after',
  'stop',
  'agent/start',
  'agent/stop',
  'workspace/open',
  'session/end',
  'prompt/submit',
  'tool/failure',
  'compact/before',
  'compact/after',
  'permission/request',
  'permission/denied',
  'stop/failure',
  'file/change',
  'config/change',
  'task/create',
  'task/complete',
  'agent/idle',
  'model-switch/before',
  'model-switch/after',
] as const);

export type CanonicalAgentEvent = (typeof canonicalAgentEvents)[number];

/**
 * The canonical payload vocabulary of event routes (#466): every field a
 * route may read from `canonical.payload`, with the JSON shape it carries on
 * every host. A field is admitted only when at least two hosts report it for
 * the same family (or the family exists on one host only, in which case its
 * defining fields are admitted); everything else stays host-specific and is
 * read from `native`. The per-host spelling of each field lives in
 * {@link agentEventPayloadNativeKeys}, and the generated events reference
 * renders the same table per host from the pinned capability JSON.
 */
export interface AgentEventPayloadFieldTypes {
  /** The subagent the event belongs to (Claude and Codex name it on every hook fired inside one). */
  readonly agentId: string;
  /** The subagent's own transcript, `null` before the host has written it. */
  readonly agentTranscriptPath: string | null;
  readonly agentType: string;
  readonly cwd: string;
  /** The failed tool's error text (`tool/failure`) or the API error string (`stop/failure`). */
  readonly error: string;
  readonly filePath: string;
  /** The model in use before a switch (`model-switch/*`, Claude `from_model`). */
  readonly fromModel: string;
  readonly isInterrupt: boolean;
  /** The turn's final assistant text; `null` when the host reports none. */
  readonly lastAssistantMessage: string | null;
  readonly model: string;
  readonly permissionMode: string;
  readonly prompt: string;
  /** `reason` on `session/end`: the host's own vocabulary (`clear`, `other`, `completed`, …). */
  readonly reason: string;
  /** The model name as the user typed it (`model-switch/*`, Claude `requested_model`); `null` when the switch was not user-initiated. */
  readonly requestedModel: string | null;
  /**
   * Whether this stop hook is already running for the turn — Claude and Codex
   * `stop_hook_active`, Cursor `loop_count > 0`. Check it before returning
   * `deny` from a `stop` route, or the continuation loops until the host caps it.
   */
  readonly reentry: boolean;
  /** The conversation id: `session_id` on Claude and Codex, `conversation_id` on Cursor. */
  readonly sessionId: string;
  /** How the session began (`session/start`), which settings layer changed (`config/change`), or what triggered a model switch (`model-switch/*`). */
  readonly source: string;
  readonly taskDescription: string;
  readonly taskId: string;
  readonly taskSubject: string;
  readonly teamName: string;
  readonly teammateName: string;
  /** The canonical name of the model being switched to (`model-switch/*`, Claude `to_model`). */
  readonly toModel: string;
  /** The pending call's input; an object on Claude and Cursor, any JSON value on Codex. */
  readonly toolInput: JsonValue;
  readonly toolName: string;
  /**
   * The completed call's response. Claude and Codex deliver `tool_response`
   * as JSON (a plain string for MCP tools on Claude); Cursor's `tool_output`
   * JSON string is parsed when it is valid JSON and kept as the string otherwise.
   */
  readonly toolResponse: JsonValue;
  readonly toolUseId: string;
  readonly transcriptPath: string | null;
  readonly trigger: 'manual' | 'auto';
  readonly workspaceRoots: readonly string[];
}

export type AgentEventPayloadFieldName = keyof AgentEventPayloadFieldTypes;

/** The JSON shape each canonical payload field is decoded as; the runtime twin of {@link AgentEventPayloadFieldTypes}. */
export type AgentEventPayloadFieldKind =
  | 'boolean'
  | 'json'
  | 'nullable-string'
  | 'string'
  | 'string-array'
  | 'trigger';

export const agentEventPayloadFieldKinds = Object.freeze({
  agentId: 'string',
  agentTranscriptPath: 'nullable-string',
  agentType: 'string',
  cwd: 'string',
  error: 'string',
  filePath: 'string',
  fromModel: 'string',
  isInterrupt: 'boolean',
  lastAssistantMessage: 'nullable-string',
  model: 'string',
  permissionMode: 'string',
  prompt: 'string',
  reason: 'string',
  reentry: 'boolean',
  requestedModel: 'nullable-string',
  sessionId: 'string',
  source: 'string',
  taskDescription: 'string',
  taskId: 'string',
  taskSubject: 'string',
  teamName: 'string',
  teammateName: 'string',
  toModel: 'string',
  toolInput: 'json',
  toolName: 'string',
  toolResponse: 'json',
  toolUseId: 'string',
  transcriptPath: 'nullable-string',
  trigger: 'trigger',
  workspaceRoots: 'string-array',
} as const satisfies Readonly<Record<AgentEventPayloadFieldName, AgentEventPayloadFieldKind>>);

// The session fields Claude and Codex put on every envelope (Cursor adds
// `cwd` on tool events only and has no permission mode or per-hook agent id).
const sessionFields = ['sessionId', 'cwd', 'transcriptPath', 'permissionMode', 'agentId', 'agentType'] as const;
// `model` reaches the payload only where two hosts send it: Codex and Cursor
// on every envelope, Claude on SessionStart alone — so the families all three
// hosts support carry it, and the Claude/Codex-only families do not.
const threeHostFields = [...sessionFields, 'model'] as const;
const toolFields = [...threeHostFields, 'toolName', 'toolInput', 'toolUseId'] as const;
const taskFields = [...sessionFields, 'taskId', 'taskSubject', 'taskDescription', 'teammateName', 'teamName'] as const;
// Claude-only families (PreModelSwitch / PostModelSwitch, 2.1.251+; pinned at
// 2.1.260) admit their defining fields: the switch itself plus what triggered it.
const modelSwitchFields = [...sessionFields, 'fromModel', 'toModel', 'requestedModel', 'source'] as const;

/**
 * The canonical payload fields of every event-route family, in the order the
 * payload object carries them. This is the one per-family table; the types
 * ({@link AgentEventPayload}) and the runtime projection derive from it.
 */
export const agentEventPayloadFields = Object.freeze({
  'agent/idle': [...sessionFields, 'teammateName', 'teamName'],
  'agent/start': threeHostFields,
  'agent/stop': [...threeHostFields, 'agentTranscriptPath', 'reentry', 'lastAssistantMessage'],
  'compact/after': [...sessionFields, 'trigger'],
  'compact/before': [...threeHostFields, 'trigger'],
  'config/change': [...sessionFields, 'source', 'filePath'],
  'file/change': [...sessionFields, 'filePath'],
  'model-switch/after': modelSwitchFields,
  'model-switch/before': modelSwitchFields,
  'permission/denied': [...sessionFields, 'toolName', 'toolInput'],
  'permission/request': [...sessionFields, 'toolName', 'toolInput'],
  'prompt/submit': [...threeHostFields, 'prompt'],
  'session/end': [...threeHostFields, 'reason'],
  'session/start': [...threeHostFields, 'source'],
  stop: [...threeHostFields, 'reentry', 'lastAssistantMessage'],
  'stop/failure': [...sessionFields, 'error', 'reentry', 'lastAssistantMessage'],
  'task/complete': taskFields,
  'task/create': taskFields,
  'tool/after': [...toolFields, 'toolResponse'],
  'tool/before': toolFields,
  // Claude and Cursor: neither shares the other's permission mode or agent id here.
  'tool/failure': ['sessionId', 'cwd', 'transcriptPath', 'toolName', 'toolInput', 'toolUseId', 'error', 'isInterrupt'],
  'workspace/open': ['workspaceRoots'],
} as const satisfies Readonly<Record<CanonicalAgentEvent, readonly AgentEventPayloadFieldName[]>>);

export type AgentEventPayloadFields = typeof agentEventPayloadFields;

/**
 * One canonical payload field as a route receives it: the decoded value plus
 * the host's own key it was read from, so a consumer can tell a mapped field
 * from a missing one and still name the native spelling in its own output.
 */
export interface AgentEventPayloadField<Value> {
  readonly nativeKey: string;
  readonly value: Value;
}

/**
 * The canonical payload of event family `E`: each admitted field is present
 * with its provenance when the host sent it and absent (`undefined`) when the
 * host did not — never fabricated. For the wide `CanonicalAgentEvent` the
 * payload admits every field of every family, all optional.
 */
export type AgentEventPayload<E extends CanonicalAgentEvent = CanonicalAgentEvent> = {
  readonly [Field in AgentEventPayloadFields[E][number]]?: AgentEventPayloadField<AgentEventPayloadFieldTypes[Field]>;
};

/** The hosts whose native envelopes the framework maps into canonical payloads. */
export type AgentEventPayloadHost = 'claude' | 'codex' | 'cursor';

/**
 * How a host spells one canonical field. `decode` names a transformation
 * beyond reading the key: `json-string` parses a JSON-encoded string
 * (Cursor `tool_output`), `positive-count` reads a counter as a boolean
 * (Cursor `loop_count` → `reentry`). Absent means the value is taken as is.
 */
export interface AgentEventPayloadNativeKey {
  readonly decode?: 'json-string' | 'positive-count';
  readonly nativeKey: string;
}

type NativeKeyTable = Readonly<Partial<Record<AgentEventPayloadFieldName, AgentEventPayloadNativeKey>>>;

const key = (nativeKey: string, decode?: AgentEventPayloadNativeKey['decode']): AgentEventPayloadNativeKey =>
  Object.freeze(decode === undefined ? { nativeKey } : { decode, nativeKey });

/** The shared Claude/Codex envelope spellings; Cursor deviates per field below. */
const standardKeys = Object.freeze({
  agentId: key('agent_id'),
  agentTranscriptPath: key('agent_transcript_path'),
  agentType: key('agent_type'),
  cwd: key('cwd'),
  error: key('error'),
  filePath: key('file_path'),
  fromModel: key('from_model'),
  isInterrupt: key('is_interrupt'),
  lastAssistantMessage: key('last_assistant_message'),
  model: key('model'),
  permissionMode: key('permission_mode'),
  prompt: key('prompt'),
  reason: key('reason'),
  reentry: key('stop_hook_active'),
  requestedModel: key('requested_model'),
  sessionId: key('session_id'),
  source: key('source'),
  taskDescription: key('task_description'),
  taskId: key('task_id'),
  taskSubject: key('task_subject'),
  teamName: key('team_name'),
  teammateName: key('teammate_name'),
  toModel: key('to_model'),
  toolInput: key('tool_input'),
  toolName: key('tool_name'),
  toolResponse: key('tool_response'),
  toolUseId: key('tool_use_id'),
  transcriptPath: key('transcript_path'),
  trigger: key('trigger'),
} as const satisfies NativeKeyTable);

const cursorKeys = Object.freeze({
  ...standardKeys,
  agentId: key('subagent_id'),
  agentType: key('subagent_type'),
  error: key('error_message'),
  reentry: key('loop_count', 'positive-count'),
  sessionId: key('conversation_id'),
  toolResponse: key('tool_output', 'json-string'),
  workspaceRoots: key('workspace_roots'),
} as const satisfies NativeKeyTable);

const pick = <Keys extends NativeKeyTable>(
  keys: Keys,
  fields: readonly (keyof Keys & AgentEventPayloadFieldName)[],
): NativeKeyTable => Object.freeze(Object.fromEntries(fields.map((field) => [field, keys[field]])));

// Claude Code common input fields (hooks reference, "Common input fields",
// 2026-09-03): session_id, transcript_path, cwd, permission_mode ("not all
// events receive this field"), plus agent_id/agent_type inside a subagent;
// `model` reaches SessionStart only.
const claudeSession = ['sessionId', 'cwd', 'transcriptPath', 'permissionMode', 'agentId', 'agentType'] as const;
const claudeTool = [...claudeSession, 'toolName', 'toolInput', 'toolUseId'] as const;
const claudeTask = [...claudeSession, 'taskId', 'taskSubject', 'taskDescription', 'teammateName', 'teamName'] as const;
// The pinned rust-v0.147.0 input schemas require session_id, transcript_path
// (nullable), cwd, model, and permission_mode on every event; agent_id and
// agent_type ride along inside a subagent (fixtures/host-lineage/codex-0.147.0.ndjson).
// `model` is mapped only on the families where a second host also sends it.
const codexSession = ['sessionId', 'cwd', 'transcriptPath', 'permissionMode', 'agentId', 'agentType'] as const;
const codexThreeHost = [...codexSession, 'model'] as const;
const codexTool = [...codexThreeHost, 'toolName', 'toolInput', 'toolUseId'] as const;
// https://cursor.com/docs/hooks (2026-08-28) plus fixtures/host-lineage/cursor-3.18.25.ndjson:
// every envelope carries conversation_id, model, and transcript_path (nullable);
// cwd arrives on the tool events only; there is no permission mode.
const cursorSession = ['sessionId', 'transcriptPath', 'model'] as const;
const cursorTool = [...cursorSession, 'cwd', 'toolName', 'toolInput', 'toolUseId'] as const;

/**
 * The per-host native spelling of each canonical payload field, per family:
 * the one mapping table the runtime projection reads. A family a host does
 * not support has no entry; a field a host never sends for a family is
 * absent from its entry, so the table doubles as the coverage matrix the
 * generated events reference renders. The pinned capability tables mirror
 * it under `hooks.eventRoutes.<event>.payload`, held equal by
 * `tests/event-payload.test.ts`.
 */
export const agentEventPayloadNativeKeys: Readonly<
  Record<AgentEventPayloadHost, Readonly<Partial<Record<CanonicalAgentEvent, NativeKeyTable>>>>
> = Object.freeze({
  claude: Object.freeze({
    'agent/idle': pick(standardKeys, [...claudeSession, 'teammateName', 'teamName']),
    'agent/start': pick(standardKeys, claudeSession),
    'agent/stop': pick(standardKeys, [...claudeSession, 'agentTranscriptPath', 'reentry', 'lastAssistantMessage']),
    'compact/after': pick(standardKeys, [...claudeSession, 'trigger']),
    'compact/before': pick(standardKeys, [...claudeSession, 'trigger']),
    'config/change': pick(standardKeys, [...claudeSession, 'source', 'filePath']),
    'file/change': pick(standardKeys, [...claudeSession, 'filePath']),
    // hooks reference "PreModelSwitch input" / "PostModelSwitch input" (2.1.251+):
    // from_model, to_model, requested_model (string or null), source; the
    // cache and pricing fields stay host-specific in `native`.
    'model-switch/after': pick(standardKeys, modelSwitchFields),
    'model-switch/before': pick(standardKeys, modelSwitchFields),
    'permission/denied': pick(standardKeys, [...claudeSession, 'toolName', 'toolInput']),
    'permission/request': pick(standardKeys, [...claudeSession, 'toolName', 'toolInput']),
    'prompt/submit': pick(standardKeys, [...claudeSession, 'prompt']),
    'session/end': pick(standardKeys, [...claudeSession, 'reason']),
    'session/start': pick(standardKeys, [...claudeSession, 'model', 'source']),
    stop: pick(standardKeys, [...claudeSession, 'reentry', 'lastAssistantMessage']),
    'stop/failure': pick(standardKeys, [...claudeSession, 'error', 'reentry', 'lastAssistantMessage']),
    'task/complete': pick(standardKeys, claudeTask),
    'task/create': pick(standardKeys, claudeTask),
    'tool/after': pick(standardKeys, [...claudeTool, 'toolResponse']),
    'tool/before': pick(standardKeys, claudeTool),
    'tool/failure': pick(standardKeys, ['sessionId', 'cwd', 'transcriptPath', 'toolName', 'toolInput', 'toolUseId', 'error', 'isInterrupt']),
  }),
  codex: Object.freeze({
    'agent/start': pick(standardKeys, codexThreeHost),
    'agent/stop': pick(standardKeys, [...codexThreeHost, 'agentTranscriptPath', 'reentry', 'lastAssistantMessage']),
    'compact/after': pick(standardKeys, [...codexSession, 'trigger']),
    'compact/before': pick(standardKeys, [...codexThreeHost, 'trigger']),
    'permission/request': pick(standardKeys, [...codexSession, 'toolName', 'toolInput']),
    'prompt/submit': pick(standardKeys, [...codexThreeHost, 'prompt']),
    'session/end': pick(standardKeys, [...codexThreeHost, 'reason']),
    'session/start': pick(standardKeys, [...codexThreeHost, 'source']),
    stop: pick(standardKeys, [...codexThreeHost, 'reentry', 'lastAssistantMessage']),
    'tool/after': pick(standardKeys, [...codexTool, 'toolResponse']),
    'tool/before': pick(standardKeys, codexTool),
  }),
  cursor: Object.freeze({
    'agent/start': pick(cursorKeys, [...cursorSession, 'agentId', 'agentType']),
    // subagentStop documents subagent_type and agent_transcript_path; subagent_id
    // is observed on Cursor 3.18.25 (fixtures/host-lineage/cursor-3.18.25.ndjson).
    'agent/stop': pick(cursorKeys, [...cursorSession, 'agentId', 'agentType', 'agentTranscriptPath', 'reentry']),
    'compact/before': pick(cursorKeys, [...cursorSession, 'trigger']),
    'prompt/submit': pick(cursorKeys, [...cursorSession, 'prompt']),
    'session/end': pick(cursorKeys, [...cursorSession, 'reason']),
    'session/start': pick(cursorKeys, cursorSession),
    stop: pick(cursorKeys, [...cursorSession, 'reentry']),
    'tool/after': pick(cursorKeys, [...cursorTool, 'toolResponse']),
    'tool/before': pick(cursorKeys, cursorTool),
    'tool/failure': pick(cursorKeys, ['sessionId', 'transcriptPath', 'cwd', 'toolName', 'toolInput', 'toolUseId', 'error', 'isInterrupt']),
    'workspace/open': pick(cursorKeys, ['workspaceRoots']),
  }),
});

export const isAgentEventPayloadHost = (target: string): target is AgentEventPayloadHost =>
  target === 'claude' || target === 'codex' || target === 'cursor';
