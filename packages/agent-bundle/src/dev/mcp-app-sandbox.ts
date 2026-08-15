import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { isIP, type Socket } from 'node:net';

import type { McpAppJsonValue } from './mcp-app-binding-service.ts';

const JSON_RPC_VERSION = '2.0';
const SANDBOX_NOTIFICATION_PREFIX = 'ui/notifications/sandbox-';
const PROXY_READY_METHOD = 'ui/notifications/sandbox-proxy-ready';
const RESOURCE_READY_METHOD = 'ui/notifications/sandbox-resource-ready';
const INITIALIZED_METHOD = 'ui/notifications/initialized';
const INITIALIZE_METHOD = 'ui/initialize';
const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024;
const DEFAULT_MAX_QUEUED_MESSAGES = 32;
const MAX_RELAY_MESSAGE_BYTES = 256 * 1024;

const PROXY_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'self'",
  'img-src data:',
  "script-src 'unsafe-inline'",
].join('; ');

const SHELL = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCP App sandbox</title>
<style>html,body,iframe{border:0;height:100%;margin:0;width:100%}</style>
<iframe id="app" sandbox="allow-scripts" referrerpolicy="no-referrer"></iframe>
<script>
  'use strict';
  const proxyReadyMethod = '${PROXY_READY_METHOD}';
  const resourceReadyMethod = '${RESOURCE_READY_METHOD}';
  const initializedMethod = '${INITIALIZED_METHOD}';
  const initializeMethod = '${INITIALIZE_METHOD}';
  const app = document.getElementById('app');
  let configuration;
  try {
    const candidate = JSON.parse(decodeURIComponent(location.hash.slice(1)));
    const host = new URL(candidate.hostOrigin);
    if (host.origin !== candidate.hostOrigin || !Number.isSafeInteger(candidate.maxMessageBytes) || candidate.maxMessageBytes <= 0) throw new Error('invalid sandbox configuration');
    configuration = { hostOrigin: host.origin, maxMessageBytes: candidate.maxMessageBytes };
  } catch {}
  if (configuration) {
    const maxMessageBytes = configuration.maxMessageBytes;
    let lifecycle = 'created';
    let initializeId;
    const byteLength = (value) => {
      try { const serialized = JSON.stringify(value); return typeof serialized === 'string' ? new TextEncoder().encode(serialized).byteLength : Infinity; } catch { return Infinity; }
    };
    const isRecord = (value) => value && typeof value === 'object' && !Array.isArray(value);
    const isRpc = (value) => isRecord(value) && value.jsonrpc === '${JSON_RPC_VERSION}' && byteLength(value) <= maxMessageBytes && (typeof value.method === 'string' || Object.hasOwn(value, 'id'));
    const isNotification = (value, method) => isRpc(value) && value.method === method && !Object.hasOwn(value, 'id');
    const isSandboxMethod = (method) => typeof method === 'string' && method.startsWith('ui/notifications/sandbox-');
    const escapeHtmlAttribute = (value) => value.replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
    const postNotification = (method, params = {}) => parent.postMessage({ jsonrpc: '${JSON_RPC_VERSION}', method, params }, configuration.hostOrigin);
    const postToApp = (value) => { if (app.contentWindow) app.contentWindow.postMessage(value, '*'); };
    const isInitializeResponse = (value) => isRpc(value) && !Object.hasOwn(value, 'method') && Object.hasOwn(value, 'id') && value.id === initializeId && (Object.hasOwn(value, 'result') || Object.hasOwn(value, 'error'));
    window.addEventListener('message', (event) => {
      if (event.source === parent) {
        if (event.origin !== configuration.hostOrigin || !isRpc(event.data)) return;
        const message = event.data;
        if (isNotification(message, resourceReadyMethod)) {
          const params = message.params;
          if (lifecycle !== 'proxy-ready' || !isRecord(params) || typeof params.html !== 'string') return;
          if (byteLength(message) > maxMessageBytes || (Object.hasOwn(params, 'sandbox') && typeof params.sandbox !== 'string') || typeof params.allow !== 'string' || typeof params.contentSecurityPolicy !== 'string') return;
          app.allow = params.allow;
          app.srcdoc = '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + escapeHtmlAttribute(params.contentSecurityPolicy) + '">' + params.html;
          lifecycle = 'resource-ready';
          return;
        }
        if (isSandboxMethod(message.method)) return;
        if (lifecycle === 'initializing' && isInitializeResponse(message)) {
          lifecycle = 'initialize-responded';
          postToApp(message);
          return;
        }
        if (lifecycle === 'initialized') postToApp(message);
        return;
      }
      if (event.source !== app.contentWindow || event.origin !== 'null' || !isRpc(event.data)) return;
      const message = event.data;
      if (message.method === initializeMethod && Object.hasOwn(message, 'id')) {
        if (lifecycle !== 'resource-ready') return;
        lifecycle = 'initializing';
        initializeId = message.id;
        parent.postMessage(message, configuration.hostOrigin);
        return;
      }
      if (isNotification(message, initializedMethod)) {
        if (lifecycle !== 'initialize-responded') return;
        lifecycle = 'initialized';
        parent.postMessage(message, configuration.hostOrigin);
        return;
      }
      if (isSandboxMethod(message.method) || lifecycle !== 'initialized') return;
      parent.postMessage(message, configuration.hostOrigin);
    });
    lifecycle = 'proxy-ready';
    postNotification(proxyReadyMethod);
  }
</script>`;

export type McpAppSandboxCapability = Readonly<Record<never, never>>;

export interface McpAppSandboxCsp {
  readonly baseUriDomains?: readonly string[];
  readonly connectDomains?: readonly string[];
  readonly frameDomains?: readonly string[];
  readonly resourceDomains?: readonly string[];
}

export interface McpAppSandboxPermissions {
  readonly camera?: McpAppSandboxCapability;
  readonly clipboardWrite?: McpAppSandboxCapability;
  readonly geolocation?: McpAppSandboxCapability;
  readonly microphone?: McpAppSandboxCapability;
}

export interface McpAppSandboxDeclaration {
  readonly csp?: McpAppSandboxCsp;
  readonly permissions?: McpAppSandboxPermissions;
}

export interface McpAppSandboxConsent {
  readonly permissions?: McpAppSandboxPermissions;
}

export interface McpAppSandboxPolicy {
  readonly contentSecurityPolicy: string;
  readonly iframeAllow: string;
  readonly internalWebSocketUrl?: string;
  readonly permissionsPolicy: string;
  readonly warnings: readonly McpAppSandboxWarning[];
}

export type McpAppConsentCapability = 'call-tool' | 'download-file' | 'open-external-link' | 'clipboard-write' | 'camera' | 'microphone' | 'geolocation' | 'request-display-mode';

export interface McpAppConsentGrant {
  readonly authorizationId: string;
  readonly bindingId: string;
  readonly capability: McpAppConsentCapability;
  readonly challengeId: string;
  readonly scope: 'action' | 'document';
}

export interface McpAppConsentRequest {
  /** Opaque server-produced reference only; it has no authorization value. */
  readonly actionFingerprint: string;
  readonly capability: McpAppConsentCapability;
  readonly details: McpAppJsonValue;
  readonly scope: 'action' | 'document';
  readonly summary: string;
}

export interface McpAppConsentChallenge {
  readonly expiresAt: number;
  readonly id: string;
  readonly request: McpAppConsentRequest;
}

export type McpAppConsentResolution =
  | Readonly<{ readonly grant: McpAppConsentGrant; readonly status: 'approved' }>
  | Readonly<{ readonly status: 'denied' | 'expired' | 'unknown' }>;

export interface McpAppConsentAuthority {
  challenge(options: Readonly<{
    readonly actionDigest: string;
    readonly bindingId: string;
    readonly capability: McpAppConsentCapability;
    readonly details: McpAppJsonValue;
    readonly profile: string;
  }>): McpAppConsentChallenge | undefined;
  consume(options: Readonly<{
    readonly actionDigest: string;
    readonly authorizationId: string;
    readonly bindingId: string;
    readonly capability: McpAppConsentCapability;
    readonly profile: string;
  }>): boolean;
  grant(challengeId: string, approved: boolean): McpAppConsentGrant | undefined;
  /** Server-only lookup; expired entries are deliberately retained long enough to deny their original continuation. */
  inspect(challengeId: string): McpAppConsentChallenge | undefined;
  documentGrants(bindingId: string, profile: string): readonly McpAppConsentGrant[];
  pending(): readonly McpAppConsentChallenge[];
  /** Atomically consumes a decision and distinguishes an expired exact challenge from a forged one. */
  resolve(challengeId: string, approved: boolean): McpAppConsentResolution;
}

export interface McpAppSandboxWarning {
  readonly code: 'csp-source-rejected' | 'csp-wildcard-rejected' | 'permission-not-consented';
  readonly value: string;
}

export interface McpAppSandboxInternalSources {
  readonly origin: string;
  readonly provenance: 'compiler-internal';
  readonly webSocketPath: '/rsbuild-hmr';
}

export interface McpAppDocumentPolicySnapshot {
  readonly allow: string;
  readonly approvedPermissions: McpAppSandboxPermissions;
  readonly revision: number;
  readonly warnings: readonly McpAppSandboxWarning[];
}

export interface McpAppSandboxRelay {
  readonly maxMessageBytes: number;
  readonly maxQueuedMessages: number;
}

export interface McpAppSandboxEndpoint {
  readonly origin: string;
  readonly relay: McpAppSandboxRelay;
}

export interface CreateMcpAppSandboxProxyOptions {
  readonly closeTimeoutMs?: number;
  readonly hostOrigin: string;
  readonly maxMessageBytes?: number;
  readonly maxQueuedMessages?: number;
  readonly port?: number;
}

export interface McpAppSandboxProxy extends McpAppSandboxEndpoint {
  readonly url: string;
  close(): Promise<void>;
}

export interface CreateMcpAppSandboxFrameOptions {
  readonly consent?: McpAppSandboxConsent;
  readonly declaration?: McpAppSandboxDeclaration;
  /** A server-created, revisioned document permission snapshot. */
  readonly documentPolicy?: McpAppDocumentPolicySnapshot;
  readonly hostOrigin: string;
  readonly proxy: McpAppSandboxEndpoint;
}

export interface McpAppSandboxFrame {
  readonly allow: string;
  readonly documentPolicy?: McpAppDocumentPolicySnapshot;
  readonly policy: McpAppSandboxPolicy;
  readonly referrerPolicy: 'no-referrer';
  readonly relay: McpAppSandboxRelay;
  readonly sandbox: 'allow-scripts allow-same-origin';
  readonly src: string;
  readonly targetOrigin: string;
}

export type McpAppSandboxLifecycle = 'created' | 'proxy-ready' | 'resource-ready' | 'initializing' | 'initialize-responded' | 'initialized' | 'closed';

export type McpAppSandboxRequestId = string | number | null;

export interface McpAppSandboxMessage {
  readonly error?: unknown;
  readonly id?: McpAppSandboxRequestId;
  readonly jsonrpc: '2.0';
  readonly method?: string;
  readonly params?: unknown;
  readonly result?: unknown;
}

export interface McpAppSandboxMessageEvent {
  readonly data: unknown;
  readonly origin: string;
  readonly source: unknown;
}

export interface McpAppSandboxWindow {
  postMessage(message: unknown, targetOrigin: string): void;
}

export interface McpAppSandboxResource {
  readonly csp?: McpAppSandboxCsp;
  readonly html: string;
  readonly permissions?: McpAppSandboxPermissions;
  readonly sandbox?: string;
}

export interface CreateMcpAppSandboxBridgeOptions {
  readonly frame: McpAppSandboxFrame;
  readonly onMessage?: (message: McpAppSandboxMessage) => void;
  readonly proxyWindow: McpAppSandboxWindow;
}

export interface McpAppSandboxBridge {
  readonly lifecycle: McpAppSandboxLifecycle;
  close(): void;
  provideResource(resource: McpAppSandboxResource): boolean;
  receive(event: McpAppSandboxMessageEvent): boolean;
  send(message: McpAppSandboxMessage): boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

const finiteJson = (value: unknown): value is McpAppJsonValue => value === null || typeof value === 'string' || typeof value === 'boolean'
  || typeof value === 'number' && Number.isFinite(value)
  || Array.isArray(value) && value.every(finiteJson)
  || isRecord(value) && Object.values(value).every(finiteJson);

const consentScope = (capability: McpAppConsentCapability): 'action' | 'document' => (
  capability === 'camera' || capability === 'microphone' || capability === 'geolocation' || capability === 'clipboard-write' ? 'document' : 'action'
);

const consentSummary = (capability: McpAppConsentCapability): string => `Allow MCP App ${capability.replaceAll('-', ' ')}?`;

export const createMcpAppConsentActionDigest = (capability: McpAppConsentCapability, details: McpAppJsonValue): string => `${capability}:${JSON.stringify(details)}`;

const consentSensitiveName = /(?:api[_-]?key|authorization|bearer|cookie|credential|pass(?:word)?|private[_-]?key|secret|token)/iu;

const publicConsentText = (value: string, maximum: number): string => {
  const normalized = Array.from(value, (character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint < 0x20 || codePoint === 0x7f ? ' ' : character;
  }).join('');
  return normalized.length <= maximum ? normalized : `${normalized.slice(0, Math.max(0, maximum - 1))}…`;
};

const publicLinkConsentDetails = (details: McpAppJsonValue): McpAppJsonValue => {
  if (!isRecord(details) || typeof details.url !== 'string') return Object.freeze({});
  try {
    const target = new URL(details.url);
    const keys = new Set<string>();
    let inspected = 0;
    for (const key of target.searchParams.keys()) {
      if (inspected >= 32 || keys.size >= 8) break;
      inspected += 1;
      keys.add(consentSensitiveName.test(key) ? '[redacted]' : publicConsentText(key, 48));
    }
    const queryKeys = [...keys].sort();
    return Object.freeze({
      queryKeys: Object.freeze(queryKeys),
      target: publicConsentText(`${target.protocol}//${target.host}${target.pathname}`, 240),
    });
  } catch {
    return Object.freeze({});
  }
};

const publicDownloadByteLength = (content: McpAppJsonValue): number | undefined => {
  if (!isRecord(content) || typeof content.type !== 'string') return undefined;
  if (content.type === 'text') return typeof content.text === 'string' ? Buffer.byteLength(content.text, 'utf8') : undefined;
  const encoded = content.type === 'image' || content.type === 'audio' ? content.data
    : content.type === 'resource' && isRecord(content.resource) ? content.resource.blob
      : undefined;
  if (typeof encoded === 'string') return encoded.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/u.test(encoded) ? Buffer.from(encoded, 'base64').length : undefined;
  if (content.type === 'resource' && isRecord(content.resource) && typeof content.resource.text === 'string') return Buffer.byteLength(content.resource.text, 'utf8');
  return content.type === 'resource_link' && typeof content.size === 'number' && Number.isSafeInteger(content.size) && content.size >= 0 ? content.size : 0;
};

const publicDownloadConsentDetails = (details: McpAppJsonValue): McpAppJsonValue => {
  const contents = isRecord(details) && Array.isArray(details.contents) ? details.contents : [];
  const items = contents.slice(0, 8).map((content) => {
    const record = isRecord(content) ? content : undefined;
    const bytes = publicDownloadByteLength(content as McpAppJsonValue);
    return Object.freeze({ bytes: bytes ?? 0, type: typeof record?.type === 'string' ? publicConsentText(record.type, 48) : 'unspecified' });
  });
  return Object.freeze({ itemCount: contents.length, items: Object.freeze(items) });
};

/** Only the browser-visible consent presentation is reduced; authority retains its private action digest. */
const publicConsentDetails = (capability: McpAppConsentCapability, details: McpAppJsonValue): McpAppJsonValue => {
  if (capability === 'open-external-link') return publicLinkConsentDetails(details);
  if (capability === 'download-file') return publicDownloadConsentDetails(details);
  return details;
};

const consentActionFingerprint = (secret: Uint8Array, actionDigest: string): string =>
  `act-${createHmac('sha256', secret).update(actionDigest).digest('base64url').slice(0, 12)}`;

export const createMcpAppConsentAuthority = (options: Readonly<{ readonly now?: () => number }> = {}): McpAppConsentAuthority => {
  const now = options.now ?? Date.now;
  const fingerprintSecret = randomBytes(32);
  const challenges = new Map<string, Readonly<{ actionDigest: string; actionFingerprint: string; bindingId: string; capability: McpAppConsentCapability; details: McpAppJsonValue; expiresAt: number; profile: string }>>();
  const expiredChallenges = new Map<string, Readonly<{ actionDigest: string; actionFingerprint: string; bindingId: string; capability: McpAppConsentCapability; details: McpAppJsonValue; expiresAt: number; profile: string }>>();
  const grants = new Map<string, Readonly<{ actionDigest: string; bindingId: string; capability: McpAppConsentCapability; challengeId: string; expiresAt: number; profile: string; scope: 'action' | 'document' }>>();
  let nextId = 1;
  const challengeSnapshot = (id: string, challenge: Readonly<{ actionFingerprint: string; capability: McpAppConsentCapability; details: McpAppJsonValue; expiresAt: number }>): McpAppConsentChallenge => Object.freeze({
    expiresAt: challenge.expiresAt,
    id,
    request: Object.freeze({ actionFingerprint: challenge.actionFingerprint, capability: challenge.capability, details: publicConsentDetails(challenge.capability, challenge.details), scope: consentScope(challenge.capability), summary: consentSummary(challenge.capability) }),
  });
  const expireChallenges = (): void => {
    const instant = now();
    for (const [id, challenge] of challenges) {
      if (challenge.expiresAt >= instant) continue;
      challenges.delete(id);
      expiredChallenges.set(id, challenge);
    }
    // Expired tombstones only exist to deny a contemporaneous, exact decision.
    // Keep this bounded so abandoned browser tabs cannot retain authority state.
    while (expiredChallenges.size > 8) expiredChallenges.delete(expiredChallenges.keys().next().value as string);
  };
  const resolutionFor = (id: string, challenge: Readonly<{ actionDigest: string; bindingId: string; capability: McpAppConsentCapability; expiresAt: number; profile: string }>, approved: boolean): McpAppConsentResolution => {
    if (challenge.expiresAt < now()) return Object.freeze({ status: 'expired' });
    if (!approved) return Object.freeze({ status: 'denied' });
    const authorizationId = `grant-${nextId++}`;
    const scope = consentScope(challenge.capability);
    grants.set(authorizationId, Object.freeze({
      actionDigest: challenge.actionDigest, bindingId: challenge.bindingId, capability: challenge.capability, challengeId: id,
      expiresAt: challenge.expiresAt, profile: challenge.profile, scope,
    }));
    return Object.freeze({
      grant: Object.freeze({ authorizationId, bindingId: challenge.bindingId, capability: challenge.capability, challengeId: id, scope }),
      status: 'approved',
    });
  };
  const resolve = (challengeId: string, approved: boolean): McpAppConsentResolution => {
    expireChallenges();
    const challenge = challenges.get(challengeId);
    if (challenge !== undefined) {
      challenges.delete(challengeId);
      return resolutionFor(challengeId, challenge, approved);
    }
    const expired = expiredChallenges.get(challengeId);
    if (expired === undefined) return Object.freeze({ status: 'unknown' });
    expiredChallenges.delete(challengeId);
    return Object.freeze({ status: 'expired' });
  };
  return Object.freeze({
    challenge(input: Readonly<{ actionDigest: string; bindingId: string; capability: McpAppConsentCapability; details: McpAppJsonValue; profile: string }>) {
      expireChallenges();
      if (!finiteJson(input.details) || !input.bindingId || !input.profile || !input.actionDigest || challenges.size >= 8) return undefined;
      const id = `consent-${nextId++}`;
      const expiresAt = now() + 30_000;
      const challenge = Object.freeze({ ...input, actionFingerprint: consentActionFingerprint(fingerprintSecret, input.actionDigest), expiresAt });
      challenges.set(id, challenge);
      return challengeSnapshot(id, challenge);
    },
    consume(input: Readonly<{ actionDigest: string; authorizationId: string; bindingId: string; capability: McpAppConsentCapability; profile: string }>) {
      const grant = grants.get(input.authorizationId);
      if (grant === undefined || grant.scope !== 'action' || grant.expiresAt < now() || grant.actionDigest !== input.actionDigest || grant.bindingId !== input.bindingId || grant.capability !== input.capability || grant.profile !== input.profile) return false;
      grants.delete(input.authorizationId);
      return true;
    },
    grant(challengeId: string, approved: boolean) {
      const resolution = resolve(challengeId, approved);
      return resolution.status === 'approved' ? resolution.grant : undefined;
    },
    inspect(challengeId: string) {
      expireChallenges();
      const challenge = challenges.get(challengeId) ?? expiredChallenges.get(challengeId);
      return challenge === undefined ? undefined : challengeSnapshot(challengeId, challenge);
    },
    documentGrants(bindingId: string, profile: string) {
      const instant = now();
      const result: McpAppConsentGrant[] = [];
      for (const [authorizationId, grant] of grants) {
        if (grant.expiresAt < instant) {
          grants.delete(authorizationId);
          continue;
        }
        if (grant.scope === 'document' && grant.bindingId === bindingId && grant.profile === profile) {
          result.push(Object.freeze({ authorizationId, bindingId, capability: grant.capability, challengeId: grant.challengeId, scope: 'document' }));
        }
      }
      return Object.freeze(result);
    },
    pending() {
      expireChallenges();
      return Object.freeze([...challenges.entries()].map(([id, challenge]) => challengeSnapshot(id, challenge)));
    },
    resolve(challengeId: string, approved: boolean) {
      return resolve(challengeId, approved);
    },
  });
};

const isCapability = (value: unknown): value is McpAppSandboxCapability => isRecord(value);

const specialIpv4 = (host: string): boolean => {
  const octets = host.split('.').map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [a, b, c] = octets as [number, number, number, number];
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 2 || b === 88 || b === 168)) || (a === 198 && (b === 18 || b === 19 || b === 51))
    || (a === 203 && b === 0 && c === 113);
};

const ipv6Number = (host: string): bigint | undefined => {
  const source = host.toLowerCase().replace(/^\[|\]$/gu, '');
  if (isIP(source) !== 6) return undefined;
  const [left, right] = source.split('::', 2);
  const leftParts = left === undefined || left.length === 0 ? [] : left.split(':');
  const rightParts = right === undefined || right.length === 0 ? [] : right.split(':');
  if (source.includes('::') ? leftParts.length + rightParts.length >= 8 : leftParts.length !== 8) return undefined;
  const parts = source.includes('::')
    ? [...leftParts, ...Array.from({ length: 8 - leftParts.length - rightParts.length }, () => '0'), ...rightParts]
    : leftParts;
  let value = 0n;
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/u.test(part)) return undefined;
    value = (value << 16n) | BigInt(`0x${part}`);
  }
  return value;
};

const inIpv6Prefix = (value: bigint, prefix: bigint, bits: number): boolean => {
  const width = 128n;
  const mask = ((1n << BigInt(bits)) - 1n) << (width - BigInt(bits));
  return (value & mask) === prefix;
};

const specialIpv6 = (host: string): boolean => {
  const value = ipv6Number(host);
  if (value === undefined) return false;
  // CSP network authority is fail-closed: only IANA global-unicast 2000::/3
  // can pass.  Everything else (site-local, ULA, NAT64, mapped IPv4, etc.)
  // remains a special-purpose address even when a parser accepts its syntax.
  if (!inIpv6Prefix(value, 0x2000n << 112n, 3)) return true;
  // Deny the special-purpose ranges that live inside global-unicast space.
  const ranges: readonly (readonly [bigint, number])[] = [
    [0x20010000n << 96n, 23], // IANA 2001::/23 special-purpose block
    [0x20010db8n << 96n, 32], // documentation
    [0x2002n << 112n, 16], // 6to4
    [0x3fffn << 112n, 20], // RFC 9637 documentation
  ];
  return ranges.some(([prefix, bits]) => inIpv6Prefix(value, prefix, bits));
};

const prohibitedHost = (value: string): boolean => {
  const host = value.toLowerCase().replace(/^\[|\]$/gu, '');
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (isIP(host) === 4) return specialIpv4(host);
  if (isIP(host) !== 6) return false;
  return specialIpv6(host);
};

const cspSources = (sources: readonly string[] | undefined): Readonly<{ accepted: readonly string[]; warnings: readonly McpAppSandboxWarning[] }> => {
  const accepted = new Set<string>();
  const warnings: McpAppSandboxWarning[] = [];
  for (const source of sources ?? []) {
    if (source.includes('*')) {
      warnings.push(Object.freeze({ code: 'csp-wildcard-rejected', value: source }));
      continue;
    }
    try {
      const parsed = new URL(source);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/' || prohibitedHost(parsed.hostname) || source !== parsed.origin) {
        warnings.push(Object.freeze({ code: 'csp-source-rejected', value: source }));
        continue;
      }
      accepted.add(parsed.origin);
    } catch {
      warnings.push(Object.freeze({ code: 'csp-source-rejected', value: source }));
    }
  }
  return Object.freeze({ accepted: Object.freeze([...accepted].slice(0, 32)), warnings: Object.freeze(warnings) });
};

const sourceList = (sources: readonly string[], fallback: string): string => sources.length > 0 ? sources.join(' ') : fallback;

const withInline = (sources: readonly string[]): string => ['\'unsafe-inline\'', ...sources].join(' ');

const permissionEntries: readonly [keyof McpAppSandboxPermissions, string][] = [
  ['camera', 'camera'],
  ['clipboardWrite', 'clipboard-write'],
  ['geolocation', 'geolocation'],
  ['microphone', 'microphone'],
];

const permitted = (
  declaration: McpAppSandboxPermissions | undefined,
  consent: McpAppSandboxPermissions | undefined,
  key: keyof McpAppSandboxPermissions,
): boolean => isCapability(declaration?.[key]) && isCapability(consent?.[key]);

const permissionPolicy = (declaration: McpAppSandboxPermissions | undefined, consent: McpAppSandboxPermissions | undefined): string => (
  permissionEntries.map(([key, directive]) => `${directive}=(${permitted(declaration, consent, key) ? 'self' : ''})`).join(', ')
);

const iframeAllow = (declaration: McpAppSandboxPermissions | undefined, consent: McpAppSandboxPermissions | undefined): string => (
  permissionEntries.filter(([key]) => permitted(declaration, consent, key)).map(([, directive]) => directive).join('; ')
);

export const deriveMcpAppSandboxPolicy = (
  declaration: McpAppSandboxDeclaration,
  consent: McpAppSandboxConsent = {},
  internalSources?: McpAppSandboxInternalSources,
): McpAppSandboxPolicy => {
  const connect = cspSources(declaration.csp?.connectDomains);
  const resources = cspSources(declaration.csp?.resourceDomains);
  const frames = cspSources(declaration.csp?.frameDomains);
  const baseUri = cspSources(declaration.csp?.baseUriDomains);
  const internalOrigin = internalSources?.provenance === 'compiler-internal' && internalSources.webSocketPath === '/rsbuild-hmr'
    ? originOf(internalSources.origin) : undefined;
  const internalWebSocketUrl = internalOrigin === undefined ? undefined : new URL('/rsbuild-hmr', internalOrigin.replace(/^http/u, 'ws')).href;
  return Object.freeze({
    contentSecurityPolicy: [
      "default-src 'none'",
      `base-uri ${sourceList(baseUri.accepted, "'self'")}`,
      `connect-src ${sourceList(Object.freeze([...connect.accepted, ...(internalWebSocketUrl === undefined ? [] : [internalWebSocketUrl])]), "'none'")}`,
      `frame-src ${sourceList(frames.accepted, "'none'")}`,
      `img-src ${['data:', ...resources.accepted].join(' ')}`,
      `media-src ${sourceList(resources.accepted, "'none'")}`,
      `font-src ${sourceList(resources.accepted, "'none'")}`,
      `style-src ${withInline(resources.accepted)}`,
      `script-src ${withInline(resources.accepted)}`,
    ].join('; '),
    iframeAllow: iframeAllow(declaration.permissions, consent.permissions),
    ...(internalWebSocketUrl === undefined ? {} : { internalWebSocketUrl }),
    permissionsPolicy: permissionPolicy(declaration.permissions, consent.permissions),
    warnings: Object.freeze([...connect.warnings, ...resources.warnings, ...frames.warnings, ...baseUri.warnings]),
  });
};

export const createMcpAppDocumentPolicySnapshot = (
  revision: number,
  declaration: McpAppSandboxDeclaration,
  grants: readonly McpAppConsentGrant[],
): McpAppDocumentPolicySnapshot => {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new RangeError('MCP App document policy revision must be a positive safe integer');
  const granted = new Set(grants.filter((grant) => grant.scope === 'document').map((grant) => grant.capability));
  const permissions = Object.freeze({
    ...(granted.has('camera') && isCapability(declaration.permissions?.camera) ? { camera: Object.freeze({}) } : {}),
    ...(granted.has('clipboard-write') && isCapability(declaration.permissions?.clipboardWrite) ? { clipboardWrite: Object.freeze({}) } : {}),
    ...(granted.has('geolocation') && isCapability(declaration.permissions?.geolocation) ? { geolocation: Object.freeze({}) } : {}),
    ...(granted.has('microphone') && isCapability(declaration.permissions?.microphone) ? { microphone: Object.freeze({}) } : {}),
  });
  const policy = deriveMcpAppSandboxPolicy(declaration, { permissions });
  return Object.freeze({ allow: policy.iframeAllow, approvedPermissions: permissions, revision, warnings: policy.warnings });
};

const originOf = (value: string): string => {
  const parsed = new URL(value);
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.username || parsed.password) {
    throw new TypeError('origin must be an HTTP(S) origin without credentials');
  }
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new TypeError('origin must not include a path, query, or fragment');
  }
  return parsed.origin;
};

const maximum = (value: number | undefined, fallback: number, name: string, maximumValue = Number.MAX_SAFE_INTEGER): number => {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > maximumValue) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${maximumValue}`);
  }
  return resolved;
};

const relayOf = (maxMessageBytes: number | undefined, maxQueuedMessages: number | undefined): McpAppSandboxRelay => Object.freeze({
  maxMessageBytes: maximum(maxMessageBytes, DEFAULT_MAX_MESSAGE_BYTES, 'maxMessageBytes', MAX_RELAY_MESSAGE_BYTES),
  maxQueuedMessages: maximum(maxQueuedMessages, DEFAULT_MAX_QUEUED_MESSAGES, 'maxQueuedMessages'),
});

const messageSize = (message: unknown): number | undefined => {
  try {
    const serialized = JSON.stringify(message);
    return typeof serialized === 'string' ? Buffer.byteLength(serialized) : undefined;
  } catch {
    return undefined;
  }
};

const hasOwn = (value: object, key: string): boolean => Object.hasOwn(value, key);

const isRequestId = (value: unknown): value is McpAppSandboxRequestId => value === null || typeof value === 'string' || typeof value === 'number';

const isMessage = (value: unknown, maxMessageBytes: number): value is McpAppSandboxMessage => {
  if (!isRecord(value) || value.jsonrpc !== JSON_RPC_VERSION) return false;
  const size = messageSize(value);
  if (size === undefined || size > maxMessageBytes) return false;
  const hasMethod = typeof value.method === 'string' && value.method.length > 0;
  const hasId = hasOwn(value, 'id') && isRequestId(value.id);
  return hasMethod || (hasId && (hasOwn(value, 'result') || hasOwn(value, 'error')));
};

const isNotification = (message: McpAppSandboxMessage, method: string): boolean => message.method === method && !hasOwn(message, 'id');

const isSandboxNotification = (message: McpAppSandboxMessage): boolean => typeof message.method === 'string' && message.method.startsWith(SANDBOX_NOTIFICATION_PREFIX);

const isInitializeRequest = (message: McpAppSandboxMessage): message is McpAppSandboxMessage & { readonly id: McpAppSandboxRequestId } => (
  message.method === INITIALIZE_METHOD && hasOwn(message, 'id') && isRequestId(message.id)
);

const isInitializeResponse = (message: McpAppSandboxMessage, id: McpAppSandboxRequestId | undefined): boolean => (
  !hasOwn(message, 'method') && hasOwn(message, 'id') && message.id === id && (hasOwn(message, 'result') || hasOwn(message, 'error'))
);

const notification = (method: string, params: unknown = {}): McpAppSandboxMessage => ({ jsonrpc: JSON_RPC_VERSION, method, params });

export const createMcpAppSandboxFrame = (
  options: CreateMcpAppSandboxFrameOptions,
): McpAppSandboxFrame => {
  const hostOrigin = originOf(options.hostOrigin);
  const proxyOrigin = originOf(options.proxy.origin);
  if (hostOrigin === proxyOrigin) throw new Error('MCP App sandbox frame must use a different origin from its host');
  const proxyUrl = new URL(proxyOrigin);
  if (proxyUrl.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(proxyUrl.hostname)) {
    throw new TypeError('MCP App sandbox frame must target a loopback HTTP proxy');
  }
  const relay = relayOf(options.proxy.relay.maxMessageBytes, options.proxy.relay.maxQueuedMessages);
  const policy = deriveMcpAppSandboxPolicy(options.declaration ?? {}, options.consent);
  const configuration = encodeURIComponent(JSON.stringify({ hostOrigin, maxMessageBytes: relay.maxMessageBytes }));
  return Object.freeze({
    allow: policy.iframeAllow,
    ...(options.documentPolicy === undefined ? {} : { documentPolicy: options.documentPolicy }),
    policy,
    referrerPolicy: 'no-referrer',
    relay,
    sandbox: 'allow-scripts allow-same-origin',
    src: `${proxyOrigin}/#${configuration}`,
    targetOrigin: proxyOrigin,
  });
};

export const createMcpAppSandboxBridge = (
  options: CreateMcpAppSandboxBridgeOptions,
): McpAppSandboxBridge => {
  const proxyOrigin = originOf(options.frame.targetOrigin);
  const relay = relayOf(options.frame.relay.maxMessageBytes, options.frame.relay.maxQueuedMessages);
  const queuedMessages: McpAppSandboxMessage[] = [];
  let lifecycle: McpAppSandboxLifecycle = 'created';
  let initializeId: McpAppSandboxRequestId | undefined;

  const post = (message: McpAppSandboxMessage): void => options.proxyWindow.postMessage(message, proxyOrigin);

  const flush = (): void => {
    while (queuedMessages.length > 0) {
      const message = queuedMessages.shift();
      if (message) post(message);
    }
  };

  return Object.freeze({
    get lifecycle(): McpAppSandboxLifecycle {
      return lifecycle;
    },
    close(): void {
      lifecycle = 'closed';
      queuedMessages.length = 0;
      initializeId = undefined;
    },
    provideResource(resource: McpAppSandboxResource): boolean {
      if (lifecycle !== 'proxy-ready' || typeof resource.html !== 'string' || (resource.sandbox !== undefined && typeof resource.sandbox !== 'string')) return false;
      const message = notification(RESOURCE_READY_METHOD, {
        allow: options.frame.policy.iframeAllow,
        contentSecurityPolicy: options.frame.policy.contentSecurityPolicy,
        html: resource.html,
        ...(resource.sandbox === undefined ? {} : { sandbox: resource.sandbox }),
      });
      if (!isMessage(message, relay.maxMessageBytes)) return false;
      lifecycle = 'resource-ready';
      post(message);
      return true;
    },
    receive(event: McpAppSandboxMessageEvent): boolean {
      if (lifecycle === 'closed' || event.source !== options.proxyWindow || event.origin !== proxyOrigin) return false;
      if (!isMessage(event.data, relay.maxMessageBytes)) return false;
      const message = event.data;
      if (isNotification(message, PROXY_READY_METHOD)) {
        if (lifecycle !== 'created') return false;
        lifecycle = 'proxy-ready';
        return true;
      }
      if (isNotification(message, INITIALIZED_METHOD)) {
        if (lifecycle !== 'initialize-responded') return false;
        lifecycle = 'initialized';
        flush();
        return true;
      }
      if (isSandboxNotification(message)) return false;
      if (isInitializeRequest(message)) {
        if (lifecycle !== 'resource-ready') return false;
        initializeId = message.id;
        lifecycle = 'initializing';
        options.onMessage?.(message);
        return true;
      }
      if (lifecycle !== 'initialized') return false;
      options.onMessage?.(message);
      return true;
    },
    send(message: McpAppSandboxMessage): boolean {
      if (lifecycle === 'closed' || !isMessage(message, relay.maxMessageBytes) || isSandboxNotification(message)) return false;
      if (lifecycle === 'initializing') {
        if (!isInitializeResponse(message, initializeId)) return false;
        lifecycle = 'initialize-responded';
        post(message);
        return true;
      }
      if (lifecycle === 'initialized') {
        post(message);
        return true;
      }
      if (lifecycle !== 'resource-ready' || queuedMessages.length >= relay.maxQueuedMessages) {
        return false;
      }
      queuedMessages.push(message);
      return true;
    },
  });
};

const listen = async (server: Server, port: number): Promise<number> => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen({ host: '127.0.0.1', port }, () => {
    server.off('error', reject);
    const address = server.address();
    if (!address || typeof address === 'string') {
      reject(new Error('MCP App sandbox proxy did not receive a TCP address'));
      return;
    }
    resolve(address.port);
  });
});

const closeServer = async (server: Server, sockets: ReadonlySet<Socket>, timeoutMs: number): Promise<void> => new Promise((resolve, reject) => {
  let settled = false;
  const deadline = setTimeout(() => {
    for (const socket of sockets) socket.destroy();
  }, timeoutMs);
  const settle = (error?: Error): void => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    if (error) reject(error);
    else resolve();
  };
  server.close((error) => settle(error ?? undefined));
});

export const createMcpAppSandboxProxy = async (
  options: CreateMcpAppSandboxProxyOptions,
): Promise<McpAppSandboxProxy> => {
  const hostOrigin = originOf(options.hostOrigin);
  const relay = relayOf(options.maxMessageBytes, options.maxQueuedMessages);
  const closeTimeoutMs = maximum(options.closeTimeoutMs, 1_000, 'closeTimeoutMs');
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://sandbox.invalid');
    if (request.method !== 'GET' || (requestUrl.pathname !== '/' && requestUrl.pathname !== '/index.html')) {
      response.writeHead(404, { 'cache-control': 'no-store', 'content-type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-security-policy': PROXY_CONTENT_SECURITY_POLICY,
      'content-type': 'text/html; charset=utf-8',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
    });
    response.end(SHELL);
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const port = await listen(server, options.port ?? 0);
  const origin = `http://127.0.0.1:${port}`;
  if (origin === hostOrigin) {
    await closeServer(server, sockets, closeTimeoutMs);
    throw new Error('MCP App sandbox proxy must use a different origin from its host');
  }
  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    origin,
    relay,
    url: `${origin}/`,
    close: () => {
      closePromise ??= closeServer(server, sockets, closeTimeoutMs);
      return closePromise;
    },
  });
};
