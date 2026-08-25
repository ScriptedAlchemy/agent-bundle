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
