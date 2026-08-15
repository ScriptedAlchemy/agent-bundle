import type { ZodType } from 'zod';
import type {
  DevRuntimeInspectionEnvelope,
  DevRuntimeMcpServerDescriptor,
} from '../../../../packages/agent-bundle/src/dev/runtime-protocol.ts';
import type { JsonObject } from '../../../../packages/agent-bundle/src/dev/types.ts';

export interface EditEvent {
  eventId: string;
  host: 'claude' | 'codex';
  sessionId: string;
  toolName: string;
  path: string;
  recordedAt: string;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | Readonly<{ [key: string]: JsonValue }>;

export type RuntimeStateRecord =
  | Readonly<{
      event: EditEvent;
      idempotencyKey: string;
      kind: 'edit';
      stateVersion: number;
    }>
  | Readonly<{
      idempotencyKey: string;
      kind: 'reset';
      seed?: JsonValue;
      stateVersion: number;
    }>;

export interface RuntimeSnapshot {
  stateVersion: number;
  edits: EditEvent[];
  readonly seed?: JsonValue;
}

export interface RuntimeKernel {
  recordEdit(
    input: Omit<EditEvent, 'eventId' | 'recordedAt'> & Readonly<{ idempotencyKey: string }>,
    options?: RuntimeMutationOptions,
  ): Promise<RuntimeSnapshot>;
  resetState(
    input: Readonly<{ idempotencyKey: string; seed?: JsonValue }>,
    options?: RuntimeMutationOptions,
  ): Promise<RuntimeSnapshot>;
  readSnapshot(options?: { limit?: number }): Promise<RuntimeSnapshot>;
}

export interface RuntimeMutationOptions {
  /** Bounded caller wait for an existing owner; lock timing itself is never caller-configurable. */
  lockAcquireTimeoutMs?: number;
  signal?: AbortSignal;
}

export interface CanonicalPostToolUse {
  host: 'claude' | 'codex';
  idempotencyKey: string;
  sessionId: string;
  cwd: string;
  toolName: string;
  path: string;
}

export interface HookRenderRequest {
  type: 'hook/after-file-edit';
  stateFile: string;
  event: CanonicalPostToolUse;
}

export interface McpRenderTimelineRequest {
  type: 'mcp/render-timeline';
  stateFile: string;
  snapshot: RuntimeSnapshot;
}

export interface McpRuntimeStatusRequest {
  type: 'mcp/runtime-status';
  stateFile: string;
}

export type RenderRequest = HookRenderRequest | McpRenderTimelineRequest | McpRuntimeStatusRequest;

export interface DevRuntimeHookInspectionRequest {
  readonly host: 'claude' | 'codex';
  readonly input: Readonly<Record<string, unknown>>;
  readonly stateFile: string;
  readonly stateStoreId: string;
  readonly type: 'hook/after-file-edit';
}

export interface DevRuntimeMcpTimelineInspectionRequest {
  readonly snapshot: RuntimeSnapshot;
  readonly stateFile: string;
  readonly stateStoreId: string;
  readonly type: 'mcp/render-timeline';
}

export interface DevRuntimeMcpStatusInspectionRequest {
  readonly stateFile: string;
  readonly stateStoreId: string;
  readonly type: 'mcp/runtime-status';
}

export type DevRuntimeInspectionRequest =
  | DevRuntimeHookInspectionRequest
  | DevRuntimeMcpTimelineInspectionRequest
  | DevRuntimeMcpStatusInspectionRequest;

export interface DevRuntimeInspectionResponse {
  /** Raw Flight bytes are sent over the provider-owned fd 3 side channel. */
  readonly flightBytes: number;
  readonly inspection: DevRuntimeInspectionEnvelope;
}

export type McpTimeline = RuntimeSnapshot;

export interface ToolAnnotations {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}

export interface RuntimeToolDefinition {
  name: string;
  description: string;
  inputSchema: ZodType;
  outputSchema: ZodType;
  annotations: ToolAnnotations;
  handlerId: string;
  _meta: Record<string, unknown>;
}

export interface NativeHookDefinition {
  host: 'claude' | 'codex';
  event: 'PostToolUse' | 'after_tool_use';
  matcher: string;
  handlerId: string;
}

export interface RuntimeResourceDefinition {
  name: string;
  uri: string;
  mimeType: string;
  _meta: Record<string, unknown> & {
    'ui.prefersBorder': true;
    'ui.csp': {
      connectDomains: [];
      resourceDomains: [];
    };
    'openai/widgetDescription': string;
  };
}

export interface RuntimeDefinition {
  tools: RuntimeToolDefinition[];
  nativeHooks: NativeHookDefinition[];
  resources: RuntimeResourceDefinition[];
}

export interface SerializedRuntimeToolDefinition extends Omit<RuntimeToolDefinition, 'inputSchema' | 'outputSchema'> {
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
}

export interface SerializedRuntimeDefinition {
  tools: SerializedRuntimeToolDefinition[];
  nativeHooks: NativeHookDefinition[];
  resources: RuntimeResourceDefinition[];
}

export interface RscRuntimeSurfaceAsset {
  readonly bytes: number;
  readonly contentType: 'application/javascript' | 'application/json' | 'text/css' | 'text/html';
  readonly generationPath: string;
  readonly requestPath: string;
  readonly sha256: string;
}

export interface RscRuntimeAppDefinition {
  readonly _meta?: JsonObject;
  readonly id: string;
  readonly name: string;
  readonly resourceUri: string;
  readonly serverId: string;
  readonly serverName: string;
  readonly targets: readonly string[];
}

export interface RscRuntimeGenerationMetadata {
  readonly appDefinitions: readonly RscRuntimeAppDefinition[];
  readonly definitionDigest: string;
  readonly entries: Readonly<Record<string, string>>;
  readonly environmentHashes: Readonly<Record<'rsc' | 'widget', string>>;
  readonly preparedRevision: string;
  readonly serverDigest: string;
  readonly servers: readonly DevRuntimeMcpServerDescriptor[];
  readonly stateStoreId: string;
  readonly surfaceAssets: Readonly<Record<string, readonly RscRuntimeSurfaceAsset[]>>;
  readonly transportDigest: string;
}
