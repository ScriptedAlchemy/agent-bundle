// Regression tests for flaws found by rendering realistic app trees and by
// consuming a real Flight stream (the upstream repository's stress harness
// and example/flight). Each test documents the failure mode it guards against.

import { expect, it } from '@rstest/core';
import { createElement as h, Fragment, type ReactNode } from 'react';
import { renderToMarkdown, renderToMarkdownStream } from '../src/index.js';

// Minimal stand-in for the lazy nodes a Flight client (react-server-dom-*)
// produces for pending server-component subtrees: a lazy *node*, not a lazy
// element type. `_init` throws the thenable while pending, like React's.
function flightLazyNode(promise: Promise<ReactNode>): ReactNode {
  const payload: { status: string; value: ReactNode } = { status: 'pending', value: null };
  promise.then((value) => {
    payload.status = 'fulfilled';
    payload.value = value;
  });
  return {
    $$typeof: Symbol.for('react.lazy'),
    _payload: payload,
    _init(p: typeof payload) {
      if (p.status !== 'fulfilled') throw promise;
      return p.value;
    },
  } as unknown as ReactNode;
}

it('Flight lazy nodes (pending server components) resolve', async () => {
  const node = flightLazyNode(Promise.resolve(h('p', null, 'from the wire')));
  const md = await renderToMarkdown(h('article', null, node));
  expect(md).toBe('from the wire\n');
});

it('whitespace at emphasis edges is hoisted outside the delimiters', async () => {
  // `**TL;DR: **rest` / `**TL;DR:**rest` both fail to parse as bold.
  const md = await renderToMarkdown(
    h(
      Fragment,
      null,
      h('p', null, h('strong', null, 'TL;DR: '), 'rest'),
      h('p', null, 'before', h('em', null, ' padded '), 'after'),
    ),
  );
  expect(md).toBe('**TL;DR:** rest\n\nbefore *padded* after\n');
});

it('literal tildes are escaped (no accidental strikethrough or fences)', async () => {
  const md = await renderToMarkdown(
    h(
      Fragment,
      null,
      h('p', null, 'the flag is ~~gone~~ (literally)'),
      h('p', null, '~~~\nnot a fence\n~~~'),
    ),
  );
  expect(md).toBe('the flag is \\~\\~gone\\~\\~ (literally)\n\n\\~\\~\\~ not a fence \\~\\~\\~\n');
});

it('checkbox inputs render as GFM task list items', async () => {
  const md = await renderToMarkdown(
    h(
      'ul',
      null,
      h('li', null, h('input', { type: 'checkbox', checked: true, readOnly: true }), ' done'),
      h('li', null, h('input', { type: 'checkbox', readOnly: true }), ' todo'),
    ),
  );
  expect(md).toBe('- [x] done\n- [ ] todo\n');
});

it('multiple blocks in a list item are separated by blank lines', async () => {
  // Joined with a single newline, the second paragraph lazily continues the
  // first and they merge into one.
  const md = await renderToMarkdown(
    h(
      'ol',
      null,
      h('li', null, h('p', null, 'first'), h('p', null, 'second')),
      h(
        'li',
        null,
        h('p', null, 'with code:'),
        h('pre', null, h('code', null, 'run()')),
        h('p', null, 'after'),
      ),
    ),
  );
  expect(md).toBe('1. first\n\n   second\n2. with code:\n   ```\n   run()\n   ```\n\n   after\n');
});

it('nested lists stay tight under their parent item', async () => {
  const md = await renderToMarkdown(
    h('ul', null, h('li', null, 'Fruit', h('ul', null, h('li', null, 'Apples')))),
  );
  expect(md).toBe('- Fruit\n  - Apples\n');
});

it('adjacent identical emphasis wrappers merge instead of misparsing', async () => {
  // `*a**b*` and `**a****b**` do not round-trip through CommonMark.
  const md = await renderToMarkdown(
    h(
      Fragment,
      null,
      h('p', null, h('em', null, 'a'), h('em', null, 'b')),
      h('p', null, h('strong', null, 'c'), h('strong', null, 'd')),
      h('p', null, h('del', null, 'e'), h('del', null, 'f')),
    ),
  );
  expect(md).toBe('*ab*\n\n**cd**\n\n~~ef~~\n');
});

it('colSpan pads cells so columns stay aligned', async () => {
  const md = await renderToMarkdown(
    h(
      'table',
      null,
      h('thead', null, h('tr', null, h('th', null, 'A'), h('th', null, 'B'), h('th', null, 'C'))),
      h(
        'tbody',
        null,
        h('tr', null, h('td', { colSpan: 2 }, 'wide'), h('td', null, 'x')),
      ),
    ),
  );
  expect(md).toBe('| A | B | C |\n| --- | --- | --- |\n| wide |  | x |\n');
});

it('container tags stream: early blocks flush before slow siblings resolve', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  async function SlowTail() {
    await gate;
    return h('p', null, 'tail');
  }
  const stream = renderToMarkdownStream(
    h('main', null, h('div', null, h('h1', null, 'Now'), h(SlowTail))),
  );
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  // Before the fix this deadlocks: <div> buffered its entire subtree.
  const first = await reader.read();
  expect(decoder.decode(first.value)).toBe('# Now');
  release();
  let rest = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += decoder.decode(value);
  }
  expect(rest).toBe('\n\ntail\n');
});

it('sibling async components resolve concurrently', async () => {
  // A only finishes after B starts; sequential resolution deadlocks.
  let startB!: () => void;
  const bStarted = new Promise<void>((resolve) => (startB = resolve));
  async function A() {
    await bStarted;
    return h('p', null, 'a');
  }
  async function B() {
    startB();
    return h('p', null, 'b');
  }
  const md = await renderToMarkdown(h(Fragment, null, h(A), h(B)));
  expect(md).toBe('a\n\nb\n');
});

it('custom serializers still receive buffered container subtrees', async () => {
  const md = await renderToMarkdown(
    h('div', { title: 'Note' }, h('p', null, 'body ', h('b', null, 'text'))),
    {
      components: {
        div: (props, { blocks }) => `> **${props.title}**\n>\n> ${blocks()}`,
      },
    },
  );
  expect(md).toBe('> **Note**\n>\n> body **text**\n');
});
