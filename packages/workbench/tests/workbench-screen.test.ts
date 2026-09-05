import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import { projectFailureText, ProjectClientError } from '../src/project-client.ts';
import { ConnectionGate, Navigation, pageForHash, type WorkbenchPage } from '../src/workbench-screen.tsx';

const pages = (...values: WorkbenchPage[]): ReadonlySet<WorkbenchPage> => new Set(values);

/** What the route client says when a contributor dev origin reaches a foreground server that was not started with the flag. */
const noFlagRefusal = 'Origin http://localhost:3000 is not allowed by the foreground server at http://127.0.0.1:3100. '
  + 'Open http://127.0.0.1:3100 instead, or start agent-bundle dev with --workbench-dev-origin http://localhost:3000 to allow this origin.';

it('renders only available routes in grouped navigation', () => {
  const markup = renderToStaticMarkup(createElement(Navigation, {
    onNavigate: () => undefined,
    page: 'skills',
    pages: pages('overview', 'routes', 'skills', 'lifecycles', 'artifacts', 'logs', 'evals', 'comparisons'),
  }));

  expect(markup).toContain('>Routes<');
  expect(markup).toContain('>Build<');
  expect(markup).toContain('>Capabilities<');
  expect(markup).toContain('>Quality<');
  expect(markup).toContain('>Inspect<');
  expect(markup).toContain('>Skills<');
  expect(markup).toContain('>Lifecycles<');
  expect(markup).toContain('>Evals<');
  expect(markup).not.toContain('>Hooks<');
  expect(markup).not.toContain('MCP playground');
  expect(markup).not.toContain('>Playground<');
});

it('resolves unsupported and unknown hashes to Overview', () => {
  const available = pages('overview', 'routes', 'skills', 'artifacts', 'logs');

  expect(pageForHash('#skills', available)).toBe('skills');
  expect(pageForHash('#routes', available)).toBe('routes');
  expect(pageForHash('#routes', pages('overview', 'skills'))).toBe('overview');
  expect(pageForHash('#hooks', available)).toBe('overview');
  expect(pageForHash('#lifecycles', pages('overview', 'lifecycles'))).toBe('lifecycles');
  expect(pageForHash('#unknown', available)).toBe('overview');
  expect(pageForHash('', available)).toBe('overview');
});

it('gates an unavailable connection with the failure code, message, and HTTP status', () => {
  const markup = renderToStaticMarkup(createElement(ConnectionGate, {
    error: projectFailureText(new ProjectClientError('Request origin is not this foreground server.', 'AB8003', 403), 'fallback'),
    state: 'unavailable',
  }));

  expect(markup).toContain('<main aria-live="polite" class="connection-recovery loading-state">');
  expect(markup).toContain('<h1>Foreground connection unavailable</h1>');
  expect(markup).toContain('<p>Waiting for the foreground server to recover.</p>');
  expect(markup).toContain('<p role="alert">AB8003 — Request origin is not this foreground server. (HTTP 403)</p>');
});

it('gates a client-side refusal of an HTTP 200 bootstrap without presenting the 200 as the failure', () => {
  const markup = renderToStaticMarkup(createElement(ConnectionGate, {
    error: projectFailureText(new ProjectClientError(noFlagRefusal, 'AB8003'), 'fallback'),
    state: 'unavailable',
  }));

  expect(markup).toContain(`<p role="alert">AB8003 — ${noFlagRefusal}</p>`);
  expect(markup).not.toContain('HTTP');
});

it('gates a reconnecting connection without an alert', () => {
  const markup = renderToStaticMarkup(createElement(ConnectionGate, { state: 'connecting' }));

  expect(markup).toContain('<h1>Foreground connection reconnecting</h1>');
  expect(markup).toContain('<p>Connecting to the foreground server.</p>');
  expect(markup).not.toContain('role="alert"');
});
