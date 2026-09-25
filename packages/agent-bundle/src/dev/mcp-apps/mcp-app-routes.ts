import type { IncomingMessage, ServerResponse } from 'node:http';

import type { McpAppJsonValue, McpAppPreviewProfile } from './mcp-app-binding-service.ts';
import type { McpAppBridgeCloseOptions, McpAppBridgeJsonRecord, McpAppBridgeLifecycle } from './mcp-app-bridge.ts';
import type { McpAppPreviewCloseResult, McpAppPreviewHostContext, McpAppPreviewTerminal } from './mcp-app-preview-service.ts';
import { hasOnlyOwnKeys } from '../../core/strict-json.ts';
import {
  diagnostic,
  isJsonRequest,
  isRequestDiagnostic,
  nonemptyString,
  rawPathname,
  readBody,
  requestError,
  responseDiagnostic,
  responseJson as writeJsonResponse,
} from '../http.ts';
import type { McpAppConsentChallenge } from './mcp-app-sandbox-types.ts';

// A force-close DELETE that lands after an accepted graceful close must stay
// idempotent (200, not 404), so this window has to dominate the frame relay's
// force-close budget — clients may fall back as late as their closeTimeoutMs,
// which web-host/browser/frame-relay.ts caps at 30s.
const gracefulCloseReceiptTimeoutMs = 35_000;

interface CreateRoute {
  readonly kind: 'create';
  readonly sessionId: string;
}

interface BindingRoute {
  readonly bindingId: string;
  readonly kind: 'messages' | 'host-context' | 'close' | 'force-close' | 'consent' | 'result';
}

type Route = CreateRoute | BindingRoute;
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
    /** Omitted for an opening call still in flight; `settle` publishes its outcome. */
    readonly result?: McpAppJsonValue;
    readonly sessionId: string;
    readonly toolName: string;
  }): Promise<McpAppRoutePreview>;
  settle?(bindingId: string, terminal: McpAppPreviewTerminal): Promise<boolean>;
  consentChallenges?(bindingId: string): readonly McpAppConsentChallenge[] | undefined;
  decideConsent?(bindingId: string, challengeId: string, approved: boolean): boolean | Promise<boolean>;
  forceClose(bindingId: string): Promise<boolean>;
  get(bindingId: string): McpAppRoutePreview | undefined;
  receive(bindingId: string, action: unknown): Promise<boolean>;
  takeOutbound(bindingId: string): Promise<readonly unknown[]>;
}

/** The tool call a host already made for a session, which a page may bind without re-sending it. */
export interface McpAppOpeningCall {
  readonly input: McpAppJsonValue;
  readonly result: McpAppJsonValue;
}

export interface McpAppRoutesOptions {
  readonly authorize: (request: IncomingMessage) => void;
  /**
   * The tool call the host performed itself when it opened a session (the
   * standalone `serve-app` host calls the opening tool once and seeds its
   * page with the result). A create request that omits `input` and `result`
   * binds to this call, so a large result is never round-tripped through the
   * browser and past the request-body bound (#562); without it, both fields
   * are required, as the Workbench sends them. `opening` is the opaque
   * per-page id a host that serves many pages over one session stamps into
   * each page's seed, so concurrent pages never bind each other's call; a
   * single-page host ignores it.
   */
  readonly openingCall?: (sessionId: string, toolName: string, opening: string | undefined) => McpAppOpeningCall | undefined;
  /**
   * Test-only override for the graceful-close receipt window. Production
   * callers must leave this unset so the window keeps dominating the frame
   * relay's force-close budget.
   */
  readonly gracefulCloseReceiptTimeoutMs?: number;
  readonly service?: McpAppRoutePreviewService;
}

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
  if (kind === 'messages' || kind === 'host-context' || kind === 'close' || kind === 'consent' || kind === 'result') return Object.freeze({ bindingId, kind });
  if (kind === undefined || kind.length === 0) throw requestError(diagnostic('AB8020', 'MCP App route path is not valid.', 400));
  throw requestError(diagnostic('AB8020', 'MCP App route path is not valid.', 400));
};

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const hasOnly: (value: JsonObject, fields: readonly string[]) => boolean = hasOnlyOwnKeys;

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

const createRequest = (
  value: JsonObject,
  sessionId: string,
  openingCall: McpAppRoutesOptions['openingCall'],
): Parameters<McpAppRoutePreviewService['create']>[0] => {
  if (!hasOnly(value, ['host', 'input', 'opening', 'previewProfile', 'result', 'toolName']) || !nonemptyString(value.toolName)
    || (value.previewProfile !== 'portable' && value.previewProfile !== 'chatgpt' && value.previewProfile !== 'claude')
    || (Object.hasOwn(value, 'opening') && !nonemptyString(value.opening))) {
    return invalidShape();
  }
  // A request carrying neither field binds the call the host already made
  // (optionally naming which one with `opening`); one carrying both is the
  // Workbench's own completed tool run, and one carrying only `input` is a
  // run still in flight whose outcome the `result` route settles (#751). A
  // result without its input is malformed.
  const carriesCall = Object.hasOwn(value, 'input') || Object.hasOwn(value, 'result');
  const call = carriesCall
    ? isJsonValue(value.input) && !Object.hasOwn(value, 'opening') && (!Object.hasOwn(value, 'result') || isJsonValue(value.result))
      ? { input: cloneJson(value.input), ...(Object.hasOwn(value, 'result') ? { result: cloneJson(value.result as McpAppJsonValue) } : {}) }
      : undefined
    : openingCall?.(sessionId, value.toolName, typeof value.opening === 'string' ? value.opening : undefined);
  if (call === undefined) return invalidShape();
  return Object.freeze({
    host: hostContext(value.host),
    input: call.input,
    previewProfile: value.previewProfile,
    ...(call.result === undefined ? {} : { result: call.result }),
    sessionId,
    toolName: value.toolName,
  });
};

const terminalRequest = (value: JsonObject): McpAppPreviewTerminal => {
  if (hasOnly(value, ['result']) && isJsonValue(value.result)) return Object.freeze({ result: cloneJson(value.result) });
  if (hasOnly(value, ['cancelled']) && nonemptyString(value.cancelled)) return Object.freeze({ cancelled: value.cancelled });
  return invalidShape();
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
  readonly #openingCall: McpAppRoutesOptions['openingCall'];
  readonly #service: McpAppRoutePreviewService | undefined;
  readonly #tails = new Map<string, Promise<void>>();
  readonly #teardowns = new Map<string, ReturnType<typeof setTimeout>>();
  #closed = false;

  constructor(options: McpAppRoutesOptions) {
    this.#authorize = options.authorize;
    this.#gracefulCloseReceiptTimeoutMs = options.gracefulCloseReceiptTimeoutMs ?? gracefulCloseReceiptTimeoutMs;
    this.#openingCall = options.openingCall;
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
    if (parsed.kind === 'create') {
      if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      const preview = await service.create(createRequest(await jsonBody(request), parsed.sessionId, this.#openingCall));
      return writeJsonResponse(response, { lifecycle: preview.bridge.lifecycle, preview: previewSnapshot(preview) });
    }
    if (parsed.kind === 'force-close') {
      if (method !== 'DELETE') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      await this.#serialize(parsed.bindingId, async () => {
        const gracefulCloseAccepted = this.#teardowns.has(parsed.bindingId);
        const closed = await service.forceClose(parsed.bindingId);
        if (!closed && !gracefulCloseAccepted) this.#unavailable();
        this.#clearTeardown(parsed.bindingId);
      });
      return writeJsonResponse(response, { closed: true, lifecycle: 'closed' });
    }
    if (parsed.kind === 'consent') {
      const preview = this.#preview(service, parsed.bindingId);
      if (method === 'GET') {
        const challenges = service.consentChallenges?.(parsed.bindingId);
        if (challenges === undefined) this.#unavailable();
        return writeJsonResponse(response, { challenges, lifecycle: preview.bridge.lifecycle });
      }
      if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      const decision = consentDecision(await jsonBody(request));
      const approved = await service.decideConsent?.(parsed.bindingId, decision.challengeId, decision.approved) ?? false;
      const refreshed = service.get(parsed.bindingId);
      if (refreshed === undefined) this.#unavailable();
      // A rejected-but-recognized action decision may carry the bridge's
      // terminal -32001 response. Forged/replayed decisions drain nothing.
      const messages = await service.takeOutbound(parsed.bindingId);
      return writeJsonResponse(response, { approved, lifecycle: refreshed.bridge.lifecycle, messages, preview: previewSnapshot(refreshed) });
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
      return writeJsonResponse(response, {
        actions: [],
        lifecycle: result.lifecycle,
        ...(result.started ? { message: result.message } : {}),
      });
    }
    if (parsed.kind === 'result') {
      if (method !== 'POST') return responseDiagnostic(response, diagnostic('AB8007', 'Route does not accept this method.', 405));
      const settle = service.settle;
      if (settle === undefined) return this.#unavailable();
      const result = await this.#serialize(parsed.bindingId, async () => {
        const preview = this.#preview(service, parsed.bindingId);
        const accepted = await settle.call(service, parsed.bindingId, terminalRequest(await jsonBody(request)));
        const messages = await service.takeOutbound(parsed.bindingId);
        return Object.freeze({ accepted, actions: Object.freeze([]), lifecycle: preview.bridge.lifecycle, messages });
      });
      return writeJsonResponse(response, result);
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
      return writeJsonResponse(response, result);
    }
    const result = await this.#serialize(parsed.bindingId, async () => {
      const preview = this.#preview(service, parsed.bindingId);
      const body = await jsonBody(request);
      if (!hasOnly(body, ['host'])) invalidShape();
      const accepted = preview.bridge.publishHostContextChanged(bridgeHostContext(hostContext(body.host)));
      const messages = await service.takeOutbound(parsed.bindingId);
      return Object.freeze({ accepted, actions: Object.freeze([]), lifecycle: preview.bridge.lifecycle, messages });
    });
    return writeJsonResponse(response, result);
  }

  #preview(service: McpAppRoutePreviewService, bindingId: string): McpAppRoutePreview {
    return service.get(bindingId) ?? this.#unavailable();
  }

  #unavailable(): never {
    throw requestError(diagnostic('AB8022', 'MCP App preview is not available.', 404));
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
