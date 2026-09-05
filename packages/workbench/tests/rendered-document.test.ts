import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from '@rstest/core';

import type { AgentDocument, AgentRenderEvent } from '../src/runtime/agent-document-client.ts';
import {
  agentDocumentNodeRenderers,
  agentRenderEventLabel,
  foldAgentDocumentEvents,
  RenderedAgentDocument,
} from '../src/application/rendered-document.tsx';

const document = (
  label: string,
  status: AgentDocument['status'] = 'success',
): AgentDocument => ({
  root: {
    children: [{ kind: 'text', text: label }],
    kind: 'result',
  },
  status,
  version: 1,
});

describe('Agent Document event fold', () => {
  it('keeps ordered replace snapshots, latest progress, accumulated errors, and complete status', () => {
    const events: readonly AgentRenderEvent[] = [
      { document: document('Shell'), sequence: 0, type: 'shell' },
      { completed: 1, message: 'Started', sequence: 1, total: 3, type: 'progress' },
      { boundaryId: 'a', document: document('Replacement'), sequence: 2, type: 'replace' },
      { completed: 2, message: 'Almost done', sequence: 3, total: 3, type: 'progress' },
      {
        boundaryId: 'b',
        error: { code: 'BOUNDARY_FAILED', data: { retryable: false }, message: 'Boundary failed' },
        sequence: 4,
        type: 'error',
      },
      { document: document('Complete', 'represented-error'), sequence: 5, type: 'complete' },
    ];

    const beforeComplete = foldAgentDocumentEvents(events.slice(0, 5));
    expect(beforeComplete.document?.root).toMatchObject({
      children: [{ kind: 'text', text: 'Replacement' }],
    });
    expect(beforeComplete.finalStatus).toBeUndefined();
    expect(beforeComplete.complete).toBe(false);

    const folded = foldAgentDocumentEvents(events);
    expect(folded.document?.root).toMatchObject({
      children: [{ kind: 'text', text: 'Complete' }],
    });
    expect(folded.progress).toEqual({
      completed: 2,
      message: 'Almost done',
      sequence: 3,
      total: 3,
      type: 'progress',
    });
    expect(folded.errors).toEqual([events[4]]);
    expect(folded.finalStatus).toBe('represented-error');
    expect(folded.complete).toBe(true);
  });

  it('labels every render event kind for timelines', () => {
    expect(agentRenderEventLabel({ document: document('x'), sequence: 0, type: 'shell' })).toBe('Shell · #0');
    expect(agentRenderEventLabel({ completed: 1, message: 'Live', sequence: 1, total: 2, type: 'progress' })).toBe('Progress · #1 · Live · 1 / 2');
    expect(agentRenderEventLabel({ boundaryId: 'b', document: document('x'), sequence: 2, type: 'replace' })).toBe('Replace · #2 · b');
    expect(agentRenderEventLabel({ error: { code: 'E', message: 'm' }, sequence: 3, type: 'error' })).toBe('Error · #3 · E');
    expect(agentRenderEventLabel({ document: document('x', 'failed'), sequence: 4, type: 'complete' })).toBe('Complete · #4 · failed');
  });
});

describe('Rendered Agent Document', () => {
  it('has a browser renderer for every semantic node kind', () => {
    expect(Object.keys(agentDocumentNodeRenderers).sort()).toEqual([
      'audio', 'context', 'error', 'image', 'json', 'markdown', 'progress', 'resource', 'result', 'text',
    ]);
  });

  it('renders every node kind through the shared projector and rich media data URIs', () => {
    const rich: AgentDocument = {
      root: {
        children: [
          { kind: 'markdown', text: '# Projected heading\n\n**Rendered Markdown**' },
          { kind: 'text', text: 'Plain output' },
          { kind: 'context', text: 'Context output' },
          { kind: 'json', value: { answer: 42 } },
          { completed: 1, kind: 'progress', message: 'In-document progress', total: 2 },
          { data: 'iVBORw0KGgo=', kind: 'image', mimeType: 'image/png' },
          { data: 'UklGRg==', kind: 'audio', mimeType: 'audio/wav' },
          { kind: 'resource', mimeType: 'text/plain', name: 'Evidence', uri: 'agent://evidence/1' },
          { code: 'REPRESENTED', kind: 'error', message: 'Represented error node' },
        ],
        kind: 'result',
        metadata: { route: 'status' },
      },
      status: 'represented-error',
      value: { final: true },
      version: 1,
    };
    const events: readonly AgentRenderEvent[] = [
      { document: rich, sequence: 0, type: 'shell' },
      { completed: 1, message: 'Live progress', sequence: 1, total: 2, type: 'progress' },
      {
        error: { code: 'STREAM_ERROR', message: 'Visible stream diagnostic' },
        sequence: 2,
        type: 'error',
      },
      { document: rich, sequence: 3, type: 'complete' },
    ];

    const markup = renderToStaticMarkup(createElement(RenderedAgentDocument, { events }));

    expect(markup).toContain('data-testid="rendered-document"');
    expect(markup).toContain('class="skill-heading skill-heading--one"');
    expect(markup).toContain('<strong>Rendered Markdown</strong>');
    expect(markup).toContain('Additional context');
    expect(markup).toContain('&quot;answer&quot;: 42');
    expect(markup).toContain('In-document progress');
    expect(markup).toContain('<progress class="agent-document-progress-bar" max="2" value="1">');
    expect(markup).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(markup).toContain('src="data:audio/wav;base64,UklGRg=="');
    expect(markup).toContain('agent://evidence/1');
    expect(markup).toContain('REPRESENTED');
    expect(markup).toContain('STREAM_ERROR');
    expect(markup).toContain('Result metadata');
    expect(markup).toContain('Document value');
    expect(markup).toContain('rendered-document-badge--represented-error');
    expect(markup).toContain('Version 1');
    // The stream completed, so the live progress line is gone and the pane is not pending.
    expect(markup).not.toContain('Live progress');
    expect(markup).toContain('aria-busy="false"');
  });

  it('shows the shell and live progress as pending while the stream is incomplete', () => {
    const events: readonly AgentRenderEvent[] = [
      { document: document('Shell placeholder'), sequence: 0, type: 'shell' },
      { completed: 1, message: 'Fetching', sequence: 1, total: 4, type: 'progress' },
    ];

    const markup = renderToStaticMarkup(createElement(RenderedAgentDocument, { events, streaming: true }));

    expect(markup).toContain('aria-busy="true"');
    expect(markup).toContain('rendered-document--pending');
    expect(markup).toContain('Shell placeholder');
    expect(markup).toContain('Fetching · 1 / 4');
    expect(markup).toContain('rendering · success');
  });

  it('explains an empty stream and a still-waiting stream differently', () => {
    const idle = renderToStaticMarkup(createElement(RenderedAgentDocument, { emptyLabel: 'Nothing yet.', events: [] }));
    const waiting = renderToStaticMarkup(createElement(RenderedAgentDocument, { events: [], streaming: true }));

    expect(idle).toContain('Nothing yet.');
    expect(idle).toContain('No document');
    expect(waiting).toContain('Waiting for the first render event…');
    expect(waiting).toContain('Rendering…');
  });

  it('keeps remote Markdown images inert while rendering data URI images', () => {
    const projected: AgentDocument = {
      root: {
        children: [{
          kind: 'markdown',
          text: [
            '![Remote tracker](https://example.invalid/track)',
            '![Protocol-relative tracker](//example.invalid/track)',
            '![Inline image](data:image/png;base64,iVBORw0KGgo=)',
            '[External guide](https://example.com/guide)',
          ].join('\n\n'),
        }],
        kind: 'result',
      },
      status: 'success',
      version: 1,
    };

    const markup = renderToStaticMarkup(createElement(RenderedAgentDocument, {
      events: [{ document: projected, sequence: 0, type: 'complete' }],
    }));

    expect(markup).toContain('class="skill-broken-image"');
    expect(markup).toContain('Remote tracker');
    expect(markup).toContain('https://example.invalid/track');
    expect(markup).not.toContain('src="https://example.invalid/track"');
    expect(markup).toContain('Protocol-relative tracker');
    expect(markup).toContain('//example.invalid/track');
    expect(markup).not.toContain('src="//example.invalid/track"');
    expect(markup.match(/<img/gu)).toHaveLength(1);
    expect(markup).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(markup).toContain('href="https://example.com/guide"');
    expect(markup).toContain('rel="noreferrer"');
    expect(markup).toContain('target="_blank"');
  });
});
