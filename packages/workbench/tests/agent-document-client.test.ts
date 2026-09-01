import { describe, expect, it } from '@rstest/core';

import {
  AgentDocumentClient,
  AgentDocumentClientError,
  decodeAgentDocumentEvents,
  type AgentDocument,
} from '../src/runtime/agent-document-client.ts';

const document: AgentDocument = {
  root: {
    children: [
      { kind: 'markdown', text: '# Rendered heading' },
      { kind: 'text', text: 'Plain text' },
      { kind: 'context', text: 'Additional context' },
      { kind: 'json', value: { accepted: true } },
      { completed: 1, kind: 'progress', message: 'Halfway', total: 2 },
      { data: 'iVBORw0KGgo=', kind: 'image', mimeType: 'image/png' },
      { data: 'UklGRg==', kind: 'audio', mimeType: 'audio/wav' },
      { kind: 'resource', mimeType: 'text/plain', name: 'Evidence', uri: 'agent://evidence/1' },
      { code: 'DOC_ERROR', kind: 'error', message: 'Represented failure' },
      { children: [{ kind: 'text', text: 'Nested result' }], kind: 'result', metadata: { source: 'nested' } },
    ],
    kind: 'result',
    metadata: { route: 'tool/status' },
  },
  status: 'success',
  value: { final: true },
  version: 1,
};

const events = [
  { document, sequence: 0, type: 'shell' },
  { completed: 1, message: 'Working', sequence: 1, total: 2, type: 'progress' },
  { boundaryId: 'boundary-a', document, sequence: 2, type: 'replace' },
  {
    boundaryId: 'boundary-b',
    error: { code: 'BOUNDARY_FAILED', data: { retryable: false }, message: 'Boundary failed' },
    sequence: 3,
    type: 'error',
  },
  { document, sequence: 4, type: 'complete' },
] as const;

describe('Agent Document client contract', () => {
  it('decodes every document node and render event variant', () => {
    const decoded = decodeAgentDocumentEvents({ events });

    expect(decoded).toHaveLength(5);
    expect(decoded.map((event) => event.type)).toEqual(['shell', 'progress', 'replace', 'error', 'complete']);
    expect(decoded[0]).toMatchObject({ document, sequence: 0, type: 'shell' });
  });

  it('rejects unknown fields at the envelope, event, document, and recursive node boundaries', () => {
    expect(() => decodeAgentDocumentEvents({ events, unknown: true })).toThrow(AgentDocumentClientError);
    expect(() => decodeAgentDocumentEvents({
      events: [{ ...events[0], unknown: true }],
    })).toThrow(AgentDocumentClientError);
    expect(() => decodeAgentDocumentEvents({
      events: [{
        ...events[0],
        document: { ...document, unknown: true },
      }],
    })).toThrow(AgentDocumentClientError);
    expect(() => decodeAgentDocumentEvents({
      events: [{
        ...events[0],
        document: {
          ...document,
          root: {
            ...document.root,
            children: [{ kind: 'text', text: 'Strict', unknown: true }],
          },
        },
      }],
    })).toThrow(AgentDocumentClientError);
  });

  it('uses the protected foreground authority and preserves structured diagnostics', async () => {
    const requests: string[] = [];
    const client = new AgentDocumentClient({
      foreground: {
        protectedRequest: async (path) => {
          requests.push(path);
          return new Response(JSON.stringify({ events }), {
            headers: { 'content-type': 'application/json' },
            status: 200,
          });
        },
      },
    });

    await expect(client.events('run-a')).resolves.toEqual(decodeAgentDocumentEvents({ events }));
    await expect(client.events('run/a')).rejects.toMatchObject({ code: 'AB8209' });
    expect(requests).toEqual(['/api/runtime/runs/run-a/document']);

    const failed = new AgentDocumentClient({
      foreground: {
        protectedRequest: async () => new Response(JSON.stringify({
          diagnostic: { code: 'AB8208', message: 'Stored Flight could not be decoded as an Agent Document.' },
        }), { status: 409 }),
      },
    });
    await expect(failed.events('run-a')).rejects.toMatchObject({
      code: 'AB8208',
      message: 'Stored Flight could not be decoded as an Agent Document.',
      status: 409,
    });
  });
});
