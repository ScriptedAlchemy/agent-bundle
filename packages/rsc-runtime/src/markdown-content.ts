import { createElement, type ReactElement, type ReactNode } from 'react';
import {
  renderToMarkdown as renderToMarkdownImpl,
  renderToMarkdownStream as renderToMarkdownStreamImpl,
} from 'rsc-markdown-stream';

import { Agent } from './elements.js';

// `rsc-markdown-stream` is not published to npm, so it is a devDependency that
// Rslib inlines into this package's build (`autoExternal` bundles
// devDependencies) and consumers never install it. Its contract is therefore
// declared here instead of re-exported from a module the emitted `.d.ts`
// could not resolve; the typed assignments of `renderToMarkdown` and
// `renderToMarkdownStream` below stop compiling if the pinned upstream commit
// drifts from these declarations.

/** Helpers handed to a {@link MarkdownSerializer} for rendering the element's children. */
export interface MarkdownSerializerHelpers {
  /** Render the element's children as inline Markdown. */
  inline(): string;
  /** Render the element's children as block Markdown (blocks joined by blank lines). */
  blocks(): string;
}

/**
 * Serializes one host element to Markdown. The returned string is emitted as
 * its own block; return `null`, `undefined`, or `''` to emit nothing.
 */
export type MarkdownSerializer = (
  props: Record<string, unknown>,
  helpers: MarkdownSerializerHelpers,
) => string | null | undefined;

export interface MarkdownOptions {
  /** Extra host tag names mapped to Markdown serializers. Overrides built-ins. */
  readonly components?: Record<string, MarkdownSerializer>;
}

/** Renders a React node tree to one GitHub Flavored Markdown string. */
export const renderToMarkdown: (children: ReactNode, options?: MarkdownOptions) => Promise<string> =
  renderToMarkdownImpl;

/**
 * Renders a React node tree to a `ReadableStream<Uint8Array>` of UTF-8
 * Markdown text; blocks are emitted as they resolve, in document order.
 */
export const renderToMarkdownStream: (
  children: ReactNode,
  options?: MarkdownOptions,
) => ReadableStream<Uint8Array> = renderToMarkdownStreamImpl;

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
