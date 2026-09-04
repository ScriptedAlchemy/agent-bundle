import { resolveStream } from './resolve.js';
import { BlockGrouper, streamMode } from './serialize.js';

async function* markdownBlocks(children, options) {
  const opts = options ?? {};
  const grouper = new BlockGrouper(opts);
  const config = { hostMode: (tag) => streamMode(tag, opts) };
  for await (const node of resolveStream(children, null, config)) {
    yield* grouper.push(node);
  }
  yield* grouper.end();
}

/**
 * Render a React node tree to a ReadableStream<Uint8Array> of UTF-8
 * markdown text. Blocks are emitted as they resolve, in document order.
 */
export function renderToMarkdownStream(children, options) {
  const blocks = markdownBlocks(children, options);
  const encoder = new TextEncoder();
  let first = true;
  return new ReadableStream({
    async pull(controller) {
      const { value, done } = await blocks.next();
      if (done) {
        if (!first) controller.enqueue(encoder.encode('\n'));
        controller.close();
      } else {
        controller.enqueue(encoder.encode((first ? '' : '\n\n') + value));
        first = false;
      }
    },
    cancel() {
      blocks.return();
    },
  });
}

/**
 * Render a React node tree to a markdown string.
 */
export async function renderToMarkdown(children, options) {
  const out = [];
  for await (const block of markdownBlocks(children, options)) out.push(block);
  return out.length === 0 ? '' : out.join('\n\n') + '\n';
}
