# rsc-markdown-stream

## 0.1.2

### Patch Changes

- 04e1616: Update third-party dependencies: `agent-bundle` now compiles with `@rsbuild/core` 2.2.5, lints with `@rslint/core` 0.9.2, loads `agent-bundle.config.ts` through `@rstackjs/load-config` 1.0.0, and reads emitted-module imports for `validate --artifact` (`AB6005`) with `es-module-lexer` 3.0.2 (`ignore` 7.0.9 and `yaml` 2.9.1 also move); `create-agent-bundle` prompts with `@clack/prompts` 1.8.1; every package is now built and tested against React 19.3.0, `@types/react` 19.3.0, and `@types/node` 26.5.1. `zod` stays at 4.5.4: `@agent-bundle/runtime` declares `zod` as a `^4.5.4` peer and its dev pin proves that floor, and zod brands schemas by minor version, so every workspace package must share one minor. (#798)

## 0.1.1

### Patch Changes

- 2e91ea1: Add the async `MarkdownContent` component and the `renderToMarkdown` /
  `renderToMarkdownStream` exports to `@agent-bundle/runtime`, so routes author
  rich Markdown blocks — headings, lists, GFM tables, task lists, nested async
  components, escaped text — as JSX lowered into `Agent.Markdown` instead of
  hand-concatenated strings. The renderer behind them, `rsc-markdown-stream`, is
  now a package of this repository and is published from it (it was previously
  only installable from its git URL), so `@agent-bundle/runtime` depends on it
  by version. `agent-bundle build` now follows symlinked (workspace) dependencies
  transitively when attributing bundle provenance, resolving each one the way
  Node does, so a project whose linked dependency links another package —
  including one hoisted to an ancestor `node_modules` — no longer fails with
  `AB5000`, and a dependency that links back onto the project never hides the
  project's own sources from provenance. (#344)
- 8c8907e: Expose `./package.json` in the `exports` of `agent-bundle`, `rsc-markdown-stream`, and `create-agent-bundle`. `create-agent-bundle` gains its first `exports` map, so `create-agent-bundle/dist/**` deep imports no longer resolve — the CLI is reachable only through its `bin`, which is the breaking change behind its minor bump. Bound `agent-bundle`'s optional `@agent-bundle/runtime` peer to `>=0.0.0 <1` instead of `*`; drop `@modelcontextprotocol/server` from `agent-bundle`'s devDependencies (it stays a dependency) and the dead `!dist/workbench/**/*.map` entry from its `files`; gate releases on `attw --profile esm-only` for all three packed tarballs plus `scripts/check-declaration-imports.mjs`, which fails `pnpm lint:release` when a shipped `.d.ts` a consumer can reach imports a devDependency, an undeclared package, an unexported subpath of the package itself, or a `#` import its `imports` map does not resolve. (#568)
