/**
 * Directional browser-envelope limits for a Runtime MCP App surface.
 *
 * App-originated messages remain deliberately small. Host results may contain
 * the self-contained App resource needed by the opaque child, so they have a
 * separately bounded, larger envelope. These limits do not apply to artifact
 * MCP App sandbox/frame transports.
 */
export const runtimeAppMessageLimits = Object.freeze({
  appToHostBytes: 256 * 1024,
  hostToAppBytes: 1024 * 1024,
} as const);
