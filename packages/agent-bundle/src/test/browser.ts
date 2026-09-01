import {
  createMcpAppBridge,
  type McpAppBridge,
  type McpAppBridgeBindingOperations,
  type McpAppBridgeHost,
  type McpAppBridgeLogEvent,
  type McpAppBridgeMessage,
  type McpAppBridgeMessageEvent,
  type McpAppBridgeModelContext,
  type McpAppBridgeSize,
  type McpAppBridgeJsonRecord,
  type McpAppValidatedDownload,
} from '../dev/mcp-apps/mcp-app-bridge.ts';
import type {
  McpAppBinding,
  McpAppJsonValue,
  McpAppToolDefinition,
} from '../dev/mcp-apps/mcp-app-binding-service.ts';
import type { McpAppProfileId } from '../dev/mcp-app-profile-descriptors.ts';
import type {
  McpAppConsentAuthority,
  McpAppConsentCapability,
  McpAppConsentChallenge,
  McpAppConsentGrant,
  McpAppConsentResolution,
} from '../dev/mcp-apps/mcp-app-sandbox.ts';
import {
  AGENT_BROWSER_TEST_REGISTRY_SYMBOL_KEY,
  AGENT_BROWSER_TEST_REGISTRY_VERSION,
  BROWSER_APP_PROOF_LEVEL,
  BROWSER_APP_PROOF_LEVEL_LABEL,
  type AgentBrowserTestRegistry,
  type CompiledBrowserTestApp,
} from './browser-registry.ts';

export interface BrowserAppProvenance {
  readonly name: string;
  readonly output: string;
  readonly proofLevel: typeof BROWSER_APP_PROOF_LEVEL;
  readonly resourceUri: string;
  readonly target: string;
}

export interface BrowserAppTraffic {
  readonly direction: 'app-to-host' | 'host-to-app';
  readonly message: McpAppBridgeMessage;
}

export interface BrowserAppHostTraffic {
  readonly downloads: readonly McpAppValidatedDownload[];
  readonly logs: readonly McpAppBridgeLogEvent[];
  readonly messages: readonly McpAppBridgeMessageEvent[];
  readonly modelContexts: readonly McpAppBridgeModelContext[];
  readonly openLinks: readonly string[];
  readonly sizes: readonly McpAppBridgeSize[];
}

export type BrowserAppScriptedConsent =
  | 'manual'
  | 'approve'
  | 'deny'
  | ((challenge: McpAppConsentChallenge) => boolean | undefined);

export interface MountBrowserAppOptions {
  readonly consentAuthority?: McpAppConsentAuthority;
  readonly container?: HTMLElement;
  readonly host?: Partial<McpAppBridgeHost>;
  readonly operations: McpAppBridgeBindingOperations;
  readonly profile?: McpAppProfileId;
  readonly scriptedConsent?: BrowserAppScriptedConsent;
  readonly timeoutMs?: number;
  readonly toolDefinition?: McpAppToolDefinition;
  readonly toolInput?: McpAppBridgeJsonRecord;
  readonly toolName?: string;
  readonly toolResult: McpAppJsonValue;
}

export interface MountedBrowserApp {
  readonly bridge: McpAppBridge;
  decideConsent(challengeId: string, approved: boolean): Promise<boolean>;
  readonly document: Document;
  readonly hostTraffic: BrowserAppHostTraffic;
  readonly iframe: HTMLIFrameElement;
  readonly pendingConsentChallenges: readonly McpAppConsentChallenge[];
  readonly provenance: BrowserAppProvenance;
  publishHostContextChanged(context: McpAppBridgeJsonRecord): boolean;
  publishToolCancelled(reason?: string): boolean;
  publishToolInput(input?: McpAppBridgeJsonRecord): boolean;
  publishToolResult(result: McpAppJsonValue): boolean;
  readonly traffic: readonly BrowserAppTraffic[];
  dispose(): Promise<void>;
}

export class BrowserAppTestError extends Error {
  readonly provenance: BrowserAppProvenance;

  constructor(message: string, provenance: BrowserAppProvenance, details: readonly string[] = []) {
    super([
      message,
      `  proof level: ${BROWSER_APP_PROOF_LEVEL_LABEL}`,
      `  app:         ${provenance.name} (${provenance.resourceUri}, target ${provenance.target})`,
      `  output:      ${provenance.output}`,
      ...details.map((detail) => `  ${detail}`),
    ].join('\n'));
    this.name = 'BrowserAppTestError';
    this.provenance = provenance;
  }
}

const registrySymbol = Symbol.for(AGENT_BROWSER_TEST_REGISTRY_SYMBOL_KEY);
const realm = globalThis as typeof globalThis & { [registrySymbol]?: AgentBrowserTestRegistry };
let nextBindingId = 1;

const unavailableProvenance = (name: string): BrowserAppProvenance => ({
  name,
  output: 'generated browser registry unavailable',
  proofLevel: BROWSER_APP_PROOF_LEVEL,
  resourceUri: 'unavailable',
  target: 'unavailable',
});

const registeredApp = (name: string): CompiledBrowserTestApp => {
  const registry = realm[registrySymbol];
  if (registry === undefined) {
    throw new BrowserAppTestError(
      'No compiled browser App registry is registered in this browser worker.',
      unavailableProvenance(name),
      ['recovery: build this pool with agentBundleBrowserRstest() from agent-bundle/rstest'],
    );
  }
  if (registry.version !== AGENT_BROWSER_TEST_REGISTRY_VERSION) {
    throw new BrowserAppTestError(
      `Incompatible browser App registry version ${String(registry.version)}; expected ${String(AGENT_BROWSER_TEST_REGISTRY_VERSION)}.`,
      unavailableProvenance(name),
    );
  }
  const app = registry.apps[name];
  if (app === undefined) {
    throw new BrowserAppTestError(
      `Compiled browser App ${JSON.stringify(name)} was not found.`,
      unavailableProvenance(name),
      [`available: ${Object.keys(registry.apps).sort().join(', ') || 'none'}`],
    );
  }
  return app;
};

const provenanceOf = (app: CompiledBrowserTestApp): BrowserAppProvenance => Object.freeze({
  name: app.name,
  output: app.output,
  proofLevel: BROWSER_APP_PROOF_LEVEL,
  resourceUri: app.resourceUri,
  target: app.target,
});

const isBridgeMessage = (value: unknown): value is McpAppBridgeMessage =>
  typeof value === 'object' && value !== null && (value as { readonly jsonrpc?: unknown }).jsonrpc === '2.0';

const createTestConsentAuthority = (): McpAppConsentAuthority => {
  const challenges = new Map<string, McpAppConsentChallenge>();
  const grants = new Map<string, McpAppConsentGrant & { readonly actionDigest: string; readonly profile: string }>();
  let nextId = 1;
  const resolve = (challengeId: string, approved: boolean): McpAppConsentResolution => {
    const challenge = challenges.get(challengeId);
    if (challenge === undefined) return Object.freeze({ status: 'unknown' });
    challenges.delete(challengeId);
    if (!approved) return Object.freeze({ status: 'denied' });
    const grant = grants.get(challengeId);
    return grant === undefined
      ? Object.freeze({ status: 'unknown' })
      : Object.freeze({ grant, status: 'approved' });
  };
  return Object.freeze({
    challenge(options: Readonly<{
      readonly actionDigest: string;
      readonly bindingId: string;
      readonly capability: McpAppConsentCapability;
      readonly details: McpAppJsonValue;
      readonly profile: string;
    }>) {
      const id = `browser-consent-${String(nextId++)}`;
      const challenge: McpAppConsentChallenge = Object.freeze({
        expiresAt: Number.MAX_SAFE_INTEGER,
        id,
        request: Object.freeze({
          actionFingerprint: `browser-action-${String(nextId)}`,
          capability: options.capability,
          details: options.details,
          scope: 'action',
          summary: `Allow MCP App ${options.capability.replaceAll('-', ' ')}?`,
        }),
      });
      grants.set(id, Object.freeze({
        actionDigest: options.actionDigest,
        authorizationId: `browser-grant-${String(nextId)}`,
        bindingId: options.bindingId,
        capability: options.capability,
        challengeId: id,
        profile: options.profile,
        scope: 'action',
      }));
      challenges.set(id, challenge);
      return challenge;
    },
    consume(options: Parameters<McpAppConsentAuthority['consume']>[0]) {
      const grant = [...grants.values()].find(
        (candidate) => candidate.authorizationId === options.authorizationId,
      );
      if (grant === undefined
        || grant.actionDigest !== options.actionDigest
        || grant.bindingId !== options.bindingId
        || grant.capability !== options.capability
        || grant.profile !== options.profile) return false;
      grants.delete(grant.challengeId);
      return true;
    },
    documentGrants: () => Object.freeze([]),
    grant(challengeId: string, approved: boolean) {
      const resolution = resolve(challengeId, approved);
      return resolution.status === 'approved' ? resolution.grant : undefined;
    },
    inspect: (challengeId: string) => challenges.get(challengeId),
    pending: () => Object.freeze([...challenges.values()]),
    resolve,
  });
};

const selectedProfile = (app: CompiledBrowserTestApp, requested: McpAppProfileId | undefined): McpAppProfileId => {
  if (requested !== undefined) return requested;
  return app.target === 'claude' || app.target === 'portable' ? app.target : 'portable';
};

const bindingFor = (
  app: CompiledBrowserTestApp,
  options: MountBrowserAppOptions,
): McpAppBinding => {
  const toolName = options.toolName ?? `show-${app.name}`;
  return Object.freeze({
    epochId: `browser-app:${app.name}`,
    id: `browser-app-binding-${String(nextBindingId++)}`,
    input: options.toolInput ?? {},
    previewProfile: selectedProfile(app, options.profile),
    resourceUri: app.resourceUri,
    result: options.toolResult,
    serverName: app.serverIds.join(','),
    sessionId: `browser-app-session:${app.name}`,
    target: app.target,
    toolDefinition: options.toolDefinition ?? Object.freeze({
      _meta: { ui: { resourceUri: app.resourceUri } },
      inputSchema: { type: 'object' },
      name: toolName,
    }),
    toolName,
  });
};

export const mountBrowserApp = async (
  name: string,
  options: MountBrowserAppOptions,
): Promise<MountedBrowserApp> => {
  const app = registeredApp(name);
  const provenance = provenanceOf(app);
  const authority = options.consentAuthority ?? createTestConsentAuthority();
  const traffic: BrowserAppTraffic[] = [];
  const downloads: McpAppValidatedDownload[] = [];
  const logs: McpAppBridgeLogEvent[] = [];
  const messages: McpAppBridgeMessageEvent[] = [];
  const modelContexts: McpAppBridgeModelContext[] = [];
  const openLinks: string[] = [];
  const sizes: McpAppBridgeSize[] = [];
  const userHost = options.host;
  const host: McpAppBridgeHost = {
    capabilities: userHost?.capabilities ?? {
      downloadFile: {},
      logging: {},
      openLinks: {},
      serverResources: {},
      serverTools: {},
    },
    context: userHost?.context ?? {
      availableDisplayModes: ['inline'],
      displayMode: 'inline',
      platform: 'desktop',
    },
    info: userHost?.info ?? { name: 'agent-bundle-browser-test', version: '1.0.0' },
    ...(userHost?.onDisplayMode === undefined ? {} : { onDisplayMode: userHost.onDisplayMode }),
    onDownload: async (download) => {
      downloads.push(download);
      await userHost?.onDownload?.(download);
    },
    onLog: async (event) => {
      logs.push(event);
      await userHost?.onLog?.(event);
    },
    onMessage: async (event) => {
      messages.push(event);
      return userHost?.onMessage?.(event);
    },
    onModelContext: async (context) => {
      modelContexts.push(context);
      await userHost?.onModelContext?.(context);
    },
    onOpenLink: async (url) => {
      openLinks.push(url);
      await userHost?.onOpenLink?.(url);
    },
    onSizeChanged: async (size) => {
      sizes.push(size);
      await userHost?.onSizeChanged?.(size);
    },
  };

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.referrerPolicy = 'no-referrer';
  iframe.srcdoc = app.html;

  let disposed = false;
  let settleHandshake!: () => void;
  let rejectHandshake!: (error: unknown) => void;
  const handshake = new Promise<void>((resolve, reject) => {
    settleHandshake = resolve;
    rejectHandshake = reject;
  });
  const settleScriptedConsent = async (): Promise<void> => {
    const script = options.scriptedConsent ?? 'manual';
    if (script === 'manual') return;
    for (const challenge of authority.pending()) {
      const approved = typeof script === 'function' ? script(challenge) : script === 'approve';
      if (approved !== undefined) await bridge.decideConsent(challenge.id, approved);
    }
  };
  const onMessage = (event: MessageEvent<unknown>): void => {
    if (event.source !== iframe.contentWindow || !isBridgeMessage(event.data)) return;
    traffic.push(Object.freeze({ direction: 'app-to-host', message: event.data }));
    void bridge.receive(event.data)
      .then(settleScriptedConsent)
      .then(() => {
        if (bridge.lifecycle === 'initialized') settleHandshake();
      }, rejectHandshake);
  };
  const bridge = (() => {
    try {
      return createMcpAppBridge({
        binding: bindingFor(app, options),
        consentAuthority: authority,
        host,
        operations: options.operations,
        profile: selectedProfile(app, options.profile),
        send: (message) => {
          const target = iframe.contentWindow;
          if (target === null) return false;
          traffic.push(Object.freeze({ direction: 'host-to-app', message }));
          target.postMessage(message, '*');
          return true;
        },
      });
    } catch (error) {
      throw new BrowserAppTestError('MCP App bridge could not be created.', provenance, [
        `cause: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  })();
  window.addEventListener('message', onMessage);
  if (!bridge.publishToolResult(options.toolResult)) {
    window.removeEventListener('message', onMessage);
    throw new BrowserAppTestError('The initial MCP App tool result was rejected.', provenance);
  }

  (options.container ?? document.body).append(iframe);
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    window.removeEventListener('message', onMessage);
    await bridge.forceClose().catch(() => undefined);
    iframe.remove();
    throw new BrowserAppTestError(
      'MCP App initialize timeout must be an integer from 1 to 30000 ms.',
      provenance,
    );
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      handshake,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          const last = traffic.at(-1)?.message;
          reject(new BrowserAppTestError(
            `MCP App initialize handshake timed out after ${String(timeoutMs)} ms.`,
            provenance,
            [`last message: ${last === undefined ? 'none' : JSON.stringify(last)}`],
          ));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    window.removeEventListener('message', onMessage);
    await bridge.forceClose().catch(() => undefined);
    iframe.remove();
    if (error instanceof BrowserAppTestError) throw error;
    throw new BrowserAppTestError('MCP App initialize handshake failed.', provenance, [
      `cause: ${error instanceof Error ? error.message : String(error)}`,
      `last message: ${traffic.length === 0 ? 'none' : JSON.stringify(traffic.at(-1)?.message)}`,
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }

  const appDocument = iframe.contentDocument;
  if (appDocument === null) {
    window.removeEventListener('message', onMessage);
    await bridge.forceClose().catch(() => undefined);
    iframe.remove();
    throw new BrowserAppTestError('Mounted MCP App document is not accessible.', provenance);
  }

  const hostTraffic: BrowserAppHostTraffic = {
    downloads,
    logs,
    messages,
    modelContexts,
    openLinks,
    sizes,
  };
  return Object.freeze({
    bridge,
    decideConsent: (challengeId: string, approved: boolean) => bridge.decideConsent(challengeId, approved),
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('message', onMessage);
      try {
        await bridge.forceClose();
      } catch (error) {
        throw new BrowserAppTestError('MCP App bridge disposal failed.', provenance, [
          `cause: ${error instanceof Error ? error.message : String(error)}`,
        ]);
      } finally {
        iframe.remove();
      }
    },
    document: appDocument,
    hostTraffic,
    iframe,
    get pendingConsentChallenges(): readonly McpAppConsentChallenge[] {
      return authority.pending();
    },
    provenance,
    publishHostContextChanged: (context: McpAppBridgeJsonRecord) => bridge.publishHostContextChanged(context),
    publishToolCancelled: (reason?: string) => bridge.publishToolCancelled(reason),
    publishToolInput: (input?: McpAppBridgeJsonRecord) => bridge.publishToolInput(input),
    publishToolResult: (result: McpAppJsonValue) => bridge.publishToolResult(result),
    traffic,
  });
};
