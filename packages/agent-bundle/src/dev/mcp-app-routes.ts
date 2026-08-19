import type { IncomingMessage, ServerResponse } from 'node:http';

import type { McpAppJsonValue, McpAppPreviewProfile } from './mcp-app-binding-service.ts';
import type { McpAppBridgeCloseOptions, McpAppBridgeJsonRecord, McpAppBridgeLifecycle } from './mcp-app-bridge.ts';
import type { McpAppPreviewCloseResult, McpAppPreviewHostContext } from './mcp-app-preview-service.ts';
import type { McpAppSandboxConsent } from './mcp-app-sandbox.ts';
import {
  decodedOpaqueSegment,
  diagnostic,
  hasOnly,
  isJsonRequest,
  isRequestDiagnostic,
  nonemptyString,
  rawPathname,
  readBody,
  requestError,
  responseDiagnostic,
  responseJson,
} from './http.ts';

const gracefulCloseReceiptTimeoutMs = 5_000;

interface CreateRoute {
  readonly kind: 'create';
  readonly sessionId: string;
}

interface BindingRoute {
  readonly bindingId: string;
  readonly kind: 'messages' | 'host-context' | 'close' | 'force-close';
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
  create(options: {
    readonly consent?: McpAppSandboxConsent;
    readonly host: McpAppPreviewHostContext;
    readonly input: McpAppJsonValue;
    readonly previewProfile: McpAppPreviewProfile;
    readonly result: McpAppJsonValue;
    readonly sessionId: string;
    readonly toolName: string;
  }): Promise<McpAppRoutePreview>;
  forceClose(bindingId: string): Promise<boolean>;
  get(bindingId: string): McpAppRoutePreview | undefined;
  receive(bindingId: string, action: unknown): Promise<boolean>;
  takeOutbound(bindingId: string): Promise<readonly unknown[]>;
}

export interface McpAppRoutesOptions {
  readonly authorize: (request: IncomingMessage) => void;
  readonly service?: McpAppRoutePreviewService;
}

const opaqueSegment = (value: string): string =>
  decodedOpaqueSegment(value, {
    code: 'AB8020',
    maxLength: 4_096,
    message: 'MCP App route path is not valid.',
    rejectBlank: true,
  });

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
  if (kind === 'messages' || kind === 'host-context' || kind === 'close') return Object.freeze({ bindingId, kind });
  if (kind === undefined || kind.length === 0) throw requestError(diagnostic('AB8020', 'MCP App route path is not valid.', 400));
  throw requestError(diagnostic('AB8020', 'MCP App route path is not valid.', 400));
};

const isRecord = (value: unknown): value is JsonObject =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

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

const consent = (value: unknown): McpAppSandboxConsent | undefined => {
  if (value === undefined) return undefined;
  const record = exactRecord(value, ['permissions']);
  if (record === undefined) return invalidShape();
  if (record.permissions === undefined) return Object.freeze({});
  const permissions = exactRecord(record.permissions, ['camera', 'clipboardWrite', 'geolocation', 'microphone']);
  if (permissions === undefined || Object.values(permissions).some((permission) => !isRecord(permission) || Object.keys(permission).length > 0)) {
    return invalidShape();
  }
  return Object.freeze({ permissions: Object.freeze({ ...permissions }) });
};

const createRequest = (value: JsonObject, sessionId: string): Parameters<McpAppRoutePreviewService['create']>[0] => {
  if (!hasOnly(value, ['consent', 'host', 'input', 'previewProfile', 'result', 'toolName']) || !nonemptyString(value.toolName)
    || !isJsonValue(value.input) || !isJsonValue(value.result) || (value.previewProfile !== 'portable' && value.previewProfile !== 'chatgpt' && value.previewProfile !== 'claude')) {
    return invalidShape();
  }
  return Object.freeze({
    ...(value.consent === undefined ? {} : { consent: consent(value.consent) }),
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
  readonly #service: McpAppRoutePreviewService | undefined;
  readonly #tails = new Map<string, Promise<void>>();
  readonly #teardowns = new Map<string, ReturnType<typeof setTimeout>>();
  #closed = false;

  constructor(options: McpAppRoutesOptions) {
    this.#authorize = options.authorize;
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
    }, gracefulCloseReceiptTimeoutMs);
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
