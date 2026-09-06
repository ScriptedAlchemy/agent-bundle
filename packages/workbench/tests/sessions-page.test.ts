import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import { ForegroundRouteClient } from '../src/mcp/mcp-route-client.ts';
import { HostSessionClient } from '../src/sessions/host-session-client.ts';
import { OpenInHost } from '../src/sessions/open-in-host.tsx';
import { SessionsPage } from '../src/sessions/sessions-page.tsx';
import { neverFetch, skillLeaf, toolLeaf } from './support/workspace-fixtures.ts';

const client = new HostSessionClient({ foreground: new ForegroundRouteClient({ fetch: neverFetch }) });

it('renders the launch buttons disabled until availability loads, the empty list, and the placeholder', () => {
  const markup = renderToStaticMarkup(createElement(SessionsPage, { client, onNavigate: () => undefined }));
  expect(markup).toContain('<h1>Host sessions</h1>');
  expect(markup).toMatch(/<button[^>]*data-testid="sessions-launch-claude"[^>]*disabled=""/u);
  expect(markup).toMatch(/<button[^>]*data-testid="sessions-launch-codex"[^>]*disabled=""/u);
  expect(markup).toContain('Checking host availability…');
  expect(markup).toContain('data-testid="sessions-empty"');
  expect(markup).toContain('data-testid="sessions-placeholder"');
  expect(markup).not.toContain('data-testid="sessions-terminal"');

  const deepLink = renderToStaticMarkup(createElement(SessionsPage, { client, onNavigate: () => undefined, session: 'hs_0123456789abcdef' }));
  expect(deepLink).toContain('Loading host sessions…');
});

it('offers Open in Claude / Codex only for leaves with a seeded prompt, disabled until availability loads', () => {
  const markup = renderToStaticMarkup(createElement(OpenInHost, { client, leaf: toolLeaf, onNavigate: () => undefined }));
  expect(markup).toMatch(/<button[^>]*data-testid="route-open-in-claude"[^>]*disabled=""[^>]*title="Checking host availability…"/u);
  expect(markup).toContain('data-testid="route-open-in-codex"');
  expect(markup).toContain('>Open in Codex</button>');
  expect(renderToStaticMarkup(createElement(OpenInHost, { client, leaf: skillLeaf, onNavigate: () => undefined }))).toBe('');
});
