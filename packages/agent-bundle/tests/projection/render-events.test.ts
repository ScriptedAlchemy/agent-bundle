import { describe, expect, it } from '@rstest/core';

import { expectDocument } from '../../src/test/matchers.ts';
import { expectEvents } from '../../src/test/events.ts';
import { renderRouteEvents } from '../../src/test/render.ts';

/**
 * Event-stream matchers over the #140 render-event contract, against streams
 * the real runtime produced rather than synthetic frames.
 *
 * These assertions are sequence-tolerant on purpose (#120): a legitimate
 * extra `replace` or `progress` frame must never turn a passing render red,
 * while a missing frame, a reordering, or a regressed ordinal still fails.
 */
describe('render events from the real runtime', () => {
  it('opens with a shell, ends with exactly one complete, and never regresses its ordinals', async () => {
    const rendered = await renderRouteEvents('tool:harness/catalog', { input: { genre: 'mystery' } });

    expectEvents(rendered)
      .toContainSequence(['shell', 'complete'])
      .toHaveMonotonicSequence()
      .toCompleteOnce()
      .toHaveNoErrors();
    expect(rendered.events[0]!.type).toBe('shell');
  });

  it('resolves the suspended boundary into the final document the complete event carries', async () => {
    const rendered = await renderRouteEvents('tool:harness/catalog', { input: { genre: 'mystery' } });
    const complete = rendered.events.at(-1);

    if (complete?.type !== 'complete') throw new Error('expected the render to end with a complete event');
    expectDocument(rendered).toHaveStatus('success').toContainMarkdown('- Piranesi');
    expect(complete.document).toEqual(rendered.document);
    expect(rendered.result).toEqual({ genre: 'mystery', titles: ['Piranesi', 'Solaris'] });
  });

  it('reports request-scoped progress on the stream instead of only the final document', async () => {
    const rendered = await renderRouteEvents('tool:harness/echo', { input: { message: 'streamed' } });

    expectEvents(rendered)
      .toHaveProgress({ atLeast: 1, messages: ['echoing'] })
      .toContainSequence(['shell', 'progress', 'complete'])
      .toHaveMonotonicSequence();
  });

  it('keeps a represented error inside the document rather than on the event stream', async () => {
    const rendered = await renderRouteEvents('tool:harness/unavailable');

    expectEvents(rendered).toHaveNoErrors().toCompleteOnce();
    expectDocument(rendered).toHaveStatus('represented-error').toHaveError('AB9001');
  });

  it('renders an event route through the same stream every other route uses', async () => {
    const rendered = await renderRouteEvents('event:tool/after', {
      input: {
        canonical: {
          event: 'tool/after',
          idempotencyKey: 'projection',
          observedAt: '2026-09-01T00:00:00.000Z',
          provenance: {
            host: 'claude',
            hostContractRevision: 'projection',
            nativeEvent: 'PostToolUse',
            source: 'native',
          },
          sequence: 1,
        },
        native: { tool_name: 'Write' },
      },
    });

    expect(rendered.invocation.kind).toBe('event');
    expectEvents(rendered).toContainSequence(['shell', 'complete']).toHaveMonotonicSequence();
    expectDocument(rendered).toContainMarkdown('Observed tool/after from claude.');
  });
});
