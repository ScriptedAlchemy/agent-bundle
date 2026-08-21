import { randomUUID } from 'node:crypto';

import { isRecord } from '../core/strict-json.ts';
import { requireMcpAppJson, type McpAppJsonValue } from './mcp-app-json.ts';

export type { McpAppJsonValue } from './mcp-app-json.ts';

export const mcpAppPreviewProfiles = Object.freeze(['chatgpt', 'claude', 'portable'] as const);

export type McpAppPreviewProfile = (typeof mcpAppPreviewProfiles)[number];

export const isMcpAppPreviewProfile = (value: unknown): value is McpAppPreviewProfile =>
  (mcpAppPreviewProfiles as readonly unknown[]).includes(value);

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
  readonly definition: McpAppToolDefinition;
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
  /**
   * Atomically registers the listener and reports whether the shared session
   * was already closed at that registration point.
   */
  watchSessionClosed(listener: (reason?: unknown) => Promise<void> | void): McpAppSessionCloseObservation;
}

export interface McpAppSessionCloseObservation {
  readonly closed: boolean;
  readonly unsubscribe: () => void;
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
  closeAttempt: Promise<void> | undefined;
  closeFailure: Error | undefined;
  closeReason: 'app-closed' | 'session-closed' | undefined;
  closing: boolean;
  unsubscribe: () => void;
}

const defaultTeardownTimeoutMs = 1_000;
const maximumTeardownTimeoutMs = 30_000;

const requireJson = (value: unknown, label: string): McpAppJsonValue => {
  return requireMcpAppJson(value, `${label} must be a finite JSON value.`);
};

const requireNonempty = (value: string, label: string): string => {
  if (value.trim().length === 0) throw new Error(`${label} must be nonempty.`);
  return value;
};

const requireProfile = (profile: McpAppPreviewProfile): McpAppPreviewProfile => {
  if (isMcpAppPreviewProfile(profile)) return profile;
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
    const requestedResourceUri = selectMcpAppResourceUri(options.tool);
    if (requestedResourceUri === undefined) {
      throw new Error('MCP App tool must declare a standard _meta.ui.resourceUri using ui://.');
    }
    const input = requireJson(options.input, 'MCP App tool input');
    const result = requireJson(options.result, 'MCP App tool result');
    const previewProfile = requireProfile(options.previewProfile);
    if (options.onTeardown !== undefined && typeof options.onTeardown !== 'function') {
      throw new TypeError('MCP App teardown callback must be a function.');
    }

    const lease = await this.#sessionAuthority.acquireAppLease(sessionId);
    let entry: BindingEntry | undefined;
    let observation: McpAppSessionCloseObservation | undefined;
    let sessionClosed = false;
    try {
      const identity = lease.session.identity;
      if (identity.sessionId !== sessionId) {
        throw new Error(`MCP App lease identity does not match requested session ${JSON.stringify(sessionId)}.`);
      }
      observation = lease.watchSessionClosed(() => {
        sessionClosed = true;
        return entry === undefined ? undefined : this.#closeEntry(entry, 'session-closed');
      });
      sessionClosed ||= observation.closed;
      if (sessionClosed) throw new Error('MCP session closed before its App binding completed.');

      const tool = await this.#canonicalTool(lease, toolName, requestedResourceUri);
      if (sessionClosed) throw new Error('MCP session closed before its App binding completed.');
      const resourceUri = selectMcpAppResourceUri(tool.definition)!;
      const toolDefinition = requireJson(tool.definition, 'MCP App leased tool definition') as McpAppToolDefinition;
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
        closeAttempt: undefined,
        closeFailure: undefined,
        closeReason: undefined,
        closing: false,
        lease,
        onTeardown: options.onTeardown,
        unsubscribe: () => undefined,
      };
      this.#entries.set(binding.id, entry);
      entry.unsubscribe = observation.unsubscribe;
      if (sessionClosed || entry.closing) {
        observation.unsubscribe();
        await this.#closeEntry(entry, 'session-closed');
        throw new Error('MCP session closed before its App binding completed.');
      }
      return binding;
    } catch (error) {
      if (entry === undefined) {
        observation?.unsubscribe();
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
    if (entry === undefined || entry.closeAttempt !== undefined) return false;
    await this.#closeEntry(entry, 'app-closed');
    return true;
  }

  #entry(bindingId: string): BindingEntry {
    const entry = this.#entries.get(bindingId);
    if (entry === undefined || entry.closing) throw new Error(`Unknown MCP App binding ${JSON.stringify(bindingId)}.`);
    return entry;
  }

  #assertActive(entry: BindingEntry): void {
    if (entry.closing || this.#entries.get(entry.binding.id) !== entry) {
      throw new Error(`MCP App binding ${JSON.stringify(entry.binding.id)} is closed.`);
    }
  }

  async #closeEntry(entry: BindingEntry, reason: 'app-closed' | 'session-closed'): Promise<void> {
    if (!entry.closing) {
      entry.closing = true;
      entry.closeReason = reason;
      entry.unsubscribe();
    }
    if (entry.closeAttempt !== undefined) return entry.closeAttempt;

    const attempt = Promise.withResolvers<void>();
    entry.closeAttempt = attempt.promise;
    void this.#releaseEntry(entry).then(
      () => attempt.resolve(),
      (error: unknown) => attempt.reject(this.#closeFailure(entry, error)),
    ).finally(() => {
      if (entry.closeAttempt === attempt.promise) entry.closeAttempt = undefined;
    });
    return attempt.promise;
  }

  async #releaseEntry(entry: BindingEntry): Promise<void> {
    await entry.lease.release();
    this.#entries.delete(entry.binding.id);
    await this.#runTeardown(entry, entry.closeReason!);
  }

  #closeFailure(entry: BindingEntry, cause: unknown): Error {
    if (entry.closeFailure !== undefined) return entry.closeFailure;
    entry.closeFailure = new Error(`MCP App lease release failed for binding ${JSON.stringify(entry.binding.id)}.`, { cause });
    return entry.closeFailure;
  }

  async #runTeardown(entry: BindingEntry, reason: 'app-closed' | 'session-closed'): Promise<void> {
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
    await Promise.race([complete, bounded]);
    if (timeout !== undefined) clearTimeout(timeout);
  }

  async #canonicalTool(
    lease: McpAppSessionLease,
    toolName: string,
    requestedResourceUri: string,
  ): Promise<McpAppBridgeTool> {
    const tool = (await lease.session.listBridgeTools()).find((candidate) => candidate.name === toolName && candidate.appVisible === true);
    if (tool === undefined || tool.definition.name !== toolName) {
      throw new Error(`MCP App tool ${JSON.stringify(toolName)} is not app-visible for the leased session.`);
    }
    const resourceUri = selectMcpAppResourceUri(tool.definition);
    if (resourceUri === undefined) {
      throw new Error(`MCP App tool ${JSON.stringify(toolName)} lacks a standard _meta.ui.resourceUri in the leased session.`);
    }
    if (resourceUri !== requestedResourceUri) {
      throw new Error(`MCP App metadata for ${JSON.stringify(toolName)} does not match the leased session tool.`);
    }
    return tool;
  }
}
