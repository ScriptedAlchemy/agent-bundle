import { MCP_APP_PROTOCOL_VERSION } from '../contracts/mcp-app-protocol.ts';
import { deepFreeze } from '../core/freeze.ts';

/** Browser-safe MCP App profile identity and descriptor registry. */
export { MCP_APP_PROTOCOL_VERSION };

export type McpAppProfileId = 'chatgpt' | 'claude' | 'portable';

/** @deprecated Use McpAppProfileId. */
export type McpAppHostProfile = McpAppProfileId;

export interface McpAppProfileDescriptor {
  readonly claimsRealHostParity: false;
  readonly evidence: 'simulated';
  readonly id: McpAppProfileId;
  readonly label: 'Portable MCP Apps' | 'ChatGPT Simulation' | 'Claude Simulation';
  readonly version:
    | 'agent-bundle:mcp-apps:2026-01-26'
    | 'agent-bundle:chatgpt-sim:1'
    | 'agent-bundle:claude-sim:1';
}

const portableProfileVersion = (`agent-bundle:mcp-apps:${MCP_APP_PROTOCOL_VERSION}`) as McpAppProfileDescriptor['version'];

export const MCP_APP_PROFILE_DESCRIPTORS: Readonly<Record<McpAppProfileId, McpAppProfileDescriptor>> = deepFreeze({
  chatgpt: {
    claimsRealHostParity: false,
    evidence: 'simulated',
    id: 'chatgpt',
    label: 'ChatGPT Simulation',
    version: 'agent-bundle:chatgpt-sim:1',
  },
  claude: {
    claimsRealHostParity: false,
    evidence: 'simulated',
    id: 'claude',
    label: 'Claude Simulation',
    version: 'agent-bundle:claude-sim:1',
  },
  portable: {
    claimsRealHostParity: false,
    evidence: 'simulated',
    id: 'portable',
    label: 'Portable MCP Apps',
    version: portableProfileVersion,
  },
});
