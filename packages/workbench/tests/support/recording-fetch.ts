export interface RecordedRequest {
  readonly body?: unknown;
  readonly method: string;
  readonly signal?: AbortSignal;
  readonly token: string | null;
  readonly url: string;
}

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
});

export const recordingFetch = (calls: RecordedRequest[], reply: () => Response): typeof fetch =>
  async (input, init) => {
    const url = String(input);
    if (url === '/api/project/session') return response({ instanceId: 'foreground-instance-a', origin: 'http://127.0.0.1:5173', token: 'foreground-token' });
    const signal = init?.signal;
    calls.push({
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      method: init?.method ?? 'GET',
      ...(signal === null || signal === undefined ? {} : { signal }),
      token: new Headers(init?.headers).get('x-agent-bundle-session'),
      url,
    });
    return reply();
  };
