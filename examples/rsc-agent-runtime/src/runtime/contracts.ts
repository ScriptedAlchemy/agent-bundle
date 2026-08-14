import type { ZodType } from 'zod';

export interface EditEvent {
  eventId: string;
  host: 'claude' | 'codex';
  sessionId: string;
  toolName: string;
  path: string;
  recordedAt: string;
}

export interface RuntimeSnapshot {
  stateVersion: number;
  edits: EditEvent[];
}

export interface RuntimeKernel {
  recordEdit(input: Omit<EditEvent, 'eventId' | 'recordedAt'>): Promise<RuntimeSnapshot>;
  readSnapshot(options?: { limit?: number }): Promise<RuntimeSnapshot>;
}

export interface CanonicalPostToolUse {
  host: 'claude' | 'codex';
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
