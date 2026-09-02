# my-agent-plugin

A skills-only agent plugin built with [agent-bundle](https://github.com/ScriptedAlchemy/agent-bundle).
One `agent-bundle.config.ts` describes the plugin; the compiler emits installable
artifacts for Claude Code, Codex, and Cursor, plus a portable layout.

## Commands

```sh
npm run dev        # local workbench with live rebuilds
npm run build      # write host artifacts to artifact/
npm run check      # validate + build + typecheck + test
```

## Layout

- `agent-bundle.config.ts` — the one typed config.
- `src/skills/getting-started/` — a Skill: `SKILL.md` frontmatter plus optional
  `references/` and `assets/`. Every `src/skills/<name>/SKILL.md` directory is
  discovered automatically; add a folder and it ships.
- `tests/` — run with `npm run test`.

## Tests

`npm run test` runs ordinary module tests — here, one test that keeps the
Skill's frontmatter aligned with its directory — and `npm run check` runs them
after validate, build, and typecheck.

A skills-only project compiles no route modules, so the framework's consumer
harness (`agent-bundle/rstest` + `agent-bundle/test`) has nothing to render:
its route-unit pool would contain zero routes and pass unconditionally. This
template ships no such pool on purpose; a green run has to mean something.

Add one with the first route module — `src/mcp/<server>/tools/<name>.tsx` for
an MCP tool, `src/cli/**` for a routed CLI command:

```ts
// rstest.route-unit.config.ts
import { defineConfig } from '@rstest/core';
import { agentBundleRstest } from 'agent-bundle/rstest';

export default defineConfig(await agentBundleRstest());
```

```json
"test": "rstest tests --exclude \"tests/route-unit/**\"",
"test:routes": "rstest --config rstest.route-unit.config.ts"
```

Then `renderRoute` and `expectDocument` from `agent-bundle/test` assert the
document the route renders, at the `route-unit` proof level. Rendering also
needs `react` and `@agent-bundle/runtime`, which a project with route modules
already depends on. The `mcp-server` template ships that wiring, plus a second
pool at the `mcp-in-memory` level, as a working example.

## The agent-bundle dependency

agent-bundle has no npm release yet; this project pins a
[pkg.pr.new](https://pkg.pr.new) preview tarball of it. To move to a newer
preview (or a real release once one exists), change the `agent-bundle` entry
in `devDependencies` — see
[Preview packages](https://github.com/ScriptedAlchemy/agent-bundle/blob/main/docs/preview-packages.md)
for the URL forms.
