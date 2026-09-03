import { describe, expect, it } from '@rstest/core';
import { createElement } from 'react';

import { Agent, MarkdownContent, renderToMarkdown } from '../src/index.js';

const e = createElement;

interface RowProps {
  readonly bytes: number;
  readonly label: string;
}

/** An async component: the renderer awaits it exactly like a server component. */
const Row = async ({ bytes, label }: RowProps) =>
  e('tr', null, e('td', null, label), e('td', null, String(bytes)));

const measuredTable = e(
  'table',
  null,
  e('thead', null, e('tr', null, e('th', null, 'File'), e('th', null, 'Bytes'))),
  e(
    'tbody',
    null,
    e(Row, { bytes: 12, key: 'a', label: 'a.m4b' }),
    e(Row, { bytes: 34, key: 'b', label: 'b.m4b' }),
  ),
);

const expectedTable = [
  '| File | Bytes |',
  '| --- | --- |',
  '| a.m4b | 12 |',
  '| b.m4b | 34 |',
].join('\n');

describe('markdown content rendering', () => {
  it('renders a GFM table from JSX with async row components', async () => {
    await expect(renderToMarkdown(measuredTable)).resolves.toBe(`${expectedTable}\n`);
  });

  it('renders GFM task lists and escapes Markdown punctuation in text', async () => {
    const tree = e(
      'ul',
      null,
      e('li', { key: 'done' }, e('input', { checked: true, readOnly: true, type: 'checkbox' }), ' verify *stars*'),
      e('li', { key: 'open' }, e('input', { readOnly: true, type: 'checkbox' }), ' review [brackets]'),
    );
    await expect(renderToMarkdown(tree)).resolves.toBe(
      '- [x] verify \\*stars\\*\n- [ ] review \\[brackets\\]\n',
    );
  });

  it('lowers JSX children into one Agent.Markdown block without a trailing newline', async () => {
    const element = await MarkdownContent({ children: measuredTable });
    expect(element.type).toBe(Agent.Markdown);
    expect((element.props as { children: string }).children).toBe(expectedTable);
  });
});
