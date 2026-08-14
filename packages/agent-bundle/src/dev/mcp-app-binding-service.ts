import { randomUUID } from 'node:crypto';

export type McpAppJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly McpAppJsonValue[]
  | { readonly [key: string]: McpAppJsonValue };

export type McpAppPreviewProfile = 'chatgpt' | 'claude' | 'portable';

export interface McpAppToolDefinition {
  readonly _meta?: { readonly [key: string]: McpAppJsonValue };
  readonly name: string;
  readonly [key: string]: McpAppJsonValue | undefined;
}

export interface McpAppSessionIdentity {
  readonly epochId: string;
  readonly serverName: string;
  readonly sessionId: string;
  readonly target: string;
}

export interface McpAppBridgeTool {
  readonly appVisible: boolean;
  readonly name: string;
}

export interface McpAppBridgeResource {
  readonly appVisible: boolean;
  readonly uri: string;
}

export interface McpAppBridgeSession {
  readonly identity: McpAppSessionIdentity;
  callTool(options: { readonly arguments: McpAppJsonValue | undefined; readonly name: string }): Promise<McpAppJsonValue>;
  listBridgeResources(): Promise<readonly McpAppBridgeResource[]>;
  listBridgeTools(): Promise<readonly McpAppBridgeTool[]>;
  readResource(options: { readonly uri: string }): Promise<McpAppJsonValue>;
}

export interface McpAppSessionLease {
  readonly session: McpAppBridgeSession;
  release(): Promise<void>;
  subscribeSessionClosed(listener: (reason?: unknown) => Promise<void> | void): () => void;
}

export interface McpAppSessionAuthority {
  acquireAppLease(sessionId: string): Promise<McpAppSessionLease>;
}

export interface McpAppBinding {
  readonly epochId: string;
  readonly id: string;
  readonly input: McpAppJsonValue;
  readonly previewProfile: McpAppPreviewProfile;
  readonly resourceUri: string;
  readonly result: McpAppJsonValue;
  readonly serverName: string;
  readonly sessionId: string;
  readonly target: string;
  readonly toolDefinition: McpAppToolDefinition;
  readonly toolName: string;
}

export interface McpAppBindingTeardown {
  (event: Readonly<{ readonly binding: McpAppBinding; readonly reason: 'app-closed' | 'session-closed' }>): Promise<void> | void;
}

export interface CreateMcpAppBindingOptions {
  readonly input: McpAppJsonValue;
  readonly onTeardown?: McpAppBindingTeardown;
  readonly previewProfile: McpAppPreviewProfile;
  readonly result: McpAppJsonValue;
  readonly sessionId: string;
  readonly tool: McpAppToolDefinition;
}

export interface McpAppToolCall {
  readonly arguments?: McpAppJsonValue;
  readonly name: string;
}

export interface McpAppResourceRead {
  readonly uri: string;
}

export interface McpAppBindingServiceOptions {
  readonly sessionAuthority: McpAppSessionAuthority;
  readonly teardownTimeoutMs?: number;
}

interface BindingEntry {
  readonly binding: McpAppBinding;
  readonly lease: McpAppSessionLease;
  readonly onTeardown: McpAppBindingTeardown | undefined;
  closePromise: Promise<void> | undefined;
  closed: boolean;
  unsubscribe: () => void;
}

const defaultTeardownTimeoutMs = 1_000;
const maximumTeardownTimeoutMs = 30_000;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

const isJsonValue = (value: unknown): value is McpAppJsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Object.values(value).every(isJsonValue);
};

const cloneJson = (value: McpAppJsonValue): McpAppJsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (Array.isArray(value)) return Object.freeze(value.map(cloneJson));
  const copy = Object.create(null) as Record<string, McpAppJsonValue>;
  for (const [key, child] of Object.entries(value)) copy[key] = cloneJson(child);
  return Object.freeze(copy);
};

const requireJson = (value: unknown, label: string): McpAppJsonValue => {
  if (!isJsonValue(value)) throw new TypeError(`${label} must be a finite JSON value.`);
  return cloneJson(value);
};

const requireNonempty = (value: string, label: string): string => {
  if (value.trim().length === 0) throw new Error(`${label} must be nonempty.`);
  return value;
};

const requireProfile = (profile: McpAppPreviewProfile): McpAppPreviewProfile => {
  if (profile === 'chatgpt' || profile === 'claude' || profile === 'portable') return profile;
  throw new Error(`Unsupported MCP App preview profile ${JSON.stringify(profile)}.`);
};

const requireTeardownTimeout = (value: number | undefined): number => {
  const timeout = value ?? defaultTeardownTimeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > maximumTeardownTimeoutMs) {
    throw new RangeError(`MCP App teardown timeout must be an integer from 1 to ${maximumTeardownTimeoutMs} ms.`);
  }
  return timeout;
};

export const selectMcpAppResourceUri = (tool: McpAppToolDefinition): string | undefined => {
  const metadata = tool._meta;
  if (!isRecord(metadata) || !isRecord(metadata.ui) || typeof metadata.ui.resourceUri !== 'string') return undefined;
  try {
    const resource = new URL(metadata.ui.resourceUri);
    return resource.protocol === 'ui:' && resource.hostname.length > 0 ? metadata.ui.resourceUri : undefined;
  } catch {
    return undefined;
  }
};

export class McpAppBindingService {
  readonly #entries = new Map<string, BindingEntry>();
  readonly #sessionAuthority: McpAppSessionAuthority;
  readonly #teardownTimeoutMs: number;

  constructor(options: McpAppBindingServiceOptions) {
    this.#sessionAuthority = options.sessionAuthority;
    this.#teardownTimeoutMs = requireTeardownTimeout(options.teardownTimeoutMs);
  }

  get(bindingId: string): McpAppBinding | undefined {
    return this.#entries.get(bindingId)?.binding;
  }

  async createBinding(options: CreateMcpAppBindingOptions): Promise<McpAppBinding> {
    const sessionId = requireNonempty(options.sessionId, 'MCP App session id');
    const toolName = requireNonempty(options.tool.name, 'MCP App tool name');
    const resourceUri = selectMcpAppResourceUri(options.tool);
    if (resourceUri === undefined) {
      throw new Error('MCP App tool must declare a standard _meta.ui.resourceUri using ui://.');
    }
    const toolDefinition = requireJson(options.tool, 'MCP App tool definition') as McpAppToolDefinition;
    const input = requireJson(options.input, 'MCP App tool input');
    const result = requireJson(options.result, 'MCP App tool result');
    const previewProfile = requireProfile(options.previewProfile);
    if (options.onTeardown !== undefined && typeof options.onTeardown !== 'function') {
      throw new TypeError('MCP App teardown callback must be a function.');
    }

    const lease = await this.#sessionAuthority.acquireAppLease(sessionId);
    let entry: BindingEntry | undefined;
    try {
      const identity = lease.session.identity;
      if (identity.sessionId !== sessionId) {
        throw new Error(`MCP App lease identity does not match requested session ${JSON.stringify(sessionId)}.`);
      }
      const binding = Object.freeze({
        epochId: requireNonempty(identity.epochId, 'MCP App epoch id'),
        id: randomUUID(),
        input,
        previewProfile,
        resourceUri,
        result,
        serverName: requireNonempty(identity.serverName, 'MCP App server name'),
        sessionId,
        target: requireNonempty(identity.target, 'MCP App target'),
        toolDefinition,
        toolName,
      });
      entry = {
        binding,
        closePromise: undefined,
        closed: false,
        lease,
        onTeardown: options.onTeardown,
        unsubscribe: () => undefined,
      };
      this.#entries.set(binding.id, entry);
      const unsubscribe = lease.subscribeSessionClosed((reason) => this.#closeEntry(entry!, 'session-closed', reason));
      entry.unsubscribe = unsubscribe;
      if (entry.closed) {
        unsubscribe();
        await entry.closePromise;
        throw new Error('MCP session closed before its App binding completed.');
      }
      return binding;
    } catch (error) {
      if (entry === undefined) {
        await lease.release();
      } else if (this.#entries.get(entry.binding.id) === entry) {
        await this.#closeEntry(entry, 'app-closed');
      }
      throw error;
    }
  }

  async callTool(bindingId: string, request: McpAppToolCall): Promise<McpAppJsonValue> {
    const entry = this.#entry(bindingId);
    const name = requireNonempty(request.name, 'MCP App bridge tool name');
    const tools = await entry.lease.session.listBridgeTools();
    this.#assertActive(entry);
    if (!tools.some((tool) => tool.name === name && tool.appVisible)) {
      throw new Error(`MCP App bridge tool ${JSON.stringify(name)} is not app-visible for this binding.`);
    }
    const argumentsValue = request.arguments === undefined ? undefined : requireJson(request.arguments, 'MCP App bridge tool arguments');
    return requireJson(await entry.lease.session.callTool({ arguments: argumentsValue, name }), 'MCP App bridge tool result');
  }

  async readResource(bindingId: string, request: McpAppResourceRead): Promise<McpAppJsonValue> {
    const entry = this.#entry(bindingId);
    const uri = requireNonempty(request.uri, 'MCP App bridge resource URI');
    const resources = await entry.lease.session.listBridgeResources();
    this.#assertActive(entry);
    if (!resources.some((resource) => resource.uri === uri && resource.appVisible)) {
      throw new Error(`MCP App bridge resource ${JSON.stringify(uri)} is not app-visible for this binding.`);
    }
    return requireJson(await entry.lease.session.readResource({ uri }), 'MCP App bridge resource result');
  }

  async closeBinding(bindingId: string): Promise<boolean> {
    const entry = this.#entries.get(bindingId);
    if (entry === undefined) return false;
    await this.#closeEntry(entry, 'app-closed');
    return true;
  }

  #entry(bindingId: string): BindingEntry {
    const entry = this.#entries.get(bindingId);
    if (entry === undefined || entry.closed) throw new Error(`Unknown MCP App binding ${JSON.stringify(bindingId)}.`);
    return entry;
  }

  #assertActive(entry: BindingEntry): void {
    if (entry.closed || this.#entries.get(entry.binding.id) !== entry) {
      throw new Error(`MCP App binding ${JSON.stringify(entry.binding.id)} is closed.`);
    }
  }

  async #closeEntry(entry: BindingEntry, reason: 'app-closed' | 'session-closed', sessionReason?: unknown): Promise<void> {
    if (entry.closePromise !== undefined) return entry.closePromise;
    entry.closed = true;
    this.#entries.delete(entry.binding.id);
    entry.unsubscribe();
    entry.closePromise = (async () => {
      const release = entry.lease.release();
      await this.#runTeardown(entry, reason, sessionReason);
      await release;
    })();
    return entry.closePromise;
  }

  async #runTeardown(entry: BindingEntry, reason: 'app-closed' | 'session-closed', sessionReason: unknown): Promise<void> {
    const teardown = entry.onTeardown;
    if (teardown === undefined) return;
    const event = Object.freeze({ binding: entry.binding, reason });
    const complete = Promise.resolve()
      .then(() => teardown(event))
      .catch(() => undefined);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const bounded = new Promise<void>((resolvePromise) => {
      timeout = setTimeout(resolvePromise, this.#teardownTimeoutMs);
    });
    void sessionReason;
    await Promise.race([complete, bounded]);
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
