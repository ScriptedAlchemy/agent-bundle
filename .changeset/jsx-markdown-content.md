---
"@agent-bundle/runtime": patch
"rsc-markdown-stream": patch
"agent-bundle": patch
---

Add the async `MarkdownContent` component and the `renderToMarkdown` /
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
