import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from '@rstest/core';

import type { AgentDocument, AgentRenderEvent } from '../src/runtime/agent-document-client.ts';
import {
  AgentDocumentStage,
  foldAgentDocumentEvents,
} from '../src/runtime/agent-document-stage.tsx';

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
  });
});

describe('Agent Document stage', () => {
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

    const markup = renderToStaticMarkup(createElement(AgentDocumentStage, { events }));

    expect(markup).toContain('class="skill-heading skill-heading--one"');
    expect(markup).toContain('<strong>Rendered Markdown</strong>');
    expect(markup).toContain('Additional context');
    expect(markup).toContain('&quot;answer&quot;: 42');
    expect(markup).toContain('In-document progress');
    expect(markup).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(markup).toContain('src="data:audio/wav;base64,UklGRg=="');
    expect(markup).toContain('agent://evidence/1');
    expect(markup).toContain('REPRESENTED');
    expect(markup).toContain('STREAM_ERROR');
    expect(markup).toContain('Live progress');
    expect(markup).toContain('represented-error');
    expect(markup).toContain('Version 1');
    expect(markup).toContain('Shell · #0');
    expect(markup).toContain('Complete · #3');
  });
});
