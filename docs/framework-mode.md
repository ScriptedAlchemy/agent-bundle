# Framework mode

Agent Bundle has one newcomer model:

1. **Files under conventional `src/` roots are the app.** For MCP, put one
   module at `src/mcp/<server>/{tools,resources,prompts}/<name>.tsx`; its path
   is its identity. `skills/<name>/SKILL.md`, `src/scripts/<name>.ts`,
   `src/cli.ts`, and `src/index.ts` keep their existing conventions.
2. **One small flat config.** `agent-bundle.config.ts` holds project identity,
   targets, and policy that no route file can own.
3. **JSX = rendering.** An executable route is one async default Server
   Component. It does the work and returns `Agent.*`; there is no public
   `execute`/`render` split.
4. **Opt in to context.** Call `await agent()` inside that component only when
   host, session, actor, workspace, capability, or state context is needed.

The complete conventional config is usually:

```ts
import { defineConfig } from 'agent-bundle/config';

export default defineConfig({
  plugin: { description: 'Evidence-backed project tools.', name: 'my-plugin', version: '0.1.0' },
  targets: ['portable', 'codex', 'claude'],
});
```

A tool is one file:

```tsx
// src/mcp/runtime/tools/status.tsx
import React from 'react';
import type { ToolConfig, ToolRouteProps } from 'agent-bundle';
import { Agent, agent } from '@agent-bundle/runtime';
import { z } from 'zod';

export const config = {
  annotations: { readOnlyHint: true },
  description: 'Read runtime status.',
} satisfies ToolConfig;
export const inputSchema = z.object({ verbose: z.boolean().optional() }).strict();
export const resultSchema = z.object({ status: z.literal('ready') }).strict();

export default async function Status({ input, signal }: ToolRouteProps<typeof inputSchema>) {
  if (signal.aborted) throw new DOMException('aborted', 'AbortError');
  if (input.verbose) await agent();
  const result = { status: 'ready' as const };
  return <Agent.Result value={result}><Agent.Text>Runtime is ready.</Agent.Text></Agent.Result>;
}
```

The compiler statically reads `config`, imports schemas and implementations
only into generated entries, installs `runAgentRequest`, and derives the real
MCP server from the route graph. Each call renders through a warm internal
Flight dispatcher and lowers the final Agent Document to legal MCP output.
Flight is an implementation transport inside the generated runtime, never a
public host wire protocol.

Everything else is power-tier reference: custom/remote server modes and
collision recovery are in [Entry conventions](entry-conventions.md); accepted
static metadata, generated `.agent-bundle/routes.d.ts`, and diagnostics are in
[Diagnostics](diagnostics.md). Handwritten `src/mcp/<server>.ts`,
`defineOperation`, and `createRscMcpServer` remain supported escape hatches;
the handwritten `runRscCli` compatibility path still serializes validated
results and never renders JSX. Routed `src/cli/**` commands and
`src/scripts/**` scripts follow one sentence: `.tsx` renders through the
Agent renderer (TTY progress, piped Markdown, `--json`, `--ndjson`); `.ts`
is plain.
