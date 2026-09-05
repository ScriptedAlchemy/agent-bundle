import { sha256Hex } from './digest.ts';

const safeStateSegment = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/u;

/**
 * Converts an arbitrary MCP server name into one safe state-directory segment.
 * Plain segments remain readable; unsafe names become content-addressed.
 */
export const mcpServerStateDirectory = (server: string): string =>
  safeStateSegment.test(server) ? server : `server-${sha256Hex(server).slice(0, 16)}`;
