// Compile-only check that the public types line up. Run via `pnpm typecheck`.
import { createElement } from 'react';

import {
  renderToMarkdown,
  renderToMarkdownStream,
  type MarkdownOptions,
  type MarkdownSerializer,
} from '../src/index.js';

const callout: MarkdownSerializer = (props, { inline, blocks }) =>
  `> [!${String(props['kind'] ?? 'NOTE')}]\n> ${inline()}${blocks() ? '' : ''}`;

const options: MarkdownOptions = { components: { callout } };

const node = createElement('p', null, 'hello');

const md: Promise<string> = renderToMarkdown(node, options);
const stream: ReadableStream<Uint8Array> = renderToMarkdownStream(node);

void md;
void stream;
