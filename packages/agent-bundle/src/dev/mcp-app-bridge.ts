import { Buffer } from 'node:buffer';

import {
  selectMcpAppResourceUri,
  type McpAppBinding,
  type McpAppJsonValue,
} from './mcp-app-binding-service.ts';
import type {
  McpAppSandboxCsp,
  McpAppSandboxPermissions,
} from './mcp-app-sandbox.ts';

export const MCP_APP_PROTOCOL_VERSION = '2026-01-26';

export type McpAppBridgeRequestId = string | number | null;
export type McpAppBridgeDisplayMode = 'inline' | 'fullscreen' | 'pip';
export type McpAppBridgeLifecycle = 'created' | 'initializing' | 'initialized' | 'closing' | 'closed';
export type McpAppBridgeFallbackReason =
  | 'bridge-closed'
  | 'invalid-resource'
  | 'missing-canonical-resource-uri'
  | 'resource-read-failed';
export type McpAppBridgeJsonRecord = { readonly [key: string]: McpAppJsonValue };

export interface McpAppBridgeMessage {
  readonly error?: McpAppBridgeRpcError;
  readonly id?: McpAppBridgeRequestId;
  readonly jsonrpc: '2.0';
  readonly method?: string;
  readonly params?: McpAppJsonValue;
  readonly result?: McpAppJsonValue;
}

export interface McpAppBridgeRpcError {
  readonly code: number;
  readonly message: string;
}

export class McpAppBridgeCloseError extends Error {
  readonly code: 'binding-close-failed' | 'binding-close-rejected';
  readonly operation = 'closeBinding';

  constructor(code: McpAppBridgeCloseError['code']) {
    super(`MCP App binding ${code === 'binding-close-rejected' ? 'was already closed' : 'could not be released'}.`);
    this.code = code;
    this.name = 'McpAppBridgeCloseError';
  }
}

export interface McpAppBridgeToolCall {
  readonly arguments?: McpAppJsonValue;
  readonly name: string;
}

export interface McpAppBridgeResourceRead {
  readonly uri: string;
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

export interface McpAppBridgeHostInfo {
  readonly name: string;
  readonly version: string;
}

export interface McpAppBridgeLogEvent {
  readonly data?: McpAppJsonValue;
  readonly level: string;
  readonly logger?: string;
}

export interface McpAppBridgeMessageEvent {
  readonly content: readonly McpAppJsonValue[];
  readonly role: 'user';
}

export interface McpAppBridgeModelContext {
  readonly content?: readonly McpAppJsonValue[];
  readonly structuredContent?: McpAppBridgeJsonRecord;
}

export interface McpAppBridgeSize {
  readonly height?: number;
  readonly width?: number;
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
  readonly operations: McpAppBridgeBindingOperations;
  readonly send: (message: McpAppBridgeMessage) => boolean;
  readonly teardownTimeoutMs?: number;
}

export interface McpAppBridge {
  readonly lifecycle: McpAppBridgeLifecycle;
  close(options: McpAppBridgeCloseOptions): Promise<void>;
  forceClose(): Promise<void>;
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

interface ParsedResource {
  readonly csp?: McpAppSandboxCsp;
  readonly html: string;
  readonly permissions?: McpAppSandboxPermissions;
}

const defaultTeardownTimeoutMs = 1_000;
const maximumTeardownTimeoutMs = 30_000;
const loggingLevels = new Set(['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency']);
const displayModes = new Set<McpAppBridgeDisplayMode>(['inline', 'fullscreen', 'pip']);

const hasOwn = (value: object, key: string): boolean => Object.hasOwn(value, key);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const isRequestId = (value: unknown): value is McpAppBridgeRequestId =>
  value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

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

const jsonRecord = (value: unknown): McpAppBridgeJsonRecord | undefined => {
  if (!isRecord(value) || !isJsonValue(value)) return undefined;
  return cloneJson(value) as McpAppBridgeJsonRecord;
};

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const normalizedTimeout = (value: number | undefined): number => {
  const timeout = value ?? defaultTeardownTimeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > maximumTeardownTimeoutMs) {
    throw new RangeError(`MCP App bridge teardown timeout must be an integer from 1 to ${maximumTeardownTimeoutMs} ms.`);
  }
  return timeout;
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

const messageOf = (value: unknown): McpAppBridgeMessage | undefined => {
  if (!isRecord(value) || value.jsonrpc !== '2.0') return undefined;
  const hasMethod = hasOwn(value, 'method');
  const hasResult = hasOwn(value, 'result');
  const hasError = hasOwn(value, 'error');
  if (Number(hasMethod) + Number(hasResult) + Number(hasError) !== 1) return undefined;
  if (!hasMethod && !hasOwn(value, 'id')) return undefined;
  if (hasOwn(value, 'id') && !isRequestId(value.id)) return undefined;
  if (hasOwn(value, 'method') && !nonempty(value.method)) return undefined;
  if (hasOwn(value, 'params') && !isJsonValue(value.params)) return undefined;
  if (hasOwn(value, 'result') && !isJsonValue(value.result)) return undefined;
  if (hasOwn(value, 'error')) {
    if (!isRecord(value.error) || typeof value.error.code !== 'number' || !Number.isFinite(value.error.code) || !nonempty(value.error.message)) return undefined;
  }
  return Object.freeze({
    ...(hasOwn(value, 'error') ? { error: Object.freeze({ code: (value.error as Record<string, unknown>).code as number, message: (value.error as Record<string, unknown>).message as string }) } : {}),
    ...(hasOwn(value, 'id') ? { id: value.id as McpAppBridgeRequestId } : {}),
    jsonrpc: '2.0' as const,
    ...(hasOwn(value, 'method') ? { method: value.method as string } : {}),
    ...(hasOwn(value, 'params') ? { params: cloneJson(value.params as McpAppJsonValue) } : {}),
    ...(hasOwn(value, 'result') ? { result: cloneJson(value.result as McpAppJsonValue) } : {}),
  });
};

const isInitialize = (message: McpAppBridgeMessage): boolean => message.method === 'ui/initialize' && hasOwn(message, 'id');

const initializedNotification = (message: McpAppBridgeMessage): boolean =>
  message.method === 'ui/notifications/initialized' && !hasOwn(message, 'id')
  && (message.params === undefined || jsonRecord(message.params) !== undefined);

const validInitialize = (params: McpAppJsonValue | undefined): boolean => {
  const record = jsonRecord(params);
  if (record === undefined || record.protocolVersion !== MCP_APP_PROTOCOL_VERSION) return false;
  const appInfo = jsonRecord(record.appInfo);
  const appCapabilities = jsonRecord(record.appCapabilities);
  if (appInfo === undefined || !nonempty(appInfo.name) || !nonempty(appInfo.version) || appCapabilities === undefined) return false;
  const requestedModes = appCapabilities.availableDisplayModes;
  return requestedModes === undefined || (Array.isArray(requestedModes) && requestedModes.every((mode) => typeof mode === 'string' && displayModes.has(mode as McpAppBridgeDisplayMode)));
};

const contentBlock = (value: McpAppJsonValue): boolean => {
  const block = jsonRecord(value);
  if (block === undefined || !nonempty(block.type)) return false;
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string';
    case 'image':
    case 'audio':
      return typeof block.data === 'string' && nonempty(block.mimeType);
    case 'resource_link':
      return nonempty(block.name) && nonempty(block.uri);
    case 'resource': {
      const resource = jsonRecord(block.resource);
      return resource !== undefined && nonempty(resource.uri)
        && (typeof resource.text === 'string' || typeof resource.blob === 'string');
    }
    default:
      return false;
  }
};

const validContentBlocks = (value: unknown): readonly McpAppJsonValue[] | undefined =>
  Array.isArray(value) && value.every((block) => isJsonValue(block) && contentBlock(block))
    ? Object.freeze(value.map((block) => cloneJson(block)))
    : undefined;

const validToolResult = (value: unknown): McpAppJsonValue | undefined => {
  const result = jsonRecord(value);
  if (result === undefined || validContentBlocks(result.content) === undefined) return undefined;
  if (result.structuredContent !== undefined && jsonRecord(result.structuredContent) === undefined) return undefined;
  if (result.isError !== undefined && typeof result.isError !== 'boolean') return undefined;
  if (result._meta !== undefined && jsonRecord(result._meta) === undefined) return undefined;
  return result;
};

const validMessageResult = (value: unknown): McpAppJsonValue | undefined => {
  const result = jsonRecord(value);
  return result === undefined || (result.isError !== undefined && typeof result.isError !== 'boolean') ? undefined : result;
};

const validDisplayModeList = (value: unknown): readonly McpAppBridgeDisplayMode[] | undefined =>
  Array.isArray(value) && value.every((mode) => typeof mode === 'string' && displayModes.has(mode as McpAppBridgeDisplayMode))
    ? Object.freeze([...value] as McpAppBridgeDisplayMode[])
    : undefined;

const validHostCapabilities = (value: unknown): McpAppBridgeJsonRecord | undefined => {
  const capabilities = jsonRecord(value);
  if (capabilities === undefined) return undefined;
  for (const key of ['openLinks', 'serverTools', 'serverResources', 'logging'] as const) {
    const capability = capabilities[key] === undefined ? undefined : jsonRecord(capabilities[key]);
    if (capabilities[key] !== undefined && capability === undefined) return undefined;
    if ((key === 'serverTools' || key === 'serverResources') && capability?.listChanged !== undefined && typeof capability.listChanged !== 'boolean') return undefined;
  }
  if (capabilities.sandbox !== undefined) {
    const sandbox = jsonRecord(capabilities.sandbox);
    const permissions = sandbox === undefined || sandbox.permissions === undefined ? undefined : jsonRecord(sandbox.permissions);
    const csp = sandbox === undefined || sandbox.csp === undefined ? undefined : jsonRecord(sandbox.csp);
    if (sandbox === undefined || (sandbox.permissions !== undefined && permissions === undefined) || (sandbox.csp !== undefined && csp === undefined)) return undefined;
    if (permissions !== undefined && !['camera', 'microphone', 'geolocation', 'clipboardWrite'].every((key) => permissions[key] === undefined || jsonRecord(permissions[key]) !== undefined)) return undefined;
    if (csp !== undefined && !['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains'].every((key) => csp[key] === undefined || (Array.isArray(csp[key]) && csp[key].every((domain) => typeof domain === 'string')))) return undefined;
  }
  return capabilities;
};

const validHostContext = (value: unknown): McpAppBridgeJsonRecord | undefined => {
  const context = jsonRecord(value);
  if (context === undefined) return undefined;
  if (context.theme !== undefined && context.theme !== 'light' && context.theme !== 'dark') return undefined;
  if (context.displayMode !== undefined && (typeof context.displayMode !== 'string' || !displayModes.has(context.displayMode as McpAppBridgeDisplayMode))) return undefined;
  if (context.availableDisplayModes !== undefined && validDisplayModeList(context.availableDisplayModes) === undefined) return undefined;
  if (context.locale !== undefined && !nonempty(context.locale)) return undefined;
  if (context.timeZone !== undefined && !nonempty(context.timeZone)) return undefined;
  if (context.userAgent !== undefined && !nonempty(context.userAgent)) return undefined;
  if (context.platform !== undefined && context.platform !== 'web' && context.platform !== 'desktop' && context.platform !== 'mobile') return undefined;
  if (context.toolInfo !== undefined) {
    const toolInfo = jsonRecord(context.toolInfo);
    const tool = toolInfo === undefined ? undefined : jsonRecord(toolInfo.tool);
    if (toolInfo === undefined || tool === undefined || !nonempty(tool.name) || (toolInfo.id !== undefined && !isRequestId(toolInfo.id))) return undefined;
  }
  if (context.deviceCapabilities !== undefined) {
    const device = jsonRecord(context.deviceCapabilities);
    if (device === undefined || (device.touch !== undefined && typeof device.touch !== 'boolean') || (device.hover !== undefined && typeof device.hover !== 'boolean')) return undefined;
  }
  if (context.styles !== undefined) {
    const styles = jsonRecord(context.styles);
    const variables = styles === undefined || styles.variables === undefined ? undefined : jsonRecord(styles.variables);
    const css = styles === undefined || styles.css === undefined ? undefined : jsonRecord(styles.css);
    if (styles === undefined || (styles.variables !== undefined && (variables === undefined || !Object.values(variables).every((variable) => typeof variable === 'string')))
      || (styles.css !== undefined && (css === undefined || (css.fonts !== undefined && typeof css.fonts !== 'string')))) return undefined;
  }
  if (context.containerDimensions !== undefined) {
    const dimensions = jsonRecord(context.containerDimensions);
    if (dimensions === undefined || !['height', 'maxHeight', 'width', 'maxWidth'].every((key) => dimensions[key] === undefined || (typeof dimensions[key] === 'number' && Number.isFinite(dimensions[key]) && dimensions[key] >= 0))) return undefined;
  }
  if (context.safeAreaInsets !== undefined) {
    const insets = jsonRecord(context.safeAreaInsets);
    if (insets === undefined || !['top', 'right', 'bottom', 'left'].every((key) => typeof insets[key] === 'number' && Number.isFinite(insets[key]) && insets[key] >= 0)) return undefined;
  }
  return context;
};

const resourceMetadata = (value: unknown): { readonly csp?: McpAppSandboxCsp; readonly permissions?: McpAppSandboxPermissions } | undefined => {
  if (value === undefined) return Object.freeze({});
  const metadata = jsonRecord(value);
  const ui = metadata === undefined ? undefined : jsonRecord(metadata.ui);
  if (ui === undefined && metadata !== undefined && metadata.ui !== undefined) return undefined;
  if (ui === undefined) return Object.freeze({});
  const csp = ui.csp === undefined ? undefined : jsonRecord(ui.csp);
  const permissions = ui.permissions === undefined ? undefined : jsonRecord(ui.permissions);
  if ((ui.csp !== undefined && csp === undefined) || (ui.permissions !== undefined && permissions === undefined)) return undefined;
  return Object.freeze({
    ...(csp === undefined ? {} : { csp: csp as McpAppSandboxCsp }),
    ...(permissions === undefined ? {} : { permissions: permissions as McpAppSandboxPermissions }),
  });
};

const htmlFromBlob = (blob: string): string | undefined => {
  if (blob.length === 0 || blob.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(blob)) return undefined;
  const bytes = Buffer.from(blob, 'base64');
  if (bytes.toString('base64') !== blob) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
};

const parsedResource = (value: McpAppJsonValue, resourceUri: string): ParsedResource | undefined => {
  const response = jsonRecord(value);
  if (response === undefined || !Array.isArray(response.contents)) return undefined;
  for (const candidate of response.contents) {
    const content = jsonRecord(candidate);
    if (content === undefined || content.uri !== resourceUri || content.mimeType !== 'text/html;profile=mcp-app') continue;
    const hasText = typeof content.text === 'string';
    const hasBlob = typeof content.blob === 'string';
    if (hasText === hasBlob) return undefined;
    const html = hasText ? content.text as string : htmlFromBlob(content.blob as string);
    const metadata = resourceMetadata(content._meta);
    if (html === undefined || metadata === undefined) return undefined;
    return Object.freeze({ ...metadata, html });
  }
  return undefined;
};

const validToolCall = (params: McpAppJsonValue | undefined): McpAppBridgeToolCall | undefined => {
  const record = jsonRecord(params);
  if (record === undefined || !nonempty(record.name)) return undefined;
  if (record.arguments !== undefined && jsonRecord(record.arguments) === undefined) return undefined;
  return Object.freeze({ ...(record.arguments === undefined ? {} : { arguments: cloneJson(record.arguments) }), name: record.name });
};

const validResourceRead = (params: McpAppJsonValue | undefined): McpAppBridgeResourceRead | undefined => {
  const record = jsonRecord(params);
  return record === undefined || !nonempty(record.uri) ? undefined : Object.freeze({ uri: record.uri });
};

const validOpenLink = (params: McpAppJsonValue | undefined): string | undefined => {
  const record = jsonRecord(params);
  if (record === undefined || !nonempty(record.url)) return undefined;
  try {
    const url = new URL(record.url);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
};

const validMessage = (params: McpAppJsonValue | undefined): McpAppBridgeMessageEvent | undefined => {
  const record = jsonRecord(params);
  const content = record === undefined ? undefined : validContentBlocks(record.content);
  if (record === undefined || record.role !== 'user' || content === undefined) return undefined;
  return Object.freeze({ content, role: 'user' });
};

const validDisplayMode = (params: McpAppJsonValue | undefined): McpAppBridgeDisplayMode | undefined => {
  const record = jsonRecord(params);
  return record === undefined || typeof record.mode !== 'string' || !displayModes.has(record.mode as McpAppBridgeDisplayMode)
    ? undefined
    : record.mode as McpAppBridgeDisplayMode;
};

const validModelContext = (params: McpAppJsonValue | undefined): McpAppBridgeModelContext | undefined => {
  const record = jsonRecord(params);
  const content = record === undefined || record.content === undefined ? undefined : validContentBlocks(record.content);
  if (record === undefined || (record.content !== undefined && content === undefined)) return undefined;
  const structuredContent = record.structuredContent === undefined ? undefined : jsonRecord(record.structuredContent);
  if (record.structuredContent !== undefined && structuredContent === undefined) return undefined;
  return Object.freeze({
    ...(content === undefined ? {} : { content }),
    ...(structuredContent === undefined ? {} : { structuredContent }),
  });
};

const validLog = (params: McpAppJsonValue | undefined): McpAppBridgeLogEvent | undefined => {
  const record = jsonRecord(params);
  if (record === undefined || typeof record.level !== 'string' || !loggingLevels.has(record.level)) return undefined;
  if (record.logger !== undefined && !nonempty(record.logger)) return undefined;
  return Object.freeze({
    ...(record.data === undefined ? {} : { data: cloneJson(record.data) }),
    level: record.level,
    ...(record.logger === undefined ? {} : { logger: record.logger }),
  });
};

const validSize = (params: McpAppJsonValue | undefined): McpAppBridgeSize | undefined => {
  const record = jsonRecord(params);
  if (record === undefined || (record.width === undefined && record.height === undefined)) return undefined;
  if ((record.width !== undefined && (typeof record.width !== 'number' || !Number.isFinite(record.width) || record.width < 0))
    || (record.height !== undefined && (typeof record.height !== 'number' || !Number.isFinite(record.height) || record.height < 0))) return undefined;
  return Object.freeze({ ...(record.height === undefined ? {} : { height: record.height }), ...(record.width === undefined ? {} : { width: record.width }) });
};

export const createMcpAppBridge = (options: CreateMcpAppBridgeOptions): McpAppBridge => {
  const binding = snapshotBinding(options.binding);
  const host = snapshotHost(options.host);
  const timeoutMs = normalizedTimeout(options.teardownTimeoutMs);
  const canonicalResourceUri = selectMcpAppResourceUri(binding.toolDefinition);
  const resourceIsCanonical = canonicalResourceUri !== undefined && canonicalResourceUri === binding.resourceUri;
  const queuedHostMessages: McpAppBridgeMessage[] = [];
  let lifecycle: McpAppBridgeLifecycle = 'created';
  let inputQueued = false;
  let terminalQueued = false;
  let closePromise: Promise<void> | undefined;
  let releasePromise: Promise<void> | undefined;
  let teardownId: McpAppBridgeRequestId | undefined;
  let hasTeardownId = false;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  let finishTeardown: (() => void) | undefined;
  let appDisplayModes: ReadonlySet<McpAppBridgeDisplayMode> | undefined;
  const hostDisplayModes = validDisplayModeList(host.context?.availableDisplayModes);

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
      return false;
    }
  };

  const emitHost = (message: McpAppBridgeMessage): boolean => {
    if (lifecycle === 'closing' || lifecycle === 'closed') return false;
    if (lifecycle !== 'initialized') {
      queuedHostMessages.push(message);
      return true;
    }
    return send(message);
  };

  const flush = (): void => {
    while (lifecycle === 'initialized' && queuedHostMessages.length > 0) {
      const message = queuedHostMessages[0];
      if (message === undefined || !send(message)) return;
      queuedHostMessages.shift();
    }
  };

  const queueInput = (argumentsValue: McpAppBridgeJsonRecord | undefined): boolean => {
    if (inputQueued || lifecycle === 'closing' || lifecycle === 'closed') return false;
    inputQueued = true;
    const params: McpAppBridgeJsonRecord = argumentsValue === undefined ? {} : { arguments: cloneJson(argumentsValue) };
    return emitHost(Object.freeze({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-input',
      params: Object.freeze(params),
    }));
  };

  const queueResult = (result: McpAppJsonValue): boolean => {
    if (terminalQueued || lifecycle === 'closing' || lifecycle === 'closed') return false;
    if (!inputQueued) {
      const originalInput = jsonRecord(binding.input);
      if (originalInput === undefined || !queueInput(originalInput)) return false;
    }
    terminalQueued = true;
    return emitHost(Object.freeze({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: cloneJson(result) }));
  };

  const releaseBinding = (): Promise<void> => {
    if (releasePromise !== undefined) return releasePromise;
    const operation = Promise.resolve().then(() => options.operations.closeBinding(binding.id));
    const pending = operation.then(
      (released) => {
        if (!released) throw new McpAppBridgeCloseError('binding-close-rejected');
        lifecycle = 'closed';
        queuedHostMessages.length = 0;
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

  const respond = (id: McpAppBridgeRequestId, result: McpAppJsonValue): boolean => send({ id, jsonrpc: '2.0', result });
  const fail = (id: McpAppBridgeRequestId, code: number, message: string): boolean => send({ error: { code, message }, id, jsonrpc: '2.0' });

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
          const result = await options.operations.readResource(binding.id, request);
          return lifecycle === 'initialized' && isJsonValue(result) ? respond(id, cloneJson(result)) : false;
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
          if (!appDisplayModes.has(actual) || !hostDisplayModes.includes(actual)) {
            return fail(id, -32000, 'Host returned a display mode outside the negotiated declarations.');
          }
          return lifecycle === 'initialized' ? respond(id, { mode: actual }) : false;
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
      const complete = (): void => finishTeardown?.();
      const pending = rememberClose(new Promise<void>((resolve) => {
        finishTeardown = resolve;
        closeTimer = setTimeout(complete, timeoutMs);
      }).then(releaseBinding));
      const sent = send({
        id: closeOptions.id,
        jsonrpc: '2.0',
        method: 'ui/resource-teardown',
        params: Object.freeze(closeOptions.reason === undefined ? {} : { reason: closeOptions.reason } as McpAppBridgeJsonRecord),
      });
      if (!sent) complete();
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
    async loadResource(): Promise<McpAppBridgeResourceResolution> {
      const fallback = (reason: McpAppBridgeFallbackReason): McpAppBridgeFallback => Object.freeze({
        input: cloneJson(binding.input),
        kind: 'fallback',
        reason,
        result: cloneJson(binding.result),
      });
      if (lifecycle === 'closing' || lifecycle === 'closed') return fallback('bridge-closed');
      if (!resourceIsCanonical) return fallback('missing-canonical-resource-uri');
      try {
        const response = await options.operations.readResource(binding.id, { uri: binding.resourceUri });
        if (lifecycle === 'closing' || lifecycle === 'closed') return fallback('bridge-closed');
        const resource = isJsonValue(response) ? parsedResource(response, binding.resourceUri) : undefined;
        return resource === undefined ? fallback('invalid-resource') : Object.freeze({ ...resource, kind: 'resource' as const });
      } catch {
        return fallback('resource-read-failed');
      }
    },
    publishHostContextChanged(context: McpAppBridgeJsonRecord): boolean {
      const snapshot = jsonRecord(context);
      return snapshot === undefined ? false : emitHost(Object.freeze({ jsonrpc: '2.0', method: 'ui/notifications/host-context-changed', params: snapshot }));
    },
    publishToolCancelled(reason?: string): boolean {
      if (terminalQueued || (reason !== undefined && !nonempty(reason))) return false;
      if (!inputQueued) {
        const originalInput = jsonRecord(binding.input);
        if (originalInput === undefined || !queueInput(originalInput)) return false;
      }
      terminalQueued = true;
      const params: McpAppBridgeJsonRecord = reason === undefined ? {} : { reason };
      return emitHost(Object.freeze({
        jsonrpc: '2.0',
        method: 'ui/notifications/tool-cancelled',
        params: Object.freeze(params),
      }));
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
          inputQueued = true;
          queuedHostMessages.push(Object.freeze({
            jsonrpc: '2.0',
            method: 'ui/notifications/tool-input',
            params: Object.freeze({ arguments: originalInput }),
          }));
        }
        if (!terminalQueued) {
          terminalQueued = true;
          queuedHostMessages.push(Object.freeze({
            jsonrpc: '2.0',
            method: 'ui/notifications/tool-result',
            params: cloneJson(binding.result),
          }));
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
