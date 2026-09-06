import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import type { TraceClient } from '../src/trace/trace-client.ts';
import { TracePage, type TracePageProps } from '../src/trace/trace-page.tsx';
import { sampleTraceEntries } from './support/trace-fixtures.ts';

/** The page never opens the feed when a snapshot is supplied; this client fails loudly if it does. */
const untouched: TraceClient = {
  replay: () => Promise.reject(new Error('replay is not under test')),
  stream: () => Promise.reject(new Error('stream is not under test')),
};

const render = (props: Partial<TracePageProps> = {}): string => renderToStaticMarkup(createElement(TracePage, {
  client: untouched,
  entries: sampleTraceEntries,
  onNavigate: () => undefined,
  timeZone: 'UTC',
  ...props,
}));

const count = (markup: string, needle: string): number => markup.split(needle).length - 1;

it('renders the correlated timeline oldest first with one line per entry, nested under its group headline', () => {
  const markup = render();
  expect(markup).toContain('<h1>Trace</h1>');
  expect(markup).toContain('8 entries in 3 groups');
  expect(markup).toContain('data-testid="trace-timeline"');
  expect(count(markup, 'data-testid="trace-group"')).toBe(3);
  expect(count(markup, 'data-testid="trace-entry"')).toBe(8);
  expect(markup).not.toContain('data-testid="trace-empty"');
  expect(markup).not.toContain('data-testid="trace-detail"');

  expect(markup.indexOf('data-group-key="conversationId:conv-1"')).toBeLessThan(markup.indexOf('data-group-key="invocationId:inv_3"'));
  expect(markup).toContain('22:41:04.101');
  expect(markup).toContain('22:41:09.541');
  expect(markup).toContain('Claude session started');
  expect(markup).toContain('conversation <span class="identifier">conv-1</span>');
  expect(markup).toContain('6 entries');
  expect(markup).toContain('trace-row trace-row--depth-1 trace-row--ok');
  expect(markup).toContain('render finished');
  expect(markup).toContain('8.1 ms');
  expect(markup).toContain('15 ms');
  expect(markup).toContain('href="/trace/trc_3"');
  expect(markup).toContain('data-group-key="entry:trc_8"');
});

it('shows the empty state that explains what produces entries, and a connecting state before the first replay', () => {
  const empty = render({ entries: [] });
  expect(empty).toContain('data-testid="trace-empty"');
  expect(empty).toContain('Run a route, call a tool in Advanced → Protocol, or invoke the plugin from a host');
  expect(count(empty, 'data-testid="trace-group"')).toBe(0);

  const connecting = renderToStaticMarkup(createElement(TracePage, { client: untouched, onNavigate: () => undefined }));
  expect(connecting).toContain('Connecting…');
  expect(connecting).toContain('data-testid="trace-empty"');
  expect(connecting).toContain('Connecting to the trace…');
});

it('opens the detail drawer for /trace/<id> with correlation links and the primary Open route action', () => {
  const markup = render({ entryId: 'trc_5' });
  expect(markup).toContain('data-testid="trace-detail"');
  expect(markup).toContain('data-entry-id="trc_5"');
  expect(markup).toContain('trace-page trace-page--detail');
  expect(markup).toContain('<h2>MCP tools/call hauler_status</h2>');
  expect(markup).toContain('mcp · <span class="identifier">mcp.request</span>');
  expect(markup).toContain('href="/advanced/protocol?session=mcp-1"');
  expect(markup).toContain('>Open route</a>');
  expect(markup).toContain('href="/trace/trc_5?correlation=conv-1"');
  expect(markup).toContain('href="/trace/trc_5?correlation=mcp-1"');
  expect(markup).toContain('href="/trace/trc_5?correlation=7"');
  expect(markup).toContain('&quot;lane&quot;: &quot;all&quot;');
  expect(markup).toContain('aria-current="true"');
  expect(markup).toContain('data-selected="true"');
  expect(markup).toContain('aria-label="Close entry"');
  expect(markup).toContain('href="/trace"');

  const invocation = render({ entryId: 'inv_3' });
  expect(invocation).toContain('data-entry-id="trc_7"');
  expect(invocation).toContain('href="/routes/mcp/curator/tool/search?invocation=inv_3"');

  const routeless = render({ entryId: 'trc_8' });
  expect(routeless).toContain('No route record behind this entry.');
  expect(routeless).toContain('This entry carries no correlation key.');
  expect(routeless).toContain('No details were published with this entry.');

  const unknown = render({ entryId: 'trc_404' });
  expect(unknown).toContain('data-testid="trace-detail"');
  expect(unknown).toContain('Not in this trace');
  expect(unknown).toContain('No retained entry is trc_404.');
});

it('scopes the timeline to the group ?correlation= names and offers the way back', () => {
  const markup = render({ correlation: 'exec-1' });
  expect(count(markup, 'data-testid="trace-group"')).toBe(1);
  expect(count(markup, 'data-testid="trace-entry"')).toBe(6);
  expect(markup).toContain('Correlated by <span class="identifier">exec-1</span>');
  expect(markup).toContain('>Show all</a>');
  expect(markup).toContain('href="/trace/trc_1?correlation=exec-1"');

  const withEntry = render({ correlation: 'exec-1', entryId: 'trc_3' });
  expect(withEntry).toContain('href="/trace?correlation=exec-1"');
  expect(withEntry).toContain('href="/trace/trc_3"');

  const missing = render({ correlation: 'nobody' });
  expect(count(missing, 'data-testid="trace-group"')).toBe(0);
  expect(missing).toContain('No entry carries nobody.');
  expect(missing).not.toContain('data-testid="trace-empty"');
});
