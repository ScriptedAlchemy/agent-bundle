import { sha256Hex } from '../core/digest.ts';
import {
  requireMcpAppJsonRecord,
  snapshotMcpAppJson,
  type McpAppJsonValue,
} from './mcp-app-json.ts';

export type { McpAppJsonValue } from './mcp-app-json.ts';

export type McpAppHostProfile = 'chatgpt' | 'claude' | 'portable';

export type McpAppCapability = 'camera' | 'clipboardWrite' | 'geolocation' | 'microphone';

export interface McpAppHostContextInput {
  readonly availableDisplayModes: readonly string[];
  readonly containerDimensions: { readonly height: number; readonly width: number };
  readonly deviceCapabilities: { readonly [key: string]: McpAppJsonValue };
  readonly displayMode: string;
  readonly locale: string;
  readonly platform: string;
  readonly safeAreaInsets: { readonly bottom: number; readonly left: number; readonly right: number; readonly top: number };
  readonly styles: { readonly [key: string]: McpAppJsonValue };
  readonly theme: 'dark' | 'light';
  readonly timeZone: string;
  readonly toolInfo: { readonly [key: string]: McpAppJsonValue };
  readonly userAgent: string;
}

export interface McpAppResourceCandidate {
  readonly available?: boolean;
  readonly mimeType?: string;
  readonly uri?: string;
}

export interface McpAppChatGptFeatures {
  /** Feature-detected values exposed by the current `window.openai` API. */
  readonly windowOpenAi?: { readonly widgetState?: McpAppJsonValue };
}

export interface McpAppClaudeFeatures {
  readonly publicMcpUrl: string;
}

export interface ResolveMcpAppHostProfileOptions {
  readonly chatgpt?: McpAppChatGptFeatures;
  readonly claude?: McpAppClaudeFeatures;
  readonly consentedCapabilities?: readonly string[];
  readonly declaredCapabilities?: readonly string[];
  readonly host: McpAppHostContextInput;
  readonly profile: McpAppHostProfile;
  readonly resource?: McpAppResourceCandidate;
  /** Preserved by its descriptor owner. A host profile never selects this raw metadata. */
  readonly toolMetadata?: { readonly [key: string]: McpAppJsonValue };
}

export interface McpAppHostContext {
  readonly availableDisplayModes: readonly string[];
  readonly containerDimensions: Readonly<{ readonly height: number; readonly width: number }>;
  readonly deviceCapabilities: { readonly [key: string]: McpAppJsonValue };
  readonly displayMode: string;
  readonly locale: string;
  readonly platform: string;
  readonly safeAreaInsets: Readonly<{ readonly bottom: number; readonly left: number; readonly right: number; readonly top: number }>;
  readonly styles: { readonly [key: string]: McpAppJsonValue };
  readonly theme: 'dark' | 'light';
  readonly timeZone: string;
  readonly toolInfo: { readonly [key: string]: McpAppJsonValue };
  readonly userAgent: string;
}

export interface McpAppHostPermissions {
  readonly camera?: Readonly<Record<string, never>>;
  readonly clipboardWrite?: Readonly<Record<string, never>>;
  readonly geolocation?: Readonly<Record<string, never>>;
  readonly microphone?: Readonly<Record<string, never>>;
}

export interface McpAppAppsHostProfile {
  readonly extensions?: Readonly<{
    readonly claude?: Readonly<{ readonly domain: string }>;
    readonly windowOpenAi?: Readonly<{ readonly widgetState: McpAppJsonValue }>;
  }>;
  readonly hostContext: McpAppHostContext;
  readonly kind: 'apps';
  readonly permissions: McpAppHostPermissions;
  readonly profile: McpAppHostProfile;
  readonly resourceUri: string;
  readonly warnings: readonly string[];
}

export interface McpAppFallbackHostProfile {
  readonly kind: 'fallback';
  readonly permissions: McpAppHostPermissions;
  readonly profile: McpAppHostProfile;
  readonly reason: 'apps-resource-invalid' | 'apps-resource-unavailable' | 'unsafe-capability-declaration';
  readonly warnings: readonly string[];
}

export type McpAppHostProfileResolution = McpAppAppsHostProfile | McpAppFallbackHostProfile;

export const MCP_APP_HTML_MIME_TYPE = 'text/html;profile=mcp-app';

const capabilities = new Set<McpAppCapability>(['camera', 'clipboardWrite', 'geolocation', 'microphone']);

const cloneRecord = (value: unknown, label: string): { readonly [key: string]: McpAppJsonValue } => {
  return requireMcpAppJsonRecord(value, `${label} must be a finite JSON object.`);
};

const cloneStringList = (value: readonly string[], label: string): readonly string[] => {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.trim().length === 0)) {
    throw new TypeError(`${label} must be an array of nonempty strings.`);
  }
  return Object.freeze([...value]);
};

const requireNonempty = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim().length === 0) throw new TypeError(`${label} must be a nonempty string.`);
  return value;
};

const requireNonnegativeFinite = (value: unknown, label: string): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${label} must be a finite nonnegative number.`);
  }
  return value;
};

const createHostContext = (input: McpAppHostContextInput): McpAppHostContext => {
  const displayMode = requireNonempty(input.displayMode, 'MCP App display mode');
  const availableDisplayModes = cloneStringList(input.availableDisplayModes, 'MCP App available display modes');
  if (!availableDisplayModes.includes(displayMode)) throw new TypeError('MCP App display modes must include the selected display mode.');
  if (input.theme !== 'dark' && input.theme !== 'light') throw new TypeError('MCP App theme must be dark or light.');

  return Object.freeze({
    availableDisplayModes,
    containerDimensions: Object.freeze({
      height: requireNonnegativeFinite(input.containerDimensions.height, 'MCP App container height'),
      width: requireNonnegativeFinite(input.containerDimensions.width, 'MCP App container width'),
    }),
    deviceCapabilities: cloneRecord(input.deviceCapabilities, 'MCP App device capabilities'),
    displayMode,
    locale: requireNonempty(input.locale, 'MCP App locale'),
    platform: requireNonempty(input.platform, 'MCP App platform'),
    safeAreaInsets: Object.freeze({
      bottom: requireNonnegativeFinite(input.safeAreaInsets.bottom, 'MCP App safe-area bottom inset'),
      left: requireNonnegativeFinite(input.safeAreaInsets.left, 'MCP App safe-area left inset'),
      right: requireNonnegativeFinite(input.safeAreaInsets.right, 'MCP App safe-area right inset'),
      top: requireNonnegativeFinite(input.safeAreaInsets.top, 'MCP App safe-area top inset'),
    }),
    styles: cloneRecord(input.styles, 'MCP App styles'),
    theme: input.theme,
    timeZone: requireNonempty(input.timeZone, 'MCP App time zone'),
    toolInfo: cloneRecord(input.toolInfo, 'MCP App tool info'),
    userAgent: requireNonempty(input.userAgent, 'MCP App user agent'),
  });
};

const validResourceUri = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'ui:' && url.hostname.length > 0;
  } catch {
    return false;
  }
};

const hasPrefix = (address: readonly number[], prefix: readonly number[], prefixLength: number): boolean => {
  for (let bit = 0; bit < prefixLength; bit += 1) {
    const byte = Math.floor(bit / 8);
    const mask = 1 << (7 - (bit % 8));
    if ((address[byte] & mask) !== (prefix[byte] & mask)) return false;
  }
  return true;
};

type IpPrefix = readonly [readonly number[], number];

const parseIpv4 = (hostname: string): readonly number[] | undefined => {
  const octets = hostname.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return undefined;
  return Object.freeze(octets);
};

const parseIpv6 = (hostname: string): readonly number[] | undefined => {
  const source = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const halves = source.split('::');
  if (halves.length > 2) return undefined;
  const left = halves[0] === '' ? [] : halves[0].split(':');
  const right = halves.length === 1 || halves[1] === '' ? [] : halves[1].split(':');
  const segments = [...left, ...right];
  const groups = segments.map((group) => Number.parseInt(group, 16));
  if (groups.some((group, index) => !/^[0-9a-f]{1,4}$/.test(segments[index]) || group < 0 || group > 0xffff)) {
    return undefined;
  }
  const missingGroups = 8 - groups.length;
  if ((halves.length === 1 && missingGroups !== 0) || (halves.length === 2 && missingGroups < 1)) return undefined;
  const expanded = halves.length === 1 ? groups : [...groups.slice(0, left.length), ...Array<number>(missingGroups).fill(0), ...groups.slice(left.length)];
  return Object.freeze(expanded.flatMap((group) => [group >> 8, group & 0xff]));
};

const specialIpv4Prefixes: readonly IpPrefix[] = [
    [[0], 8],
    [[10], 8],
    [[100, 64], 10],
    [[127], 8],
    [[169, 254], 16],
    [[172, 16], 12],
    [[192, 0, 0], 24],
    [[192, 0, 2], 24],
    [[192, 31, 196], 24],
    [[192, 52, 193], 24],
    [[192, 88, 99], 24],
    [[192, 168], 16],
    [[192, 175, 48], 24],
    [[198, 18], 15],
    [[198, 51, 100], 24],
    [[203, 0, 113], 24],
    [[224], 4],
  [[240], 4],
];

const specialIpv6Prefixes: readonly IpPrefix[] = [
    [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 96],
    [[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff], 96],
    [[0, 100, 255, 155, 0, 0, 0, 0, 0, 0, 0, 0], 96],
    [[0, 100, 255, 155, 0, 1], 48],
    [[1, 0, 0, 0, 0, 0, 0, 0], 64],
    [[1, 0, 0, 0, 0, 0, 0, 1], 64],
    [[32, 1], 23],
    [[32, 1, 13, 184], 32],
    [[32, 2], 16],
    [[63, 255, 0], 20],
    [[95, 0], 16],
    [[252], 7],
    [[254, 128], 10],
  [[255], 8],
];

const isSpecialIpv4 = (address: readonly number[]): boolean =>
  specialIpv4Prefixes.some(([prefix, prefixLength]) => hasPrefix(address, prefix, prefixLength));

const isSpecialIpv6 = (address: readonly number[]): boolean =>
  specialIpv6Prefixes.some(([prefix, prefixLength]) => hasPrefix(address, prefix, prefixLength));

const isPublicHostname = (hostname: string): boolean => {
  const normalized = hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (normalized === 'localhost' || normalized.endsWith('.localhost') || normalized.endsWith('.local')) return false;
  const ipv4 = parseIpv4(normalized);
  if (ipv4 !== undefined) return !isSpecialIpv4(ipv4);
  const ipv6 = parseIpv6(normalized);
  return ipv6 === undefined || !isSpecialIpv6(ipv6);
};

const claudeDomain = (publicMcpUrl: string): string | undefined => {
  try {
    const url = new URL(publicMcpUrl);
    if (
      publicMcpUrl !== url.href ||
      url.protocol !== 'https:' ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hash.length > 0 ||
      !isPublicHostname(url.hostname)
    ) {
      return undefined;
    }
    return `${sha256Hex(publicMcpUrl).slice(0, 32)}.claudemcpcontent.com`;
  } catch {
    return undefined;
  }
};

const resolvePermissions = (
  declaredCapabilities: readonly string[] | undefined,
  consentedCapabilities: readonly string[] | undefined,
): Readonly<{ readonly permissions: McpAppHostPermissions; readonly unsafe: boolean; readonly warnings: readonly string[] }> => {
  if ((declaredCapabilities ?? []).some((capability) => capability.includes('*'))) {
    return Object.freeze({
      permissions: Object.freeze({}),
      unsafe: true,
      warnings: Object.freeze(['Wildcard MCP App capability declarations are rejected.']),
    });
  }
  const consented = new Set(consentedCapabilities ?? []);
  const granted: Record<string, Readonly<Record<string, never>>> = {};
  for (const capability of declaredCapabilities ?? []) {
    if (capabilities.has(capability as McpAppCapability) && consented.has(capability)) granted[capability] = Object.freeze({});
  }
  return Object.freeze({ permissions: Object.freeze(granted), unsafe: false, warnings: Object.freeze([]) });
};

const resourceFallback = (
  profile: McpAppHostProfile,
  reason: McpAppFallbackHostProfile['reason'],
  warnings: readonly string[] = [],
): McpAppFallbackHostProfile =>
  Object.freeze({
    kind: 'fallback',
    permissions: Object.freeze({}),
    profile,
    reason,
    warnings: Object.freeze([...warnings]),
  });

export const resolveMcpAppHostProfile = (options: ResolveMcpAppHostProfileOptions): McpAppHostProfileResolution => {
  if (options.resource === undefined || options.resource.available === false) {
    return resourceFallback(options.profile, 'apps-resource-unavailable');
  }
  if (!validResourceUri(options.resource.uri) || options.resource.mimeType !== MCP_APP_HTML_MIME_TYPE) {
    return resourceFallback(options.profile, 'apps-resource-invalid');
  }
  const hostContext = createHostContext(options.host);
  const permissionResolution = resolvePermissions(options.declaredCapabilities, options.consentedCapabilities);
  if (permissionResolution.unsafe) {
    return resourceFallback(options.profile, 'unsafe-capability-declaration', permissionResolution.warnings);
  }
  const resolution: McpAppAppsHostProfile = {
    hostContext,
    kind: 'apps',
    permissions: permissionResolution.permissions,
    profile: options.profile,
    resourceUri: options.resource.uri,
    warnings: permissionResolution.warnings,
  };
  if (options.profile === 'chatgpt') {
    if (options.chatgpt?.windowOpenAi?.widgetState === undefined) return Object.freeze(resolution);
    const widgetState = snapshotMcpAppJson(options.chatgpt.windowOpenAi.widgetState);
    if (widgetState === undefined) {
      throw new TypeError('ChatGPT window.openai widget state must be a finite JSON value.');
    }
    return Object.freeze({
      ...resolution,
      extensions: Object.freeze({
        windowOpenAi: Object.freeze({ widgetState }),
      }),
    });
  }

  if (options.profile === 'claude') {
    const publicMcpUrl = options.claude?.publicMcpUrl;
    if (publicMcpUrl === undefined) return Object.freeze(resolution);
    const domain = claudeDomain(publicMcpUrl);
    if (domain === undefined) return Object.freeze(resolution);
    return Object.freeze({
      ...resolution,
      extensions: Object.freeze({ claude: Object.freeze({ domain }) }),
    });
  }
  return Object.freeze(resolution);
};
