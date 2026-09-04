# rsc-markdown-stream

Render React / RSC trees to **Markdown**, never HTML.

This is a custom renderer in the spirit of [rsc-html-stream](https://github.com/devongovett/rsc-html-stream), but for the other half of the job: where you would normally hand your tree to `renderToReadableStream` from `react-dom/server`, hand it to `renderToMarkdownStream` instead and get a stream of GitHub Flavored Markdown. No HTML is ever produced, no RSC payload is injected, nothing hydrates — markdown *is* the output.

Zero dependencies. `react` is the only peer (v19+). `react-dom` is not in the dependency graph at all.

## Usage

```js
import {renderToMarkdown} from 'rsc-markdown-stream';

let md = await renderToMarkdown(<Article />);
// "# Hello\n\nSome **bold** text...\n"
```

Streaming, parallel to the SSR setup you already know — consume an RSC stream and render it to markdown instead of HTML:

```js
import {renderToReadableStream} from 'react-server-dom-BUNDLER/server.edge';
import {createFromReadableStream} from 'react-server-dom-BUNDLER/client.edge';
import {renderToMarkdownStream} from 'rsc-markdown-stream';

let rscStream = renderToReadableStream(<App />);

let data;
function Content() {
  data ??= createFromReadableStream(rscStream);
  return React.use(data);
}

let markdownStream = renderToMarkdownStream(<Content />);
// ReadableStream<Uint8Array> of UTF-8 markdown, emitted block by block
```

## Where it runs in agent-bundle

This package is the renderer behind `MarkdownContent` in
[`@agent-bundle/runtime`](../rsc-runtime/README.md): routes author headings, lists, and GFM tables
as JSX, and the runtime lowers the rendered Markdown into an `Agent.Markdown` node inside a real
React Flight request compiled under the `react-server` condition. The upstream repository,
[ScriptedAlchemy/rsc-markdown-stream](https://github.com/ScriptedAlchemy/rsc-markdown-stream),
keeps a standalone Rsbuild example of the full pipeline — an RSC server writing raw Flight bytes
to stdout, a consumer decoding them with `react-server-dom-webpack/client` and handing the tree to
`renderToMarkdownStream` — plus a browser demo; neither ships with this package.

Markdown blocks stream out progressively as each server component's data resolves: the header
arrives first, a table next, the slower subtrees last — the same progressive behavior you'd get
from streaming HTML SSR, but the output is markdown.

## shadcn/ui to markdown

Component-library trees — Radix primitives, cva variants, lucide icons and all — render to markdown surprisingly well (the upstream example renders a shadcn/ui dashboard this way):

- shadcn's `Table` components are real `<table>` elements underneath, so they come out as GFM tables.
- Radix `Checkbox` renders a hidden `<input type="checkbox">` for form interop — inside `<li>` that becomes a GFM task list (`- [x]`).
- Radix `AccordionTrigger` lives inside an `<h3>` header, so triggers become real markdown headings; collapsed content and inactive `TabsContent` are unmounted by Radix and produce nothing, while the `defaultValue` panel renders.
- Radix state/hooks (`useState`, `useId`, context) run on the renderer's built-in dispatcher in their initial, uncontrolled state. Portal-based components (Dialog, Popover, Tooltip) are the ones that won't work.
- Styled containers (Card, Alert, Button) flatten to plain text blocks — map `button` to a custom serializer via `options.components` to keep adjacent button labels from running together.

### How this relates to rsc-html-stream

[rsc-html-stream](https://github.com/devongovett/rsc-html-stream) does not render anything: it is a ~130-line transport that interleaves Flight bytes into an HTML stream as `<script>` tags (server) and reassembles them into a `ReadableStream` for hydration (client). In that stack, the actual rendering is done by `react-dom/server` (HTML) and `react-server-dom-*` (Flight). This library replaces the `react-dom/server` leg with a renderer that emits markdown — and since markdown output never hydrates, no transport/injection layer is needed at all: the Flight stream is consumed once, on the server side of your pipeline.

## API

- `renderToMarkdownStream(children, options?)` → `ReadableStream<Uint8Array>` — markdown text, streamed a block at a time as components resolve, in document order.
- `renderToMarkdown(children, options?)` → `Promise<string>`.

`options.components` maps extra host tag names to serializers, and can also override the built-ins. A serializer gets `(props, {inline, blocks})` and returns a markdown block:

```js
await renderToMarkdown(<callout kind="WARNING">Mind the gap.</callout>, {
  components: {
    callout: (props, {inline}) => `> [!${props.kind}]\n> ${inline()}`,
  },
});
```

## What renders to what

| React | Markdown |
| --- | --- |
| `h1`…`h6` | `#`…`######` headings |
| `p` | paragraph |
| `strong` / `b`, `em` / `i`, `del` / `s` | `**bold**`, `*italic*`, `~~strike~~` |
| `code` | `` `inline code` `` (nested backticks handled) |
| `pre` (+ `code className="language-js"`) | fenced code block with language |
| `a`, `img` | `[text](href "title")`, `![alt](src)` |
| `ul` / `ol` / `li` | lists, nested lists, `start` offsets; adjacent sibling lists alternate markers (`-`/`*`, `1.`/`1)`) so they don't merge |
| `blockquote` | `>` quoted blocks |
| `hr`, `br` | `---`, hard break (dropped at paragraph edges, where it would be a literal backslash) |
| `input type="checkbox"` (in `li`) | GFM task list items `- [x]` / `- [ ]` |
| `table` / `thead` / `tbody` / `tr` / `th` / `td` | GFM tables with alignment, `colSpan` padding; `caption` becomes the paragraph above |
| `dl` / `dt` / `dd` | terms and definitions as paragraphs |
| `div`, `section`, `article`, … | passthrough as blocks |
| `span`, unknown tags | passthrough inline — HTML tags are never emitted |
| `script`, `style`, `template`, `noscript`, `head`, `title`, `meta`, `link` | nothing |

Function and class components are invoked, async components and promise children are awaited, and `React.use`, `useState`, `useContext` and friends work via a minimal built-in hooks dispatcher (effects never run; state stays at its initial value, like any server render). Fragments, arrays, iterables, `Suspense` (content is always awaited; fallbacks never render), `Activity` (hidden mode renders nothing), `ViewTransition`, `lazy`, `memo`, `forwardRef` and context providers are all handled.

Markdown punctuation in text is escaped where it would change meaning (`*`, `_` except between word characters, `~`, `[`, `<`, backticks, entity-like `&amp;`, list/heading markers at line start, a heading's trailing `#`, …) and never inside `code` / `pre`. Nesting an emphasis inside the same emphasis is a no-op rather than an upgrade to strong. Blocks are separated by exactly one blank line.

Streaming is real, not cosmetic: pass-through containers (`div`, `article`, `section`, …) stream their children block by block instead of buffering the subtree, so a slow component at the bottom of a layout never delays the blocks above it. Sibling subtrees resolve concurrently (like React) while output stays in document order. Only leaf blocks (`p`, `pre`, `table`, list, heading, blockquote — and any tag with a custom serializer) buffer their own subtree, since their markdown can't be emitted piecemeal.

## Out of scope, on purpose

- No HTML output, ever — this is not React → HTML → markdown; the tree is walked directly.
- No RSC payload injection, no `<script>` tags, no hydration. If you want those, that's [rsc-html-stream](https://github.com/devongovett/rsc-html-stream) + `react-dom/server`.
- No bundler integration: feed it React elements (e.g. from `createFromReadableStream`) and it emits markdown.

## Working in the workspace

```sh
pnpm --filter rsc-markdown-stream build       # Rslib: src/index.js → dist/index.js (+ dist/index.d.ts)
pnpm --filter rsc-markdown-stream typecheck   # the public types and the test suite
pnpm exec rstest --config rstest.unit.config.ts packages/rsc-markdown-stream/tests
```

The suite lives under `tests/` and runs in the repository's unit pool; `tests/react-server.test.ts`
spawns Node with `--conditions react-server` and runs in the integration pool
(`pnpm test:integration:run`). `@agent-bundle/runtime`'s
`tests/markdown-content-flight.test.ts` proves the built package inside a real Flight request.

## License

Apache-2.0, like the rest of the agent-bundle repository (see `LICENSE` and `NOTICE`). The
package was imported from
[ScriptedAlchemy/rsc-markdown-stream](https://github.com/ScriptedAlchemy/rsc-markdown-stream)
at commit `eba2ea0b930493b80b9f4f9bb2c582041b0a3f47`, where it was distributed under the MIT
License; that notice is preserved as `UPSTREAM-LICENSE`.
