import type { ClientCapabilities, Resource, Tool } from '@modelcontextprotocol/client';

import {
  MCP_APP_MIME_TYPE,
  MCP_APP_UI_EXTENSION,
} from './mcp-app-bridge.ts';
import type {
  McpAppBridgeResource,
  McpAppBridgeTool,
  McpAppJsonValue,
  McpAppToolDefinition,
} from './mcp-app-binding-service.ts';
import { requireMcpAppJson } from './mcp-app-json.ts';
import { isRecord } from '../core/strict-json.ts';

/** Advertised on initialize so servers can discover the workbench's MCP Apps support. */
export const mcpAppClientCapabilities = {
  extensions: {
    [MCP_APP_UI_EXTENSION]: {
      mimeTypes: [MCP_APP_MIME_TYPE],
    },
  },
} satisfies ClientCapabilities;

export const canonicalMcpAppJson = (value: unknown, label: string): McpAppJsonValue =>
  requireMcpAppJson(value, `${label} must contain only ordinary finite JSON values.`);

const appVisible = (definition: McpAppJsonValue): boolean => {
  if (!isRecord(definition)) return true;
  const metadata = definition._meta;
  if (!isRecord(metadata)) return true;
  const ui = metadata.ui;
  if (!isRecord(ui) || !Object.hasOwn(ui, 'visibility')) return true;
  const visibility = ui.visibility;
  return Array.isArray(visibility) && visibility.every((capability) => typeof capability === 'string') &&
    visibility.some((capability) => capability === 'app');
};

export const canonicalMcpAppTool = (tool: Tool): McpAppBridgeTool => {
  const definition = canonicalMcpAppJson(tool, 'MCP App tool definition');
  if (!isRecord(definition) || typeof definition.name !== 'string' || definition.name.trim().length === 0) {
    throw new TypeError('MCP App tool definition must have a nonempty name.');
  }
  return Object.freeze({
    appVisible: appVisible(definition),
    definition: definition as McpAppToolDefinition,
    name: definition.name,
  });
};

export const canonicalMcpAppResource = (resource: Resource): McpAppBridgeResource => {
  const definition = canonicalMcpAppJson(resource, 'MCP App resource definition');
  if (!isRecord(definition) || typeof definition.uri !== 'string' || definition.uri.trim().length === 0) {
    throw new TypeError('MCP App resource definition must have a nonempty URI.');
  }
  return Object.freeze({ appVisible: appVisible(definition), uri: definition.uri });
};
