# Framework mode

Structure lives in `agent-bundle.config.ts` and file conventions. JSX renders.
That is the whole model (RFC #63); RFC #50's entry conventions are the sibling
contract for `bin`/`lib`/MCP entries.

## What a newcomer must learn

Three things:

1. **One directory convention.** Every `skills/<name>/SKILL.md` ships as a
   Skill. Add a folder and it ships — no declaration anywhere.
2. **One flat config file.** `agent-bundle.config.ts` declares the plugin
   identity, targets, and anything a file cannot say for itself:

```ts
import { defineConfig } from 'agent-bundle';

export default defineConfig({
  plugin: { description: '…', name: 'my-plugin', version: '0.1.0' },
  targets: ['portable', 'codex', 'claude'],
});
```

3. **JSX = rendering.** React elements appear only where something is
   rendered: MCP/hook results at runtime (`Mcp.Result`, `Hook.Text`), and
   skill documents at build time (below). There are no structural JSX
   elements — no `<AgentBundle>`, `<Skill>`, or `<McpServer>`.

Entry files follow the same convention-with-fallback trick: `src/cli.ts` is
the package bin, `src/index.ts` the library, `src/mcp/<server-id>.ts` a
declared server's stdio entry — each applies when the file exists, and
explicit config always wins over a convention (`AB473x` nudges flag the
confusable shadowed states). See `docs/entry-conventions.md`.

## Applications with operations (when you have a CLI or MCP server)

`defineRscApplication` declares the runtime identity plus one typed operation
catalog; the conventional entries consume it:

```ts
// src/application.ts
export const application = defineRscApplication({
  name: 'my-plugin',
  operations: [status],
  version: '0.1.0',
});

// src/cli.ts
export const main = (argv: readonly string[]) => runRscCli(application, argv);

// src/mcp/runtime.ts
export default () => createRscMcpServer(application, 'runtime');
```

The server's structural declaration (`mcp.servers.runtime: {}`) lives in the
config; the name passed to `createRscMcpServer` only selects which operations
to serve.

## One operation, end to end

An **operation** is a host-neutral use-case definition: one named unit of
work with a validated input, an implementation, and a validated result. It
is *not* a CLI command — the CLI command and the MCP tool are optional
projections declared alongside the shared core, and either (or both) may be
present. The `status` operation used above looks like this in full,
including the JSX:

```tsx
// src/operations/status.tsx
import { defineOperation } from '@agent-bundle/rsc-runtime/plugin';
import { Mcp } from '@agent-bundle/rsc-runtime';
import { z } from 'zod';

export const status = defineOperation({
  // Shared core — both projections funnel through these four fields.
  id: 'status',
  inputSchema: z.object({ verbose: z.boolean().optional() }).strict(),
  execute: async () => ({ status: 'ready' as const }),
  resultSchema: z.object({ status: z.literal('ready') }).strict(),

  // CLI projection — argv parsing, help text, exit codes. No JSX: the CLI
  // prints the validated result as one line of JSON.
  cli: {
    name: 'status',
    parse: (args) => (args.includes('--verbose') ? { verbose: true } : {}),
    summary: 'Read runtime status.',
    usage: 'status [--verbose]',
  },

  // MCP projection — tool metadata plus the result renderer. `render` is
  // consumed only here.
  mcp: {
    description: 'Read runtime status.',
    name: 'runtime_status',
    readOnly: true,
    server: 'runtime',
  },
  render: (result) => (
    <Mcp.Result structuredContent={result}>
      <Mcp.Text>{`Runtime is ${result.status}.`}</Mcp.Text>
    </Mcp.Result>
  ),
});
```

Both projections run the identical pipeline —
`inputSchema.parse(input)` → `execute(input, { signal })` →
`resultSchema.parse(result)` — so inputs, implementation, and output
validation cannot drift between surfaces. Only the last step differs:

- **CLI** (`runRscCli`): `cli.parse(argv)` produces the input; the validated
  result is written to stdout as one line of JSON (`JSON.stringify`), and
  `cli.exitCode(result)` (default `0`) becomes the process exit code. The
  CLI never touches `render` and never renders JSX.
- **MCP** (`createRscMcpServer`): the tool handler calls `render(result)`
  and `lowerMcpResult` synchronously lowers the returned React element tree
  (`Mcp.Result`, `Mcp.Text`, `Mcp.Image`, `Mcp.Audio`, `Mcp.ResourceLink`,
  `Mcp.EmbeddedResource`) into a plain MCP `CallToolResult` object. The
  lowering is strict — `Mcp.Text` takes exactly one string child, hence the
  template literal above.

## Why `.tsx`, and what "RSC runtime" is not

Despite the package name, `@agent-bundle/rsc-runtime` is **not a React
Server Components renderer or runtime, and no Flight transport is
involved**. Nothing streams a component tree to a client, hydrates, or
holds server component state. What the MCP projection uses is an **MCP
result DSL**: `render` returns ordinary React elements, and
`lowerMcpResult` walks that tree synchronously — function components are
simply called — to produce the `CallToolResult` the MCP SDK sends. The
package owns no transport, persistence, or application state; those remain
explicit dependencies of `execute` implementations.

Operation modules are `.tsx` for exactly one reason: the `render` callback
returns JSX. Everything else in an operation — schemas, argv parsing, MCP
metadata — is plain TypeScript, and modules with no runtime JSX (such as an
application module that only composes operation arrays) stay `.ts`.

For a new reader, in one breath:

1. **What is an operation?** A host-neutral use-case definition — id, input
   schema, `execute`, result schema — with optional CLI and MCP projections.
2. **Which parts are shared by CLI and MCP?** The core four: `id`,
   `inputSchema`, `execute`, `resultSchema` (plus the validation pipeline
   around them).
3. **Which projection consumes `render`?** Only MCP. The CLI serializes the
   validated result as JSON.
4. **Is any React Server Components renderer or Flight transport
   involved?** No. `lowerMcpResult` is a synchronous element-tree lowering,
   not a renderer or transport.
5. **Why are operation modules `.tsx`?** Only because `render` returns JSX.

## Rendered skills (power tier, never required)

A skill whose document is generated: put `SKILL.tsx` (or `SKILL.ts`) in the
skill directory instead of `SKILL.md`. The module default-exports a component
and exports a `frontmatter` record; the build renders the tree to Markdown
and emits the `SKILL.md` every host consumes.

```tsx
// skills/deploy-checklist/SKILL.tsx
export const frontmatter = {
  description: 'Deployment checklist.',
  name: 'deploy-checklist',
};

export default () => (
  <>
    <h1>Deploy checklist</h1>
    <p>Verify each step <strong>in order</strong>.</p>
  </>
);
```

The renderer supports a documented element subset (`h1`–`h6`, `p`,
`ul`/`ol`/`li`, `strong`, `em`, `code`, `pre`, `blockquote`, `a`, `hr`,
`br`, fragments) and rejects anything outside it by name — never a silent
approximation. Components may be async, and may import project code, so the
document can be computed from the same sources the plugin ships. A
hand-authored `SKILL.md` in the same directory always wins (`AB4735`).

## Precedence, said once

Config wins, conventions fill. Declaring `skills:` in config replaces the
directory convention entirely (`AB4734` flags any directory left uncovered);
the same rule governs `bin`, `lib`, and MCP server entries.
