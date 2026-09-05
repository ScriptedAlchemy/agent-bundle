import { MCP_APP_PROTOCOL_VERSION } from '../contracts/mcp-app-protocol.ts';
import {
  type JsonObject,
  type JsonValue,
  isPlainDataRecord,
  ownDataValue,
  snapshotStrictJsonValue,
} from '../core/strict-json.ts';
import { parseMcpRouteProtocolId } from '../routes/protocol-name.ts';

export const APP_PROTOCOL_VERSION = MCP_APP_PROTOCOL_VERSION;

export type AppClientErrorCode =
  | 'timeout'
  | 'aborted'
  | 'disposed'
  | 'connection-rebound'
  | 'invalid-message'
  | 'rpc'
  | 'capability-unavailable'
  | 'consent-required';

export class AppClientError extends Error {
  readonly code: AppClientErrorCode;
  readonly data?: JsonValue;
  readonly rpcCode?: number;

  constructor(
    code: AppClientErrorCode,
    message: string,
    options: Readonly<{ data?: JsonValue; rpcCode?: number }> = {},
  ) {
    super(message);
    this.name = 'AppClientError';
    this.code = code;
    this.data = options.data;
    this.rpcCode = options.rpcCode;
  }
}

export interface AppRouteContract {
  readonly input: unknown;
  readonly result: unknown;
}

/** Project-generated declarations augment this interface with `routes`. */
// rslint-disable-next-line @typescript-eslint/no-empty-object-type -- declaration-merge extension point
export interface AppRegister {}

export type AppRoutes = AppRegister extends {
  readonly routes: infer Routes;
}
  ? Routes extends { readonly [Id in keyof Routes]: AppRouteContract }
    ? Routes
    : never
  : unknown;

export type AppRouteId = unknown extends AppRoutes
  ? `tool:${string}/${string}`
  : Extract<keyof AppRoutes, `tool:${string}/${string}`> & string;

export type AppRouteInput<Id extends string> = Id extends keyof AppRoutes
  ? AppRoutes[Id] extends AppRouteContract ? AppRoutes[Id]['input'] : unknown
  : unknown;

export type AppRouteResult<Id extends string> = Id extends keyof AppRoutes
  ? AppRoutes[Id] extends AppRouteContract ? AppRoutes[Id]['result'] : unknown
  : unknown;

export interface AppImplementation {
  readonly name: string;
  readonly version: string;
}

export interface AppMessageEvent {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
}

export interface AppMessageTarget {
  postMessage(message: JsonObject, targetOrigin: string): void;
}

export interface AppWindow {
  readonly parent: AppMessageTarget;
  addEventListener(type: 'message', listener: (event: AppMessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: AppMessageEvent) => void): void;
}

export interface AppConnectOptions {
  readonly parent?: AppMessageTarget;
  readonly targetOrigin?: string;
  readonly window?: AppWindow;
}

export interface CreateAppClientOptions extends AppConnectOptions {
  readonly appCapabilities?: JsonObject;
  readonly appInfo?: AppImplementation;
  readonly timeoutMs?: number;
}

export interface AppAbortSignal {
  readonly aborted: boolean;
  addEventListener(
    type: 'abort',
    listener: () => void,
    options?: Readonly<{ once?: boolean }>,
  ): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

export interface AppRequestOptions {
  readonly signal?: AppAbortSignal;
  readonly timeoutMs?: number;
}

export interface AppInitializeResult extends JsonObject {
  readonly hostCapabilities: JsonObject;
  readonly hostContext: JsonObject;
  readonly hostInfo: JsonObject;
  readonly protocolVersion: typeof APP_PROTOCOL_VERSION;
}

export type AppToolInputListener<Id extends string> = (
  input: AppRouteInput<Id>,
) => Promise<void> | void;

export type AppToolResultListener<Id extends string> = (
  result: AppRouteResult<Id>,
) => Promise<void> | void;

export type AppToolErrorListener = (
  error: AppClientError,
) => Promise<void> | void;

export type AppToolCancelledListener = (
  event: Readonly<{ reason?: string }>,
) => Promise<void> | void;

export interface AppClient {
  readonly connected: boolean;
  readonly disposed: boolean;
  connect(options?: AppRequestOptions): Promise<AppInitializeResult>;
  request<Result extends JsonValue = JsonValue>(
    method: string,
    params?: JsonObject,
    options?: AppRequestOptions,
  ): Promise<Result>;
  call<Id extends AppRouteId>(
    routeId: Id,
    input: AppRouteInput<Id>,
    options?: AppRequestOptions,
  ): Promise<AppRouteResult<Id>>;
  onToolInput<Id extends AppRouteId>(
    routeId: Id,
    listener: AppToolInputListener<Id>,
  ): () => void;
  onToolResult<Id extends AppRouteId>(
    routeId: Id,
    listener: AppToolResultListener<Id>,
  ): () => void;
  onToolError<Id extends AppRouteId>(
    routeId: Id,
    listener: AppToolErrorListener,
  ): () => void;
  onToolCancelled(listener: AppToolCancelledListener): () => void;
  rebind(options?: AppConnectOptions): Promise<AppInitializeResult>;
  dispose(): void;
}

interface RpcError {
  readonly code: number;
  readonly data?: JsonValue;
  readonly message: string;
}

interface RpcMessage {
  readonly error?: RpcError;
  readonly id?: null | number | string;
  readonly jsonrpc: '2.0';
  readonly method?: string;
  readonly params?: JsonValue;
  readonly result?: JsonValue;
}

interface PendingRequest {
  readonly initialize: boolean;
  readonly reject: (error: AppClientError) => void;
  readonly resolve: (value: JsonValue) => void;
  readonly signal?: AppAbortSignal;
  readonly timeout: ReturnType<typeof setTimeout>;
  readonly abort?: () => void;
}

type AnyListener = (value: unknown) => Promise<void> | void;

const allowedMessageKeys = Object.freeze(['error', 'id', 'jsonrpc', 'method', 'params', 'result']);
const allowedErrorKeys = Object.freeze(['code', 'data', 'message']);
const defaultTimeoutMs = 15_000;
const maximumTimeoutMs = 2_147_483_647;

const hasOwn = (value: object, key: string): boolean => Object.hasOwn(value, key);

const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

const requestId = (value: unknown): value is null | number | string =>
  value === null || typeof value === 'string' ||
  (typeof value === 'number' && Number.isFinite(value));

const timeoutValue = (value: number | undefined, fallback: number): number => {
  const timeout = value ?? fallback;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > maximumTimeoutMs) {
    throw new RangeError(`App client timeout must be an integer from 1 to ${String(maximumTimeoutMs)} ms.`);
  }
  return timeout;
};

const trustedOrigin = (value: string | undefined): string | undefined => {
  if (value === undefined) return undefined;
  if (value === '*' || value === 'null' || !nonempty(value)) {
    throw new TypeError('App client targetOrigin must be an exact trusted origin.');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError('App client targetOrigin must be an exact trusted origin.');
  }
  if (parsed.origin !== value || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new TypeError('App client targetOrigin must be an exact trusted http: or https: origin.');
  }
  return value;
};

const currentWindow = (): AppWindow => {
  const candidate = (globalThis as { readonly window?: AppWindow }).window;
  if (candidate === undefined) {
    throw new TypeError('App client requires a browser window or an injected window option.');
  }
  return candidate;
};

const rpcMessage = (value: unknown): RpcMessage | undefined => {
  let snapshot: JsonValue;
  try {
    snapshot = snapshotStrictJsonValue(value);
  } catch {
    return undefined;
  }
  if (!isPlainDataRecord(snapshot) || snapshot.jsonrpc !== '2.0') return undefined;
  const keys = Object.keys(snapshot);
  if (keys.some((key) => !allowedMessageKeys.includes(key))) return undefined;
  const hasMethod = hasOwn(snapshot, 'method');
  const hasResult = hasOwn(snapshot, 'result');
  const hasError = hasOwn(snapshot, 'error');
  if (Number(hasMethod) + Number(hasResult) + Number(hasError) !== 1) return undefined;
  if (hasOwn(snapshot, 'id') && !requestId(snapshot.id)) return undefined;
  if (hasMethod) {
    if (!nonempty(snapshot.method) || hasResult || hasError) return undefined;
    if (hasOwn(snapshot, 'params') && !isPlainDataRecord(snapshot.params)) return undefined;
    return snapshot as unknown as RpcMessage;
  }
  if (!hasOwn(snapshot, 'id') || hasOwn(snapshot, 'params')) return undefined;
  if (hasError) {
    if (!isPlainDataRecord(snapshot.error)) return undefined;
    if (
      Object.keys(snapshot.error).some((key) => !allowedErrorKeys.includes(key)) ||
      typeof snapshot.error.code !== 'number' ||
      !Number.isFinite(snapshot.error.code) ||
      !nonempty(snapshot.error.message)
    ) {
      return undefined;
    }
  }
  return snapshot as unknown as RpcMessage;
};

const candidateId = (value: unknown): null | number | string | undefined => {
  if (!isPlainDataRecord(value)) return undefined;
  const jsonrpc = ownDataValue(value, 'jsonrpc');
  const id = ownDataValue(value, 'id');
  if (jsonrpc?.found !== true || jsonrpc.value !== '2.0' || id?.found !== true || !requestId(id.value)) {
    return undefined;
  }
  return id.value;
};

const initializeResult = (value: JsonValue): AppInitializeResult | undefined => {
  if (!isPlainDataRecord(value) || value.protocolVersion !== APP_PROTOCOL_VERSION) return undefined;
  if (
    !isPlainDataRecord(value.hostCapabilities) ||
    !isPlainDataRecord(value.hostContext) ||
    !isPlainDataRecord(value.hostInfo) ||
    !nonempty(value.hostInfo.name) ||
    !nonempty(value.hostInfo.version)
  ) {
    return undefined;
  }
  return value as AppInitializeResult;
};

const toolResultEnvelope = (value: JsonValue): JsonObject | undefined => {
  if (!isPlainDataRecord(value) || !Array.isArray(value.content)) return undefined;
  if (!value.content.every((block) => isPlainDataRecord(block) && nonempty(block.type))) return undefined;
  if (value.isError !== undefined && typeof value.isError !== 'boolean') return undefined;
  if (value._meta !== undefined && !isPlainDataRecord(value._meta)) return undefined;
  return value;
};

const errorFromRpc = (error: RpcError): AppClientError => {
  const code: AppClientErrorCode = error.code === -32601
    ? 'capability-unavailable'
    : error.code === -32001 ? 'consent-required' : 'rpc';
  return new AppClientError(code, error.message, {
    ...(error.data === undefined ? {} : { data: error.data }),
    rpcCode: error.code,
  });
};

const routeToolName = (routeId: string): string => {
  const identity = parseMcpRouteProtocolId(routeId);
  if (identity?.kind !== 'tool') {
    throw new TypeError(`App client route id ${JSON.stringify(routeId)} must use tool:<server>/<name>.`);
  }
  return identity.name;
};

const invokeListener = (listener: AnyListener, value: unknown): void => {
  void Promise.resolve().then(() => listener(value)).catch(() => undefined);
};

export const createAppClient = (options: CreateAppClientOptions = {}): AppClient => {
  let boundWindow = options.window ?? currentWindow();
  let parent = options.parent ?? boundWindow.parent;
  let configuredOrigin = trustedOrigin(options.targetOrigin);
  let pinnedOrigin = configuredOrigin;
  let nextId = 0;
  let connectionGeneration = 0;
  let connection: Promise<AppInitializeResult> | undefined;
  let connectedResult: AppInitializeResult | undefined;
  let openingToolName: string | undefined;
  let isDisposed = false;
  const timeoutMs = timeoutValue(options.timeoutMs, defaultTimeoutMs);
  const appInfo = snapshotStrictJsonValue(options.appInfo ?? { name: 'agent-bundle-app', version: '1.0.0' });
  const appCapabilities = snapshotStrictJsonValue(options.appCapabilities ?? {});
  if (
    !isPlainDataRecord(appInfo) ||
    !nonempty(appInfo.name) ||
    !nonempty(appInfo.version) ||
    !isPlainDataRecord(appCapabilities)
  ) {
    throw new TypeError('App client appInfo and appCapabilities must be finite JSON objects.');
  }

  const pending = new Map<null | number | string, PendingRequest>();
  const inputListeners = new Map<string, Set<AnyListener>>();
  const resultListeners = new Map<string, Set<AnyListener>>();
  const errorListeners = new Map<string, Set<AnyListener>>();
  const cancelledListeners = new Set<AnyListener>();

  const post = (message: JsonObject, targetOrigin: string): void => {
    try {
      parent.postMessage(message, targetOrigin);
    } catch {
      throw new AppClientError('invalid-message', 'The App host rejected a JSON-RPC message.');
    }
  };

  const clearPending = (id: null | number | string): PendingRequest | undefined => {
    const request = pending.get(id);
    if (request === undefined) return undefined;
    pending.delete(id);
    clearTimeout(request.timeout);
    if (request.abort !== undefined && request.signal !== undefined) {
      request.signal.removeEventListener('abort', request.abort);
    }
    return request;
  };

  const notifyCancelled = (id: null | number | string, reason: string): void => {
    if (connectedResult === undefined || pinnedOrigin === undefined) return;
    try {
      post({
        jsonrpc: '2.0',
        method: 'notifications/cancelled',
        params: { reason, requestId: id },
      }, pinnedOrigin);
    } catch {
      // The original timeout or abort remains the observable request failure.
    }
  };

  const rejectPending = (
    code: AppClientErrorCode,
    message: string,
    cancellationReason?: string,
  ): void => {
    for (const id of [...pending.keys()]) {
      if (cancellationReason !== undefined) notifyCancelled(id, cancellationReason);
      clearPending(id)?.reject(new AppClientError(code, message));
    }
  };

  const sendResponse = (id: null | number | string, result: JsonObject): void => {
    if (pinnedOrigin === undefined) return;
    post({ id, jsonrpc: '2.0', result }, pinnedOrigin);
  };

  const publishOpening = (listeners: Map<string, Set<AnyListener>>, value: unknown): void => {
    if (openingToolName === undefined) return;
    for (const [routeId, registered] of listeners) {
      if (routeToolName(routeId) !== openingToolName) continue;
      for (const listener of [...registered]) invokeListener(listener, value);
    }
  };

  const dispose = (): void => {
    if (isDisposed) return;
    isDisposed = true;
    connectionGeneration += 1;
    boundWindow.removeEventListener('message', receive);
    rejectPending('disposed', 'The App client was disposed.', 'disposed');
    connection = undefined;
    connectedResult = undefined;
    openingToolName = undefined;
    pinnedOrigin = undefined;
    inputListeners.clear();
    resultListeners.clear();
    errorListeners.clear();
    cancelledListeners.clear();
  };

  const receive = (event: AppMessageEvent): void => {
    if (isDisposed || event.source !== parent) return;
    if (pinnedOrigin !== undefined && event.origin !== pinnedOrigin) return;
    const message = rpcMessage(event.data);
    if (message === undefined) {
      const id = candidateId(event.data);
      if (id !== undefined && pending.has(id)) {
        clearPending(id)?.reject(new AppClientError('invalid-message', 'The App host returned an invalid JSON-RPC response.'));
      }
      return;
    }

    if (message.method === undefined) {
      const request = message.id === undefined ? undefined : clearPending(message.id);
      if (request === undefined) return;
      let responseOrigin: string | undefined;
      if (request.initialize && configuredOrigin === undefined) {
        try {
          responseOrigin = trustedOrigin(event.origin);
        } catch {
          request.reject(new AppClientError('invalid-message', 'The App host returned an unpinnable origin.'));
          return;
        }
      }
      if (message.error !== undefined) {
        request.reject(errorFromRpc(message.error));
        return;
      }
      if (message.result === undefined) {
        request.reject(new AppClientError('invalid-message', 'The App host response did not contain a result.'));
        return;
      }
      if (request.initialize && initializeResult(message.result) === undefined) {
        request.reject(new AppClientError('invalid-message', `The App host did not negotiate protocol ${APP_PROTOCOL_VERSION}.`));
        return;
      }
      if (responseOrigin !== undefined) pinnedOrigin = responseOrigin;
      request.resolve(message.result);
      return;
    }

    if (pinnedOrigin === undefined || connectedResult === undefined) return;
    if (message.id !== undefined) {
      if (message.method === 'ui/resource-teardown') {
        try {
          sendResponse(message.id, {});
        } finally {
          dispose();
        }
        return;
      }
      post({
        error: { code: -32601, message: `${message.method} is not supported by this App client.` },
        id: message.id,
        jsonrpc: '2.0',
      }, pinnedOrigin);
      return;
    }
    if (message.method === 'ui/notifications/tool-input') {
      const params = isPlainDataRecord(message.params) ? message.params : undefined;
      if (params !== undefined && isPlainDataRecord(params.arguments)) {
        publishOpening(inputListeners, params.arguments);
      }
      return;
    }
    if (message.method === 'ui/notifications/tool-result') {
      const result = message.params === undefined ? undefined : toolResultEnvelope(message.params);
      if (result === undefined) {
        publishOpening(
          errorListeners,
          new AppClientError('invalid-message', 'The opening tool returned an invalid result.'),
        );
      } else if (result.isError === true) {
        publishOpening(
          errorListeners,
          new AppClientError('rpc', 'The opening tool returned an error.', { data: result }),
        );
      } else if (!isPlainDataRecord(result.structuredContent)) {
        publishOpening(
          errorListeners,
          new AppClientError('invalid-message', 'The opening tool did not return structured content.'),
        );
      } else {
        publishOpening(resultListeners, result.structuredContent);
      }
      return;
    }
    if (message.method === 'ui/notifications/tool-cancelled') {
      const params = message.params === undefined ? {} : message.params;
      if (!isPlainDataRecord(params) || (params.reason !== undefined && typeof params.reason !== 'string')) return;
      const eventValue = params.reason === undefined ? {} : { reason: params.reason };
      for (const listener of [...cancelledListeners]) invokeListener(listener, eventValue);
    }
  };

  boundWindow.addEventListener('message', receive);

  const sendRequest = (
    method: string,
    params: JsonObject | undefined,
    requestOptions: AppRequestOptions,
    initialize: boolean,
  ): Promise<JsonValue> => {
    if (isDisposed) return Promise.reject(new AppClientError('disposed', 'The App client was disposed.'));
    if (!nonempty(method)) return Promise.reject(new TypeError('App client request method must be nonempty.'));
    if (requestOptions.signal?.aborted === true) {
      return Promise.reject(new AppClientError('aborted', 'The App client request was aborted.'));
    }
    let snapshot: JsonObject | undefined;
    try {
      snapshot = params === undefined ? undefined : snapshotStrictJsonValue(params) as JsonObject;
    } catch {
      return Promise.reject(new AppClientError('invalid-message', 'App client request params must be finite strict JSON.'));
    }
    const id = ++nextId;
    const targetOrigin = initialize ? configuredOrigin ?? '*' : pinnedOrigin;
    if (targetOrigin === undefined) {
      return Promise.reject(new AppClientError('capability-unavailable', 'The App client is not connected.'));
    }
    return new Promise<JsonValue>((resolvePromise, rejectPromise) => {
      const timeout = setTimeout(() => {
        if (clearPending(id) === undefined) return;
        notifyCancelled(id, 'timeout');
        rejectPromise(new AppClientError('timeout', `App client request ${method} timed out.`));
      }, timeoutValue(requestOptions.timeoutMs, timeoutMs));
      const abort = requestOptions.signal === undefined ? undefined : (): void => {
        if (clearPending(id) === undefined) return;
        notifyCancelled(id, 'aborted');
        rejectPromise(new AppClientError('aborted', `App client request ${method} was aborted.`));
      };
      pending.set(id, {
        initialize,
        reject: rejectPromise,
        resolve: resolvePromise,
        signal: requestOptions.signal,
        timeout,
        ...(abort === undefined ? {} : { abort }),
      });
      requestOptions.signal?.addEventListener('abort', abort!, { once: true });
      try {
        post({
          id,
          jsonrpc: '2.0',
          method,
          ...(snapshot === undefined ? {} : { params: snapshot }),
        }, targetOrigin);
      } catch (error) {
        clearPending(id);
        rejectPromise(error instanceof AppClientError
          ? error
          : new AppClientError('invalid-message', 'The App request could not be sent.'));
      }
    });
  };

  const connect = (requestOptions: AppRequestOptions = {}): Promise<AppInitializeResult> => {
    if (isDisposed) return Promise.reject(new AppClientError('disposed', 'The App client was disposed.'));
    if (connectedResult !== undefined) return Promise.resolve(connectedResult);
    if (connection !== undefined) return connection;
    const generation = connectionGeneration;
    const connecting = sendRequest('ui/initialize', {
      appCapabilities,
      appInfo,
      protocolVersion: APP_PROTOCOL_VERSION,
    }, requestOptions, true).then((result) => {
      if (generation !== connectionGeneration || connection !== connecting) {
        throw new AppClientError('connection-rebound', 'The App client connection was rebound.');
      }
      const initialized = initializeResult(result);
      if (initialized === undefined || pinnedOrigin === undefined) {
        throw new AppClientError('invalid-message', 'The App host returned an invalid initialize result.');
      }
      post({ jsonrpc: '2.0', method: 'ui/notifications/initialized' }, pinnedOrigin);
      connectedResult = initialized;
      const toolInfo = isPlainDataRecord(initialized.hostContext.toolInfo)
        ? initialized.hostContext.toolInfo
        : undefined;
      const tool = toolInfo !== undefined && isPlainDataRecord(toolInfo.tool)
        ? toolInfo.tool
        : undefined;
      openingToolName = tool !== undefined && nonempty(tool.name) ? tool.name : undefined;
      return initialized;
    }).catch((error: unknown) => {
      if (connection === connecting) connection = undefined;
      throw error;
    });
    connection = connecting;
    return connecting;
  };

  const request = <Result extends JsonValue = JsonValue>(
    method: string,
    params?: JsonObject,
    requestOptions: AppRequestOptions = {},
  ): Promise<Result> => {
    if (connectedResult !== undefined) {
      return sendRequest(method, params, requestOptions, false) as Promise<Result>;
    }
    return connect(requestOptions).then(
      () => sendRequest(method, params, requestOptions, false) as Promise<Result>,
    );
  };

  const call = async <Id extends AppRouteId>(
    routeId: Id,
    input: AppRouteInput<Id>,
    requestOptions: AppRequestOptions = {},
  ): Promise<AppRouteResult<Id>> => {
    const name = routeToolName(routeId);
    let argumentsValue: JsonObject;
    try {
      const snapshot = snapshotStrictJsonValue(input);
      if (!isPlainDataRecord(snapshot)) throw new TypeError();
      argumentsValue = snapshot;
    } catch {
      throw new AppClientError('invalid-message', `Input for ${routeId} must be a finite strict JSON object.`);
    }
    const response = await request<JsonValue>('tools/call', { arguments: argumentsValue, name }, requestOptions);
    const result = toolResultEnvelope(response);
    if (result === undefined) {
      throw new AppClientError('invalid-message', `Tool ${routeId} returned an invalid result envelope.`);
    }
    if (result.isError === true) {
      throw new AppClientError('rpc', `Tool ${routeId} returned an error.`, { data: result });
    }
    if (!isPlainDataRecord(result.structuredContent)) {
      throw new AppClientError('invalid-message', `Tool ${routeId} returned an invalid structured result.`);
    }
    return result.structuredContent as AppRouteResult<Id>;
  };

  const register = (
    listeners: Map<string, Set<AnyListener>>,
    routeId: string,
    listener: AnyListener,
  ): (() => void) => {
    routeToolName(routeId);
    if (typeof listener !== 'function') throw new TypeError('App client listener must be a function.');
    const registered = listeners.get(routeId) ?? new Set<AnyListener>();
    registered.add(listener);
    listeners.set(routeId, registered);
    return (): void => {
      registered.delete(listener);
      if (registered.size === 0) listeners.delete(routeId);
    };
  };

  const client: AppClient = {
    get connected() { return connectedResult !== undefined; },
    get disposed() { return isDisposed; },
    connect,
    request,
    call,
    onToolInput: (routeId, listener) => register(inputListeners, routeId, listener as AnyListener),
    onToolResult: (routeId, listener) => register(resultListeners, routeId, listener as AnyListener),
    onToolError: (routeId, listener) => register(errorListeners, routeId, listener as AnyListener),
    onToolCancelled: (listener) => {
      if (typeof listener !== 'function') throw new TypeError('App client listener must be a function.');
      cancelledListeners.add(listener as AnyListener);
      return (): void => { cancelledListeners.delete(listener as AnyListener); };
    },
    async rebind(rebindOptions: AppConnectOptions = {}): Promise<AppInitializeResult> {
      if (isDisposed) throw new AppClientError('disposed', 'The App client was disposed.');
      const nextOrigin = hasOwn(rebindOptions, 'targetOrigin')
        ? trustedOrigin(rebindOptions.targetOrigin)
        : configuredOrigin;
      connectionGeneration += 1;
      rejectPending(
        'connection-rebound',
        'The App client connection was rebound.',
        'connection-rebound',
      );
      connection = undefined;
      connectedResult = undefined;
      openingToolName = undefined;
      pinnedOrigin = undefined;
      const replacementWindow = rebindOptions.window ?? boundWindow;
      if (replacementWindow !== boundWindow) {
        boundWindow.removeEventListener('message', receive);
        boundWindow = replacementWindow;
        boundWindow.addEventListener('message', receive);
      }
      parent = rebindOptions.parent ?? boundWindow.parent;
      configuredOrigin = nextOrigin;
      pinnedOrigin = configuredOrigin;
      return await connect();
    },
    dispose,
  };
  return Object.freeze(client);
};
