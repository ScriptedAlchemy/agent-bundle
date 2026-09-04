import { expect, it } from '@rstest/core';
import React, { createElement as h, Fragment, Suspense } from 'react';
import { renderToMarkdown, renderToMarkdownStream } from '../src/index.js';

it('function component returning host tags', async () => {
  function Greeting({ name }: { name: string }) {
    return h('p', null, 'Hello, ', h('strong', null, name), '!');
  }
  const md = await renderToMarkdown(h(Greeting, { name: 'world' }));
  expect(md).toBe('Hello, **world**!\n');
});

it('async function component', async () => {
  async function Delayed() {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return h('p', null, 'eventually');
  }
  const md = await renderToMarkdown(h('div', null, h(Delayed)));
  expect(md).toBe('eventually\n');
});

it('promise as a child', async () => {
  const md = await renderToMarkdown(
    h('p', null, 'before ', Promise.resolve(h('em', null, 'awaited')), ' after'),
  );
  expect(md).toBe('before *awaited* after\n');
});

it('React.use on a promise (RSC client pattern)', async () => {
  const data = Promise.resolve(h('p', null, 'from the RSC stream'));
  function Content() {
    return React.use(data);
  }
  const md = await renderToMarkdown(h(Content));
  expect(md).toBe('from the RSC stream\n');
});

it('Suspense boundaries resolve their content, never the fallback', async () => {
  async function Slow() {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return h('p', null, 'slow content');
  }
  const md = await renderToMarkdown(
    h(Suspense, { fallback: h('p', null, 'loading...') }, h(Slow)),
  );
  expect(md).toBe('slow content\n');
});

it('hooks work without a DOM renderer', async () => {
  function Hooky() {
    const [count] = React.useState(41);
    const doubled = React.useMemo(() => count + 1, [count]);
    const ref = React.useRef('unused');
    React.useEffect(() => {
      throw new Error('effects must not run');
    });
    return h('p', null, `count is ${doubled}`, ref.current === 'unused' ? '' : '!');
  }
  const md = await renderToMarkdown(h(Hooky));
  expect(md).toBe('count is 42\n');
});

it('context providers and useContext', async () => {
  const Theme = React.createContext('light');
  function Show() {
    return h('p', null, 'theme: ', React.useContext(Theme));
  }
  const md = await renderToMarkdown(
    h(Fragment, null, h(Show), h(Theme, { value: 'dark' }, h(Show))),
  );
  expect(md).toBe('theme: light\n\ntheme: dark\n');
});

it('fragments, arrays, and null children', async () => {
  const md = await renderToMarkdown(
    h(
      Fragment,
      null,
      [h('p', { key: 'a' }, 'one'), null, false, h('p', { key: 'b' }, 'two')],
      undefined,
      h(Fragment, null, h('p', null, 'three')),
    ),
  );
  expect(md).toBe('one\n\ntwo\n\nthree\n');
});

it('custom components option extends and overrides serialization', async () => {
  const md = await renderToMarkdown(
    h(
      Fragment,
      null,
      h('callout', { kind: 'WARNING' }, 'Mind the ', h('b', null, 'gap'), '.'),
      h('hr'),
    ),
    {
      components: {
        callout: (props, { inline }) => `> [!${props.kind}]\n> ${inline()}`,
        hr: () => '***',
      },
    },
  );
  expect(md).toBe('> [!WARNING]\n> Mind the **gap**.\n\n***\n');
});

const article = h(
  'article',
  null,
  h('h1', null, 'Streaming Markdown from RSC'),
  h('p', null, h('em', null, 'March 2026'), ' — by ', h('a', { href: '/team' }, 'the team')),
  h(
    'p',
    null,
    'React Server Components produce a tree, and this library walks it to emit ',
    h('strong', null, 'markdown'),
    ' instead of HTML. Inline ',
    h('code', null, 'renderToMarkdown()'),
    ' calls are all it takes.',
  ),
  h('h2', null, 'Why bother?'),
  h(
    'ul',
    null,
    h('li', null, 'LLM prompts and tools consume markdown, not HTML'),
    h(
      'li',
      null,
      'Static exports',
      h('ul', null, h('li', null, 'docs sites'), h('li', null, 'changelogs')),
    ),
  ),
  h('pre', null, h('code', { className: 'language-js' }, "import {renderToMarkdown} from 'rsc-markdown-stream';\n")),
  h('blockquote', null, h('p', null, 'No HTML was rendered in the making of this output.')),
  h('hr'),
  h('p', null, 'That is the whole job.'),
);

const articleMarkdown = `# Streaming Markdown from RSC

*March 2026* — by [the team](/team)

React Server Components produce a tree, and this library walks it to emit **markdown** instead of HTML. Inline \`renderToMarkdown()\` calls are all it takes.

## Why bother?

- LLM prompts and tools consume markdown, not HTML
- Static exports
  - docs sites
  - changelogs

\`\`\`js
import {renderToMarkdown} from 'rsc-markdown-stream';
\`\`\`

> No HTML was rendered in the making of this output.

---

That is the whole job.
`;

it('article fixture', async () => {
  expect(await renderToMarkdown(article)).toBe(articleMarkdown);
});

it('renderToMarkdownStream emits the same markdown, in multiple chunks', async () => {
  const stream = renderToMarkdownStream(article);
  expect(stream).toBeInstanceOf(ReadableStream);
  const decoder = new TextDecoder();
  const chunks = [];
  for await (const chunk of stream) {
    expect(chunk).toBeInstanceOf(Uint8Array);
    chunks.push(decoder.decode(chunk, { stream: true }));
  }
  expect(chunks.length).toBeGreaterThan(3);
  expect(chunks.join('')).toBe(articleMarkdown);
});

it('stream propagates render errors', async () => {
  function Boom(): null {
    throw new Error('boom');
  }
  const stream = renderToMarkdownStream(h('div', null, h(Boom)));
  const reader = stream.getReader();
  await expect(reader.read()).rejects.toThrow(/boom/);
});
