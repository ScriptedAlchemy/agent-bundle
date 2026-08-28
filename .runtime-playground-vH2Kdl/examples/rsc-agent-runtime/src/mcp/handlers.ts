import { createFileRuntimeKernel } from '../runtime/state-file.js';
import { lowerMcpResult } from '@agent-bundle/rsc-runtime';
import { requestFlightRender } from '../flight/request-render.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { resolveStateFile, type McpRequestExtra, type ResolveStateOptions } from './resolve-state.js';

type ToolInput = { limit?: number };
type McpToolHandler = (input: ToolInput, extra: McpRequestExtra) => Promise<CallToolResult>;

const textSnapshot = (snapshot: { edits: unknown[]; stateVersion: number }): CallToolResult => ({
  content: [{ text: JSON.stringify(snapshot), type: 'text' }],
  structuredContent: snapshot,
});

export const createMcpHandlers = (options: ResolveStateOptions): Record<string, McpToolHandler> => ({
  recent_edits: async (input, extra) => {
    const stateFile = await resolveStateFile(options, extra);
    const snapshot = await createFileRuntimeKernel({ stateFile }).readSnapshot({ limit: input.limit });
    return textSnapshot(snapshot);
  },
  render_edit_timeline: async (input, extra) => {
    const stateFile = await resolveStateFile(options, extra);
    const snapshot = await createFileRuntimeKernel({ stateFile }).readSnapshot({ limit: input.limit });
    return lowerMcpResult(
      await requestFlightRender({ snapshot, stateFile, type: 'mcp/render-timeline' }),
    );
  },
  runtime_status: async (_input, extra) => {
    const stateFile = await resolveStateFile(options, extra);
    return lowerMcpResult(await requestFlightRender({ stateFile, type: 'mcp/runtime-status' }));
  },
});
