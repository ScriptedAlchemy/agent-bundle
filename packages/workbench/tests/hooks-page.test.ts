import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import type {
  HookPlaygroundDiagnosticResult,
  HookPlaygroundHook,
  HookPlaygroundSimulation,
} from '../../agent-bundle/src/dev/hook-playground-service.ts';
import { HookClient } from '../src/hooks/hook-client.ts';
import { ForegroundRouteClient } from '../src/mcp/mcp-route-client.ts';
import { HookRequestLifecycle, HookSimulationView, HooksPage, runHookReplay, runHookSimulation } from '../src/hooks/hooks-page.tsx';
import { hookPlaygroundViewFor } from '../src/hooks/hooks-model.ts';

const hooks: readonly HookPlaygroundHook[] = [{
  binding: { epochId: 'epoch-1', hook: 'hook:session-start', target: 'claude' },
  hook: { event: 'sessionStart', id: 'hook:session-start', name: 'session-start', path: 'claude/hooks/session-start.mjs', target: 'claude' },
}];

const simulation: HookPlaygroundSimulation = {
  binding: { epochId: 'epoch-1', hook: 'hook:session-start', target: 'claude' },
  canonicalIntent: {
    event: 'sessionStart',
    hook: 'hook:session-start',
    input: { cwd: '/workspace', sessionId: 'session-1', source: 'startup', transcriptPath: '/workspace/transcript.jsonl' },
  },
  canonicalResult: { additionalContext: 'Ready to review' },
  hostMapping: {
    canonicalEvent: 'sessionStart',
    matcher: 'startup',
    nativeEvent: 'SessionStart',
    nativeProjection: 'deterministic',
    nativeSelector: 'SessionStart',
    target: 'claude',
    wrapperPath: 'claude/hooks/session-start.mjs',
  },
  nativeInput: { cwd: '/workspace', hook_event_name: 'SessionStart', session_id: 'session-1', source: 'startup' },
  nativeOutput: { hookSpecificOutput: { additionalContext: 'Ready to review', hookEventName: 'SessionStart' } },
  replay: {
    binding: { epochId: 'epoch-1', hook: 'hook:session-start', target: 'claude' },
    input: { cwd: '/workspace', sessionId: 'session-1', source: 'startup', transcriptPath: '/workspace/transcript.jsonl' },
  },
};

const diagnostics: HookPlaygroundDiagnosticResult = {
  diagnostics: [{
    code: 'hook.playground.event.unsupported',
    event: 'sessionStart',
    message: 'Hook playground target "codex" cannot map canonical event "sessionStart".',
    severity: 'error',
    target: 'codex',
  }],
};

const response = (body: unknown): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status: 200,
});

const foreground = (fetch: typeof globalThis.fetch): ForegroundRouteClient => new ForegroundRouteClient({ fetch });

it('renders the canonical intent, host mapping, and native trace of a simulation', () => {
  const markup = renderToStaticMarkup(createElement(HookSimulationView, {
    view: hookPlaygroundViewFor({ epochId: 'epoch-1', hooks, result: simulation, selectedKey: 'claude/hook:session-start' }),
  }));

  expect(markup).toContain('Canonical intent');
  expect(markup).toContain('Host mapping');
  expect(markup).toContain('Canonical input');
  expect(markup).toContain('Native input');
  expect(markup).toContain('Native output');
  expect(markup).toContain('Canonical result');
  expect(markup).toContain('sessionStart');
  expect(markup).toContain('SessionStart');
  expect(markup).toContain('claude/hooks/session-start.mjs');
  expect(markup).toContain('startup');
  expect(markup).toContain('hook_event_name');
  expect(markup).toContain('hookSpecificOutput');
  expect(markup).toContain('Ready to review');
});

it('states an absent canonical result and native output instead of hiding them', () => {
  const markup = renderToStaticMarkup(createElement(HookSimulationView, {
    view: hookPlaygroundViewFor({
      epochId: 'epoch-1',
      hooks,
      result: { ...simulation, canonicalResult: undefined, nativeOutput: undefined },
      selectedKey: undefined,
    }),
  }));

  expect(markup).toContain('The emitted wrapper returned no canonical result.');
  expect(markup).toContain('The host codec produced no native output.');
});

it('renders returned diagnostics as a visible alert', () => {
  const markup = renderToStaticMarkup(createElement(HookSimulationView, {
    view: hookPlaygroundViewFor({ epochId: 'epoch-1', hooks, result: diagnostics, selectedKey: undefined }),
  }));

  expect(markup).toContain('role="alert"');
  expect(markup).toContain('hook.playground.event.unsupported');
  expect(markup).toContain('cannot map canonical event');
  expect(markup).toContain('Severity: error');
  expect(markup).toContain('Event: sessionStart');
  expect(markup).toContain('Target: codex');
});

it('renders the hook controls and no request state when no epoch is active', () => {
  const client = new HookClient({ foreground: foreground(async () => { throw new Error('No epoch may issue a hook playground request.'); }) });
  const markup = renderToStaticMarkup(createElement(HooksPage, { client, epochId: undefined }));

  expect(markup).toContain('No artifact epoch is active');
  expect(markup).not.toContain('id="hook-binding"');
  expect(markup).not.toContain('Run simulation');
  expect(markup).toContain('<main');
});

it('renders the simulation and replay controls for an active epoch', () => {
  const client = new HookClient({ foreground: foreground(async (input) => String(input) === '/api/project/session'
    ? response({
      cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
      origin: 'http://127.0.0.1:5173',
      token: 'foreground-token',
    })
    : response({ hooks })) });
  const markup = renderToStaticMarkup(createElement(HooksPage, { client, epochId: 'epoch-1' }));

  expect(markup).toContain('id="hook-binding"');
  expect(markup).toContain('id="hook-canonical-input"');
  expect(markup).toContain('Run simulation');
  expect(markup).toContain('Replay saved simulation');
  expect(markup).toContain('name="hook-input-mode"');
  expect(markup).toContain('value="inline"');
  expect(markup).toContain('value="fixture"');
  expect(markup).not.toContain('value="path"');
});

it('posts fixture input with the strict simulation request body', async () => {
  const bodies: unknown[] = [];
  const client = new HookClient({
    foreground: foreground(async (request, init) => {
      if (String(request) === '/api/project/session') return response({
        cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
        origin: 'http://127.0.0.1:5173',
        token: 'foreground-token',
      });
      bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined);
      return response({ simulation });
    }),
  });

  await runHookSimulation(client, simulation.binding, { cwd: '/fixture' }, 'fixture');

  expect(bodies).toEqual([{
    epochId: 'epoch-1',
    hook: 'hook:session-start',
    input: { fixture: { cwd: '/fixture' } },
    target: 'claude',
  }]);
});

it('makes stale and superseded simulation requests unable to update current page state', () => {
  const lifecycle = new HookRequestLifecycle();
  const stale = lifecycle.begin('run');
  const current = lifecycle.begin('run');
  const applied: string[] = [];

  if (lifecycle.isCurrent(stale)) applied.push('stale');
  if (lifecycle.isCurrent(current)) applied.push('current');
  lifecycle.invalidate();
  if (lifecycle.isCurrent(current)) applied.push('after-epoch-change');

  expect(stale.signal.aborted).toBe(true);
  expect(current.signal.aborted).toBe(true);
  expect(applied).toEqual(['current']);
});

it('replays a saved simulation against its original epoch, not the selected one', async () => {
  const bodies: unknown[] = [];
  const client = new HookClient({
    foreground: foreground(async (input, init) => {
      const url = String(input);
      if (url === '/api/project/session') return response({
        cookieName: 'agent-bundle-foreground-session-0123456789abcdef0123456789abcdef',
        origin: 'http://127.0.0.1:5173',
        token: 'foreground-token',
      });
      bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined);
      return response({ simulation });
    }),
  });
  const view = hookPlaygroundViewFor({ epochId: 'epoch-2', hooks, result: simulation, selectedKey: undefined });

  expect(view.replay).toEqual(simulation.replay);
  await runHookReplay(client, view.replay!);

  expect(bodies).toEqual([simulation.replay]);
  expect((bodies[0] as { readonly binding: { readonly epochId: string } }).binding.epochId).toBe('epoch-1');
});
