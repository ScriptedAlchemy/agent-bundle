import { Buffer } from 'node:buffer';

import {
  cloneMcpAppJson,
  snapshotMcpAppJson,
  snapshotMcpAppJsonRecord,
  type McpAppJsonValue,
} from './mcp-app-json.ts';
import type {
  McpAppSandboxCsp,
  McpAppSandboxPermissions,
} from './mcp-app-sandbox.ts';

export const MCP_APP_PROTOCOL_VERSION = '2026-01-26';

/** The pinned MCP Apps extension identifier the workbench advertises on session initialize. */
export const MCP_APP_UI_EXTENSION = 'io.modelcontextprotocol/ui';

/** The only resource MIME type the workbench renders as an MCP App. */
export const MCP_APP_MIME_TYPE = 'text/html;profile=mcp-app';

export type McpAppBridgeRequestId = string | number | null;
export type McpAppBridgeDisplayMode = 'inline' | 'fullscreen' | 'pip';
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

export interface McpAppBridgeToolCall {
  readonly arguments?: McpAppJsonValue;
  readonly name: string;
}

export interface McpAppBridgeResourceRead {
  readonly uri: string;
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

export interface ParsedMcpAppResource {
  readonly csp?: McpAppSandboxCsp;
  readonly html: string;
  readonly permissions?: McpAppSandboxPermissions;
}

export interface ValidMcpAppResourceReadResult extends McpAppBridgeJsonRecord {
  readonly contents: readonly McpAppJsonValue[];
}

const loggingLevels = new Set(['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency']);
const displayModes = new Set<McpAppBridgeDisplayMode>(['inline', 'fullscreen', 'pip']);
const hostStyleVariables = new Set([
  '--color-background-primary', '--color-background-secondary', '--color-background-tertiary', '--color-background-inverse', '--color-background-ghost', '--color-background-info', '--color-background-danger', '--color-background-success', '--color-background-warning', '--color-background-disabled',
  '--color-text-primary', '--color-text-secondary', '--color-text-tertiary', '--color-text-inverse', '--color-text-ghost', '--color-text-info', '--color-text-danger', '--color-text-success', '--color-text-warning', '--color-text-disabled',
  '--color-border-primary', '--color-border-secondary', '--color-border-tertiary', '--color-border-inverse', '--color-border-ghost', '--color-border-info', '--color-border-danger', '--color-border-success', '--color-border-warning', '--color-border-disabled',
  '--color-ring-primary', '--color-ring-secondary', '--color-ring-inverse', '--color-ring-info', '--color-ring-danger', '--color-ring-success', '--color-ring-warning',
  '--font-sans', '--font-mono', '--font-weight-normal', '--font-weight-medium', '--font-weight-semibold', '--font-weight-bold',
  '--font-text-xs-size', '--font-text-sm-size', '--font-text-md-size', '--font-text-lg-size', '--font-heading-xs-size', '--font-heading-sm-size', '--font-heading-md-size', '--font-heading-lg-size', '--font-heading-xl-size', '--font-heading-2xl-size', '--font-heading-3xl-size',
  '--font-text-xs-line-height', '--font-text-sm-line-height', '--font-text-md-line-height', '--font-text-lg-line-height', '--font-heading-xs-line-height', '--font-heading-sm-line-height', '--font-heading-md-line-height', '--font-heading-lg-line-height', '--font-heading-xl-line-height', '--font-heading-2xl-line-height', '--font-heading-3xl-line-height',
  '--border-radius-xs', '--border-radius-sm', '--border-radius-md', '--border-radius-lg', '--border-radius-xl', '--border-radius-full', '--border-width-regular', '--shadow-hairline', '--shadow-sm', '--shadow-md', '--shadow-lg',
]);

export const hasOwn = (value: object, key: string): boolean => Object.hasOwn(value, key);
export const cloneJson = cloneMcpAppJson;
export const jsonRecord = snapshotMcpAppJsonRecord;
export const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

export const isRequestId = (value: unknown): value is McpAppBridgeRequestId =>
  value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

export const messageOf = (value: unknown): McpAppBridgeMessage | undefined => {
  const record = jsonRecord(value);
  if (record === undefined || record.jsonrpc !== '2.0') return undefined;
  const hasMethod = hasOwn(record, 'method');
  const hasResult = hasOwn(record, 'result');
  const hasError = hasOwn(record, 'error');
  if (Number(hasMethod) + Number(hasResult) + Number(hasError) !== 1) return undefined;
  if (!hasMethod && !hasOwn(record, 'id')) return undefined;
  if (hasOwn(record, 'id') && !isRequestId(record.id)) return undefined;
  if (hasOwn(record, 'method') && !nonempty(record.method)) return undefined;
  if (!hasMethod && hasOwn(record, 'params')) return undefined;
  const error = hasError ? jsonRecord(record.error) : undefined;
  if (hasError && (error === undefined || typeof error.code !== 'number' || !Number.isFinite(error.code) || !nonempty(error.message))) return undefined;
  return Object.freeze({
    ...(error === undefined ? {} : { error: Object.freeze({ code: error.code as number, message: error.message as string }) }),
    ...(hasOwn(record, 'id') ? { id: record.id as McpAppBridgeRequestId } : {}),
    jsonrpc: '2.0' as const,
    ...(hasOwn(record, 'method') ? { method: record.method as string } : {}),
    ...(hasOwn(record, 'params') ? { params: cloneJson(record.params as McpAppJsonValue) } : {}),
    ...(hasOwn(record, 'result') ? { result: cloneJson(record.result as McpAppJsonValue) } : {}),
  });
};

export const isInitialize = (message: McpAppBridgeMessage): boolean => message.method === 'ui/initialize' && hasOwn(message, 'id');

export const initializedNotification = (message: McpAppBridgeMessage): boolean =>
  message.method === 'ui/notifications/initialized' && !hasOwn(message, 'id')
  && (message.params === undefined || jsonRecord(message.params) !== undefined);

const validExperimentalCapabilities = (value: unknown): boolean => {
  const capabilities = jsonRecord(value);
  return capabilities !== undefined && Object.values(capabilities).every((capability) => jsonRecord(capability) !== undefined);
};

const validListChangedCapability = (value: unknown): boolean => {
  const capability = jsonRecord(value);
  return capability !== undefined && (capability.listChanged === undefined || typeof capability.listChanged === 'boolean');
};

const validContentModalities = (value: unknown): boolean => {
  const modalities = jsonRecord(value);
  if (modalities === undefined) return false;
  return ['text', 'image', 'audio', 'resource', 'resourceLink', 'structuredContent']
    .every((key) => modalities[key] === undefined || jsonRecord(modalities[key]) !== undefined);
};

const validCsp = (value: unknown): boolean => {
  const csp = jsonRecord(value);
  return csp !== undefined && ['connectDomains', 'resourceDomains', 'frameDomains', 'baseUriDomains']
    .every((key) => csp[key] === undefined || (Array.isArray(csp[key]) && csp[key].every((domain) => typeof domain === 'string')));
};

const validPermissions = (value: unknown): boolean => {
  const permissions = jsonRecord(value);
  return permissions !== undefined && ['camera', 'microphone', 'geolocation', 'clipboardWrite']
    .every((key) => permissions[key] === undefined || jsonRecord(permissions[key]) !== undefined);
};

const validSandbox = (value: unknown): boolean => {
  const sandbox = jsonRecord(value);
  return sandbox !== undefined
    && (sandbox.permissions === undefined || validPermissions(sandbox.permissions))
    && (sandbox.csp === undefined || validCsp(sandbox.csp));
};

const validAppCapabilities = (value: unknown): McpAppBridgeJsonRecord | undefined => {
  const capabilities = jsonRecord(value);
  if (capabilities === undefined) return undefined;
  if (capabilities.experimental !== undefined && !validExperimentalCapabilities(capabilities.experimental)) return undefined;
  if (capabilities.tools !== undefined && !validListChangedCapability(capabilities.tools)) return undefined;
  if (capabilities.availableDisplayModes !== undefined && validDisplayModeList(capabilities.availableDisplayModes) === undefined) return undefined;
  return capabilities;
};

const validIcon = (value: unknown): boolean => {
  const icon = jsonRecord(value);
  return icon !== undefined && nonempty(icon.src)
    && (icon.mimeType === undefined || nonempty(icon.mimeType))
    && (icon.sizes === undefined || (Array.isArray(icon.sizes) && icon.sizes.every(nonempty)))
    && (icon.theme === undefined || icon.theme === 'light' || icon.theme === 'dark');
};

const validIcons = (value: unknown): boolean => Array.isArray(value) && value.every(validIcon);

const validIsoDateTimeWithOffset = (value: unknown): boolean => {
  if (typeof value !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (year === undefined || month === undefined || day === undefined || hour === undefined || minute === undefined || second === undefined
    || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day && !Number.isNaN(Date.parse(value));
};

const validAnnotations = (value: unknown): boolean => {
  const annotations = jsonRecord(value);
  if (annotations === undefined) return false;
  if (annotations.audience !== undefined && (!Array.isArray(annotations.audience) || !annotations.audience.every((role) => role === 'user' || role === 'assistant'))) return false;
  if (annotations.priority !== undefined && (typeof annotations.priority !== 'number' || annotations.priority < 0 || annotations.priority > 1)) return false;
  if (annotations.lastModified !== undefined && !validIsoDateTimeWithOffset(annotations.lastModified)) return false;
  return true;
};

const validImplementation = (value: unknown): McpAppBridgeJsonRecord | undefined => {
  const implementation = jsonRecord(value);
  if (implementation === undefined || !nonempty(implementation.name) || !nonempty(implementation.version)) return undefined;
  if (['title', 'websiteUrl', 'description'].some((key) => implementation[key] !== undefined && typeof implementation[key] !== 'string')) return undefined;
  if (implementation.icons !== undefined && !validIcons(implementation.icons)) return undefined;
  return implementation;
};

export const validInitialize = (params: McpAppJsonValue | undefined): boolean => {
  const record = jsonRecord(params);
  if (record === undefined || record.protocolVersion !== MCP_APP_PROTOCOL_VERSION) return false;
  return validImplementation(record.appInfo) !== undefined && validAppCapabilities(record.appCapabilities) !== undefined;
};

const contentBlock = (value: McpAppJsonValue): boolean => {
  const block = jsonRecord(value);
  if (block === undefined || !nonempty(block.type)) return false;
  if (block.annotations !== undefined && !validAnnotations(block.annotations)) return false;
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string';
    case 'image':
    case 'audio':
      return typeof block.data === 'string' && nonempty(block.mimeType);
    case 'resource_link':
      return nonempty(block.name) && nonempty(block.uri)
        && (block.title === undefined || typeof block.title === 'string')
        && (block.description === undefined || typeof block.description === 'string')
        && (block.mimeType === undefined || typeof block.mimeType === 'string')
        && (block.size === undefined || typeof block.size === 'number')
        && (block.icons === undefined || validIcons(block.icons));
    case 'resource':
      return validResourceContent(block.resource) !== undefined;
    default:
      return false;
  }
};

const validContentBlocks = (value: unknown): readonly McpAppJsonValue[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const blocks: McpAppJsonValue[] = [];
  for (const valueBlock of value) {
    const block = snapshotMcpAppJson(valueBlock);
    if (block === undefined || !contentBlock(block)) return undefined;
    blocks.push(block);
  }
  return Object.freeze(blocks);
};

export const validToolResult = (value: unknown): McpAppJsonValue | undefined => {
  const result = jsonRecord(value);
  if (result === undefined || validContentBlocks(result.content) === undefined) return undefined;
  if (result.structuredContent !== undefined && jsonRecord(result.structuredContent) === undefined) return undefined;
  if (result.isError !== undefined && typeof result.isError !== 'boolean') return undefined;
  if (result._meta !== undefined && jsonRecord(result._meta) === undefined) return undefined;
  return result;
};

export const validMessageResult = (value: unknown): McpAppJsonValue | undefined => {
  const result = jsonRecord(value);
  return result === undefined || (result.isError !== undefined && typeof result.isError !== 'boolean') ? undefined : result;
};

export const validDisplayModeList = (value: unknown): readonly McpAppBridgeDisplayMode[] | undefined =>
  Array.isArray(value) && value.every((mode) => typeof mode === 'string' && displayModes.has(mode as McpAppBridgeDisplayMode))
    ? Object.freeze([...value] as McpAppBridgeDisplayMode[])
    : undefined;

export const validHostCapabilities = (value: unknown): McpAppBridgeJsonRecord | undefined => {
  const capabilities = jsonRecord(value);
  if (capabilities === undefined) return undefined;
  if (capabilities.experimental !== undefined && !validExperimentalCapabilities(capabilities.experimental)) return undefined;
  if (['openLinks', 'downloadFile', 'logging'].some((key) => capabilities[key] !== undefined && jsonRecord(capabilities[key]) === undefined)) return undefined;
  if (['serverTools', 'serverResources'].some((key) => capabilities[key] !== undefined && !validListChangedCapability(capabilities[key]))) return undefined;
  if (capabilities.sandbox !== undefined && !validSandbox(capabilities.sandbox)) return undefined;
  if (['updateModelContext', 'message'].some((key) => capabilities[key] !== undefined && !validContentModalities(capabilities[key]))) return undefined;
  if (capabilities.sampling !== undefined) {
    const sampling = jsonRecord(capabilities.sampling);
    if (sampling === undefined || (sampling.tools !== undefined && jsonRecord(sampling.tools) === undefined)) return undefined;
  }
  return capabilities;
};

const validObjectJsonSchema = (value: unknown): boolean => {
  const schema = jsonRecord(value);
  if (schema === undefined || schema.type !== 'object') return false;
  if (schema.properties !== undefined) {
    const properties = jsonRecord(schema.properties);
    if (properties === undefined || !Object.values(properties).every((property) => jsonRecord(property) !== undefined)) return false;
  }
  return schema.required === undefined || (Array.isArray(schema.required) && schema.required.every((required) => typeof required === 'string'));
};

const validToolDefinition = (value: unknown): boolean => {
  const tool = jsonRecord(value);
  if (tool === undefined || !nonempty(tool.name) || !validObjectJsonSchema(tool.inputSchema)) return false;
  if (tool.outputSchema !== undefined && !validObjectJsonSchema(tool.outputSchema)) return false;
  if (tool.icons !== undefined && !validIcons(tool.icons)) return false;
  if (tool.title !== undefined && typeof tool.title !== 'string') return false;
  if (tool.description !== undefined && typeof tool.description !== 'string') return false;
  if (tool.annotations !== undefined) {
    const annotations = jsonRecord(tool.annotations);
    if (annotations === undefined
      || (annotations.title !== undefined && !nonempty(annotations.title))
      || ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'].some((key) => annotations[key] !== undefined && typeof annotations[key] !== 'boolean')) return false;
  }
  if (tool.execution !== undefined) {
    const execution = jsonRecord(tool.execution);
    if (execution === undefined || (execution.taskSupport !== undefined && execution.taskSupport !== 'required' && execution.taskSupport !== 'optional' && execution.taskSupport !== 'forbidden')) return false;
  }
  return true;
};

export const validHostContext = (value: unknown): McpAppBridgeJsonRecord | undefined => {
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
    if (toolInfo === undefined || !validToolDefinition(toolInfo.tool) || (toolInfo.id !== undefined && !isRequestId(toolInfo.id))) return undefined;
  }
  if (context.deviceCapabilities !== undefined) {
    const device = jsonRecord(context.deviceCapabilities);
    if (device === undefined || (device.touch !== undefined && typeof device.touch !== 'boolean') || (device.hover !== undefined && typeof device.hover !== 'boolean')) return undefined;
  }
  if (context.styles !== undefined) {
    const styles = jsonRecord(context.styles);
    const variables = styles === undefined || styles.variables === undefined ? undefined : jsonRecord(styles.variables);
    const css = styles === undefined || styles.css === undefined ? undefined : jsonRecord(styles.css);
    if (styles === undefined || (styles.variables !== undefined && (variables === undefined || !Object.entries(variables).every(([key, variable]) => hostStyleVariables.has(key) && typeof variable === 'string')))
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

const validResourceMetadata = (value: unknown): McpAppBridgeJsonRecord | undefined => {
  const metadata = jsonRecord(value);
  if (metadata === undefined) return undefined;
  if (metadata.ui === undefined) return metadata;
  const ui = jsonRecord(metadata.ui);
  if (ui === undefined
    || (ui.csp !== undefined && !validCsp(ui.csp))
    || (ui.permissions !== undefined && !validPermissions(ui.permissions))
    || (ui.domain !== undefined && !nonempty(ui.domain))
    || (ui.prefersBorder !== undefined && typeof ui.prefersBorder !== 'boolean')) return undefined;
  return metadata;
};

const validResourceContent = (value: unknown): McpAppBridgeJsonRecord | undefined => {
  const content = jsonRecord(value);
  if (content === undefined || !nonempty(content.uri) || (content.mimeType !== undefined && !nonempty(content.mimeType))) return undefined;
  const hasText = typeof content.text === 'string';
  const hasBlob = typeof content.blob === 'string';
  if (hasText === hasBlob || (content._meta !== undefined && validResourceMetadata(content._meta) === undefined)) return undefined;
  return content;
};

export const validResourceReadResult = (value: unknown): ValidMcpAppResourceReadResult | undefined => {
  const result = jsonRecord(value);
  const contents = result?.contents;
  if (result === undefined || !Array.isArray(contents) || !contents.every((content) => validResourceContent(content) !== undefined)) return undefined;
  return Object.freeze({ ...result, contents: Object.freeze([...contents]) }) as ValidMcpAppResourceReadResult;
};

const resourceMetadata = (value: unknown): { readonly csp?: McpAppSandboxCsp; readonly permissions?: McpAppSandboxPermissions } | undefined => {
  if (value === undefined) return Object.freeze({});
  const metadata = validResourceMetadata(value);
  const ui = metadata === undefined ? undefined : jsonRecord(metadata.ui);
  if (metadata === undefined || ui === undefined && metadata.ui !== undefined) return undefined;
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

export const parsedResource = (value: McpAppJsonValue, resourceUri: string): ParsedMcpAppResource | undefined => {
  const response = validResourceReadResult(value);
  if (response === undefined) return undefined;
  for (const candidate of response.contents) {
    const content = validResourceContent(candidate);
    if (content === undefined || content.uri !== resourceUri || content.mimeType !== MCP_APP_MIME_TYPE) continue;
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

export const validToolCall = (params: McpAppJsonValue | undefined): McpAppBridgeToolCall | undefined => {
  const record = jsonRecord(params);
  if (record === undefined || !nonempty(record.name)) return undefined;
  if (record.arguments !== undefined && jsonRecord(record.arguments) === undefined) return undefined;
  return Object.freeze({ ...(record.arguments === undefined ? {} : { arguments: cloneJson(record.arguments) }), name: record.name });
};

export const validResourceRead = (params: McpAppJsonValue | undefined): McpAppBridgeResourceRead | undefined => {
  const record = jsonRecord(params);
  return record === undefined || !nonempty(record.uri) ? undefined : Object.freeze({ uri: record.uri });
};

export const validOpenLink = (params: McpAppJsonValue | undefined): string | undefined => {
  const record = jsonRecord(params);
  if (record === undefined || !nonempty(record.url)) return undefined;
  try {
    const url = new URL(record.url);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch {
    return undefined;
  }
};

export const validMessage = (params: McpAppJsonValue | undefined): McpAppBridgeMessageEvent | undefined => {
  const record = jsonRecord(params);
  const content = record === undefined ? undefined : validContentBlocks(record.content);
  if (record === undefined || record.role !== 'user' || content === undefined) return undefined;
  return Object.freeze({ content, role: 'user' });
};

export const validDisplayMode = (params: McpAppJsonValue | undefined): McpAppBridgeDisplayMode | undefined => {
  const record = jsonRecord(params);
  return record === undefined || typeof record.mode !== 'string' || !displayModes.has(record.mode as McpAppBridgeDisplayMode)
    ? undefined
    : record.mode as McpAppBridgeDisplayMode;
};

export const validModelContext = (params: McpAppJsonValue | undefined): McpAppBridgeModelContext | undefined => {
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

export const validLog = (params: McpAppJsonValue | undefined): McpAppBridgeLogEvent | undefined => {
  const record = jsonRecord(params);
  if (record === undefined || record.data === undefined || typeof record.level !== 'string' || !loggingLevels.has(record.level)) return undefined;
  if (record.logger !== undefined && !nonempty(record.logger)) return undefined;
  return Object.freeze({
    data: cloneJson(record.data),
    level: record.level,
    ...(record.logger === undefined ? {} : { logger: record.logger }),
  });
};

export const validSize = (params: McpAppJsonValue | undefined): McpAppBridgeSize | undefined => {
  const record = jsonRecord(params);
  if (record === undefined || (record.width === undefined && record.height === undefined)) return undefined;
  if ((record.width !== undefined && (typeof record.width !== 'number' || !Number.isFinite(record.width) || record.width < 0))
    || (record.height !== undefined && (typeof record.height !== 'number' || !Number.isFinite(record.height) || record.height < 0))) return undefined;
  return Object.freeze({ ...(record.height === undefined ? {} : { height: record.height }), ...(record.width === undefined ? {} : { width: record.width }) });
};
