import { Buffer } from 'node:buffer';

import {
  selectMcpAppResourceUri,
  type McpAppBinding,
  type McpAppBindingTeardown,
  type McpAppJsonValue,
  type McpAppPreviewProfile,
  type McpAppToolDefinition,
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
    readonly tool: McpAppToolDefinition;
  }): Promise<McpAppBinding>;
}

export interface McpAppPreviewToolAuthority {
  resolveTool(sessionId: string, toolName: string): Promise<McpAppToolDefinition>;
}

export type McpAppPreviewHostContext = Omit<McpAppHostContextInput, 'toolInfo'>;

export interface CreateMcpAppPreviewOptions {
  readonly consent?: McpAppSandboxConsent;
  readonly host: McpAppPreviewHostContext;
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

/** `true` means an uninitialized App closed without a teardown frame. */
export type McpAppPreviewCloseResult = McpAppBridgeMessage | boolean;

export interface McpAppPreviewServiceOptions {
  readonly bindingAuthority: McpAppPreviewBindingAuthority;
  readonly closeTimeoutMs?: number;
  readonly host?: Omit<McpAppBridgeHost, 'context' | 'info'>;
  readonly hostInfo: McpAppBridgeHostInfo;
  readonly hostOrigin: string;
  readonly maxActionBytes?: number;
  readonly maxOutboundBytes?: number;
  readonly maxOutboundMessages?: number;
  readonly maxQueuedActions?: number;
  readonly sandboxProxy: McpAppSandboxEndpoint;
  readonly toolAuthority: McpAppPreviewToolAuthority;
}

interface PreviewEntry {
  readonly binding: McpAppBinding;
  readonly bridge: McpAppBridge;
  preview?: McpAppPreview;
  readonly outbound: McpAppBridgeMessage[];
  pendingTeardown?: McpAppBridgeMessage;
  actionCount: number;
  closePromise?: Promise<void>;
  closing: boolean;
  closed: boolean;
  outboundBytes: number;
  tail: Promise<void>;
}

interface CreateControl {
  aborted: boolean;
  binding?: McpAppBinding;
  closed: boolean;
  done: Promise<void>;
  entry?: PreviewEntry;
  finish(failure?: unknown): void;
  releasePromise?: Promise<void>;
}

const defaultMaximumActions = 32;
const defaultMaximumActionBytes = 64 * 1024;
const defaultMaximumOutboundBytes = 256 * 1024;
const defaultMaximumOutboundMessages = 64;
const defaultCloseTimeoutMs = 1_000;

const positiveInteger = (value: number | undefined, fallback: number, name: string): number => {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1) throw new TypeError(`${name} must be a positive safe integer.`);
  return normalized;
};

const boundedTimeout = (value: number | undefined): number => positiveInteger(value, defaultCloseTimeoutMs, 'MCP App preview close timeout');

const createControl = (): CreateControl => {
  let finish: (failure?: unknown) => void = () => undefined;
  const done = new Promise<void>((resolve, reject) => {
    finish = (failure) => failure === undefined ? resolve() : reject(failure);
  });
  void done.catch(() => undefined);
  return { aborted: false, closed: false, done, finish };
};

const messageByteLength = (message: unknown): number | undefined => {
  try {
    return Buffer.byteLength(JSON.stringify(message), 'utf8');
  } catch {
    return undefined;
  }
};

const canonicalTool = (tool: McpAppToolDefinition): McpAppBridgeJsonRecord => {
  const snapshot: Record<string, McpAppJsonValue> = {};
  for (const [key, value] of Object.entries(tool)) {
    if (value !== undefined) snapshot[key] = value;
  }
  return Object.freeze(snapshot);
};

const hostContextRecord = (host: McpAppPreviewHostContext, tool: McpAppBridgeJsonRecord): McpAppBridgeJsonRecord => Object.freeze({
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
  toolInfo: { tool },
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
  readonly #closeTimeoutMs: number;
  readonly #host: Omit<McpAppBridgeHost, 'context' | 'info'>;
  readonly #hostInfo: McpAppBridgeHostInfo;
  readonly #hostOrigin: string;
  readonly #maxActionBytes: number;
  readonly #maxOutboundBytes: number;
  readonly #maxOutboundMessages: number;
  readonly #maxQueuedActions: number;
  readonly #sandboxProxy: McpAppSandboxEndpoint;
  readonly #toolAuthority: McpAppPreviewToolAuthority;
  readonly #creates = new Set<CreateControl>();
  readonly #entries = new Map<string, PreviewEntry>();
  #closing = false;
  #closeAllPromise?: Promise<void>;

  constructor(options: McpAppPreviewServiceOptions) {
    this.#bindingAuthority = options.bindingAuthority;
    this.#closeTimeoutMs = boundedTimeout(options.closeTimeoutMs);
    this.#host = options.host ?? {};
    this.#hostInfo = Object.freeze({ name: options.hostInfo.name, version: options.hostInfo.version });
    this.#hostOrigin = options.hostOrigin;
    this.#maxActionBytes = positiveInteger(options.maxActionBytes, defaultMaximumActionBytes, 'MCP App maximum action bytes');
    this.#maxOutboundBytes = positiveInteger(options.maxOutboundBytes, defaultMaximumOutboundBytes, 'MCP App maximum outbound bytes');
    this.#maxOutboundMessages = positiveInteger(options.maxOutboundMessages, defaultMaximumOutboundMessages, 'MCP App maximum outbound messages');
    this.#maxQueuedActions = positiveInteger(options.maxQueuedActions, defaultMaximumActions, 'MCP App maximum queued actions');
    this.#sandboxProxy = options.sandboxProxy;
    this.#toolAuthority = options.toolAuthority;
  }

  get(bindingId: string): McpAppPreview | undefined {
    return this.#entries.get(bindingId)?.preview;
  }

  async create(options: CreateMcpAppPreviewOptions): Promise<McpAppPreview> {
    if (this.#closing) throw new Error('MCP App preview service is closed.');
    const control = createControl();
    this.#creates.add(control);
    let cleanupFailure: unknown;
    try {
      const tool = await this.#toolAuthority.resolveTool(options.sessionId, options.toolName);
      this.#assertCreateAvailable(control);
      const binding = await this.#bindingAuthority.createBinding({
        input: options.input,
        onTeardown: (event) => {
          control.closed = true;
          this.#onBindingTeardown(event.binding.id);
        },
        previewProfile: options.previewProfile,
        result: options.result,
        sessionId: options.sessionId,
        tool,
      });
      control.binding = binding;
      this.#assertCanonicalBinding(binding, options);
      this.#assertCreateAvailable(control);
      const toolDefinition = canonicalTool(binding.toolDefinition);
      const host: McpAppHostContextInput = {
        ...options.host,
        toolInfo: { tool: toolDefinition },
      };
      const outbound: McpAppBridgeMessage[] = [];
      const entryRef: { current?: PreviewEntry } = {};
      const bridge = createMcpAppBridge({
        binding,
        host: {
          ...this.#host,
          context: hostContextRecord(options.host, toolDefinition),
          info: this.#hostInfo,
        },
        operations: this.#bindingAuthority,
        send: (message) => {
          const entry = entryRef.current;
          const bytes = messageByteLength(message);
          if (entry === undefined || entry.closed) return false;
          if (entry.closing && message.method === 'ui/resource-teardown') {
            if (entry.pendingTeardown !== undefined) return false;
            entry.pendingTeardown = message;
            return true;
          }
          if (bytes === undefined || bytes > this.#maxOutboundBytes
            || outbound.length >= this.#maxOutboundMessages || entry.outboundBytes + bytes > this.#maxOutboundBytes) {
            return false;
          }
          outbound.push(message);
          entry.outboundBytes += bytes;
          return true;
        },
      });
      const entry: PreviewEntry = {
        actionCount: 0,
        binding,
        bridge,
        closing: false,
        closed: false,
        outbound,
        outboundBytes: 0,
        tail: Promise.resolve(),
      };
      entryRef.current = entry;
      control.entry = entry;
      this.#entries.set(binding.id, entry);
      this.#assertCreateAvailable(control);
      const resource = await bridge.loadResource();
      this.#assertCreateAvailable(control);
      const profile = resolveMcpAppHostProfile({
        consentedCapabilities: capabilitiesOf(options.consent?.permissions),
        declaredCapabilities: capabilitiesOf(resource.kind === 'resource' ? resource.permissions : undefined),
        host,
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
      this.#assertCreateAvailable(control);
      entry.preview = preview;
      return preview;
    } catch (error) {
      try {
        await this.#abortCreate(control);
      } catch (cleanupError) {
        cleanupFailure = cleanupError;
      }
      throw error;
    } finally {
      this.#creates.delete(control);
      control.finish(cleanupFailure);
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

  async close(bindingId: string, options: McpAppBridgeCloseOptions): Promise<McpAppPreviewCloseResult> {
    const entry = this.#entries.get(bindingId);
    if (entry === undefined) return false;
    void this.#closeEntry(entry, () => entry.bridge.close(options), false).catch(() => undefined);
    return this.#takeTeardown(entry, options.id) ?? true;
  }

  async forceClose(bindingId: string): Promise<boolean> {
    const entry = this.#entries.get(bindingId);
    if (entry === undefined) return false;
    await this.#forceCloseEntry(entry);
    return true;
  }

  async closeAll(): Promise<void> {
    if (this.#closeAllPromise !== undefined) return this.#closeAllPromise;
    this.#closing = true;
    const creates = [...this.#creates];
    for (const control of creates) control.aborted = true;
    const operations = [
      ...[...this.#entries.values()].map((entry) => this.#forceCloseEntry(entry)),
      ...creates.flatMap((control) => [
        this.#abortCreate(control),
        this.#within(control.done, 'MCP App preview creation drain'),
      ]),
    ];
    this.#closeAllPromise = Promise.allSettled(operations).then((results) => {
      const failures = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : []);
      if (failures.length > 0) throw new AggregateError(failures, 'MCP App preview shutdown failed.');
    });
    return this.#closeAllPromise;
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

  #closeEntry(entry: PreviewEntry, operation: () => Promise<void>, discardOutbound: boolean, replace = false): Promise<void> {
    if (!replace && entry.closePromise !== undefined) return entry.closePromise;
    entry.closing = true;
    if (discardOutbound) {
      entry.outbound.length = 0;
      entry.outboundBytes = 0;
      entry.pendingTeardown = undefined;
    }
    let operationResult: Promise<void>;
    try {
      operationResult = operation();
    } catch (error) {
      operationResult = Promise.reject(error);
    }
    const close = this.#within(operationResult, 'MCP App preview binding close');
    const pending = close.then(
      () => {
        if (entry.closePromise !== pending) return;
        entry.closed = true;
        entry.outbound.length = 0;
        entry.outboundBytes = 0;
        entry.pendingTeardown = undefined;
        if (this.#entries.get(entry.binding.id) === entry) this.#entries.delete(entry.binding.id);
      },
      (error: unknown) => {
        if (entry.closePromise === pending) entry.closePromise = undefined;
        throw error;
      },
    );
    entry.closePromise = pending;
    return pending;
  }

  #takeTeardown(entry: PreviewEntry, id: McpAppBridgeCloseOptions['id']): McpAppBridgeMessage | undefined {
    const teardown = entry.pendingTeardown;
    if (teardown === undefined || teardown.id !== id) return undefined;
    entry.pendingTeardown = undefined;
    return teardown;
  }

  #onBindingTeardown(bindingId: string | undefined): void {
    if (bindingId === undefined) return;
    const entry = this.#entries.get(bindingId);
    if (entry === undefined) return;
    entry.closed = true;
    entry.outbound.length = 0;
    entry.outboundBytes = 0;
    entry.pendingTeardown = undefined;
    this.#entries.delete(bindingId);
    void this.#forceCloseEntry(entry).catch(() => undefined);
  }

  #assertCreateAvailable(control: CreateControl): void {
    if (this.#closing || control.aborted || control.closed) {
      throw new Error('MCP App preview creation was closed before completion.');
    }
  }

  #within<T>(operation: Promise<T>, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} exceeded its bounded timeout.`)), this.#closeTimeoutMs);
    });
    return Promise.race([operation, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  }

  async #abortCreate(control: CreateControl): Promise<void> {
    const entry = control.entry;
    if (entry !== undefined) {
      await this.#forceCloseEntry(entry);
      return;
    }
    if (control.binding !== undefined && !control.closed) await this.#releaseControl(control);
  }

  #releaseControl(control: CreateControl): Promise<void> {
    if (control.releasePromise !== undefined) return control.releasePromise;
    const binding = control.binding;
    if (binding === undefined) return Promise.resolve();
    const release = this.#within(
      Promise.resolve().then(async () => {
        if (!await this.#bindingAuthority.closeBinding(binding.id)) throw new Error('MCP App preview binding release was rejected.');
      }),
      'MCP App preview creation release',
    );
    control.releasePromise = release.catch((error: unknown) => {
      throw new Error(`MCP App preview creation release failed for binding ${JSON.stringify(binding.id)}.`, { cause: error });
    });
    return control.releasePromise;
  }

  #forceCloseEntry(entry: PreviewEntry): Promise<void> {
    return this.#closeEntry(entry, () => entry.bridge.forceClose(), true, true);
  }
}
