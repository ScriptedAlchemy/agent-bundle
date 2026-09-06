import { z } from 'zod';

import { parseJsonWithoutDuplicateKeys } from '../../../agent-bundle/src/contracts/strict-json.ts';
import { CodedClientError, diagnosticErrorEnvelopeSchema } from '../client-helpers.ts';
import type { ForegroundRequestAuthority } from '../mcp/mcp-route-client.ts';
import type {
  HostAvailability,
  HostSession,
  HostSessionLaunchRequest,
  HostSessionList,
  HostSessionSize,
} from '../../../agent-bundle/src/contracts/host-sessions.ts';

export interface HostSessionClientOptions {
  readonly foreground: ForegroundRequestAuthority;
}

export class HostSessionClientError extends CodedClientError {
  readonly status: number | undefined;

  constructor(code: string, message: string, status?: number) {
    super('HostSessionClientError', code, message);
    this.status = status;
  }
}

/** A decoded `/stream` frame; `output` carries the PTY bytes the base64 wire text encoded. */
export type HostSessionStreamMessage =
  | Readonly<{ readonly session: HostSession; readonly type: 'state' }>
  | Readonly<{ readonly bytes: Uint8Array; readonly type: 'output' }>
  | Readonly<{ readonly session: HostSession; readonly type: 'end' }>;

const textSchema = z.string().min(1);
const sizeSchema = z.number().int().min(1).max(500);
const hostSchema = z.enum(['claude', 'codex']);
const sessionSchema: z.ZodType<HostSession> = z.strictObject({
  authority: z.strictObject({
    epochId: textSchema,
    install: textSchema,
    projectRoot: textSchema,
  }),
  cols: sizeSchema,
  endedAt: z.number().finite().nonnegative().optional(),
  exitCode: z.number().int().optional(),
  host: hostSchema,
  id: textSchema,
  pid: z.number().int().nonnegative().optional(),
  prompt: z.string().optional(),
  restartOf: textSchema.optional(),
  rows: sizeSchema,
  signal: textSchema.optional(),
  startedAt: z.number().finite().nonnegative(),
  state: z.enum(['exited', 'running', 'terminated']),
  traceSessionId: textSchema.optional(),
});
const availabilitySchema: z.ZodType<HostAvailability> = z.strictObject({
  executable: textSchema.optional(),
  host: hostSchema,
  launchable: z.boolean(),
  reason: z.string().optional(),
});
const listSchema: z.ZodType<HostSessionList> = z.strictObject({
  hosts: z.array(availabilitySchema),
  sessions: z.array(sessionSchema),
});
const sessionResponseSchema = z.strictObject({ session: sessionSchema });
const outputFrameSchema = z.strictObject({
  data: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u),
});

const invalid = (message: string): HostSessionClientError => new HostSessionClientError('AB8261', message);

const responseError = (value: unknown, status: number): HostSessionClientError => {
  const decoded = diagnosticErrorEnvelopeSchema.safeParse(value);
  return decoded.success
    ? new HostSessionClientError(decoded.data.diagnostic.code, decoded.data.diagnostic.message, status)
    : new HostSessionClientError('AB8261', `Host session request failed with HTTP ${String(status)}.`, status);
};

const opaqueSessionId = (value: string): string => {
  if (
    value.length === 0 || value === '.' || value === '..' ||
    value.includes('/') || value.includes('\\') || value.includes('\0')
  ) {
    throw invalid('Host session id is not a valid opaque segment.');
  }
  return encodeURIComponent(value);
};

const bodyFor = async (response: Response): Promise<unknown> =>
  response.status === 204 ? undefined : response.json().catch(() => undefined);

const sessionBody = (value: unknown): HostSession => {
  const decoded = sessionResponseSchema.safeParse(value);
  if (!decoded.success) throw invalid('Host session route returned an invalid response.');
  return Object.freeze(decoded.data.session);
};

/** `atob` + `Uint8Array.from`: `Uint8Array.fromBase64` is not in the Workbench's Chrome target. */
export const decodeBase64 = (data: string): Uint8Array =>
  Uint8Array.from(atob(data), (character) => character.charCodeAt(0));

const invalidFrame = (): HostSessionClientError => invalid('Host session stream returned an invalid frame.');

const decodeFrame = (event: string | undefined, data: string | undefined): HostSessionStreamMessage => {
  if (event === undefined || data === undefined) throw invalidFrame();
  let parsed: unknown;
  try {
    parsed = parseJsonWithoutDuplicateKeys(data);
  } catch {
    throw invalidFrame();
  }
  switch (event) {
    case 'state':
    case 'end': {
      const decoded = sessionResponseSchema.safeParse(parsed);
      if (!decoded.success) throw invalidFrame();
      return Object.freeze({ session: Object.freeze(decoded.data.session), type: event });
    }
    case 'output': {
      const decoded = outputFrameSchema.safeParse(parsed);
      if (!decoded.success) throw invalidFrame();
      return Object.freeze({ bytes: decodeBase64(decoded.data.data), type: 'output' });
    }
    default:
      throw invalidFrame();
  }
};

const json = (body: unknown, signal?: AbortSignal): RequestInit => ({
  body: JSON.stringify(body),
  headers: { 'content-type': 'application/json' },
  method: 'POST',
  ...(signal === undefined ? {} : { signal }),
});

export class HostSessionClient {
  readonly #foreground: ForegroundRequestAuthority;

  constructor({ foreground }: HostSessionClientOptions) {
    this.#foreground = foreground;
  }

  async #request(path: string, init: RequestInit): Promise<unknown> {
    const response = await this.#foreground.protectedRequest(path, init);
    const body = await bodyFor(response);
    if (!response.ok) throw responseError(body, response.status);
    return body;
  }

  async list(signal?: AbortSignal): Promise<HostSessionList> {
    const body = await this.#request('/api/sessions', signal === undefined ? {} : { signal });
    const decoded = listSchema.safeParse(body);
    if (!decoded.success) throw invalid('Host session list route returned an invalid response.');
    return Object.freeze({ hosts: Object.freeze(decoded.data.hosts), sessions: Object.freeze(decoded.data.sessions) });
  }

  async launch(request: HostSessionLaunchRequest, signal?: AbortSignal): Promise<HostSession> {
    return sessionBody(await this.#request('/api/sessions', json(request, signal)));
  }

  async read(id: string, signal?: AbortSignal): Promise<HostSession> {
    return sessionBody(await this.#request(`/api/sessions/${opaqueSessionId(id)}`, signal === undefined ? {} : { signal }));
  }

  async stream(
    id: string,
    listener: (message: HostSessionStreamMessage) => void,
    signal?: AbortSignal,
  ): Promise<HostSession> {
    const response = await this.#foreground.protectedRequest(
      `/api/sessions/${opaqueSessionId(id)}/stream`,
      signal === undefined ? {} : { signal },
    );
    if (!response.ok) throw responseError(await bodyFor(response), response.status);
    if (response.body === null) throw invalid('Host session stream returned no body.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffered = '';
    let final: HostSession | undefined;
    for (;;) {
      const next = await reader.read();
      buffered += decoder.decode(next.value, { stream: !next.done });
      let boundary = buffered.indexOf('\n\n');
      while (boundary !== -1) {
        const lines = buffered.slice(0, boundary).split('\n');
        buffered = buffered.slice(boundary + 2);
        boundary = buffered.indexOf('\n\n');
        if (lines.every((line) => line.startsWith(':') || line.length === 0)) continue;
        const message = decodeFrame(
          lines.find((line) => line.startsWith('event: '))?.slice(7),
          lines.find((line) => line.startsWith('data: '))?.slice(6),
        );
        listener(message);
        if (message.type === 'end') final = message.session;
      }
      if (next.done) break;
    }
    if (final === undefined) throw invalid('Host session stream ended without an end frame.');
    return final;
  }

  async input(id: string, data: string, signal?: AbortSignal): Promise<void> {
    await this.#request(`/api/sessions/${opaqueSessionId(id)}/input`, json({ data }, signal));
  }

  async resize(id: string, size: HostSessionSize, signal?: AbortSignal): Promise<void> {
    await this.#request(`/api/sessions/${opaqueSessionId(id)}/resize`, json(size, signal));
  }

  async terminate(id: string, signal?: AbortSignal): Promise<HostSession> {
    return sessionBody(await this.#request(`/api/sessions/${opaqueSessionId(id)}/terminate`, json({}, signal)));
  }

  async restart(id: string, size: HostSessionSize, signal?: AbortSignal): Promise<HostSession> {
    return sessionBody(await this.#request(`/api/sessions/${opaqueSessionId(id)}/restart`, json(size, signal)));
  }

  async forget(id: string, signal?: AbortSignal): Promise<void> {
    await this.#request(`/api/sessions/${opaqueSessionId(id)}`, { method: 'DELETE', ...(signal === undefined ? {} : { signal }) });
  }
}
