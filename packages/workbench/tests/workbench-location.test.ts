import { expect, it } from '@rstest/core';

import {
  advancedSections,
  formatWorkbenchLocation,
  isWorkbenchShellPath,
  parseWorkbenchLocation,
  sameWorkbenchLocation,
  type WorkbenchLocation,
} from '../src/shell/workbench-location.ts';

const roundTrips: readonly Readonly<{ readonly location: WorkbenchLocation; readonly url: string }>[] = [
  { location: { area: 'application' }, url: '/' },
  { location: { area: 'application', node: { kind: 'tool', name: 'search_audible', server: 'curator' } }, url: '/routes/mcp/curator/tool/search_audible' },
  { location: { area: 'application', node: { kind: 'resource', name: 'library', server: 'curator' } }, url: '/routes/mcp/curator/resource/library' },
  { location: { area: 'application', node: { kind: 'prompt', name: 'plan', server: 'curator' } }, url: '/routes/mcp/curator/prompt/plan' },
  { location: { area: 'application', node: { kind: 'app', name: 'shelf', server: 'curator' } }, url: '/routes/mcp/curator/app/shelf' },
  { location: { area: 'application', node: { event: 'tool/before', kind: 'event' } }, url: '/routes/events/tool/before' },
  { location: { area: 'application', node: { kind: 'cli', path: ['audible', 'search'] } }, url: '/routes/cli/audible/search' },
  { location: { area: 'application', node: { kind: 'script', name: 'sync' } }, url: '/routes/scripts/sync' },
  { location: { area: 'application', node: { id: 'skill:review', kind: 'skill' } }, url: '/routes/skills/skill%3Areview' },
  { location: { area: 'application', node: { id: 'release', kind: 'command' } }, url: '/routes/commands/release' },
  { location: { area: 'application', node: { id: 'style', kind: 'rule' } }, url: '/routes/rules/style' },
  {
    location: { area: 'application', invocationId: 'inv-1', node: { kind: 'tool', name: 'search_audible', server: 'curator' }, tab: 'structured' },
    url: '/routes/mcp/curator/tool/search_audible?invocation=inv-1&tab=structured',
  },
  { location: { area: 'trace' }, url: '/trace' },
  { location: { area: 'trace', invocationId: 'inv 1/a' }, url: '/trace/inv%201%2Fa' },
  { location: { area: 'problems' }, url: '/problems' },
  { location: { area: 'sessions' }, url: '/sessions' },
  { location: { area: 'sessions', host: 'claude' }, url: '/sessions/claude' },
  ...advancedSections.map((section) => ({ location: { area: 'advanced' as const, section }, url: `/advanced/${section}` })),
];

const split = (url: string): readonly [string, string] => {
  const index = url.indexOf('?');
  return index === -1 ? [url, ''] : [url.slice(0, index), url.slice(index)];
};

it('formats and parses every destination in the brief as a round trip', () => {
  for (const { location, url } of roundTrips) {
    expect(formatWorkbenchLocation(location)).toBe(url);
    const [pathname, search] = split(url);
    const parsed = parseWorkbenchLocation(pathname, search);
    expect(parsed).toEqual(location);
    expect(sameWorkbenchLocation(parsed, location)).toBe(true);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(isWorkbenchShellPath(pathname)).toBe(true);
  }
});

it('encodes route segments so names with reserved characters survive the URL', () => {
  const location: WorkbenchLocation = { area: 'application', node: { kind: 'tool', name: 'a/b c?d', server: 's#1' } };
  const url = formatWorkbenchLocation(location);
  expect(url).toBe('/routes/mcp/s%231/tool/a%2Fb%20c%3Fd');
  expect(parseWorkbenchLocation(url)).toEqual(location);
});

it('lands unknown paths and malformed encodings on the Application root instead of throwing', () => {
  const root: WorkbenchLocation = { area: 'application' };
  expect(parseWorkbenchLocation('/nowhere')).toEqual(root);
  expect(parseWorkbenchLocation('/routes')).toEqual(root);
  expect(parseWorkbenchLocation('/routes/unknown-group/x')).toEqual(root);
  expect(parseWorkbenchLocation('/routes/mcp/curator/widget/x')).toEqual(root);
  expect(parseWorkbenchLocation('/routes/mcp/curator/tool')).toEqual(root);
  expect(parseWorkbenchLocation('/routes/mcp/curator/tool/a/b')).toEqual(root);
  expect(parseWorkbenchLocation('/routes/mcp/%E0%A4%A/tool/x')).toEqual(root);
  expect(parseWorkbenchLocation('/routes/scripts/%00')).toEqual(root);
  expect(parseWorkbenchLocation('/routes/cli/%ZZ')).toEqual(root);
  expect(parseWorkbenchLocation('//routes//scripts//sync')).toEqual({ area: 'application', node: { kind: 'script', name: 'sync' } });
});

it('drops query parameters that do not belong to the area', () => {
  expect(parseWorkbenchLocation('/', '?invocation=inv-1&tab=raw')).toEqual({ area: 'application' });
  expect(parseWorkbenchLocation('/problems', '?tab=raw')).toEqual({ area: 'problems' });
  expect(parseWorkbenchLocation('/trace', '?invocation=inv-1')).toEqual({ area: 'trace' });
});

it('normalizes trace, sessions, and advanced tails', () => {
  expect(parseWorkbenchLocation('/trace/a/b')).toEqual({ area: 'trace' });
  expect(parseWorkbenchLocation('/trace/%ZZ')).toEqual({ area: 'trace' });
  expect(parseWorkbenchLocation('/sessions/a/b')).toEqual({ area: 'sessions' });
  expect(parseWorkbenchLocation('/advanced')).toEqual({ area: 'advanced', section: 'evals' });
  expect(parseWorkbenchLocation('/advanced/nope')).toEqual({ area: 'advanced', section: 'evals' });
  expect(parseWorkbenchLocation('/advanced/logs/extra')).toEqual({ area: 'advanced', section: 'evals' });
  expect(parseWorkbenchLocation('/advanced/hosts')).toEqual({ area: 'advanced', section: 'hosts' });
});

it('compares locations by their URL', () => {
  expect(sameWorkbenchLocation({ area: 'trace' }, { area: 'trace' })).toBe(true);
  expect(sameWorkbenchLocation({ area: 'trace' }, { area: 'trace', invocationId: 'x' })).toBe(false);
  expect(sameWorkbenchLocation(
    { area: 'application', node: { kind: 'cli', path: ['a', 'b'] } },
    { area: 'application', node: { kind: 'cli', path: ['a', 'b'] } },
  )).toBe(true);
});
