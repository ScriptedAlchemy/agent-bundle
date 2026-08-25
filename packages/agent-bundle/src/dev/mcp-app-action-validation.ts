import type { McpAppJsonValue } from './mcp-apps/mcp-app-binding-service.ts';
import { cloneMcpAppFiniteJson } from './mcp-app-metadata.ts';
import { runtimeAppFiniteOrdinaryJsonByteLength } from './runtime-app-message-limits.ts';

type McpAppJsonRecord = Readonly<Record<string, McpAppJsonValue>>;

export interface McpAppValidatedDownload {
  readonly contents: readonly McpAppJsonValue[];
  readonly embeddedBytes: number;
  readonly itemCount: number;
}

const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

const cloneJson = (value: unknown): McpAppJsonValue | undefined => {
  if (runtimeAppFiniteOrdinaryJsonByteLength(value) === undefined) return undefined;
  try {
    return cloneMcpAppFiniteJson(value);
  } catch {
    return undefined;
  }
};

const jsonRecord = (value: unknown): McpAppJsonRecord | undefined => {
  const copied = cloneJson(value);
  return copied === undefined || copied === null || Array.isArray(copied) || typeof copied !== 'object'
    ? undefined
    : copied as McpAppJsonRecord;
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
  return annotations.lastModified === undefined || validIsoDateTimeWithOffset(annotations.lastModified);
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

const validResourceMetadata = (value: unknown): McpAppJsonRecord | undefined => {
  const metadata = jsonRecord(value);
  if (metadata === undefined || metadata.ui === undefined) return metadata;
  const ui = jsonRecord(metadata.ui);
  if (ui === undefined
    || (ui.csp !== undefined && !validCsp(ui.csp))
    || (ui.permissions !== undefined && !validPermissions(ui.permissions))
    || (ui.domain !== undefined && !nonempty(ui.domain))
    || (ui.prefersBorder !== undefined && typeof ui.prefersBorder !== 'boolean')) return undefined;
  return metadata;
};

const validResourceContent = (value: unknown): McpAppJsonRecord | undefined => {
  const content = jsonRecord(value);
  if (content === undefined || !nonempty(content.uri) || (content.mimeType !== undefined && !nonempty(content.mimeType))) return undefined;
  const hasText = typeof content.text === 'string';
  const hasBlob = typeof content.blob === 'string';
  if (hasText === hasBlob || (content._meta !== undefined && validResourceMetadata(content._meta) === undefined)) return undefined;
  return content;
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
  const copied = cloneJson(value);
  if (!Array.isArray(copied) || !copied.every(contentBlock)) return undefined;
  return Object.freeze([...copied]);
};

const decodedEmbeddedBytes = (block: McpAppJsonValue): number | undefined => {
  const record = jsonRecord(block);
  if (record === undefined) return undefined;
  const encoded = record.type === 'image' || record.type === 'audio' ? record.data : record.type === 'resource' ? jsonRecord(record.resource)?.blob : undefined;
  if (encoded === undefined) return 0;
  if (typeof encoded !== 'string' || encoded.length % 4 !== 0) return undefined;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  let terminal = 0;
  for (let index = 0; index < encoded.length - padding; index += 1) {
    const code = encoded.charCodeAt(index);
    const value = code >= 65 && code <= 90 ? code - 65
      : code >= 97 && code <= 122 ? code - 71
        : code >= 48 && code <= 57 ? code + 4
          : code === 43 ? 62
            : code === 47 ? 63
              : -1;
    if (value < 0) return undefined;
    terminal = value;
  }
  for (let index = encoded.length - padding; index < encoded.length; index += 1) {
    if (encoded.charCodeAt(index) !== 61) return undefined;
  }
  if ((padding === 2 && terminal % 16 !== 0) || (padding === 1 && terminal % 4 !== 0)) return undefined;
  return encoded.length / 4 * 3 - padding;
};

export const validateMcpAppExternalUrl = (value: unknown): string | undefined => {
  if (!nonempty(value) || value.length > 4_096 || value.includes('\0')) return undefined;
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && !url.username && !url.password && !url.hash && url.href === value
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
};

export const validateMcpAppExternalLink = (params: unknown): Readonly<{ readonly url: string }> | undefined => {
  const record = jsonRecord(params);
  const url = record === undefined ? undefined : validateMcpAppExternalUrl(record.url);
  return url === undefined ? undefined : Object.freeze({ url });
};

export const validateMcpAppDownloadContents = (value: unknown): McpAppValidatedDownload | undefined => {
  const contents = validContentBlocks(value);
  if (contents === undefined || contents.length === 0 || contents.length > 20) return undefined;
  let embeddedBytes = 0;
  for (const content of contents) {
    const bytes = decodedEmbeddedBytes(content);
    if (bytes === undefined) return undefined;
    embeddedBytes += bytes;
    if (embeddedBytes > 10 * 1024 * 1024) return undefined;
  }
  return Object.freeze({ contents, embeddedBytes, itemCount: contents.length });
};

export const validateMcpAppDownloadRequest = (value: unknown): McpAppValidatedDownload | undefined => {
  const record = jsonRecord(value);
  return record === undefined ? undefined : validateMcpAppDownloadContents(record.contents);
};

export const validateMcpAppUiUri = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'ui:' && parsed.hostname.length > 0 && parsed.toString() === value ? value : undefined;
  } catch {
    return undefined;
  }
};
