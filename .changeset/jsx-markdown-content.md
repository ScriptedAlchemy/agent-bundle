---
"@agent-bundle/runtime": patch
---

Add the async `MarkdownContent` component and the `renderToMarkdown` /
`renderToMarkdownStream` exports to `@agent-bundle/runtime`, so routes author
rich Markdown blocks — headings, lists, GFM tables, task lists, nested async
components, escaped text — as JSX lowered into `Agent.Markdown` instead of
hand-concatenated strings. The renderer (`rsc-markdown-stream`) is bundled
into the package build, so installing `@agent-bundle/runtime` adds no git
dependency. (#344)
