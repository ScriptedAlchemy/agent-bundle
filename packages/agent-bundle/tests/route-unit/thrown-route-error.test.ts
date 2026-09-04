import { Agent } from '@agent-bundle/runtime';
import { describe, expect, it } from '@rstest/core';
import { createElement, Suspense } from 'react';

import { createCanonicalEventProps, projectEventDocument } from '../../src/events/project.ts';
import { AgentTestError } from '../../src/test/errors.ts';
import { expectDocument } from '../../src/test/matchers.ts';
import { renderRoute, renderRouteEvents } from '../../src/test/render.ts';

const rejection = async (render: Promise<unknown>): Promise<AgentTestError> => {
  try {
    await render;
  } catch (thrown: unknown) {
    return thrown as AgentTestError;
  }
  throw new Error('The render resolved, so no harness diagnostic was produced.');
};

/**
 * Pins what a thrown — not represented — route error is at the route-unit
 * level (#492). `Agent.Error` is the supported error path; these tests exist
 * so the thrown paths are decisions rather than omissions.
 */
describe('a route whose default export throws', () => {
  it('fails the render with no document, so nothing downstream can project it', async () => {
    const error = await rejection(renderRoute('tool:harness/fault', { input: { mode: 'throw' } }));

    expect(error).toBeInstanceOf(AgentTestError);
    expect(error.code).toBe('render-failed');
    expect(error.message).toContain('cause:        Error: fault: route threw');
    expect(error.message).toContain('route:        tool:harness/fault (tool)');
  });

  it('produces no render events either: the layout chain never ran, so there is no shell to stream', async () => {
    const error = await rejection(renderRouteEvents('tool:harness/fault', { input: { mode: 'throw' } }));

    expect(error.code).toBe('render-failed');
    expect(error.message).toContain('fault: route threw');
  });
});

describe('a route whose nested Suspense boundary rejects', () => {
  it('completes as a represented error with code "boundary" inside the surviving layout shell', async () => {
    const rendered = await renderRoute('tool:harness/fault', { input: { mode: 'reject-boundary' } });

    // The reconciler folds the rejected boundary into the document as an error
    // node, so the outcome is the represented-error shape a route would get
    // from rendering <Agent.Error code="boundary"> itself.
    expectDocument(rendered)
      .toHaveStatus('represented-error')
      .toContainText('fault: reject-boundary')
      .toHaveError('boundary');
    expect(rendered.document.root.kind).toBe('result');
    if (rendered.document.root.kind !== 'result') throw new Error('unreachable');
    expect(rendered.document.root.children).toContainEqual({
      code: 'boundary',
      kind: 'error',
      message: 'fault: boundary rejected',
    });
    // The layouts composed before the boundary settled keep their metadata,
    // and the route's own result value is still the document value.
    expect(rendered.document.root.metadata).toMatchObject({ layout: 'harness', route: 'tool:harness/fault' });
    expect(rendered.result).toEqual({ mode: 'reject-boundary', settled: true });
  });

  it('streams shell → error(boundaryId) → complete rather than failing the render', async () => {
    const rendered = await renderRouteEvents('tool:harness/fault', { input: { mode: 'reject-boundary' } });

    expect(rendered.events.map((event) => event.type)).toEqual(['shell', 'error', 'complete']);
    const errorEvent = rendered.events[1];
    if (errorEvent?.type !== 'error') throw new Error('expected the second event to be the boundary error');
    expect(errorEvent.boundaryId).toBeDefined();
    expect(errorEvent.error).toEqual({ code: 'boundary', message: 'fault: boundary rejected' });
    expect(rendered.document.status).toBe('represented-error');
  });
});

describe('an event route that throws', () => {
  const props = () => createCanonicalEventProps(
    'tool/after',
    { hook_event_name: 'PostToolUse', tool_name: 'Write' },
    'claude',
    'PostToolUse',
    '2.1.250',
    new AbortController().signal,
  );

  it('fails the render before any hook output exists — the wrapper then exits 1 with the message on stderr', async () => {
    const { canonical, native } = props();
    const error = await rejection(renderRoute({
      default: async () => {
        throw new Error('event route exploded');
      },
    }, { input: { canonical, native }, kind: 'event-route', routeId: 'event:tool/after' }));

    expect(error.code).toBe('render-failed');
    expect(error.message).toContain('event route exploded');
    // There is no document, so `projectEventDocument` is never reached: the
    // generated wrapper writes the message to stderr, nothing to stdout, and
    // exits 1 (see hooks.test.ts and generated-route-server.test.ts).
  });

  it('projects a rejected boundary as if the error node were absent: only context and value reach the host', async () => {
    const { canonical, native } = props();
    const Rejecting = async () => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 1);
      });
      throw new Error('event boundary rejected');
    };
    const rendered = await renderRoute({
      default: async () => createElement(
        Agent.Result,
        null,
        createElement(Agent.Context, null, 'kept context'),
        createElement(Suspense, { fallback: createElement(Agent.Context, null, 'loading') }, createElement(Rejecting)),
      ),
    }, { input: { canonical, native }, kind: 'event-route', routeId: 'event:tool/after' });

    expect(rendered.document.status).toBe('represented-error');
    // The hook projection reads Agent.Context and the result value only; a
    // represented or boundary error node contributes nothing to the host
    // output, so the host sees a normal pass-through with the surviving context.
    expect(projectEventDocument(rendered.document, 'tool/after', 'claude', 'PostToolUse')).toEqual({
      hookSpecificOutput: { additionalContext: 'kept context', hookEventName: 'PostToolUse' },
    });
  });
});
