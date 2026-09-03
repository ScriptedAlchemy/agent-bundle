import type { McpAppJsonValue } from './mcp-app-binding-service.ts';

/**
 * Consent capability vocabulary lives here, outside the sandbox module, so
 * the browser-safe contract surface never drags the sandbox's node:* imports
 * into a Workbench bundle.
 */
const mcpAppConsentCapabilities = ['call-tool', 'download-file', 'open-external-link', 'clipboard-write', 'camera', 'microphone', 'geolocation', 'request-display-mode'] as const;

export type McpAppConsentCapability = (typeof mcpAppConsentCapabilities)[number];

export const isMcpAppConsentCapability = (value: unknown): value is McpAppConsentCapability =>
  (mcpAppConsentCapabilities as readonly unknown[]).includes(value);

export const createMcpAppConsentActionDigest = (
  capability: McpAppConsentCapability,
  details: McpAppJsonValue,
): string => `${capability}:${JSON.stringify(details)}`;
