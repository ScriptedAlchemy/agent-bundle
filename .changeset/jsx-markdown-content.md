---
"@agent-bundle/runtime": minor
---

Add the async `MarkdownContent` component and re-export `renderToMarkdown` /
`renderToMarkdownStream` from `rsc-markdown-stream`, so routes author rich
Markdown blocks — GFM tables, task lists, nested async components, escaped
text — as JSX lowered into `Agent.Markdown` instead of hand-concatenated
strings.
