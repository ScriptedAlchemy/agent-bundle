import { ForegroundSessionAuthority, type ForegroundSessionSnapshot } from '../foreground-session.ts';

export type McpAppJsonPrimitive = null | boolean | number | string;

export type McpAppJsonArray = readonly McpAppJsonValue[];

export interface McpAppJsonObject {
  readonly [key: string]: McpAppJsonValue;
}

export type McpAppJsonValue = McpAppJsonArray | McpAppJsonObject | McpAppJsonPrimitive;

export type McpAppPreviewProfile = 'chatgpt' | 'claude' | 'portable';
export type McpAppBridgeLifecycle = 'created' | 'initializing' | 'initialized' | 'closing' | 'closed';
export type McpAppRequestId = string | number | null;

export interface McpAppHostContext {
  readonly availableDisplayModes: readonly string[];
  readonly containerDimensions: Readonly<{ readonly height: number; readonly width: number }>;
  readonly deviceCapabilities: Readonly<Record<string, McpAppJsonValue>>;
  readonly displayMode: string;
  readonly locale: string;
  readonly platform: string;
  readonly safeAreaInsets: Readonly<{ readonly bottom: number; readonly left: number; readonly right: number; readonly top: number }>;
  readonly styles: Readonly<Record<string, McpAppJsonValue>>;
  readonly theme: 'dark' | 'light';
  readonly timeZone: string;
  readonly userAgent: string;
}

export interface McpAppPreviewCreateRequest {
  readonly consent?: McpAppJsonValue;
  readonly host: McpAppHostContext;
  readonly input: McpAppJsonValue;
  readonly previewProfile: McpAppPreviewProfile;
  readonly result: McpAppJsonValue;
  readonly toolName: string;
}

export interface McpAppRelayFrame {
  readonly allow: string;
  readonly policy: Readonly<{
    readonly contentSecurityPolicy: string;
    readonly iframeAllow: string;
    readonly permissionsPolicy: string;
  }>;
  readonly referrerPolicy: 'no-referrer';
  readonly relay: Readonly<{ readonly maxMessageBytes: number; readonly maxQueuedMessages: number }>;
  readonly sandbox: 'allow-scripts allow-same-origin';
  readonly src: string;
  readonly targetOrigin: string;
}

export interface McpAppPreview {
  readonly bindingId: string;
  readonly frame?: McpAppRelayFrame;
  readonly profile: McpAppJsonValue;
  readonly resource: McpAppJsonValue;
}

export interface McpAppRouteMessages {
  readonly accepted: boolean;
  readonly lifecycle: McpAppBridgeLifecycle;
  readonly messages: readonly McpAppJsonValue[];
}

export interface McpAppRouteClose {
  readonly lifecycle: McpAppBridgeLifecycle;
  readonly message?: McpAppJsonValue;
}

export interface McpAppClientOptions {
  readonly authority?: ForegroundSessionAuthority;
  readonly fetch?: typeof fetch;
}

interface Diagnostic {
  readonly code: string;
  readonly message: string;
}

const maximumPathSegmentLength = 4_096;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const detachedJson = (value: unknown, ancestors = new WeakSet<object>()): McpAppJsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new McpAppClientError('AB8016', 'Foreground MCP App data must contain finite JSON numbers.');
  }
  if (typeof value !== 'object') throw new McpAppClientError('AB8016', 'Foreground MCP App data must contain only JSON values.');
  if (ancestors.has(value)) throw new McpAppClientError('AB8016', 'Foreground MCP App data must not be cyclic.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((entry) => detachedJson(entry, ancestors)));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new McpAppClientError('AB8016', 'Foreground MCP App data must use ordinary JSON objects.');
    }
    const copy = Object.create(null) as Record<string, McpAppJsonValue>;
    for (const [key, entry] of Object.entries(value)) copy[key] = detachedJson(entry, ancestors);
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
};

const asRecord = (value: unknown, code = 'AB8019'): Readonly<Record<string, McpAppJsonValue>> => {
  if (!isRecord(value)) throw new McpAppClientError(code, 'Foreground MCP App route returned an invalid response.');
  try {
    return detachedJson(value) as Readonly<Record<string, McpAppJsonValue>>;
  } catch {
    throw new McpAppClientError(code, 'Foreground MCP App route returned an invalid response.');
  }
};

const asArray = (value: unknown): readonly McpAppJsonValue[] => {
  if (!Array.isArray(value)) throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid response.');
  try {
    return detachedJson(value) as readonly McpAppJsonValue[];
  } catch {
    throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid response.');
  }
};

const diagnostic = (value: unknown, status: number): Diagnostic => {
  if (isRecord(value) && isRecord(value.diagnostic) && typeof value.diagnostic.code === 'string' && typeof value.diagnostic.message === 'string') {
    return { code: value.diagnostic.code, message: value.diagnostic.message };
  }
  return { code: 'AB8019', message: `Foreground MCP App request failed with HTTP ${status}.` };
};

const opaqueSegment = (value: string, name: string): string => {
  if (
    value.length === 0 || value.length > maximumPathSegmentLength || value.trim().length === 0 || value === '.' || value === '..' ||
    value.includes('/') || value.includes('\\') || value.includes('\0')
  ) throw new McpAppClientError('AB8015', `${name} is not available.`);
  return encodeURIComponent(value);
};

const lifecycle = (value: unknown): McpAppBridgeLifecycle => {
  if (value === 'created' || value === 'initializing' || value === 'initialized' || value === 'closing' || value === 'closed') return value;
  throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid lifecycle.');
};

const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const origin = (value: unknown): string => {
  if (typeof value !== 'string') throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid frame origin.');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid frame origin.');
  }
  if (parsed.origin !== value || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid frame origin.');
  }
  return value;
};

const frame = (value: unknown, foregroundOrigin: string): McpAppRelayFrame => {
  const snapshot = asRecord(value);
  const policy = asRecord(snapshot.policy);
  const relay = asRecord(snapshot.relay);
  if (
    typeof snapshot.allow !== 'string' || typeof policy.contentSecurityPolicy !== 'string' || typeof policy.iframeAllow !== 'string' ||
    typeof policy.permissionsPolicy !== 'string' || snapshot.referrerPolicy !== 'no-referrer' ||
    !positiveInteger(relay.maxMessageBytes) || !positiveInteger(relay.maxQueuedMessages) ||
    snapshot.sandbox !== 'allow-scripts allow-same-origin' || typeof snapshot.src !== 'string'
  ) throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid frame.');
  const targetOrigin = origin(snapshot['targetOrigin']);
  if (targetOrigin === foregroundOrigin) {
    throw new McpAppClientError('AB8019', 'Foreground MCP App frame must use a distinct proxy origin.');
  }
  let source: URL;
  try {
    source = new URL(snapshot.src);
  } catch {
    throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid frame.');
  }
  if (source.origin !== targetOrigin) throw new McpAppClientError('AB8019', 'Foreground MCP App frame must use its declared target origin.');
  return Object.freeze({
    allow: snapshot.allow,
    policy: Object.freeze({
      contentSecurityPolicy: policy.contentSecurityPolicy,
      iframeAllow: policy.iframeAllow,
      permissionsPolicy: policy.permissionsPolicy,
    }),
    referrerPolicy: 'no-referrer',
    relay: Object.freeze({ maxMessageBytes: relay.maxMessageBytes, maxQueuedMessages: relay.maxQueuedMessages }),
    sandbox: 'allow-scripts allow-same-origin',
    src: snapshot.src,
    targetOrigin,
  });
};

const preview = (value: unknown, foregroundOrigin: string): McpAppPreview => {
  const snapshot = asRecord(value);
  if (typeof snapshot.bindingId !== 'string') throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid preview.');
  const bindingId = opaqueSegment(snapshot.bindingId, 'MCP App binding');
  if (snapshot.profile === undefined || snapshot.resource === undefined) {
    throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid preview.');
  }
  return Object.freeze({
    bindingId: decodeURIComponent(bindingId),
    ...(snapshot.frame === undefined ? {} : { frame: frame(snapshot.frame, foregroundOrigin) }),
    profile: snapshot.profile,
    resource: snapshot.resource,
  });
};

const messages = (value: unknown): McpAppRouteMessages => {
  const snapshot = asRecord(value);
  if (typeof snapshot.accepted !== 'boolean') throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid message response.');
  return Object.freeze({ accepted: snapshot.accepted, lifecycle: lifecycle(snapshot.lifecycle), messages: asArray(snapshot.messages) });
};

const close = (value: unknown): McpAppRouteClose => {
  const snapshot = asRecord(value);
  return Object.freeze({
    lifecycle: lifecycle(snapshot.lifecycle),
    ...(snapshot.message === undefined ? {} : { message: snapshot.message }),
  });
};

const closeOptions = (value: Readonly<{ readonly id: McpAppRequestId; readonly reason?: string }>): Readonly<{ readonly id: McpAppRequestId; readonly reason?: string }> => {
  if (!validRequestId(value.id) || (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.trim().length === 0))) {
    throw new McpAppClientError('AB8016', 'MCP App close options are not valid.');
  }
  return Object.freeze({ id: value.id, ...(value.reason === undefined ? {} : { reason: value.reason }) });
};

const validRequestId = (value: unknown): value is McpAppRequestId =>
  value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

/** Credential-memory-only browser client for binding-scoped MCP App routes. */
export class McpAppClient {
  readonly #authority: ForegroundSessionAuthority;
  readonly #fetch: typeof fetch;

  constructor(options: McpAppClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#authority = options.authority ?? new ForegroundSessionAuthority({ fetch: this.#fetch });
  }

  async create(sessionId: string, request: McpAppPreviewCreateRequest): Promise<McpAppPreview> {
    const foreground = await this.#snapshot();
    return preview(asRecord(await this.#json(`/api/mcp/sessions/${opaqueSegment(sessionId, 'MCP session')}/apps`, {
      body: JSON.stringify(detachedJson(request)),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })).preview, foreground.origin);
  }

  async message(bindingId: string, message: McpAppJsonValue, signal?: AbortSignal): Promise<McpAppRouteMessages> {
    return messages(await this.#json(`${this.#bindingPath(bindingId)}/messages`, {
      body: JSON.stringify({ message: detachedJson(message) }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    }));
  }

  async close(bindingId: string, options: Readonly<{ readonly id: McpAppRequestId; readonly reason?: string }>): Promise<McpAppRouteClose> {
    return close(await this.#json(`${this.#bindingPath(bindingId)}/close`, {
      body: JSON.stringify(detachedJson(closeOptions(options))),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }));
  }

  async forceClose(bindingId: string): Promise<boolean> {
    const response = asRecord(await this.#json(this.#bindingPath(bindingId), { method: 'DELETE' }));
    if (response.closed !== true || response.lifecycle !== 'closed') {
      throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid close response.');
    }
    return true;
  }

  async #json(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await this.#request(path, init);
    const body: unknown = await response.json().catch(() => {
      throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid response.');
    });
    if (!response.ok) {
      const detail = diagnostic(body, response.status);
      throw new McpAppClientError(detail.code, detail.message);
    }
    try {
      return detachedJson(body);
    } catch {
      throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid response.');
    }
  }

  async #request(path: string, init: RequestInit = {}): Promise<Response> {
    const authentication = await this.#snapshot();
    const headers = new Headers(init.headers);
    headers.set('x-agent-bundle-session', authentication.token);
    const response = await this.#fetch(path, { ...init, headers });
    if (!response.ok) {
      const body: unknown = await response.clone().json().catch(() => undefined);
      const detail = diagnostic(body, response.status);
      throw new McpAppClientError(detail.code, detail.message);
    }
    return response;
  }

  async #snapshot(): Promise<ForegroundSessionSnapshot> {
    try {
      return await this.#authority.snapshot();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Foreground session bootstrap returned an invalid response.';
      throw new McpAppClientError(
        message === 'Foreground session bootstrap origin does not match this browser.' ? 'AB8003' : 'AB8019',
        message,
      );
    }
  }

  #bindingPath(bindingId: string): string {
    return `/api/mcp/apps/${opaqueSegment(bindingId, 'MCP App binding')}`;
  }
}

export class McpAppClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpAppClientError';
    this.code = code;
  }
}
