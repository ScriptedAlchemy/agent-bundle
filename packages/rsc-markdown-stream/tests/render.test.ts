import { expect, it } from '@rstest/core';
import { createElement as h, Fragment } from 'react';
import { renderToMarkdown } from '../src/index.js';

it('headings', async () => {
  const md = await renderToMarkdown(
    h(Fragment, null, h('h1', null, 'One'), h('h2', null, 'Two'), h('h6', null, 'Six')),
  );
  expect(md).toBe('# One\n\n## Two\n\n###### Six\n');
});

it('paragraphs and emphasis', async () => {
  const md = await renderToMarkdown(
    h(
      Fragment,
      null,
      h('p', null, 'Some ', h('strong', null, 'bold'), ' and ', h('em', null, 'italic'), '.'),
      h('p', null, h('del', null, 'gone'), ' but not forgotten'),
    ),
  );
  expect(md).toBe('Some **bold** and *italic*.\n\n~~gone~~ but not forgotten\n');
});

it('links and images', async () => {
  const md = await renderToMarkdown(
    h(
      'p',
      null,
      'See ',
      h('a', { href: 'https://example.com', title: 'Example' }, 'the docs'),
      ' and ',
      h('img', { src: '/cat.png', alt: 'a cat' }),
      '.',
    ),
  );
  expect(md).toBe('See [the docs](https://example.com "Example") and ![a cat](/cat.png).\n');
});

it('link without title, bare text passthrough', async () => {
  const md = await renderToMarkdown(
    h('p', null, h('a', { href: '/about' }, 'About'), ' ', h('a', null, 'no href')),
  );
  expect(md).toBe('[About](/about) no href\n');
});

it('inline code with nested backticks', async () => {
  const md = await renderToMarkdown(
    h('p', null, 'Run ', h('code', null, 'npm test'), ' or ', h('code', null, 'a `b` c')),
  );
  expect(md).toBe('Run `npm test` or ``a `b` c``\n');
});

it('nested lists', async () => {
  const md = await renderToMarkdown(
    h(
      'ul',
      null,
      h(
        'li',
        null,
        'Fruit',
        h('ul', null, h('li', null, 'Apples'), h('li', null, 'Bananas')),
      ),
      h('li', null, 'Vegetables'),
    ),
  );
  expect(md).toBe('- Fruit\n  - Apples\n  - Bananas\n- Vegetables\n');
});

it('ordered list with start index', async () => {
  const md = await renderToMarkdown(
    h('ol', { start: 3 }, h('li', null, 'three'), h('li', null, 'four')),
  );
  expect(md).toBe('3. three\n4. four\n');
});

it('fenced code with language', async () => {
  const md = await renderToMarkdown(
    h('pre', null, h('code', { className: 'language-js' }, 'const x = 1;\nconsole.log(x);\n')),
  );
  expect(md).toBe('```js\nconst x = 1;\nconsole.log(x);\n```\n');
});

it('fenced code containing backtick fences grows the fence', async () => {
  const md = await renderToMarkdown(h('pre', null, h('code', null, '```\ninner\n```')));
  expect(md).toBe('````\n```\ninner\n```\n````\n');
});

it('blockquote with multiple blocks', async () => {
  const md = await renderToMarkdown(
    h('blockquote', null, h('p', null, 'First line.'), h('p', null, 'Second line.')),
  );
  expect(md).toBe('> First line.\n>\n> Second line.\n');
});

it('table with alignment', async () => {
  const md = await renderToMarkdown(
    h(
      'table',
      null,
      h('thead', null, h('tr', null, h('th', null, 'Name'), h('th', { align: 'right' }, 'Qty'))),
      h(
        'tbody',
        null,
        h('tr', null, h('td', null, 'Apples'), h('td', null, '3')),
        h('tr', null, h('td', null, h('em', null, 'Pears')), h('td', null, '12')),
      ),
    ),
  );
  expect(md).toBe('| Name | Qty |\n| --- | ---: |\n| Apples | 3 |\n| *Pears* | 12 |\n');
});

it('hr and br', async () => {
  const md = await renderToMarkdown(
    h(Fragment, null, h('p', null, 'line one', h('br'), 'line two'), h('hr')),
  );
  expect(md).toBe('line one\\\nline two\n\n---\n');
});

it('escapes markdown punctuation in text', async () => {
  const md = await renderToMarkdown(h('p', null, 'literal *stars*, [brackets] and `ticks`'));
  expect(md).toBe('literal \\*stars\\*, \\[brackets\\] and \\`ticks\\`\n');
});

it('does not escape inside code', async () => {
  const md = await renderToMarkdown(
    h(Fragment, null, h('p', null, h('code', null, 'a[i] * b')), h('pre', null, '*raw* [text]')),
  );
  expect(md).toBe('`a[i] * b`\n\n```\n*raw* [text]\n```\n');
});

it('escapes text that would start a block construct', async () => {
  const md = await renderToMarkdown(h('p', null, '- not a list item'));
  expect(md).toBe('\\- not a list item\n');
});

it('div-like blocks pass through with spacing, span-likes do not', async () => {
  const md = await renderToMarkdown(
    h(
      'div',
      null,
      h('section', null, h('p', null, 'inside a section')),
      h('p', null, h('span', null, 'spans'), ' flow ', h('span', null, 'inline')),
    ),
  );
  expect(md).toBe('inside a section\n\nspans flow inline\n');
});

it('unknown host tags pass children through without emitting HTML', async () => {
  const md = await renderToMarkdown(
    h('x-widget', { id: 'w' }, h('p', null, 'block inside'), 'trailing ', h('b', null, 'text')),
  );
  expect(md).toBe('block inside\n\ntrailing **text**\n');
});

it('collapses extra blank space between blocks', async () => {
  const md = await renderToMarkdown(
    h(Fragment, null, '\n  \n', h('p', null, 'a'), '\n\n\n', h('div', null), h('p', null, 'b'), null),
  );
  expect(md).toBe('a\n\nb\n');
});

it('empty tree renders to empty string', async () => {
  expect(await renderToMarkdown(null)).toBe('');
  expect(await renderToMarkdown(h(Fragment, null))).toBe('');
});
