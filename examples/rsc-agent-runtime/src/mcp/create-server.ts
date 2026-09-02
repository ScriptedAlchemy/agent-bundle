import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { RESOURCE_MIME_TYPE, registerAppResource, registerAppTool } from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { runtimeDefinition } from '../definition.js';
import { projectName, projectVersion } from '../project-identity.js';
import { createMcpHandlers } from './handlers.js';
import { resourceMetadata } from './host-metadata.js';
import type { McpRequestExtra, ResolveStateOptions } from './resolve-state.js';

export interface CreateRuntimeMcpServerOptions extends ResolveStateOptions {
  publicMcpUrl?: string;
  widgetHtml?: string;
}

const defaultWidgetPath = (): string =>
  join(dirname(process.argv[1] ?? process.cwd()), '../../app/edit-timeline-v1.html');

const defaultWidgetHtml = async (): Promise<string> => readFile(defaultWidgetPath(), 'utf8');

export const createRuntimeMcpServer = (options: CreateRuntimeMcpServerOptions = {}): McpServer => {
  const server = new McpServer({ name: projectName, version: projectVersion });
  const handlers = createMcpHandlers(options);

  for (const tool of runtimeDefinition.tools) {
    const handler = handlers[tool.handlerId];
    if (handler === undefined) {
      throw new Error(`No MCP handler registered for ${tool.handlerId}`);
    }

    const callback = (input: unknown, extra: McpRequestExtra) =>
      handler(
        input !== null && typeof input === 'object' && typeof (input as { limit?: unknown }).limit === 'number'
          ? { limit: (input as { limit: number }).limit }
          : {},
        extra,
      );
    const config = {
      _meta: tool._meta,
      annotations: tool.annotations,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
    };

    if (tool._meta.ui !== undefined) {
      registerAppTool(server, tool.name, config, callback);
    } else {
      server.registerTool(tool.name, config, callback);
    }
  }

  for (const resource of runtimeDefinition.resources) {
    const registrationMetadata = resourceMetadata(resource);
    const contentMetadata = resourceMetadata(resource, options.publicMcpUrl);
    registerAppResource(
      server,
      resource.name,
      resource.uri,
      { _meta: registrationMetadata, mimeType: RESOURCE_MIME_TYPE },
      async () => ({
        contents: [
          {
            _meta: contentMetadata,
            mimeType: RESOURCE_MIME_TYPE,
            text: options.widgetHtml ?? (await defaultWidgetHtml()),
            uri: resource.uri,
          },
        ],
      }),
    );
  }

  return server;
};
