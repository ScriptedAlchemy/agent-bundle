import type { McpAppJsonValue } from './mcp-app-binding-service.ts';
import type { McpAppConsentCapability } from './mcp-app-sandbox.ts';

export const createMcpAppConsentActionDigest = (
  capability: McpAppConsentCapability,
  details: McpAppJsonValue,
): string => `${capability}:${JSON.stringify(details)}`;
