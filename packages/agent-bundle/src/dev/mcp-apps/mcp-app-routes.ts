import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { McpAppJsonValue, McpAppPreviewProfile } from './mcp-app-binding-service.ts';
import type { McpAppBridgeCloseOptions, McpAppBridgeJsonRecord, McpAppBridgeLifecycle } from './mcp-app-bridge.ts';
import type { McpAppPreviewCloseResult, McpAppPreviewHostContext } from './mcp-app-preview-service.ts';
import { McpAppRuntimePreviewError } from '../mcp-app-runtime-preview-service.ts';
import type {
  CreateMcpAppPreviewRequest,
  McpAppBindingOperation,
  McpAppRuntimeRoutePreviewService,
} from '../mcp-app-runtime-preview-service.ts';
import { hasOnlyOwnKeys } from '../../core/strict-json.ts';
import { isMcpAppConsentCapability } from './mcp-app-sandbox.ts';
import type { McpAppConsentChallenge } from './mcp-app-sandbox.ts';
import type { McpAppConsentRequest } from './mcp-app-sandbox.ts';
import { runtimeAppMessageLimits } from '../runtime-app-message-limits.ts';

const bodyLimit = 64 * 1024;
// A force-close DELETE that lands after an accepted graceful close must stay
// idempotent (200, not 404), so this window has to dominate the frame relay's
// force-close budget — clients may fall back as late as their closeTimeoutMs,
// which mcp-app-frame.tsx caps at 30s.
const gracefulCloseReceiptTimeoutMs = 35_000;

interface RequestDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

interface CreateRoute {
  readonly kind: 'create';
  readonly sessionId: string;
}

interface BindingRoute {
  readonly bindingId: string;
  readonly kind: 'messages' | 'host-context' | 'close' | 'force-close' | 'consent';
}

interface RuntimeCreateRoute { readonly kind: 'runtime-create'; }
interface RuntimeBindingRoute {
  readonly bindingId: string;
  readonly kind: 'runtime-get' | 'runtime-close' | 'runtime-operation' | 'runtime-consent-create';
}
interface RuntimeConsentRoute {
  readonly bindingId: string;
  readonly consentId: string;
  readonly kind: 'runtime-consent-decide';
}

type Route = CreateRoute | BindingRoute | RuntimeCreateRoute | RuntimeBindingRoute | RuntimeConsentRoute;
type RuntimeRoute = RuntimeCreateRoute | RuntimeBindingRoute | RuntimeConsentRoute;
type JsonObject = Record<string, unknown>;
type JsonRequestId = string | number | null;

export interface McpAppRoutePreview {
  readonly binding: { readonly id: string };
  readonly bridge: {
    readonly lifecycle: McpAppBridgeLifecycle;
    publishHostContextChanged(context: McpAppBridgeJsonRecord): boolean;
  };
  readonly frame?: unknown;
  readonly profile: unknown;
  readonly resource: unknown;
}

export interface McpAppRoutePreviewService {
  close(bindingId: string, options: McpAppBridgeCloseOptions): Promise<McpAppPreviewCloseResult>;
  /** Foreground shutdown barrier: publish invalidations while authenticated SSE is still live. */
  prepareClose?(): Promise<void>;
  create(options: {
    readonly host: McpAppPreviewHostContext;
    readonly input: McpAppJsonValue;
    readonly previewProfile: McpAppPreviewProfile;
    readonly result: McpAppJsonValue;
    readonly sessionId: string;
    readonly toolName: string;
  }): Promise<McpAppRoutePreview>;
  consentChallenges?(bindingId: string): readonly McpAppConsentChallenge[] | undefined;
  decideConsent?(bindingId: string, challengeId: string, approved: boolean): boolean | Promise<boolean>;
  forceClose(bindingId: string): Promise<boolean>;
  get(bindingId: string): McpAppRoutePreview | undefined;
  receive(bindingId: string, action: unknown): Promise<boolean>;
  takeOutbound(bindingId: string): Promise<readonly unknown[]>;
  /** Optional provider-owned run preview lane; artifact methods above remain independent. */
  readonly runtime?: McpAppRuntimeRoutePreviewService;
}

export interface McpAppRoutesOptions {
  readonly authorize: (request: IncomingMessage) => void;
  /**
   * Test-only override for the graceful-close receipt window. Production
   * callers must leave this unset so the window keeps dominating the frame
   * relay's force-close budget.
   */
  readonly gracefulCloseReceiptTimeoutMs?: number;
  readonly service?: McpAppRoutePreviewService;
}

const diagnostic = (code: string, message: string, status: number): RequestDiagnostic => ({ code, message, status });

const requestError = (value: RequestDiagnostic): RequestDiagnostic & Error => Object.assign(
  new Error(value.message),
  value,
);

const isRequestDiagnostic = (value: unknown): value is RequestDiagnostic =>
  typeof value === 'object' && value !== null &&
  typeof (value as Partial<RequestDiagnostic>).code === 'string' &&
  typeof (value as Partial<RequestDiagnostic>).message === 'string' &&
  typeof (value as Partial<RequestDiagnostic>).status === 'number';

const responseDiagnostic = (response: ServerResponse, value: RequestDiagnostic): void => {
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  response.writeHead(value.status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ diagnostic: { code: value.code, message: value.message } }));
};

const responseJson = (response: ServerResponse, body: unknown): void => {
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

/** Runtime App operation results cross the bounded host-to-opaque-App channel. */
const runtimeOperationResponseJson = (response: ServerResponse, body: unknown): void => {
  let encoded: string;
  try {
    const serialized = JSON.stringify(body);
    if (typeof serialized !== 'string') throw new TypeError('Runtime MCP App operation response is not JSON.');
    encoded = serialized;
  } catch {
    throw requestError(diagnostic('AB8023', 'Runtime MCP App operation response could not be encoded.', 502));
  }
  const bytes = Buffer.byteLength(encoded, 'utf8');
  if (bytes > runtimeAppMessageLimits.hostToAppBytes) {
    throw requestError(diagnostic('AB8023', 'Runtime MCP App operation response exceeds its transport bound.', 413));
  }
  response.writeHead(200, {
    'content-length': String(bytes),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(encoded);
};

const singleHeader = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

const unquoteHeaderValue = (value: string): string | undefined => {
  if (/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(value)) return value;
  if (!/^"(?:[^"\\\r\n]|\\[\t !-~])*"$/u.test(value)) return undefined;
  return value.slice(1, -1).replace(/\\([\t !-~])/gu, '$1');
};

const isJsonRequest = (request: IncomingMessage): boolean => {
  const contentType = singleHeader(request.headers['content-type']);
  if (contentType === undefined) return false;
  const parts = contentType.split(';').map((part) => part.trim());
  if (parts.shift()?.toLowerCase() !== 'application/json') return false;
  if (parts.length === 0) return true;
  if (parts.length !== 1) return false;
  const parameter = parts[0]!;
  const equals = parameter.indexOf('=');
  if (equals < 1 || parameter.slice(0, equals).trim().toLowerCase() !== 'charset') return false;
  return unquoteHeaderValue(parameter.slice(equals + 1).trim())?.toLowerCase() === 'utf-8';
};

const readBody = async (request: IncomingMessage): Promise<string> => new Promise((resolvePromise, rejectPromise) => {
  let size = 0;
  let tooLarge = false;
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > bodyLimit) {
      tooLarge = true;
      return;
    }
    if (!tooLarge) chunks.push(chunk);
  });
  request.once('end', () => {
    if (tooLarge) {
      rejectPromise(requestError(diagnostic('AB8010', 'Request body exceeds 64 KiB.', 413)));
      return;
    }
    resolvePromise(Buffer.concat(chunks).toString('utf8'));
  });
  request.once('error', rejectPromise);
});

const rawPathname = (requestTarget: string | undefined): string => requestTarget?.split(/[?#]/u, 1)[0] ?? '';

const opaqueSegment = (value: string): string => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw requestError(diagnostic('AB8020', 'MCP App route path is not valid.', 400));
  }
  if (
    decoded.length === 0 || decoded.length > 4_096 || decoded.trim().length === 0 || decoded === '.' || decoded === '..' ||
    decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0')
  ) {
    throw requestError(diagnostic('AB8020', 'MCP App route path is not valid.', 400));
  }
  return decoded;
};

const route = (requestTarget: string | undefined): Route | undefined => {
  const pathname = rawPathname(requestTarget);
  if (
    (requestTarget?.includes('?') === true || requestTarget?.includes('#') === true) &&
    (pathname === '/api/runtime/apps' || pathname.startsWith('/api/runtime/apps/'))
  ) {
    throw requestError(diagnostic('AB8020', 'MCP App route path is not valid.', 400));
  }
  if (pathname === '/api/runtime/apps') return Object.freeze({ kind: 'runtime-create' });
  if (pathname.startsWith('/api/runtime/apps/')) {
    const parts = pathname.split('/');
    if (parts.length < 5 || parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'runtime' || parts[3] !== 'apps') {
      throw requestError(diagnostic('AB8020', 'MCP App route path is not valid.', 400));
    }
    const bindingId = opaqueSegment(parts[4]!);
    if (parts.length === 5) return Object.freeze({ bindingId, kind: 'runtime-get' });
    if (parts.length === 6 && parts[5] === 'operations') return Object.freeze({ bindingId, kind: 'runtime-operation' });
    if (parts.length === 6 && parts[5] === 'consents') return Object.freeze({ bindingId, kind: 'runtime-consent-create' });
    if (parts.length === 7 && parts[5] === 'consents') {
      return Object.freeze({ bindingId, consentId: opaqueSegment(parts[6]!), kind: 'runtime-consent-decide' });
    }
    throw requestError(diagnostic('AB8020', 'MCP App route path is not valid.', 400));
  }
  if (pathname !== '/api/mcp' && !pathname.startsWith('/api/mcp/')) return undefined;
  const parts = pathname.split('/');
  if (parts[0] !== '' || parts[1] !== 'api' || parts[2] !== 'mcp') return undefined;
  if (parts[3] === 'sessions' && parts.length === 6 && parts[5] === 'apps') {
    return Object.freeze({ kind: 'create', sessionId: opaqueSegment(parts[4]!) });
  }
  if (parts[3] !== 'apps') return undefined;
  if (parts.length === 5) return Object.freeze({ bindingId: opaqueSegment(parts[4]!), kind: 'force-close' });
  if (parts.length !== 6) throw requestError(diagnostic('AB8020', 'MCP App route path is not valid.', 400));
  const bindingId = opaqueSegment(parts[4]!);
  const kind = parts[5];
  if (kind === 'messages' || kind === 'host-context' || kind === 'close' || kind === 'consent') return Object.freeze({ bindingId, kind });
  if (kind === undefined || kind.length === 0) throw requestError(diagnostic('AB8020', 'MCP App route path is not valid.', 400));
  throw requestError(diagnostic('AB8020', 'MCP App route path is not valid.', 400));
};

const isRuntimeRoute = (value: Route): value is RuntimeRoute => value.kind.startsWith('runtime-');

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const hasOnly: (value: JsonObject, fields: readonly string[]) => boolean = hasOnlyOwnKeys;

const nonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 4_096 && !value.includes('\0');

const isJsonValue = (value: unknown): value is McpAppJsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
};

const cloneJson = (value: McpAppJsonValue): McpAppJsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(cloneJson));
  return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneJson(child)])));
};

const jsonRecord = (value: unknown): McpAppBridgeJsonRecord | undefined =>
  isRecord(value) && isJsonValue(value) ? cloneJson(value) as McpAppBridgeJsonRecord : undefined;

const invalidShape = (): never => {
  throw requestError(diagnostic('AB8021', 'MCP App request has an invalid shape.', 400));
};

const jsonBody = async (request: IncomingMessage): Promise<JsonObject> => {
  if (!isJsonRequest(request)) {
    throw requestError(diagnostic('AB8009', 'Request body must use application/json.', 415));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBody(request));
  } catch (error) {
    if (isRequestDiagnostic(error)) throw error;
    throw requestError(diagnostic('AB8001', 'Request body must be valid JSON.', 400));
  }
  if (!isRecord(parsed)) return invalidShape();
  return parsed;
};

const requestAbort = (request: IncomingMessage, response: ServerResponse): Readonly<{ readonly dispose: () => void; readonly signal: AbortSignal }> => {
  const controller = new AbortController();
  const abort = (): void => {
    if (!controller.signal.aborted) controller.abort(new Error('Runtime MCP App request was cancelled.'));
  };
  const abortResponse = (): void => {
    if (!response.writableEnded) abort();
  };
  request.once('aborted', abort);
  response.once('close', abortResponse);
  return Object.freeze({
    dispose: () => {
      request.removeListener('aborted', abort);
      response.removeListener('close', abortResponse);
    },
    signal: controller.signal,
  });
};

const exactRecord = (value: unknown, fields: readonly string[]): JsonObject | undefined =>
  isRecord(value) && hasOnly(value, fields) ? value : undefined;

const finiteNonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;

const stringList = (value: unknown): readonly string[] | undefined =>
  Array.isArray(value) && value.every(nonemptyString) ? Object.freeze([...value]) : undefined;

const hostContext = (value: unknown): McpAppPreviewHostContext => {
  const record = exactRecord(value, [
    'availableDisplayModes', 'containerDimensions', 'deviceCapabilities', 'displayMode', 'locale', 'platform',
    'safeAreaInsets', 'styles', 'theme', 'timeZone', 'userAgent',
  ]);
  if (record === undefined || !nonemptyString(record.displayMode) || !nonemptyString(record.locale) || !nonemptyString(record.platform)
    || !nonemptyString(record.timeZone) || !nonemptyString(record.userAgent) || (record.theme !== 'dark' && record.theme !== 'light')) {
    return invalidShape();
  }
  const availableDisplayModes = stringList(record.availableDisplayModes);
  const containerDimensions = exactRecord(record.containerDimensions, ['height', 'width']);
  const safeAreaInsets = exactRecord(record.safeAreaInsets, ['bottom', 'left', 'right', 'top']);
  const deviceCapabilities = jsonRecord(record.deviceCapabilities);
  const styles = jsonRecord(record.styles);
  if (
    availableDisplayModes === undefined || !availableDisplayModes.includes(record.displayMode) || containerDimensions === undefined || safeAreaInsets === undefined ||
    !finiteNonnegative(containerDimensions.height) || !finiteNonnegative(containerDimensions.width) ||
    !finiteNonnegative(safeAreaInsets.bottom) || !finiteNonnegative(safeAreaInsets.left) ||
    !finiteNonnegative(safeAreaInsets.right) || !finiteNonnegative(safeAreaInsets.top) ||
    deviceCapabilities === undefined || styles === undefined
  ) {
    return invalidShape();
  }
  return Object.freeze({
    availableDisplayModes,
    containerDimensions: Object.freeze({ height: containerDimensions.height, width: containerDimensions.width }),
    deviceCapabilities,
    displayMode: record.displayMode,
    locale: record.locale,
    platform: record.platform,
    safeAreaInsets: Object.freeze({
      bottom: safeAreaInsets.bottom,
      left: safeAreaInsets.left,
      right: safeAreaInsets.right,
      top: safeAreaInsets.top,
    }),
    styles,
    theme: record.theme,
    timeZone: record.timeZone,
    userAgent: record.userAgent,
  });
};

const createRequest = (value: JsonObject, sessionId: string): Parameters<McpAppRoutePreviewService['create']>[0] => {
  if (!hasOnly(value, ['host', 'input', 'previewProfile', 'result', 'toolName']) || !nonemptyString(value.toolName)
    || !isJsonValue(value.input) || !isJsonValue(value.result) || (value.previewProfile !== 'portable' && value.previewProfile !== 'chatgpt' && value.previewProfile !== 'claude')) {
    return invalidShape();
  }
  return Object.freeze({
    host: hostContext(value.host),
    input: cloneJson(value.input),
    previewProfile: value.previewProfile,
    result: cloneJson(value.result),
    sessionId,
    toolName: value.toolName,
  });
};

const messageRequest = (value: JsonObject): McpAppJsonValue => {
  if (!hasOnly(value, ['message']) || !isJsonValue(value.message)) return invalidShape();
  return cloneJson(value.message);
};

const closeRequest = (value: JsonObject): McpAppBridgeCloseOptions => {
  if (!hasOnly(value, ['id', 'reason']) || !Object.hasOwn(value, 'id')) return invalidShape();
  const id = value.id;
  if (id !== null && (typeof id !== 'number' || !Number.isFinite(id)) && !nonemptyString(id)) return invalidShape();
  if (value.reason !== undefined && !nonemptyString(value.reason)) return invalidShape();
  return Object.freeze({ ...(value.reason === undefined ? {} : { reason: value.reason }), id: id as JsonRequestId });
};

const consentDecision = (value: JsonObject): Readonly<{ approved: boolean; challengeId: string }> => {
  if (!hasOnly(value, ['approved', 'challengeId']) || typeof value.approved !== 'boolean' || !nonemptyString(value.challengeId)) return invalidShape();
  return Object.freeze({ approved: value.approved, challengeId: value.challengeId });
};

const runtimeCreateRequest = (value: JsonObject): CreateMcpAppPreviewRequest => {
  if (!hasOnly(value, ['expectedGenerationId', 'profileId', 'runId']) || !nonemptyString(value.expectedGenerationId) || !nonemptyString(value.runId)
    || (value.profileId !== 'portable' && value.profileId !== 'chatgpt' && value.profileId !== 'claude')) return invalidShape();
  return Object.freeze({ expectedGenerationId: value.expectedGenerationId, profileId: value.profileId, runId: value.runId });
};

const runtimeOperation = (value: JsonObject): McpAppBindingOperation => {
  if (value.kind === 'tools/list' && hasOnly(value, ['kind'])) return Object.freeze({ kind: 'tools/list' });
  if (value.kind === 'resources/list' && hasOnly(value, ['kind'])) return Object.freeze({ kind: 'resources/list' });
  if (value.kind === 'resources/read' && hasOnly(value, ['kind', 'uri']) && nonemptyString(value.uri)) {
    return Object.freeze({ kind: 'resources/read', uri: value.uri });
  }
  if (value.kind === 'tools/call' && hasOnly(value, ['arguments', 'consentId', 'kind', 'name']) && nonemptyString(value.name)
    && (value.arguments === undefined || isJsonValue(value.arguments)) && (value.consentId === undefined || nonemptyString(value.consentId))) {
    return Object.freeze({
      ...(value.arguments === undefined ? {} : { arguments: cloneJson(value.arguments) }),
      ...(value.consentId === undefined ? {} : { consentId: value.consentId }),
      kind: 'tools/call', name: value.name,
    });
  }
  return invalidShape();
};

const runtimeConsentRequest = (value: JsonObject): McpAppConsentRequest => {
  if (!hasOnly(value, ['actionFingerprint', 'capability', 'details', 'scope', 'summary']) || !nonemptyString(value.actionFingerprint)
    || !nonemptyString(value.summary) || !isJsonValue(value.details) || (value.scope !== 'action' && value.scope !== 'document')
    || !isMcpAppConsentCapability(value.capability)) return invalidShape();
  return Object.freeze({ actionFingerprint: value.actionFingerprint, capability: value.capability, details: cloneJson(value.details), scope: value.scope, summary: value.summary });
};

const runtimeConsentDecision = (value: JsonObject): 'allow-once' | 'deny' => {
  if (!hasOnly(value, ['decision']) || (value.decision !== 'allow-once' && value.decision !== 'deny')) return invalidShape();
  return value.decision;
};

const previewSnapshot = (preview: McpAppRoutePreview): Readonly<Record<string, unknown>> => Object.freeze({
  bindingId: preview.binding.id,
  ...(preview.frame === undefined ? {} : { frame: preview.frame }),
  profile: preview.profile,
  resource: preview.resource,
});

const bridgeHostContext = (host: McpAppPreviewHostContext): McpAppBridgeJsonRecord => Object.freeze({
  availableDisplayModes: host.availableDisplayModes,
  containerDimensions: host.containerDimensions,
  deviceCapabilities: host.deviceCapabilities,
  displayMode: host.displayMode,
  locale: host.locale,
  platform: host.platform,
  safeAreaInsets: host.safeAreaInsets,
  styles: host.styles,
  theme: host.theme,
  timeZone: host.timeZone,
  userAgent: host.userAgent,
});

/** Authenticated HTTP boundary for already-bound MCP App previews. */
export class McpAppRoutes {
  readonly #authorize: (request: IncomingMessage) => void;
  readonly #gracefulCloseReceiptTimeoutMs: number;
  readonly #service: McpAppRoutePreviewService | undefined;
  readonly #tails = new Map<string, Promise<void>>();
  readonly #teardowns = new Map<string, ReturnType<typeof setTimeout>>();
  #closed = false;

  constructor(options: McpAppRoutesOptions) {
    this.#authorize = options.authorize;
    this.#gracefulCloseReceiptTimeoutMs = options.gracefulCloseReceiptTimeoutMs ?? gracefulCloseReceiptTimeoutMs;
    this.#service = options.service;
  }

  close(): void {
    this.#closed = true;
    this.#tails.clear();
    for (const receipt of this.#teardowns.values()) clearTimeout(receipt);
    this.#teardowns.clear();
  }

  async handle(request: IncomingMessage, response: ServerResponse): Promise<boolean> {
    const parsed = route(request.url);
    if (parsed === undefined) return false;
    this.#authorize(request);
    if (this.#closed) throw requestError(diagnostic('AB8022', 'MCP App routes are not available.', 503));
    const service = this.#service;
    if (service === undefined) throw requestError(diagnostic('AB8022', 'MCP App routes are not available.', 404));
    try {
      await this.#dispatch(parsed, request, response, service);
    } catch (error) {
      if (isRequestDiagnostic(error)) throw error;
      if (error instanceof McpAppRuntimePreviewError) {
        throw requestError(diagnostic(error.code, error.message, error.status));
      }
      throw requestError(diagnostic('AB8023', 'MCP App operation could not be completed.', 502));
    }
    return true;
  }

  async #dispatch(
    parsed: Route,
    request: IncomingMessage,
    response: ServerResponse,
    service: McpAppRoutePreviewService,
  ): Promise<void> {
    const method = request.method ?? 'GET';
    if (isRuntimeRoute(parsed)) return this.#dispatchRuntime(parsed, request, response, service.runtime);
    if (parsed.kind === 'create') {
      if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      const preview = await service.create(createRequest(await jsonBody(request), parsed.sessionId));
      return responseJson(response, { lifecycle: preview.bridge.lifecycle, preview: previewSnapshot(preview) });
    }
    if (parsed.kind === 'force-close') {
      if (method !== 'DELETE') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      await this.#serialize(parsed.bindingId, async () => {
        const gracefulCloseAccepted = this.#teardowns.has(parsed.bindingId);
        const closed = await service.forceClose(parsed.bindingId);
        if (!closed && !gracefulCloseAccepted) this.#unavailable();
        this.#clearTeardown(parsed.bindingId);
      });
      return responseJson(response, { closed: true, lifecycle: 'closed' });
    }
    if (parsed.kind === 'consent') {
      const preview = this.#preview(service, parsed.bindingId);
      if (method === 'GET') {
        const challenges = service.consentChallenges?.(parsed.bindingId);
        if (challenges === undefined) this.#unavailable();
        return responseJson(response, { challenges, lifecycle: preview.bridge.lifecycle });
      }
      if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      const decision = consentDecision(await jsonBody(request));
      const approved = await service.decideConsent?.(parsed.bindingId, decision.challengeId, decision.approved) ?? false;
      const refreshed = service.get(parsed.bindingId);
      if (refreshed === undefined) this.#unavailable();
      // A rejected-but-recognized action decision may carry the bridge's
      // terminal -32001 response. Forged/replayed decisions drain nothing.
      const messages = await service.takeOutbound(parsed.bindingId);
      return responseJson(response, { approved, lifecycle: refreshed.bridge.lifecycle, messages, preview: previewSnapshot(refreshed) });
    }
    if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
    if (parsed.kind === 'close') {
      const result = await this.#serialize(parsed.bindingId, async () => {
        const options = closeRequest(await jsonBody(request));
        const preview = this.#preview(service, parsed.bindingId);
        if (this.#teardowns.has(parsed.bindingId)) return Object.freeze({ lifecycle: preview.bridge.lifecycle, started: false });
        const close = await service.close(parsed.bindingId, options);
        if (close === false) this.#unavailable();
        this.#rememberTeardown(parsed.bindingId);
        const lifecycle = preview.bridge.lifecycle === 'closed' ? 'closed' : 'closing';
        return Object.freeze({
          lifecycle,
          ...(close === true ? {} : { message: close }),
          started: true,
        });
      });
      return responseJson(response, {
        actions: [],
        lifecycle: result.lifecycle,
        ...(result.started ? { message: result.message } : {}),
      });
    }
    if (parsed.kind === 'messages') {
      const result = await this.#serialize(parsed.bindingId, async () => {
        const preview = this.#preview(service, parsed.bindingId);
        const accepted = await service.receive(parsed.bindingId, messageRequest(await jsonBody(request)));
        const messages = await service.takeOutbound(parsed.bindingId);
        if (preview.bridge.lifecycle === 'closed') {
          this.#clearTeardown(parsed.bindingId);
        }
        return Object.freeze({ accepted, actions: Object.freeze([]), lifecycle: preview.bridge.lifecycle, messages });
      });
      return responseJson(response, result);
    }
    const result = await this.#serialize(parsed.bindingId, async () => {
      const preview = this.#preview(service, parsed.bindingId);
      const body = await jsonBody(request);
      if (!hasOnly(body, ['host'])) invalidShape();
      const accepted = preview.bridge.publishHostContextChanged(bridgeHostContext(hostContext(body.host)));
      const messages = await service.takeOutbound(parsed.bindingId);
      return Object.freeze({ accepted, actions: Object.freeze([]), lifecycle: preview.bridge.lifecycle, messages });
    });
    return responseJson(response, result);
  }

  async #dispatchRuntime(
    parsed: RuntimeCreateRoute | RuntimeBindingRoute | RuntimeConsentRoute,
    request: IncomingMessage,
    response: ServerResponse,
    runtime: McpAppRuntimeRoutePreviewService | undefined,
  ): Promise<void> {
    if (runtime === undefined) return this.#unavailable();
    const method = request.method ?? 'GET';
    if (parsed.kind === 'runtime-create') {
      if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      return responseJson(response, { preview: await runtime.create(runtimeCreateRequest(await jsonBody(request))) });
    }
    if (parsed.kind === 'runtime-get') {
      if (method === 'DELETE') {
        if (runtime.get(parsed.bindingId) === undefined && runtime.isRevoked?.(parsed.bindingId) !== true) {
          this.#runtimeUnavailable(runtime, parsed.bindingId);
        }
        await runtime.close(parsed.bindingId);
        return responseJson(response, { closed: true });
      }
      if (method !== 'GET') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      const preview = runtime.get(parsed.bindingId);
      if (preview === undefined) this.#runtimeUnavailable(runtime, parsed.bindingId);
      response.writeHead(200, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8', 'x-content-type-options': 'nosniff' });
      response.end(JSON.stringify({ preview }));
      return;
    }
    if (parsed.kind === 'runtime-close') {
      if (method !== 'DELETE') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      await runtime.close(parsed.bindingId);
      return responseJson(response, { closed: true });
    }
    if (parsed.kind === 'runtime-operation') {
      if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      if (runtime.get(parsed.bindingId) === undefined) this.#runtimeUnavailable(runtime, parsed.bindingId);
      const cancellation = requestAbort(request, response);
      try {
        return runtimeOperationResponseJson(response, await runtime.operate(parsed.bindingId, runtimeOperation(await jsonBody(request)), Object.freeze({ signal: cancellation.signal })));
      } finally {
        cancellation.dispose();
      }
    }
    if (parsed.kind === 'runtime-consent-create') {
      if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      if (runtime.get(parsed.bindingId) === undefined) this.#runtimeUnavailable(runtime, parsed.bindingId);
      return responseJson(response, await runtime.createConsent(parsed.bindingId, runtimeConsentRequest(await jsonBody(request))));
    }
    if (parsed.kind !== 'runtime-consent-decide') throw new Error('Runtime MCP App route is not valid.');
    if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
    if (runtime.get(parsed.bindingId) === undefined) this.#runtimeUnavailable(runtime, parsed.bindingId);
    return responseJson(response, await runtime.decideConsent(parsed.bindingId, parsed.consentId, runtimeConsentDecision(await jsonBody(request))));
  }

  #preview(service: McpAppRoutePreviewService, bindingId: string): McpAppRoutePreview {
    return service.get(bindingId) ?? this.#unavailable();
  }

  #unavailable(): never {
    throw requestError(diagnostic('AB8022', 'MCP App preview is not available.', 404));
  }

  #runtimeUnavailable(runtime: McpAppRuntimeRoutePreviewService, bindingId: string): never {
    if (runtime.isRevoked?.(bindingId) === true) {
      throw requestError(diagnostic('AB8022', 'Runtime MCP App preview was revoked.', 410));
    }
    return this.#unavailable();
  }

  #clearTeardown(bindingId: string): void {
    const receipt = this.#teardowns.get(bindingId);
    if (receipt !== undefined) clearTimeout(receipt);
    this.#teardowns.delete(bindingId);
  }

  #rememberTeardown(bindingId: string): void {
    if (this.#closed) return;
    const receipt = setTimeout(() => {
      if (this.#teardowns.get(bindingId) === receipt) this.#teardowns.delete(bindingId);
    }, this.#gracefulCloseReceiptTimeoutMs);
    this.#teardowns.set(bindingId, receipt);
  }

  #serialize<T>(bindingId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(bindingId) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#tails.set(bindingId, tail);
    void tail.finally(() => {
      if (this.#tails.get(bindingId) === tail) this.#tails.delete(bindingId);
    });
    return result;
  }

}
