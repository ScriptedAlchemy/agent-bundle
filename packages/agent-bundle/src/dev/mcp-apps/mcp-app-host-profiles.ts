import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';

import {
  MCP_APP_PROFILE_DESCRIPTORS,
  type McpAppHostProfile,
  type McpAppProfileDescriptor,
} from '../mcp-app-profile-descriptors.ts';
import {
  cloneMcpAppFiniteJson,
  inspectMcpAppMetadata,
  type McpAppJsonValue,
  type McpAppMetadataInspection,
} from '../mcp-app-metadata.ts';
import type {
  NormalizationConfigExtension,
  NormalizedPlugin,
} from '../../core/types.ts';

export { MCP_APP_PROFILE_DESCRIPTORS } from '../mcp-app-profile-descriptors.ts';
export type { McpAppHostProfile, McpAppProfileDescriptor, McpAppProfileId } from '../mcp-app-profile-descriptors.ts';

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
  /** Resource `_meta`, retained only as frozen metadata inspection evidence. */
  readonly metadata?: unknown;
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

export interface McpAppConfigExtensionInspectionEntry {
  readonly configured: true;
  readonly id: string;
  readonly key: string;
  readonly provenance: Readonly<{ readonly kind: 'config'; readonly sourcePath: string }>;
  readonly target: string;
}

export interface McpAppConfigExtensionInspection {
  readonly entries: readonly McpAppConfigExtensionInspectionEntry[];
  readonly sourceRevision: string;
}

export interface McpAppProfileBootstrap {
  readonly kind: 'none' | 'chatgpt-widget-state-v1';
  readonly script: string | undefined;
}

export interface McpAppClaudeDomainInspection {
  readonly declaredDomain?: string;
  readonly expectedDomain: string;
  readonly provenance: 'sha256-canonical-full-mcp-url';
}

/** Host-only derived domain evidence stays with the inspected resource metadata. */
export interface McpAppHostMetadataInspection extends McpAppMetadataInspection {
  readonly claudeDomain?: McpAppClaudeDomainInspection;
}

export interface McpAppConfigExtensionInspectionOptions {
  readonly descriptors: readonly NormalizationConfigExtension[];
  readonly extensions: NormalizedPlugin['extensions'];
  readonly projectRoot: string;
  readonly sourceRevision: string;
}

export interface ResolveMcpAppHostProfileOptions {
  readonly chatgpt?: McpAppChatGptFeatures;
  readonly claude?: McpAppClaudeFeatures;
  /** Inspection-only normalized configuration; it does not opt a project into Runtime. */
  readonly configExtensions?: McpAppConfigExtensionInspectionOptions;
  readonly consentedCapabilities?: readonly string[];
  readonly declaredCapabilities?: readonly string[];
  readonly host: McpAppHostContextInput;
  readonly profile: McpAppHostProfile;
  readonly resource?: McpAppResourceCandidate;
  /** Preserved as metadata evidence; it never selects a profile feature. */
  readonly toolMetadata?: unknown;
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
  readonly bootstrap: McpAppProfileBootstrap;
  readonly configExtensions: McpAppConfigExtensionInspection;
  readonly descriptor: McpAppProfileDescriptor;
  readonly hostContext: McpAppHostContext;
  readonly kind: 'apps';
  readonly metadata: McpAppHostMetadataInspection;
  readonly permissions: McpAppHostPermissions;
  readonly resourceUri: string;
  readonly warnings: readonly string[];
}

export interface McpAppFallbackHostProfile {
  readonly configExtensions: McpAppConfigExtensionInspection;
  readonly descriptor: McpAppProfileDescriptor;
  readonly kind: 'fallback';
  readonly permissions: McpAppHostPermissions;
  readonly reason: 'apps-resource-invalid' | 'apps-resource-unavailable' | 'unsafe-capability-declaration';
  readonly warnings: readonly string[];
}

export type McpAppHostProfileResolution = McpAppAppsHostProfile | McpAppFallbackHostProfile;

export const MCP_APP_HTML_MIME_TYPE = 'text/html;profile=mcp-app';

/**
 * Fixed framework code, installed before untrusted App code. It has no global
 * API until the parent window sends a binding capability over this closed
 * channel; activation data is never interpolated into this source string.
 */
const fixedDormantChatGptBootstrap = String.raw`(() => {
  "use strict";
  const channel = "agent-bundle:mcp-app:chatgpt-widget-state-v1";
  const activateType = channel + "/activate";
  const persistType = channel + "/persist";
  const persistedType = channel + "/persisted";
  const diagnosticType = channel + "/diagnostic";
  const root = globalThis;
  const parentWindow = root.parent;
  const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
  const ownValue = (value, key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined ? undefined : descriptor.value;
  };
  const plainRecord = (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype === null) return true;
    const constructor = ownValue(prototype, "constructor");
    return typeof constructor === "function" && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(Object);
  };
  const denseArray = (value) => {
    if (!Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    const constructor = prototype === null ? undefined : ownValue(prototype, "constructor");
    return typeof constructor === "function" && Function.prototype.toString.call(constructor) === Function.prototype.toString.call(Array);
  };
  const cloneFiniteJson = (value, ancestors = new WeakSet()) => {
    if (value === null || typeof value === "boolean" || typeof value === "string") return value;
    if (typeof value === "number") {
      if (Number.isFinite(value)) return value;
      throw new TypeError("ChatGPT widget state must be finite JSON.");
    }
    if (denseArray(value)) {
      if (ancestors.has(value)) throw new TypeError("ChatGPT widget state must be finite JSON.");
      const keys = Reflect.ownKeys(value).filter((key) => key !== "length");
      if (keys.length !== value.length || keys.some((key, index) => key !== String(index))) {
        throw new TypeError("ChatGPT widget state must be a dense JSON array.");
      }
      ancestors.add(value);
      try {
        return Object.freeze(value.map((item, index) => {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
            throw new TypeError("ChatGPT widget state must be finite JSON.");
          }
          return cloneFiniteJson(descriptor.value, ancestors);
        }));
      } finally {
        ancestors.delete(value);
      }
    }
    if (!plainRecord(value) || ancestors.has(value) || Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("ChatGPT widget state must be finite JSON.");
    }
    ancestors.add(value);
    try {
      const clone = Object.create(Object.getPrototypeOf(value) === null ? null : Object.prototype);
      for (const key of Object.keys(value).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
          throw new TypeError("ChatGPT widget state must be finite JSON.");
        }
        Object.defineProperty(clone, key, {
          configurable: false,
          enumerable: true,
          value: cloneFiniteJson(descriptor.value, ancestors),
          writable: false,
        });
      }
      return Object.freeze(clone);
    } finally {
      ancestors.delete(value);
    }
  };
  let active = false;
  let bindingId;
  let capability;
  let hostOrigin;
  let widgetState;
  let acceptedState;
  let acceptedRevision = 0;
  let nextRequestId = 0;
  const pending = new Map();
  const send = (message) => parentWindow.postMessage(message, hostOrigin);
  const recomputeWidgetState = () => {
    let latest;
    for (const request of pending.values()) {
      if (request.revision > acceptedRevision && (latest === undefined || request.revision > latest.revision)) {
        latest = request;
      }
    }
    widgetState = latest === undefined ? acceptedState : latest.state;
  };
  const report = (code) => {
    try {
      send(Object.freeze({ bindingId, capability, code, type: diagnosticType }));
    } catch {
      // A detached parent cannot receive a diagnostic; the local rollback still happened.
    }
  };
  const authenticated = (message) =>
    plainRecord(message)
    && ownValue(message, "bindingId") === bindingId
    && ownValue(message, "capability") === capability;
  const activate = (message, origin) => {
    if (active || !authenticated(message)) return;
    const initialState = ownValue(message, "initialState");
    if (typeof bindingId !== "string" || bindingId.length === 0
      || typeof capability !== "string" || capability.length === 0
      || typeof origin !== "string" || origin.length === 0
      || hasOwn(root, "openai")) return;
    let initial;
    try {
      initial = cloneFiniteJson(initialState);
    } catch {
      return;
    }
    const api = {};
    Object.defineProperty(api, "widgetState", {
      enumerable: true,
      get: () => widgetState,
    });
    Object.defineProperty(api, "setWidgetState", {
      enumerable: true,
      value: (next) => {
        const replacement = cloneFiniteJson(next);
        const requestId = ++nextRequestId;
        widgetState = replacement;
        pending.set(requestId, Object.freeze({ revision: requestId, state: replacement }));
        try {
          send(Object.freeze({ bindingId, capability, requestId, state: replacement, type: persistType }));
        } catch {
          pending.delete(requestId);
          recomputeWidgetState();
          report("widget-state-persistence-unavailable");
        }
      },
      writable: false,
    });
    try {
      Object.defineProperty(root, "openai", {
        configurable: false,
        enumerable: false,
        value: Object.freeze(api),
        writable: false,
      });
      widgetState = initial;
      acceptedState = initial;
      hostOrigin = origin;
      active = true;
    } catch {
      report("widget-state-activation-failed");
    }
  };
  root.addEventListener("message", (event) => {
    if (event === null || event.isTrusted !== true || event.source !== parentWindow || event.origin !== hostOrigin && active) return;
    const message = event.data;
    if (!plainRecord(message)) return;
    const type = ownValue(message, "type");
    if (!active && type === activateType) {
      bindingId = ownValue(message, "bindingId");
      capability = ownValue(message, "capability");
      activate(message, event.origin);
      if (!active) {
        bindingId = undefined;
        capability = undefined;
      }
      return;
    }
    if (!active || type !== persistedType || !authenticated(message)) return;
    const requestId = ownValue(message, "requestId");
    const request = typeof requestId === "number" ? pending.get(requestId) : undefined;
    if (request === undefined) return;
    pending.delete(requestId);
    if (ownValue(message, "accepted") === true) {
      if (request.revision > acceptedRevision) {
        acceptedRevision = request.revision;
        acceptedState = request.state;
      }
    } else {
      report("widget-state-persistence-rejected");
    }
    recomputeWidgetState();
  });
})();`;

const noBootstrap = Object.freeze({ kind: 'none' as const, script: undefined });

const chatGptBootstrap = (): McpAppProfileBootstrap => Object.freeze({
  kind: 'chatgpt-widget-state-v1',
  script: fixedDormantChatGptBootstrap,
});

const emptyConfigExtensions: McpAppConfigExtensionInspection = Object.freeze({
  entries: Object.freeze([]),
  sourceRevision: 'unconfigured',
});

const capabilities = new Set<McpAppCapability>(['camera', 'clipboardWrite', 'geolocation', 'microphone']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const isConfigExtensionRecord = (value: unknown): value is Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const cloneRecord = (value: unknown, label: string): { readonly [key: string]: McpAppJsonValue } => {
  const cloned = cloneMcpAppFiniteJson(value, label);
  if (!isRecord(cloned)) throw new TypeError(`${label} must be a finite JSON object.`);
  return cloned;
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

const ownDataValue = (value: Record<string, unknown>, key: string, label: string): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || descriptor.get !== undefined || descriptor.set !== undefined) {
    throw new TypeError(`${label} must be an own data property.`);
  }
  return descriptor.value;
};

const ownNonemptyString = (value: Record<string, unknown>, key: string, label: string): string =>
  requireNonempty(ownDataValue(value, key, label), label);

const redactedConfigPath = (projectRoot: string, sourcePath: string): string => {
  const root = resolve(projectRoot);
  const candidate = resolve(sourcePath);
  const relativePath = relative(root, candidate);
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith('..\\') || relativePath.startsWith('../')) {
    return '<external-config>';
  }
  return relativePath.replaceAll('\\', '/');
};

/**
 * Projects registry-approved normalized extension identities only. In
 * particular, the adapter-owned `value` field is intentionally never read.
 */
export const inspectMcpAppConfigExtensions = (
  options: McpAppConfigExtensionInspectionOptions,
): McpAppConfigExtensionInspection => {
  const projectRoot = requireNonempty(options.projectRoot, 'MCP App config project root');
  const sourceRevision = requireNonempty(options.sourceRevision, 'MCP App config source revision');
  const descriptorTargetByKey = new Map<string, string>();
  for (const descriptor of options.descriptors) {
    if (!isRecord(descriptor)) throw new TypeError('MCP App config descriptor must be a plain record.');
    const key = ownNonemptyString(descriptor, 'key', 'MCP App config descriptor key');
    const target = ownNonemptyString(descriptor, 'target', 'MCP App config descriptor target');
    if (descriptorTargetByKey.has(key)) throw new TypeError(`MCP App config descriptor has duplicate key ${key}.`);
    descriptorTargetByKey.set(key, target);
  }
  if (!isConfigExtensionRecord(options.extensions)) {
    throw new TypeError('MCP App normalized extensions must have an ordinary or null prototype.');
  }
  for (const key of Object.keys(options.extensions)) {
    if (!descriptorTargetByKey.has(key)) throw new TypeError(`MCP App config extension ${key} is not registered.`);
  }

  const entries: McpAppConfigExtensionInspectionEntry[] = [];
  for (const [key, descriptorTarget] of [...descriptorTargetByKey.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    if (!Object.hasOwn(options.extensions, key)) continue;
    const extension = options.extensions[key];
    if (!isRecord(extension)) throw new TypeError(`MCP App config extension ${key} must be a plain record.`);
    const id = ownNonemptyString(extension, 'id', `MCP App config extension ${key} id`);
    const extensionKey = ownNonemptyString(extension, 'key', `MCP App config extension ${key} key`);
    const target = ownNonemptyString(extension, 'target', `MCP App config extension ${key} target`);
    if (id !== `extension:${key}` || extensionKey !== key || target !== descriptorTarget) {
      throw new TypeError(`MCP App config extension ${key} does not match its registered descriptor.`);
    }
    const provenance = ownDataValue(extension, 'provenance', `MCP App config extension ${key} provenance`);
    if (!isRecord(provenance) || ownDataValue(provenance, 'kind', `MCP App config extension ${key} provenance kind`) !== 'config') {
      throw new TypeError(`MCP App config extension ${key} must have config provenance.`);
    }
    const sourcePath = ownNonemptyString(provenance, 'sourcePath', `MCP App config extension ${key} provenance source path`);
    entries.push(Object.freeze({
      configured: true,
      id,
      key,
      provenance: Object.freeze({ kind: 'config', sourcePath: redactedConfigPath(projectRoot, sourcePath) }),
      target,
    }));
  }
  return Object.freeze({ entries: Object.freeze(entries), sourceRevision });
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
    if (publicMcpUrl.trim() !== publicMcpUrl || publicMcpUrl.includes('#')) return undefined;
    const url = new URL(publicMcpUrl);
    if (
      url.protocol !== 'https:' ||
      url.username.length > 0 ||
      url.password.length > 0 ||
      url.hash.length > 0 ||
      !isPublicHostname(url.hostname)
    ) {
      return undefined;
    }
    return `${createHash('sha256').update(url.href, 'utf8').digest('hex').slice(0, 32)}.claudemcpcontent.com`;
  } catch {
    return undefined;
  }
};

const setOwn = <Value>(target: Record<string, Value>, key: string, value: Value): void => {
  Object.defineProperty(target, key, { configurable: false, enumerable: true, value, writable: false });
};

const resourceDeclaredDomain = (metadata: McpAppMetadataInspection): string | undefined => {
  const ui = metadata.standard.ui;
  return isRecord(ui) && typeof ui.domain === 'string' ? ui.domain : undefined;
};

const inspectProfileMetadata = (
  toolMetadata: unknown,
  resourceMetadata: unknown,
  expectedDomain: string | undefined,
): McpAppHostMetadataInspection => {
  const tool = inspectMcpAppMetadata(toolMetadata);
  const resource = inspectMcpAppMetadata(resourceMetadata);
  const merged: Record<string, McpAppJsonValue> = {};
  for (const source of [tool.raw, resource.raw]) {
    for (const key of Object.keys(source).sort()) setOwn(merged, key, source[key]!);
  }
  const inspected = inspectMcpAppMetadata(merged);
  if (expectedDomain === undefined) return inspected;
  const declaredDomain = resourceDeclaredDomain(resource);
  return Object.freeze({
    ...inspected,
    claudeDomain: Object.freeze({
      ...(declaredDomain === undefined ? {} : { declaredDomain }),
      expectedDomain,
      provenance: 'sha256-canonical-full-mcp-url' as const,
    }),
  });
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
  configExtensions: McpAppConfigExtensionInspection,
  reason: McpAppFallbackHostProfile['reason'],
  warnings: readonly string[] = [],
): McpAppFallbackHostProfile =>
  Object.freeze({
    configExtensions,
    descriptor: MCP_APP_PROFILE_DESCRIPTORS[profile],
    kind: 'fallback',
    permissions: Object.freeze({}),
    reason,
    warnings: Object.freeze([...warnings]),
  });

export const resolveMcpAppHostProfile = (options: ResolveMcpAppHostProfileOptions): McpAppHostProfileResolution => {
  const configExtensions = options.configExtensions === undefined
    ? emptyConfigExtensions
    : inspectMcpAppConfigExtensions(options.configExtensions);
  if (options.resource === undefined || options.resource.available === false) {
    return resourceFallback(options.profile, configExtensions, 'apps-resource-unavailable');
  }
  if (!validResourceUri(options.resource.uri) || options.resource.mimeType !== MCP_APP_HTML_MIME_TYPE) {
    return resourceFallback(options.profile, configExtensions, 'apps-resource-invalid');
  }
  const hostContext = createHostContext(options.host);
  const permissionResolution = resolvePermissions(options.declaredCapabilities, options.consentedCapabilities);
  if (permissionResolution.unsafe) {
    return resourceFallback(options.profile, configExtensions, 'unsafe-capability-declaration', permissionResolution.warnings);
  }
  const publicMcpUrl = options.profile === 'claude' ? options.claude?.publicMcpUrl : undefined;
  const expectedDomain = publicMcpUrl === undefined ? undefined : claudeDomain(publicMcpUrl);
  const warnings = [
    ...permissionResolution.warnings,
    ...(publicMcpUrl !== undefined && expectedDomain === undefined
      ? ['Claude simulation requires a canonical public HTTPS MCP URL.']
      : []),
  ];
  const metadata = inspectProfileMetadata(options.toolMetadata, options.resource.metadata, expectedDomain);
  if (metadata.claudeDomain?.declaredDomain !== undefined
    && metadata.claudeDomain.declaredDomain !== metadata.claudeDomain.expectedDomain) {
    warnings.push('Declared MCP App ui.domain does not match the derived Claude domain.');
  }
  const resolution: McpAppAppsHostProfile = {
    bootstrap: options.profile === 'chatgpt' ? chatGptBootstrap() : noBootstrap,
    configExtensions,
    descriptor: MCP_APP_PROFILE_DESCRIPTORS[options.profile],
    hostContext,
    kind: 'apps',
    metadata,
    permissions: permissionResolution.permissions,
    resourceUri: options.resource.uri,
    warnings: Object.freeze(warnings),
  };
  return Object.freeze(resolution);
};
