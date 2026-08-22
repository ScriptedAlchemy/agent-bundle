import { Buffer } from 'node:buffer';

import { CodedError } from '../../core/errors.ts';
import {
  selectMcpAppResourceUri,
  type McpAppBinding,
} from './mcp-app-binding-service.ts';
import {
  snapshotMcpAppJson,
  type McpAppJsonValue,
} from './mcp-app-json.ts';
import {
  MCP_APP_PROTOCOL_VERSION,
  cloneJson,
  hasOwn,
  initializedNotification,
  isInitialize,
  isRequestId,
  jsonRecord,
  messageOf,
  nonempty,
  parsedResource,
  validDisplayMode,
  validDisplayModeList,
  validHostCapabilities,
  validHostContext,
  validInitialize,
  validLog,
  validMessage,
  validMessageResult,
  validModelContext,
  validOpenLink,
  validResourceRead,
  validResourceReadResult,
  validSize,
  validToolCall,
  validToolResult,
  type McpAppBridgeDisplayMode,
  type McpAppBridgeHostInfo,
  type McpAppBridgeJsonRecord,
  type McpAppBridgeLogEvent,
  type McpAppBridgeMessage,
  type McpAppBridgeMessageEvent,
  type McpAppBridgeModelContext,
  type McpAppBridgeRequestId,
  type McpAppBridgeResourceRead,
  type McpAppBridgeSize,
  type McpAppBridgeToolCall,
} from './mcp-app-protocol.ts';
import type {
  McpAppSandboxCsp,
  McpAppSandboxPermissions,
} from './mcp-app-sandbox.ts';

export { MCP_APP_MIME_TYPE, MCP_APP_PROTOCOL_VERSION, MCP_APP_UI_EXTENSION } from './mcp-app-protocol.ts';
export type {
  McpAppBridgeDisplayMode,
  McpAppBridgeHostInfo,
  McpAppBridgeJsonRecord,
  McpAppBridgeLogEvent,
  McpAppBridgeMessage,
  McpAppBridgeMessageEvent,
  McpAppBridgeModelContext,
  McpAppBridgeRequestId,
  McpAppBridgeResourceRead,
  McpAppBridgeRpcError,
  McpAppBridgeSize,
  McpAppBridgeToolCall,
} from './mcp-app-protocol.ts';

export type McpAppBridgeLifecycle = 'created' | 'initializing' | 'initialized' | 'closing' | 'closed';
export type McpAppBridgeFallbackReason =
  | 'bridge-closed'
  | 'invalid-resource'
  | 'missing-canonical-resource-uri'
  | 'resource-read-failed';
export class McpAppBridgeCloseError extends CodedError<'binding-close-failed' | 'binding-close-rejected'> {
  readonly operation = 'closeBinding';

  constructor(code: McpAppBridgeCloseError['code']) {
    super(
      'McpAppBridgeCloseError',
      code,
      `MCP App binding ${code === 'binding-close-rejected' ? 'was already closed' : 'could not be released'}.`,
    );
  }
}

/**
 * The bridge deliberately receives only binding-scoped operations.  It cannot
 * access, restart, or close a shared MCP session directly.
 */
export interface McpAppBridgeBindingOperations {
  callTool(bindingId: string, request: McpAppBridgeToolCall): Promise<McpAppJsonValue>;
  closeBinding(bindingId: string): Promise<boolean>;
  readResource(bindingId: string, request: McpAppBridgeResourceRead): Promise<McpAppJsonValue>;
}

export interface McpAppBridgeHost {
  readonly capabilities?: McpAppBridgeJsonRecord;
  readonly context?: McpAppBridgeJsonRecord;
  readonly info: McpAppBridgeHostInfo;
  onDisplayMode?(mode: McpAppBridgeDisplayMode): Promise<McpAppBridgeDisplayMode> | McpAppBridgeDisplayMode;
  onLog?(event: McpAppBridgeLogEvent): Promise<void> | void;
  onMessage?(event: McpAppBridgeMessageEvent): Promise<McpAppJsonValue | void> | McpAppJsonValue | void;
  onModelContext?(context: McpAppBridgeModelContext): Promise<void> | void;
  onOpenLink?(url: string): Promise<void> | void;
  onSizeChanged?(size: McpAppBridgeSize): Promise<void> | void;
}

export interface McpAppBridgeResource {
  readonly csp?: McpAppSandboxCsp;
  readonly html: string;
  readonly kind: 'resource';
  readonly permissions?: McpAppSandboxPermissions;
}

export interface McpAppBridgeFallback {
  readonly input: McpAppJsonValue;
  readonly kind: 'fallback';
  readonly reason: McpAppBridgeFallbackReason;
  readonly result: McpAppJsonValue;
}

export type McpAppBridgeResourceResolution = McpAppBridgeResource | McpAppBridgeFallback;

export interface McpAppBridgeCloseOptions {
  readonly id: McpAppBridgeRequestId;
  readonly reason?: string;
}

export interface CreateMcpAppBridgeOptions {
  readonly binding: McpAppBinding;
  readonly host: McpAppBridgeHost;
  readonly maxQueuedHostMessageBytes?: number;
  readonly operations: McpAppBridgeBindingOperations;
  readonly send: (message: McpAppBridgeMessage) => boolean;
  readonly teardownTimeoutMs?: number;
}

export interface McpAppBridge {
  readonly lifecycle: McpAppBridgeLifecycle;
  close(options: McpAppBridgeCloseOptions): Promise<void>;
  forceClose(): Promise<void>;
  flushHostTraffic(): boolean;
  loadResource(): Promise<McpAppBridgeResourceResolution>;
  publishHostContextChanged(context: McpAppBridgeJsonRecord): boolean;
  publishToolCancelled(reason?: string): boolean;
  publishToolInput(argumentsValue?: McpAppBridgeJsonRecord): boolean;
  publishToolInputPartial(argumentsValue?: McpAppBridgeJsonRecord): boolean;
  publishToolResult(result: McpAppJsonValue): boolean;
  receive(message: unknown): Promise<boolean>;
}

interface BridgeBindingSnapshot {
  readonly id: string;
  readonly input: McpAppJsonValue;
  readonly resourceUri: string;
  readonly result: McpAppJsonValue;
  readonly toolDefinition: McpAppBinding['toolDefinition'];
}

interface QueuedHostMessage {
  byteLength: number;
  failedSendAttempts: number;
  readonly message: McpAppBridgeMessage;
}

const defaultTeardownTimeoutMs = 1_000;
const maximumTeardownTimeoutMs = 30_000;
const defaultMaximumQueuedHostMessageBytes = 1_048_576;
const maximumQueuedHostMessageBytes = 16_777_216;
const maximumQueuedHostMessageSendAttempts = 3;

const normalizedTimeout = (value: number | undefined): number => {
  const timeout = value ?? defaultTeardownTimeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > maximumTeardownTimeoutMs) {
    throw new RangeError(`MCP App bridge teardown timeout must be an integer from 1 to ${maximumTeardownTimeoutMs} ms.`);
  }
  return timeout;
};

const normalizedQueuedHostMessageBytes = (value: number | undefined): number => {
  const maximum = value ?? defaultMaximumQueuedHostMessageBytes;
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > maximumQueuedHostMessageBytes) {
    throw new RangeError(`MCP App bridge queued host-message limit must be an integer from 1 to ${maximumQueuedHostMessageBytes} bytes.`);
  }
  return maximum;
};

const snapshotBinding = (value: McpAppBinding): BridgeBindingSnapshot => {
  if (!nonempty(value.id) || !nonempty(value.resourceUri)) throw new TypeError('MCP App bridge binding must contain nonempty id and resource URI values.');
  const input = jsonRecord(value.input);
  const result = validToolResult(value.result);
  const toolDefinition = jsonRecord(value.toolDefinition);
  if (input === undefined || result === undefined || toolDefinition === undefined) throw new TypeError('MCP App bridge binding must contain stable MCP Apps input, result, and tool values.');
  return Object.freeze({
    id: value.id,
    input,
    resourceUri: value.resourceUri,
    result,
    toolDefinition: toolDefinition as McpAppBinding['toolDefinition'],
  });
};

const snapshotHost = (host: McpAppBridgeHost): McpAppBridgeHost => {
  if (!nonempty(host.info?.name) || !nonempty(host.info?.version)) throw new TypeError('MCP App host info must contain nonempty name and version values.');
  const capabilities = host.capabilities === undefined ? Object.freeze({}) : validHostCapabilities(host.capabilities);
  const context = host.context === undefined ? Object.freeze({}) : validHostContext(host.context);
  if (capabilities === undefined || context === undefined) throw new TypeError('MCP App host context must use stable MCP Apps field values.');
  return Object.freeze({
    ...host,
    capabilities,
    context,
    info: Object.freeze({ name: host.info.name, version: host.info.version }),
  });
};

export const createMcpAppBridge = (options: CreateMcpAppBridgeOptions): McpAppBridge => {
  const binding = snapshotBinding(options.binding);
  const host = snapshotHost(options.host);
  const timeoutMs = normalizedTimeout(options.teardownTimeoutMs);
  const queuedHostMessageByteLimit = normalizedQueuedHostMessageBytes(options.maxQueuedHostMessageBytes);
  const canonicalResourceUri = selectMcpAppResourceUri(binding.toolDefinition);
  const resourceIsCanonical = canonicalResourceUri !== undefined && canonicalResourceUri === binding.resourceUri;
  const queuedHostMessages: QueuedHostMessage[] = [];
  let queuedHostMessageBytes = 0;
  let lifecycle: McpAppBridgeLifecycle = 'created';
  let hostTrafficBlocked = false;
  let inputQueued = false;
  let terminalQueued = false;
  let closePromise: Promise<void> | undefined;
  let releasePromise: Promise<void> | undefined;
  let teardownId: McpAppBridgeRequestId | undefined;
  let hasTeardownId = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let finishTeardown: (() => void) | undefined;
  let appDisplayModes: ReadonlySet<McpAppBridgeDisplayMode> | undefined;
  let hostDisplayModes = validDisplayModeList(host.context?.availableDisplayModes);
  const isClosed = (): boolean => lifecycle === 'closing' || lifecycle === 'closed';

  const hostMessageByteLength = (message: McpAppBridgeMessage): number => Buffer.byteLength(JSON.stringify(message), 'utf8');

  const enqueueHostMessage = (message: McpAppBridgeMessage): boolean => {
    const byteLength = hostMessageByteLength(message);
    if (byteLength > queuedHostMessageByteLimit || queuedHostMessageBytes + byteLength > queuedHostMessageByteLimit) return false;
    queuedHostMessages.push({ byteLength, failedSendAttempts: 0, message });
    queuedHostMessageBytes += byteLength;
    return true;
  };

  const dequeueHostMessage = (): QueuedHostMessage | undefined => {
    const message = queuedHostMessages.shift();
    if (message !== undefined) queuedHostMessageBytes -= message.byteLength;
    return message;
  };

  const send = (message: McpAppBridgeMessage): boolean => {
    try {
      return options.send(Object.freeze({
        ...(message.error === undefined ? {} : { error: Object.freeze({ ...message.error }) }),
        ...(hasOwn(message, 'id') ? { id: message.id } : {}),
        jsonrpc: '2.0' as const,
        ...(message.method === undefined ? {} : { method: message.method }),
        ...(message.params === undefined ? {} : { params: cloneJson(message.params) }),
        ...(message.result === undefined ? {} : { result: cloneJson(message.result) }),
      }));
    } catch {
      // Host send() failures must not take down the bridge.
      return false;
    }
  };

  const emitHost = (message: McpAppBridgeMessage): boolean => {
    if (lifecycle === 'closing' || lifecycle === 'closed') return false;
    if (hostMessageByteLength(message) > queuedHostMessageByteLimit) return false;
    if (lifecycle !== 'initialized' || hostTrafficBlocked) {
      return enqueueHostMessage(message);
    }
    if (send(message)) return true;
    hostTrafficBlocked = true;
    return enqueueHostMessage(message);
  };

  const flush = (): boolean => {
    if (lifecycle !== 'initialized') return false;
    while (lifecycle === 'initialized' && queuedHostMessages.length > 0) {
      const message = queuedHostMessages[0];
      if (message === undefined) return false;
      if (!send(message.message)) {
        message.failedSendAttempts += 1;
        hostTrafficBlocked = true;
        if (message.failedSendAttempts >= maximumQueuedHostMessageSendAttempts) failClosedHostTraffic();
        return false;
      }
      dequeueHostMessage();
    }
    hostTrafficBlocked = false;
    return true;
  };

  const queueInput = (argumentsValue: McpAppBridgeJsonRecord | undefined): boolean => {
    if (inputQueued || lifecycle === 'closing' || lifecycle === 'closed') return false;
    const params: McpAppBridgeJsonRecord = argumentsValue === undefined ? {} : { arguments: cloneJson(argumentsValue) };
    const queued = emitHost(Object.freeze({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-input',
      params: Object.freeze(params),
    }));
    if (queued) inputQueued = true;
    return queued;
  };

  const queueResult = (result: McpAppJsonValue): boolean => {
    if (terminalQueued || lifecycle === 'closing' || lifecycle === 'closed') return false;
    if (!inputQueued) {
      const originalInput = jsonRecord(binding.input);
      if (originalInput === undefined || !queueInput(originalInput)) return false;
    }
    const queued = emitHost(Object.freeze({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: cloneJson(result) }));
    if (queued) terminalQueued = true;
    return queued;
  };

  const releaseBinding = (): Promise<void> => {
    if (releasePromise !== undefined) return releasePromise;
    const operation = Promise.resolve().then(() => options.operations.closeBinding(binding.id));
    const pending = operation.then(
      (released) => {
        if (!released) throw new McpAppBridgeCloseError('binding-close-rejected');
        lifecycle = 'closed';
        queuedHostMessages.length = 0;
        queuedHostMessageBytes = 0;
        if (closeTimer !== undefined) clearTimeout(closeTimer);
        finishTeardown = undefined;
      },
      () => {
        throw new McpAppBridgeCloseError('binding-close-failed');
      },
    ).catch((error: unknown) => {
      if (releasePromise === pending) releasePromise = undefined;
      if (lifecycle !== 'closed') lifecycle = 'closing';
      throw error;
    });
    releasePromise = pending;
    return pending;
  };

  const rememberClose = (pending: Promise<void>): Promise<void> => {
    closePromise = pending;
    void pending.then(undefined, () => {
      if (closePromise === pending) closePromise = undefined;
    });
    return pending;
  };

  const failClosedHostTraffic = (): void => {
    lifecycle = 'closing';
    queuedHostMessages.length = 0;
    queuedHostMessageBytes = 0;
    hostTrafficBlocked = false;
    void rememberClose(releaseBinding()).catch(() => undefined);
  };

  const respond = (id: McpAppBridgeRequestId, result: McpAppJsonValue): boolean => {
    const message = { id, jsonrpc: '2.0' as const, result };
    return lifecycle === 'initialized' ? emitHost(message) : send(message);
  };
  const fail = (id: McpAppBridgeRequestId, code: number, message: string): boolean => {
    const response = { error: { code, message }, id, jsonrpc: '2.0' as const };
    return lifecycle === 'initialized' ? emitHost(response) : send(response);
  };

  const receiveRequest = async (message: McpAppBridgeMessage): Promise<boolean> => {
    const id = message.id!;
    switch (message.method) {
      case 'ping':
        if (message.params !== undefined && jsonRecord(message.params) === undefined) return fail(id, -32602, 'ping requires object params.');
        return respond(id, {});
      case 'tools/call': {
        const request = validToolCall(message.params);
        if (request === undefined) return fail(id, -32602, 'tools/call requires a name and finite JSON arguments.');
        try {
          const result = validToolResult(await options.operations.callTool(binding.id, request));
          if (result === undefined) return lifecycle === 'initialized' ? fail(id, -32000, 'MCP App tool call returned an invalid result.') : false;
          return lifecycle === 'initialized' ? respond(id, result) : false;
        } catch {
          return lifecycle === 'initialized' ? fail(id, -32000, 'MCP App tool call failed.') : false;
        }
      }
      case 'resources/read': {
        const request = validResourceRead(message.params);
        if (request === undefined) return fail(id, -32602, 'resources/read requires a nonempty URI.');
        try {
          const result = validResourceReadResult(await options.operations.readResource(binding.id, request));
          if (result === undefined) return lifecycle === 'initialized' ? fail(id, -32000, 'MCP App resource read returned an invalid result.') : false;
          return lifecycle === 'initialized' ? respond(id, result) : false;
        } catch {
          return lifecycle === 'initialized' ? fail(id, -32000, 'MCP App resource read failed.') : false;
        }
      }
      case 'ui/open-link': {
        const url = validOpenLink(message.params);
        if (url === undefined) return fail(id, -32602, 'ui/open-link requires an http: or https: URL.');
        if (host.onOpenLink === undefined) return fail(id, -32601, 'ui/open-link is not supported by this host.');
        try {
          await host.onOpenLink(url);
          return lifecycle === 'initialized' ? respond(id, {}) : false;
        } catch {
          return lifecycle === 'initialized' ? fail(id, -32000, 'ui/open-link was denied by this host.') : false;
        }
      }
      case 'ui/message': {
        const event = validMessage(message.params);
        if (event === undefined) return fail(id, -32602, 'ui/message requires a user role and valid MCP content blocks.');
        if (host.onMessage === undefined) return fail(id, -32601, 'ui/message is not supported by this host.');
        try {
          const result = await host.onMessage(event);
          const messageResult = result === undefined ? {} : validMessageResult(result);
          if (messageResult === undefined) return lifecycle === 'initialized' ? fail(id, -32000, 'Host returned an invalid ui/message result.') : false;
          return lifecycle === 'initialized' ? respond(id, messageResult) : false;
        } catch {
          return lifecycle === 'initialized' ? fail(id, -32000, 'ui/message was denied by this host.') : false;
        }
      }
      case 'ui/request-display-mode': {
        const mode = validDisplayMode(message.params);
        if (mode === undefined) return fail(id, -32602, 'ui/request-display-mode requires a supported display mode.');
        if (appDisplayModes === undefined || !appDisplayModes.has(mode)) return fail(id, -32602, 'ui/request-display-mode must be declared by the App.');
        if (hostDisplayModes === undefined || !hostDisplayModes.includes(mode)) return fail(id, -32602, 'ui/request-display-mode is not available from this host.');
        if (host.onDisplayMode === undefined) return fail(id, -32601, 'ui/request-display-mode is not supported by this host.');
        try {
          const actual = await host.onDisplayMode(mode);
          if (lifecycle !== 'initialized') return false;
          if (!appDisplayModes.has(actual) || !hostDisplayModes.includes(actual)) {
            return fail(id, -32000, 'Host returned a display mode outside the negotiated declarations.');
          }
          return respond(id, { mode: actual });
        } catch {
          return lifecycle === 'initialized' ? fail(id, -32000, 'ui/request-display-mode was denied by this host.') : false;
        }
      }
      case 'ui/update-model-context': {
        const context = validModelContext(message.params);
        if (context === undefined) return fail(id, -32602, 'ui/update-model-context requires finite JSON content.');
        if (host.onModelContext === undefined) return fail(id, -32601, 'ui/update-model-context is not supported by this host.');
        try {
          await host.onModelContext(context);
          return lifecycle === 'initialized' ? respond(id, {}) : false;
        } catch {
          return lifecycle === 'initialized' ? fail(id, -32000, 'ui/update-model-context was denied by this host.') : false;
        }
      }
      default:
        return fail(id, -32601, `Unsupported MCP App method ${JSON.stringify(message.method)}.`);
    }
  };

  return Object.freeze({
    get lifecycle(): McpAppBridgeLifecycle {
      return lifecycle;
    },
    close(closeOptions: McpAppBridgeCloseOptions): Promise<void> {
      if (closePromise !== undefined) return closePromise;
      if (!isRequestId(closeOptions?.id) || (closeOptions.reason !== undefined && !nonempty(closeOptions.reason))) {
        throw new TypeError('MCP App bridge teardown requires a JSON-RPC id and an optional nonempty reason.');
      }
      if (lifecycle !== 'initialized') {
        lifecycle = 'closing';
        return rememberClose(releaseBinding());
      }
      lifecycle = 'closing';
      hasTeardownId = true;
      teardownId = closeOptions.id;
      const teardown = Promise.withResolvers<void>();
      finishTeardown = teardown.resolve;
      closeTimer = setTimeout(teardown.resolve, timeoutMs);
      const pending = rememberClose(teardown.promise.then(releaseBinding));
      const sent = send({
        id: closeOptions.id,
        jsonrpc: '2.0',
        method: 'ui/resource-teardown',
        params: Object.freeze(closeOptions.reason === undefined ? {} : { reason: closeOptions.reason } as McpAppBridgeJsonRecord),
      });
      if (!sent) teardown.resolve();
      return pending;
    },
    forceClose(): Promise<void> {
      if (closePromise !== undefined) {
        finishTeardown?.();
        return closePromise;
      }
      lifecycle = 'closing';
      return rememberClose(releaseBinding());
    },
    flushHostTraffic(): boolean {
      return flush();
    },
    async loadResource(): Promise<McpAppBridgeResourceResolution> {
      const fallback = (reason: McpAppBridgeFallbackReason): McpAppBridgeFallback => Object.freeze({
        input: cloneJson(binding.input),
        kind: 'fallback',
        reason,
        result: cloneJson(binding.result),
      });
      if (isClosed()) return fallback('bridge-closed');
      if (!resourceIsCanonical) return fallback('missing-canonical-resource-uri');
      try {
        const response = await options.operations.readResource(binding.id, { uri: binding.resourceUri });
        if (isClosed()) return fallback('bridge-closed');
        const resourceResponse = snapshotMcpAppJson(response);
        const resource = resourceResponse === undefined ? undefined : parsedResource(resourceResponse, binding.resourceUri);
        return resource === undefined ? fallback('invalid-resource') : Object.freeze({ ...resource, kind: 'resource' as const });
      } catch {
        return isClosed() ? fallback('bridge-closed') : fallback('resource-read-failed');
      }
    },
    publishHostContextChanged(context: McpAppBridgeJsonRecord): boolean {
      const snapshot = validHostContext(context);
      if (snapshot === undefined) return false;
      const availableDisplayModes = snapshot.availableDisplayModes === undefined ? undefined : validDisplayModeList(snapshot.availableDisplayModes);
      const published = emitHost(Object.freeze({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: snapshot }));
      if (published && availableDisplayModes !== undefined) hostDisplayModes = availableDisplayModes;
      return published;
    },
    publishToolCancelled(reason?: string): boolean {
      if (terminalQueued || (reason !== undefined && !nonempty(reason))) return false;
      if (!inputQueued) {
        const originalInput = jsonRecord(binding.input);
        if (originalInput === undefined || !queueInput(originalInput)) return false;
      }
      const params: McpAppBridgeJsonRecord = reason === undefined ? {} : { reason };
      const queued = emitHost(Object.freeze({
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-cancelled',
        params: Object.freeze(params),
      }));
      if (queued) terminalQueued = true;
      return queued;
    },
    publishToolInput(argumentsValue?: McpAppBridgeJsonRecord): boolean {
      const snapshot = argumentsValue === undefined ? undefined : jsonRecord(argumentsValue);
      return argumentsValue !== undefined && snapshot === undefined ? false : queueInput(snapshot);
    },
    publishToolInputPartial(argumentsValue?: McpAppBridgeJsonRecord): boolean {
      if (inputQueued || lifecycle === 'closing' || lifecycle === 'closed') return false;
      const snapshot = argumentsValue === undefined ? undefined : jsonRecord(argumentsValue);
      if (argumentsValue !== undefined && snapshot === undefined) return false;
      const params: McpAppBridgeJsonRecord = snapshot === undefined ? {} : { arguments: snapshot };
      return emitHost(Object.freeze({
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-input-partial',
        params: Object.freeze(params),
      }));
    },
    publishToolResult(result: McpAppJsonValue): boolean {
      const toolResult = validToolResult(result);
      return toolResult === undefined ? false : queueResult(toolResult);
    },
    async receive(value: unknown): Promise<boolean> {
      const message = messageOf(value);
      if (message === undefined) return false;
      if (lifecycle === 'closing') {
        if (hasTeardownId && !hasOwn(message, 'method') && hasOwn(message, 'id') && message.id === teardownId
          && (message.result !== undefined || message.error !== undefined)) {
          finishTeardown?.();
          return true;
        }
        return false;
      }
      if (lifecycle === 'closed') return false;
      if (lifecycle === 'created') {
        if (!isInitialize(message) || !validInitialize(message.params)) {
          return isInitialize(message) ? fail(message.id!, -32602, `ui/initialize requires protocol version ${MCP_APP_PROTOCOL_VERSION}.`) : false;
        }
        const sent = respond(message.id!, {
          hostCapabilities: host.capabilities!,
          hostContext: host.context!,
          hostInfo: { name: host.info.name, version: host.info.version },
          protocolVersion: MCP_APP_PROTOCOL_VERSION,
        });
        if (sent) {
          const initializedParams = jsonRecord(message.params)!;
          const capabilities = jsonRecord(initializedParams.appCapabilities)!;
          appDisplayModes = Array.isArray(capabilities.availableDisplayModes)
            ? new Set(capabilities.availableDisplayModes as readonly McpAppBridgeDisplayMode[])
            : undefined;
          lifecycle = 'initializing';
        }
        return sent;
      }
      if (lifecycle === 'initializing') {
        if (!initializedNotification(message)) return false;
        lifecycle = 'initialized';
        const originalInput = jsonRecord(binding.input);
        if (originalInput === undefined) {
          void releaseBinding().catch(() => undefined);
          return false;
        }
        if (!inputQueued) {
          const inputMessage = Object.freeze({
            jsonrpc: '2.0',
            method: 'ui/notifications/tool-input',
            params: Object.freeze({ arguments: originalInput }),
          });
          if (!enqueueHostMessage(inputMessage)) {
            lifecycle = 'closing';
            void releaseBinding().catch(() => undefined);
            return false;
          }
          inputQueued = true;
        }
        if (!terminalQueued) {
          const resultMessage = Object.freeze({
            jsonrpc: '2.0',
            method: 'ui/notifications/tool-result',
            params: cloneJson(binding.result),
          });
          if (!enqueueHostMessage(resultMessage)) {
            lifecycle = 'closing';
            void releaseBinding().catch(() => undefined);
            return false;
          }
          terminalQueued = true;
        }
        flush();
        return true;
      }
      if (message.method === 'notifications/message') {
        if (hasOwn(message, 'id')) return false;
        const event = validLog(message.params);
        if (event === undefined) return false;
        try {
          await host.onLog?.(event);
          return lifecycle === 'initialized';
        } catch {
          return false;
        }
      }
      if (message.method === 'ui/notifications/size-changed') {
        if (hasOwn(message, 'id')) return false;
        const size = validSize(message.params);
        if (size === undefined) return false;
        try {
          await host.onSizeChanged?.(size);
          return lifecycle === 'initialized';
        } catch {
          return false;
        }
      }
      if (!hasOwn(message, 'id')) return false;
      return receiveRequest(message);
    },
  });
};
