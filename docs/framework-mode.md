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
