import { describe, expect, it } from '@rstest/core';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { createElement, Fragment, use, type ReactNode } from 'react';

import { Agent, MarkdownContent, renderToMarkdown, renderToMarkdownStream } from '../src/index.js';

const e = createElement;

/**
 * Parses Markdown the way the Workbench displays it (`react-markdown` +
 * `remark-gfm` sit on micromark), so assertions describe what a reader
 * sees, not just which characters were emitted.
 */
const toHtml = (markdown: string): string =>
  micromark(markdown, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });

const markdownOf = async (children: ReactNode): Promise<string> => {
  const element = await MarkdownContent({ children });
  expect(element.type).toBe(Agent.Markdown);
  return (element.props as { children: string }).children;
};

const count = (haystack: string, needle: string): number => haystack.split(needle).length - 1;

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

/** Every element the runtime documents as supported, in one tree. */
const kitchenSink = e(
  Fragment,
  null,
  e('h1', null, 'Library audit'),
  e(
    'p',
    null,
    'Scanned ',
    e('strong', null, '2 files'),
    ' in ',
    e('em', null, '1 source'),
    '; ',
    e('del', null, '3'),
    ' 2 groups, see ',
    e('a', { href: 'https://example.test/docs', title: 'Docs' }, 'the docs'),
    ' and ',
    e('code', null, 'audit --fix'),
    '.',
  ),
  e('h2', null, 'Findings'),
  e(
    'ul',
    null,
    e('li', { key: 'dup' }, 'Duplicates', e('ul', null, e('li', { key: 'a' }, 'Shared title.flac'), e('li', { key: 'b' }, 'Shared title.mp3'))),
    e('li', { key: 'multi' }, 'Multipart'),
  ),
  e('ol', { start: 3 }, e('li', { key: 'a' }, 'third'), e('li', { key: 'b' }, 'fourth')),
  e(
    'ul',
    null,
    e('li', { key: 'done' }, e('input', { checked: true, readOnly: true, type: 'checkbox' }), ' verify'),
    e('li', { key: 'open' }, e('input', { readOnly: true, type: 'checkbox' }), ' review'),
  ),
  e('pre', null, e('code', { className: 'language-sh' }, 'agent-bundle audit --fix\n')),
  e('blockquote', null, e('p', null, 'Quoted ', e('em', null, 'note'), '.')),
  e(
    'table',
    null,
    e('caption', null, 'Measured files'),
    e('thead', null, e('tr', null, e('th', null, 'File'), e('th', { align: 'right' }, 'Bytes'), e('th', { align: 'center' }, 'Status'))),
    e('tbody', null, e('tr', null, e('td', null, 'a | b.m4b'), e('td', null, '12'), e('td', null, 'measured'))),
  ),
  e('hr'),
  e('div', null, e('section', null, e('p', null, 'Nested container text.'))),
  e('img', { alt: 'Cover art', src: '/cover.png' }),
);

const expectedKitchenSink = [
  '# Library audit',
  '',
  'Scanned **2 files** in *1 source*; ~~3~~ 2 groups, see [the docs](https://example.test/docs "Docs") and `audit --fix`.',
  '',
  '## Findings',
  '',
  '- Duplicates',
  '  - Shared title.flac',
  '  - Shared title.mp3',
  '- Multipart',
  '',
  '3. third',
  '4. fourth',
  '',
  '- [x] verify',
  '- [ ] review',
  '',
  '```sh',
  'agent-bundle audit --fix',
  '```',
  '',
  '> Quoted *note*.',
  '',
  'Measured files',
  '',
  '| File | Bytes | Status |',
  '| --- | ---: | :---: |',
  '| a \\| b.m4b | 12 | measured |',
  '',
  '---',
  '',
  'Nested container text.',
  '',
  '![Cover art](/cover.png)',
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
    await expect(markdownOf(measuredTable)).resolves.toBe(expectedTable);
  });

  it('renders every supported element and a GFM parser reads the same structure back', async () => {
    const markdown = await markdownOf(kitchenSink);
    expect(markdown).toBe(expectedKitchenSink);

    const html = toHtml(markdown);
    expect(html).toContain('<h1>Library audit</h1>');
    expect(html).toContain('Scanned <strong>2 files</strong> in <em>1 source</em>; <del>3</del> 2 groups');
    expect(html).toContain('<a href="https://example.test/docs" title="Docs">the docs</a>');
    expect(html).toContain('<code>audit --fix</code>');
    expect(html).toContain('<h2>Findings</h2>');
    expect(html).toContain('<li>Duplicates\n<ul>\n<li>Shared title.flac</li>\n<li>Shared title.mp3</li>\n</ul>\n</li>');
    expect(html).toContain('<ol start="3">\n<li>third</li>\n<li>fourth</li>\n</ol>');
    expect(html).toContain('<li><input type="checkbox" disabled="" checked="" /> verify</li>');
    expect(html).toContain('<li><input type="checkbox" disabled="" /> review</li>');
    expect(html).toContain('<pre><code class="language-sh">agent-bundle audit --fix\n</code></pre>');
    expect(html).toContain('<blockquote>\n<p>Quoted <em>note</em>.</p>\n</blockquote>');
    expect(html).toContain('<p>Measured files</p>');
    expect(html).toContain('<th align="right">Bytes</th>');
    expect(html).toContain('<th align="center">Status</th>');
    expect(html).toContain('<td>a | b.m4b</td>');
    expect(html).toContain('<hr />');
    expect(html).toContain('<p>Nested container text.</p>');
    expect(html).toContain('<img src="/cover.png" alt="Cover art" />');
    expect(count(html, '<table>')).toBe(1);
    expect(count(html, '<ul>')).toBe(3);
    expect(count(html, '<ol')).toBe(1);
    expect(html).not.toMatch(/<(div|section|span|caption)[\s>]/u);
  });

  it('keeps hostile text literal: no accidental emphasis, links, entities, or block markers', async () => {
    const markdown = await markdownOf(
      e(
        Fragment,
        null,
        e('p', null, '*stars* _under_ snake_case [x] <tag> &amp; ~~tilde~~ `tick`'),
        e('p', null, '- not a bullet'),
        e('p', null, '# not a heading'),
        e('p', null, '1. not an item'),
        e('p', null, '> not a quote'),
        e('p', null, '---'),
      ),
    );
    expect(toHtml(markdown)).toBe(
      [
        '<p>*stars* _under_ snake_case [x] &lt;tag&gt; &amp;amp; ~~tilde~~ `tick`</p>',
        '<p>- not a bullet</p>',
        '<p># not a heading</p>',
        '<p>1. not an item</p>',
        '<p>&gt; not a quote</p>',
        '<p>---</p>',
      ].join('\n'),
    );
  });

  it('keeps sibling lists apart, drops edge hard breaks, and preserves trailing # in headings', async () => {
    const markdown = await markdownOf(
      e(
        Fragment,
        null,
        e('ul', null, e('li', null, 'a')),
        e('ul', null, e('li', null, 'b')),
        e('p', null, 'line', e('br')),
        e('h2', null, 'Chapter 1 #'),
      ),
    );
    expect(markdown).toBe('- a\n\n* b\n\nline\n\n## Chapter 1 \\#');
    expect(toHtml(markdown)).toBe(
      '<ul>\n<li>a</li>\n</ul>\n<ul>\n<li>b</li>\n</ul>\n<p>line</p>\n<h2>Chapter 1 #</h2>',
    );
  });

  it('resolves async components and React.use inside the content', async () => {
    const data = Promise.resolve(['one', 'two']);
    const UsesData = () => {
      const items = use(data);
      return e('ul', null, items.map((item) => e('li', { key: item }, item)));
    };
    const AsyncNote = async () => {
      await Promise.resolve();
      return e('p', null, 'async note');
    };
    await expect(markdownOf(e(Fragment, null, e(AsyncNote), e(UsesData)))).resolves.toBe(
      'async note\n\n- one\n- two',
    );
  });

  it('forwards custom host-tag serializers', async () => {
    const element = await MarkdownContent({
      children: e('callout', { kind: 'NOTE' }, 'Mind the ', e('b', null, 'gap'), '.'),
      components: {
        callout: (props, { inline }) => `> [!${String(props['kind'])}]\n> ${inline()}`,
      },
    });
    expect((element.props as { children: string }).children).toBe('> [!NOTE]\n> Mind the **gap**.');
  });

  it('streams the same Markdown block by block', async () => {
    const chunks: string[] = [];
    const decoder = new TextDecoder();
    for await (const chunk of renderToMarkdownStream(kitchenSink)) {
      chunks.push(decoder.decode(chunk, { stream: true }));
    }
    expect(chunks.length).toBeGreaterThan(3);
    expect(chunks.join('')).toBe(`${expectedKitchenSink}\n`);
  });

  it('renders an empty block for empty content', async () => {
    await expect(markdownOf(null)).resolves.toBe('');
  });
});
