# `@agent-bundle/rsc-runtime`

Small React primitives for producing Agent Bundle hook and MCP protocol results with JSX.

```tsx
import { Mcp, lowerMcpResult } from '@agent-bundle/rsc-runtime';

const result = lowerMcpResult(
  <Mcp.Result structuredContent={{ status: 'ready' }}>
    <Mcp.Text>Ready.</Mcp.Text>
  </Mcp.Result>,
);
```

The package exports `Hook`, `Mcp`, `lowerHookResult`, `lowerMcpResult`, and
`createRscRequestContext`. It does not own an RSC renderer, application state,
transport, persistence, or host packaging. React 19 is a peer dependency and Node
22.19 or newer is required.

Structured MCP metadata and content are copied through a strict finite-JSON
boundary before being returned, so later caller mutations do not alter a result.

## Complete plugin applications

The `@agent-bundle/rsc-runtime/plugin` entry defines an Agent Bundle application
once and derives its compiler configuration, CLI commands, and MCP tool catalog
from the same typed operation registry:

```tsx
import {
  AgentBundle,
  McpServer,
  Operation,
  Script,
  Skill,
  defineOperation,
  defineRscAgentBundle,
} from '@agent-bundle/rsc-runtime/plugin';
import { Mcp } from '@agent-bundle/rsc-runtime';
import { z } from 'zod';

const inputSchema = z.object({}).strict();
const resultSchema = z.object({ status: z.literal('ready') }).strict();

const status = defineOperation({
  cli: {
    name: 'status',
    parse: () => ({}),
    summary: 'Read status.',
    usage: 'status',
  },
  execute: async () => ({ status: 'ready' as const }),
  id: 'status',
  inputSchema,
  mcp: {
    description: 'Read status.',
    name: 'runtime_status',
    readOnly: true,
    server: 'runtime',
  },
  render: (result) => (
    <Mcp.Result structuredContent={result}>
      <Mcp.Text>Ready.</Mcp.Text>
    </Mcp.Result>
  ),
  resultSchema,
});

export const application = defineRscAgentBundle(
  <AgentBundle name="example" targets={['claude', 'codex']} version="1.0.0">
    <Skill source="./skills/example" />
    <Script entry="./src/cli-entry.ts" name="example" />
    <McpServer entry="./src/mcp-server.ts" name="runtime" />
    <Operation definition={status} />
  </AgentBundle>,
);
```

Export `application.config` from `agent-bundle.config.ts`, use
`runRscCli(application, argv)` for the executable, and use
`createRscMcpServer(application, 'runtime')` for stdio MCP. Operation inputs,
implementations, output validation, and result renderers cannot drift between the
two surfaces. Definition lowering rejects duplicate ownership and references to
undeclared MCP servers before Agent Bundle compilation begins.

This layer intentionally does not own transport persistence or application
state. Those remain explicit dependencies of operation implementations.
