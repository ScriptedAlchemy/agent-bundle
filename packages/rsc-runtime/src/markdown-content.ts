import { createElement, type ReactElement, type ReactNode } from 'react';
import {
  renderToMarkdown,
  renderToMarkdownStream,
  type MarkdownOptions,
  type MarkdownSerializer,
  type MarkdownSerializerHelpers,
} from 'rsc-markdown-stream';

import { Agent } from './elements.js';

export { renderToMarkdown, renderToMarkdownStream };
export type { MarkdownOptions, MarkdownSerializer, MarkdownSerializerHelpers };

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
