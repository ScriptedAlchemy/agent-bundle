import { documentToCallToolResult } from '@agent-bundle/runtime';
import type { CallToolResult, ServerContext } from '@modelcontextprotocol/server';

import { createFileRuntimeKernel } from '../runtime/state-file.js';
import { requestAgentDocument } from '../flight/request-render.js';

import { resolveStateFile, type ResolveStateOptions } from './resolve-state.js';

type ToolInput = { limit?: number };
type McpToolHandler = (input: ToolInput, ctx: ServerContext) => Promise<CallToolResult>;

const textSnapshot = (snapshot: { edits: unknown[]; stateVersion: number }): CallToolResult => ({
  content: [{ text: JSON.stringify(snapshot), type: 'text' }],
  structuredContent: snapshot,
});

export const createMcpHandlers = (options: ResolveStateOptions): Record<string, McpToolHandler> => ({
  recent_edits: async (input, ctx) => {
    const stateFile = await resolveStateFile(options, ctx);
    const snapshot = await createFileRuntimeKernel({ stateFile }).readSnapshot({ limit: input.limit });
    return textSnapshot(snapshot);
  },
  render_edit_timeline: async (input, ctx) => {
    const stateFile = await resolveStateFile(options, ctx);
    const snapshot = await createFileRuntimeKernel({ stateFile }).readSnapshot({ limit: input.limit });
    return documentToCallToolResult(
      await requestAgentDocument({ snapshot, stateFile, type: 'mcp/render-timeline' }),
    );
  },
  runtime_status: async (_input, ctx) => {
    const stateFile = await resolveStateFile(options, ctx);
    return documentToCallToolResult(await requestAgentDocument({ stateFile, type: 'mcp/runtime-status' }));
  },
});
