// Regression tests for output that a GFM parser read differently from what
// the React tree meant. Each case was confirmed by rendering the markdown
// back to HTML with micromark before the fix.

import { expect, it } from '@rstest/core';
import { createElement as h, Fragment } from 'react';
import { renderToMarkdown } from '../src/index.js';

it('a hard break at the edge of a paragraph is dropped, not emitted as a literal backslash', async () => {
  const md = await renderToMarkdown(
    h(
      Fragment,
      null,
      h('p', null, 'trailing', h('br')),
      h('p', null, h('br'), 'leading'),
      h('p', null, 'both', h('br'), h('br')),
      h('p', null, 'escaped backslash\\', h('br')),
    ),
  );
  expect(md).toBe('trailing\n\nleading\n\nboth\n\nescaped backslash\\\\\n');
});

it('entity-looking text is escaped so parsers show it literally', async () => {
  const md = await renderToMarkdown(h('p', null, 'a &lt; b &amp; &#169; &#x1F600; AT&T & Co'));
  expect(md).toBe('a \\&lt; b \\&amp; \\&#169; \\&#x1F600; AT&T & Co\n');
});

it('intraword underscores stay unescaped; edge underscores are escaped', async () => {
  const md = await renderToMarkdown(h('p', null, 'snake_case_name __init__ _lead trail_ a_1'));
  expect(md).toBe('snake_case_name \\_\\_init\\_\\_ \\_lead trail\\_ a_1\n');
});

it('adjacent sibling lists alternate markers instead of merging into one loose list', async () => {
  const md = await renderToMarkdown(
    h(
      Fragment,
      null,
      h('ul', null, h('li', null, 'a')),
      h('ul', null, h('li', null, 'b')),
      h('ul', null, h('li', null, 'c')),
      h('ol', null, h('li', null, 'one')),
      h('ol', null, h('li', null, 'two')),
      h('p', null, 'break'),
      h('ul', null, h('li', null, 'd')),
    ),
  );
  expect(md).toBe('- a\n\n* b\n\n- c\n\n1. one\n\n1) two\n\nbreak\n\n- d\n');
});

it('adjacent lists inside a list item also alternate markers', async () => {
  const md = await renderToMarkdown(
    h('ul', null, h('li', null, h('ul', null, h('li', null, 'a')), h('ul', null, h('li', null, 'b')))),
  );
  expect(md).toBe('- - a\n  * b\n');
});

it('a task checkbox glued to its label still forms a task item', async () => {
  const md = await renderToMarkdown(
    h(
      'ul',
      null,
      h('li', null, h('input', { type: 'checkbox', checked: true }), 'done'),
      h('li', null, h('input', { type: 'checkbox' }), 'todo'),
    ),
  );
  expect(md).toBe('- [x] done\n- [ ] todo\n');
});

it('ordered lists honour start={0} and ignore invalid starts', async () => {
  const md = await renderToMarkdown(
    h(
      Fragment,
      null,
      h('ol', { start: 0 }, h('li', null, 'zero'), h('li', null, 'one')),
      h('ol', { start: -4 }, h('li', null, 'invalid')),
    ),
  );
  expect(md).toBe('0. zero\n1. one\n\n1) invalid\n');
});

it('empty list items have no trailing space', async () => {
  const md = await renderToMarkdown(h('ul', null, h('li', null), h('li', null, 'b')));
  expect(md).toBe('-\n- b\n');
});

it('heading text ending in # is not eaten as a closing sequence', async () => {
  const md = await renderToMarkdown(
    h(Fragment, null, h('h1', null, 'Chapter 1 #'), h('h2', null, '#'), h('h3', null, 'C#')),
  );
  expect(md).toBe('# Chapter 1 \\#\n\n## \\#\n\n### C#\n');
});

it('definition lists render as blocks instead of gluing terms to definitions', async () => {
  const md = await renderToMarkdown(
    h('dl', null, h('dt', null, 'Term'), h('dd', null, 'Definition'), h('dt', null, 'Other'), h('dd', null, 'Second')),
  );
  expect(md).toBe('Term\n\nDefinition\n\nOther\n\nSecond\n');
});

it('table captions render as a paragraph above the table', async () => {
  const md = await renderToMarkdown(
    h(
      'table',
      null,
      h('caption', null, 'Totals ', h('em', null, 'by year')),
      h('thead', null, h('tr', null, h('th', null, 'A'))),
      h('tbody', null, h('tr', null, h('td', null, '1'))),
    ),
  );
  expect(md).toBe('Totals *by year*\n\n| A |\n| --- |\n| 1 |\n');
});

it('non-content tags (style, script, head metadata) emit nothing', async () => {
  const md = await renderToMarkdown(
    h(
      'div',
      null,
      h('style', null, '.a{color:red}'),
      h('script', null, 'alert(1)'),
      h('title', null, 'Page'),
      h('template', null, h('p', null, 'hidden')),
      h('p', null, 'visible ', h('script', null, 'inline()'), 'text'),
      h('ul', null, h('li', null, h('noscript', null, 'no js'), 'item')),
    ),
  );
  expect(md).toBe('visible text\n\n- item\n');
});

it('nesting the same emphasis inside itself does not change its meaning', async () => {
  const md = await renderToMarkdown(
    h(
      Fragment,
      null,
      h('p', null, h('em', null, h('em', null, 'a'))),
      h('p', null, h('strong', null, h('b', null, 'b'))),
      h('p', null, h('em', null, h('em', null, 'c'), ' and more')),
    ),
  );
  expect(md).toBe('*a*\n\n**b**\n\n*c and more*\n');
});

it('Activity and ViewTransition elements pass their children through', async () => {
  // React's element types for these are symbols, which createElement's
  // public overloads do not admit; the renderer dispatches on the symbol.
  const symbolType = (name: string) => Symbol.for(name) as unknown as string;
  const md = await renderToMarkdown(
    h(
      Fragment,
      null,
      h(symbolType('react.activity'), { mode: 'visible' }, h('p', null, 'shown')),
      h(symbolType('react.activity'), { mode: 'hidden' }, h('p', null, 'hidden')),
      h(symbolType('react.view_transition'), null, h('p', null, 'transitioned')),
    ),
  );
  expect(md).toBe('shown\n\ntransitioned\n');
});
