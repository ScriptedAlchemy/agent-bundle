import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import type {
  HookPlaygroundDiagnosticResult,
  HookPlaygroundHook,
  HookPlaygroundSimulation,
} from '../../agent-bundle/src/dev/hook-playground-service.ts';
import { HookClient } from '../src/hooks/hook-client.ts';
import { HookSimulationView, HooksPage, runHookReplay } from '../src/hooks/hooks-page.tsx';
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
});

it('renders the hook controls and no request state when no epoch is active', () => {
  const client = new HookClient({ fetch: async () => { throw new Error('No epoch may issue a hook playground request.'); } });
  const markup = renderToStaticMarkup(createElement(HooksPage, { client, epochId: undefined }));

  expect(markup).toContain('No artifact epoch is active');
  expect(markup).not.toContain('id="hook-binding"');
  expect(markup).not.toContain('Run simulation');
});

it('renders the simulation and replay controls for an active epoch', () => {
  const client = new HookClient({ fetch: async () => response({ hooks }) });
  const markup = renderToStaticMarkup(createElement(HooksPage, { client, epochId: 'epoch-1' }));

  expect(markup).toContain('id="hook-binding"');
  expect(markup).toContain('id="hook-canonical-input"');
  expect(markup).toContain('Run simulation');
  expect(markup).toContain('Replay saved simulation');
});

it('replays a saved simulation against its original epoch, not the selected one', async () => {
  const bodies: unknown[] = [];
  const client = new HookClient({
    fetch: async (input, init) => {
      const url = String(input);
      if (url === '/api/project/session') return response({ origin: 'http://127.0.0.1:5173', token: 'foreground-token' });
      bodies.push(typeof init?.body === 'string' ? JSON.parse(init.body) : undefined);
      return response({ simulation });
    },
  });
  const view = hookPlaygroundViewFor({ epochId: 'epoch-2', hooks, result: simulation, selectedKey: undefined });

  expect(view.replay).toEqual(simulation.replay);
  await runHookReplay(client, view.replay!);

  expect(bodies).toEqual([simulation.replay]);
  expect((bodies[0] as { readonly binding: { readonly epochId: string } }).binding.epochId).toBe('epoch-1');
});
