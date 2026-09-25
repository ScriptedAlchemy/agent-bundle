import { createElement, type ReactElement, type ReactNode } from 'react';
import * as renderer from 'rsc-markdown-stream';

import { Agent } from './elements.js';

// The renderer is bundled into dist and is not a dependency, so these types
// are declared here: shipped declarations cannot import 'rsc-markdown-stream'.
// The annotated re-exports below fail to compile if the renderer drifts.

export interface MarkdownSerializerHelpers {
  /** Render the element's children as inline markdown. */
  inline(): string;
  /** Render the element's children as block markdown (blocks joined by blank lines). */
  blocks(): string;
}

/**
 * Serializes one host element to markdown. The returned string is emitted
 * as its own block. Return `null`, `undefined`, or `''` to emit nothing.
 */
export type MarkdownSerializer = (
  props: Record<string, unknown>,
  helpers: MarkdownSerializerHelpers,
) => string | null | undefined;

export interface MarkdownOptions {
  /** Extra host tag names mapped to markdown serializers. Overrides built-ins. */
  components?: Record<string, MarkdownSerializer>;
}

/**
 * Render a React node tree to a ReadableStream<Uint8Array> of UTF-8 markdown
 * text. Blocks are emitted as they resolve, in document order.
 */
export const renderToMarkdownStream: (children: ReactNode, options?: MarkdownOptions) => ReadableStream<Uint8Array> =
  renderer.renderToMarkdownStream;

/** Render a React node tree to a markdown string. */
export const renderToMarkdown: (children: ReactNode, options?: MarkdownOptions) => Promise<string> =
  renderer.renderToMarkdown;

export interface MarkdownContentProps {
  /** JSX content rendered to GitHub Flavored Markdown. */
  readonly children: ReactNode;
  /** Extra host-tag serializers forwarded to `renderToMarkdown`. */
  readonly components?: MarkdownOptions['components'];
}

/**
 * Renders JSX children — headings, paragraphs, lists, GFM tables, task
 * lists, and nested sync or async components — to one GitHub Flavored
 * Markdown string through `rsc-markdown-stream`, lowered into
 * `Agent.Markdown`. Routes author rich Markdown blocks as JSX instead of
 * hand-concatenated strings, with Markdown punctuation in text escaped by
 * the renderer.
 *
 * The rendered block carries no trailing newline: Agent Document
 * projections own the blank-line joining between sibling blocks.
 */
export const MarkdownContent = async ({ children, components }: MarkdownContentProps): Promise<ReactElement> => {
  const markdown = await renderToMarkdown(children, components === undefined ? undefined : { components });
  return createElement(Agent.Markdown, null, markdown.replace(/\n+$/u, ''));
};
