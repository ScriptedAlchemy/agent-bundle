import { z } from 'zod';

import type { RuntimeDefinition, ToolAnnotations } from './runtime/contracts.js';

export const editTimelineResourceUri = 'ui://rsc-agent-runtime/edit-timeline-v1.html';

const readOnlyAnnotations: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
  readOnlyHint: true,
};

const editEventSchema = z.object({
  eventId: z.string(),
  host: z.enum(['claude', 'codex']),
  path: z.string(),
  recordedAt: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
});

const snapshotSchema = z.object({
  edits: z.array(editEventSchema),
  stateVersion: z.number().int().nonnegative(),
});

const limitInputSchema = z.object({
  limit: z.number().int().min(1).max(50).optional(),
});

export const runtimeDefinition: RuntimeDefinition = {
  nativeHooks: [
    {
      event: 'PostToolUse',
      handlerId: 'record_post_tool_use',
      host: 'claude',
      matcher: 'Write|Edit',
    },
    {
      event: 'after_tool_use',
      handlerId: 'record_post_tool_use',
      host: 'codex',
      matcher: 'apply_patch',
    },
  ],
  resources: [
    {
      _meta: {
        'openai/widgetDescription': 'Interactive timeline of file edits recorded by agent hooks.',
        'ui.csp': {
          connectDomains: [],
          resourceDomains: [],
        },
        'ui.prefersBorder': true,
      },
      mimeType: 'text/html;profile=mcp-app',
      name: 'edit-timeline',
      uri: editTimelineResourceUri,
    },
  ],
  tools: [
    {
      _meta: {},
      annotations: readOnlyAnnotations,
      description: 'Read file edits recorded by agent hooks.',
      handlerId: 'recent_edits',
      inputSchema: limitInputSchema,
      name: 'recent_edits',
      outputSchema: snapshotSchema,
    },
    {
      _meta: {
        'openai/outputTemplate': editTimelineResourceUri,
        ui: { resourceUri: editTimelineResourceUri },
      },
      annotations: readOnlyAnnotations,
      description: 'Render the interactive file edit timeline.',
      handlerId: 'render_edit_timeline',
      inputSchema: limitInputSchema,
      name: 'render_edit_timeline',
      outputSchema: snapshotSchema,
    },
    {
      _meta: {},
      annotations: readOnlyAnnotations,
      description: 'Read the current shared runtime state.',
      handlerId: 'runtime_status',
      inputSchema: z.object({}),
      name: 'runtime_status',
      outputSchema: z.object({
        editCount: z.number().int().nonnegative(),
        stateVersion: z.number().int().nonnegative(),
      }),
    },
  ],
};
