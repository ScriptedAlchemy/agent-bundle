import type { ReactNode } from 'react';

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
export function renderToMarkdownStream(
  children: ReactNode,
  options?: MarkdownOptions,
): ReadableStream<Uint8Array>;

/** Render a React node tree to a markdown string. */
export function renderToMarkdown(children: ReactNode, options?: MarkdownOptions): Promise<string>;
