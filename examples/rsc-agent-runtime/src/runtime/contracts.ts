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

export type RenderRequest = {
  type: 'hook/after-file-edit';
  stateFile: string;
  event: CanonicalPostToolUse;
};

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
  _meta: {
    ui?: { resourceUri: string };
    'openai/outputTemplate'?: string;
  };
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
  _meta: {
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
