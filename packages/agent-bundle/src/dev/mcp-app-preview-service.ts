import { Buffer } from 'node:buffer';

import {
  selectMcpAppResourceUri,
  type McpAppBinding,
  type McpAppBindingTeardown,
  type McpAppJsonValue,
  type McpAppPreviewProfile,
} from './mcp-app-binding-service.ts';
import {
  createMcpAppBridge,
  type McpAppBridge,
  type McpAppBridgeBindingOperations,
  type McpAppBridgeCloseOptions,
  type McpAppBridgeHost,
  type McpAppBridgeHostInfo,
  type McpAppBridgeJsonRecord,
  type McpAppBridgeMessage,
  type McpAppBridgeResourceResolution,
} from './mcp-app-bridge.ts';
import {
  MCP_APP_HTML_MIME_TYPE,
  resolveMcpAppHostProfile,
  type McpAppHostContextInput,
  type McpAppHostProfileResolution,
} from './mcp-app-host-profiles.ts';
import {
  createMcpAppSandboxFrame,
  type McpAppSandboxConsent,
  type McpAppSandboxEndpoint,
  type McpAppSandboxFrame,
  type McpAppSandboxPermissions,
} from './mcp-app-sandbox.ts';

export interface McpAppPreviewBindingAuthority extends McpAppBridgeBindingOperations {
  createBinding(options: {
    readonly input: McpAppJsonValue;
    readonly onTeardown?: McpAppBindingTeardown;
    readonly previewProfile: McpAppPreviewProfile;
    readonly result: McpAppJsonValue;
    readonly sessionId: string;
    readonly toolName: string;
  }): Promise<McpAppBinding>;
}

export interface CreateMcpAppPreviewOptions {
  readonly consent?: McpAppSandboxConsent;
  readonly host: McpAppHostContextInput;
  readonly input: McpAppJsonValue;
  readonly previewProfile: McpAppPreviewProfile;
  readonly result: McpAppJsonValue;
  readonly sessionId: string;
  readonly toolName: string;
}

export interface McpAppPreview {
  readonly binding: McpAppBinding;
  readonly bridge: McpAppBridge;
  readonly frame?: McpAppSandboxFrame;
  readonly profile: McpAppHostProfileResolution;
  readonly resource: McpAppBridgeResourceResolution;
}

export interface McpAppPreviewServiceOptions {
  readonly bindingAuthority: McpAppPreviewBindingAuthority;
  readonly host?: Omit<McpAppBridgeHost, 'context' | 'info'>;
  readonly hostInfo: McpAppBridgeHostInfo;
  readonly hostOrigin: string;
  readonly maxActionBytes?: number;
  readonly maxOutboundBytes?: number;
  readonly maxOutboundMessages?: number;
  readonly maxQueuedActions?: number;
  readonly sandboxProxy: McpAppSandboxEndpoint;
}

interface PreviewEntry {
  readonly binding: McpAppBinding;
  readonly bridge: McpAppBridge;
  readonly preview: McpAppPreview;
  readonly outbound: McpAppBridgeMessage[];
  actionCount: number;
  closePromise?: Promise<void>;
  closed: boolean;
  outboundBytes: number;
  tail: Promise<void>;
}

const defaultMaximumActions = 32;
const defaultMaximumActionBytes = 64 * 1024;
const defaultMaximumOutboundBytes = 256 * 1024;
const defaultMaximumOutboundMessages = 64;

const positiveInteger = (value: number | undefined, fallback: number, name: string): number => {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw new TypeError(`${name} must be a positive safe integer.`);
  return normalized;
};

const messageByteLength = (message: unknown): number | undefined => {
  try {
    return Buffer.byteLength(JSON.stringify(message), 'utf8');
  } catch {
    return undefined;
  }
};

const hostContextRecord = (host: McpAppHostContextInput): McpAppBridgeJsonRecord => Object.freeze({
  availableDisplayModes: [...host.availableDisplayModes],
  containerDimensions: { ...host.containerDimensions },
  deviceCapabilities: { ...host.deviceCapabilities },
  displayMode: host.displayMode,
  locale: host.locale,
  platform: host.platform,
  safeAreaInsets: { ...host.safeAreaInsets },
  styles: { ...host.styles },
  theme: host.theme,
  timeZone: host.timeZone,
  toolInfo: { ...host.toolInfo },
  userAgent: host.userAgent,
});

const capabilitiesOf = (permissions: McpAppSandboxPermissions | undefined): readonly string[] =>
  Object.freeze(permissions === undefined ? [] : Object.keys(permissions));

const resourceForProfile = (binding: McpAppBinding, resource: McpAppBridgeResourceResolution):
  | { readonly available: false }
  | { readonly mimeType: string; readonly uri: string } => {
  if (resource.kind === 'resource') return Object.freeze({ mimeType: MCP_APP_HTML_MIME_TYPE, uri: binding.resourceUri });
  if (resource.reason === 'invalid-resource' || resource.reason === 'missing-canonical-resource-uri') {
    return Object.freeze({ mimeType: '', uri: binding.resourceUri });
  }
  return Object.freeze({ available: false });
};

export class McpAppPreviewService {
  readonly #bindingAuthority: McpAppPreviewBindingAuthority;
  readonly #host: Omit<McpAppBridgeHost, 'context' | 'info'>;
  readonly #hostInfo: McpAppBridgeHostInfo;
  readonly #hostOrigin: string;
  readonly #maxActionBytes: number;
  readonly #maxOutboundBytes: number;
  readonly #maxOutboundMessages: number;
  readonly #maxQueuedActions: number;
  readonly #sandboxProxy: McpAppSandboxEndpoint;
  readonly #entries = new Map<string, PreviewEntry>();

  constructor(options: McpAppPreviewServiceOptions) {
    this.#bindingAuthority = options.bindingAuthority;
    this.#host = options.host ?? {};
    this.#hostInfo = Object.freeze({ name: options.hostInfo.name, version: options.hostInfo.version });
    this.#hostOrigin = options.hostOrigin;
    this.#maxActionBytes = positiveInteger(options.maxActionBytes, defaultMaximumActionBytes, 'MCP App maximum action bytes');
    this.#maxOutboundBytes = positiveInteger(options.maxOutboundBytes, defaultMaximumOutboundBytes, 'MCP App maximum outbound bytes');
    this.#maxOutboundMessages = positiveInteger(options.maxOutboundMessages, defaultMaximumOutboundMessages, 'MCP App maximum outbound messages');
    this.#maxQueuedActions = positiveInteger(options.maxQueuedActions, defaultMaximumActions, 'MCP App maximum queued actions');
    this.#sandboxProxy = options.sandboxProxy;
  }

  get(bindingId: string): McpAppPreview | undefined {
    return this.#entries.get(bindingId)?.preview;
  }

  async create(options: CreateMcpAppPreviewOptions): Promise<McpAppPreview> {
    const binding = await this.#bindingAuthority.createBinding({
      input: options.input,
      onTeardown: (event) => this.#onBindingTeardown(event.binding.id),
      previewProfile: options.previewProfile,
      result: options.result,
      sessionId: options.sessionId,
      toolName: options.toolName,
    });
    try {
      this.#assertCanonicalBinding(binding, options);
      const outbound: McpAppBridgeMessage[] = [];
      const entryRef: { current?: PreviewEntry } = {};
      const bridge = createMcpAppBridge({
        binding,
        host: {
          ...this.#host,
          context: hostContextRecord(options.host),
          info: this.#hostInfo,
        },
        operations: this.#bindingAuthority,
        send: (message) => {
          const entry = entryRef.current;
          const bytes = messageByteLength(message);
          if (entry === undefined || entry.closed || bytes === undefined || bytes > this.#maxOutboundBytes
            || outbound.length >= this.#maxOutboundMessages || entry.outboundBytes + bytes > this.#maxOutboundBytes) {
            return false;
          }
          outbound.push(message);
          entry.outboundBytes += bytes;
          return true;
        },
      });
      const resource = await bridge.loadResource();
      const profile = resolveMcpAppHostProfile({
        consentedCapabilities: capabilitiesOf(options.consent?.permissions),
        declaredCapabilities: capabilitiesOf(resource.kind === 'resource' ? resource.permissions : undefined),
        host: options.host,
        profile: options.previewProfile,
        resource: resourceForProfile(binding, resource),
      });
      const frame = resource.kind === 'resource' && profile.kind === 'apps'
        ? createMcpAppSandboxFrame({
          consent: options.consent,
          declaration: { csp: resource.csp, permissions: resource.permissions },
          hostOrigin: this.#hostOrigin,
          proxy: this.#sandboxProxy,
        })
        : undefined;
      const preview = Object.freeze({ binding, bridge, ...(frame === undefined ? {} : { frame }), profile, resource });
      const entry: PreviewEntry = {
        actionCount: 0,
        binding,
        bridge,
        closed: false,
        outbound,
        outboundBytes: 0,
        preview,
        tail: Promise.resolve(),
      };
      entryRef.current = entry;
      this.#entries.set(binding.id, entry);
      return preview;
    } catch (error) {
      await this.#bindingAuthority.closeBinding(binding.id).catch(() => undefined);
      throw error;
    }
  }

  async receive(bindingId: string, action: unknown): Promise<boolean> {
    const entry = this.#entries.get(bindingId);
    const bytes = messageByteLength(action);
    if (entry === undefined || entry.closed || bytes === undefined || bytes > this.#maxActionBytes || entry.actionCount >= this.#maxQueuedActions) {
      return false;
    }
    entry.actionCount += 1;
    return this.#serialize(entry, async () => entry.bridge.receive(action)).finally(() => {
      entry.actionCount -= 1;
    });
  }

  async takeOutbound(bindingId: string): Promise<readonly McpAppBridgeMessage[]> {
    const entry = this.#entries.get(bindingId);
    if (entry === undefined || entry.closed) return Object.freeze([]);
    return this.#serialize(entry, () => {
      const outbound = Object.freeze(entry.outbound.splice(0));
      entry.outboundBytes = 0;
      entry.bridge.flushHostTraffic();
      return outbound;
    });
  }

  async close(bindingId: string, options: McpAppBridgeCloseOptions): Promise<boolean> {
    const entry = this.#entries.get(bindingId);
    if (entry === undefined) return false;
    await this.#closeEntry(entry, () => entry.bridge.close(options));
    return true;
  }

  async forceClose(bindingId: string): Promise<boolean> {
    const entry = this.#entries.get(bindingId);
    if (entry === undefined) return false;
    if (entry.closePromise !== undefined) {
      void entry.bridge.forceClose().catch(() => undefined);
      await entry.closePromise;
      return true;
    }
    await this.#closeEntry(entry, () => entry.bridge.forceClose());
    return true;
  }

  async closeAll(): Promise<void> {
    const results = await Promise.allSettled([...this.#entries.values()].map((entry) => this.#closeEntry(entry, () => entry.bridge.forceClose())));
    const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
    if (failures.length > 0) throw new AggregateError(failures, 'MCP App preview shutdown failed.');
  }

  #assertCanonicalBinding(binding: McpAppBinding, options: CreateMcpAppPreviewOptions): void {
    if (binding.sessionId !== options.sessionId || binding.toolName !== options.toolName || binding.previewProfile !== options.previewProfile) {
      throw new Error('MCP App preview binding does not match its requested session, tool, and preview profile.');
    }
    const resourceUri = selectMcpAppResourceUri(binding.toolDefinition);
    if (resourceUri === undefined || resourceUri !== binding.resourceUri) {
      throw new Error('MCP App preview binding must retain one canonical standard _meta.ui.resourceUri.');
    }
  }

  #serialize<T>(entry: PreviewEntry, operation: () => Promise<T> | T): Promise<T> {
    const result = entry.tail.then(operation, operation);
    entry.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  #closeEntry(entry: PreviewEntry, operation: () => Promise<void>): Promise<void> {
    if (entry.closePromise !== undefined) return entry.closePromise;
    entry.closed = true;
    entry.outbound.length = 0;
    entry.outboundBytes = 0;
    const close = this.#serialize(entry, operation);
    entry.closePromise = close.finally(() => {
      if (this.#entries.get(entry.binding.id) === entry) this.#entries.delete(entry.binding.id);
    });
    return entry.closePromise;
  }

  #onBindingTeardown(bindingId: string | undefined): void {
    if (bindingId === undefined) return;
    const entry = this.#entries.get(bindingId);
    if (entry === undefined) return;
    entry.closed = true;
    entry.outbound.length = 0;
    entry.outboundBytes = 0;
    this.#entries.delete(bindingId);
    if (entry.closePromise === undefined) {
      entry.closePromise = entry.bridge.forceClose().catch(() => undefined);
    }
  }
}
