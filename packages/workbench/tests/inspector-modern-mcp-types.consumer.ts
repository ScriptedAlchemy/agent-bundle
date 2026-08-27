// @ts-expect-error Inspector no longer exposes the legacy SSE config type.
import type { SseServerConfig } from '../src/inspector/vendor/core/mcp/types.js';

import type {
  MCPServerConfig,
  ServerType,
} from '../src/inspector/vendor/core/mcp/types.js';

const stdio: MCPServerConfig = {
  command: 'node',
};

const streamableHttp: MCPServerConfig = {
  type: 'streamable-http',
  url: 'https://mcp.example.test',
};

const serverType: ServerType = 'streamable-http';

declare const removedSseConfig: SseServerConfig;

const legacySse: MCPServerConfig = {
  // @ts-expect-error Inspector does not accept legacy SSE server configurations.
  type: 'sse',
  url: 'https://mcp.example.test',
};

// @ts-expect-error Inspector's transport discriminator excludes legacy SSE.
const legacyServerType: ServerType = 'sse';

void [stdio, streamableHttp, serverType, removedSseConfig, legacySse, legacyServerType];
