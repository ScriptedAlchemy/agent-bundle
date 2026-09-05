import { isCallToolResult } from '@modelcontextprotocol/client';

import type { ProjectClient } from '../project-client.ts';
import type { ProjectEventMessage } from '../../../agent-bundle/src/contracts/project.ts';
import { isMcpAppConsentCapability, validateMcpAppUiUri } from '../../../agent-bundle/src/contracts/mcp-apps.ts';
import { MCP_APP_PROFILE_DESCRIPTORS, runtimeAppMessageLimits } from '../../../agent-bundle/src/contracts/mcp-apps.ts';
import type { McpAppProfileId } from '../../../agent-bundle/src/contracts/mcp-apps.ts';
import type {
  CreateMcpAppPreviewRequest as RuntimeCreateRequest,
  McpAppBindingOperation,
  McpAppConsentCreatedResponse,
  McpAppConsentDecisionResponse,
  McpAppPreviewSnapshot,
  McpAppRuntimeInvalidationDetails,
} from '../../../agent-bundle/src/contracts/mcp-apps.ts';
import type {
  McpAppBoundOperationResult,
  McpAppPublicRuntimeVector,
  McpAppRuntimeBindingSnapshot,
} from '../../../agent-bundle/src/contracts/mcp-apps.ts';
import type { McpAppConsentRequest, McpAppDocumentPolicySnapshot } from '../../../agent-bundle/src/contracts/mcp-apps.ts';

import { exactKeys, isRecord } from '../client-helpers.ts';
import { hasOnlyOwnKeys } from '../strict-json.ts';
import { finiteOrdinaryJsonByteLength } from './finite-json.ts';
import { ForegroundRouteClient, ForegroundRouteClientError, sameRuntimeBinding, type McpRuntimeBindingIdentity } from './mcp-route-client.ts';

export type McpAppJsonPrimitive = null | boolean | number | string;

export type McpAppJsonArray = readonly McpAppJsonValue[];

export interface McpAppJsonObject {
  readonly [key: string]: McpAppJsonValue;
}

export type McpAppJsonValue = McpAppJsonArray | McpAppJsonObject | McpAppJsonPrimitive;

export type McpAppPreviewProfile = McpAppProfileId;
export type McpAppBridgeLifecycle = 'created' | 'initializing' | 'initialized' | 'closing' | 'closed';
export type McpAppRequestId = string | number | null;

export interface McpAppHostContext {
  readonly availableDisplayModes: readonly string[];
  readonly containerDimensions: Readonly<{ readonly height: number; readonly width: number }>;
  readonly deviceCapabilities: Readonly<Record<string, McpAppJsonValue>>;
  readonly displayMode: string;
  readonly locale: string;
  readonly platform: string;
  readonly safeAreaInsets: Readonly<{ readonly bottom: number; readonly left: number; readonly right: number; readonly top: number }>;
  readonly styles: Readonly<Record<string, McpAppJsonValue>>;
  readonly theme: 'dark' | 'light';
  readonly timeZone: string;
  readonly userAgent: string;
}

export const workbenchMcpAppHostContext = (): McpAppHostContext => {
  const browser = typeof window === 'undefined' ? undefined : window;
  const locale = browser?.navigator.language;
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return Object.freeze({
    availableDisplayModes: Object.freeze(['inline']),
    containerDimensions: Object.freeze({
      height: Math.max(0, browser?.innerHeight ?? 0),
      width: Math.max(0, browser?.innerWidth ?? 0),
    }),
    deviceCapabilities: Object.freeze({}),
    displayMode: 'inline',
    locale: typeof locale === 'string' && locale.length > 0 ? locale : 'en',
    platform: 'web',
    safeAreaInsets: Object.freeze({ bottom: 0, left: 0, right: 0, top: 0 }),
    styles: Object.freeze({}),
    theme: browser?.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    timeZone: typeof timeZone === 'string' && timeZone.length > 0 ? timeZone : 'UTC',
    userAgent: browser?.navigator.userAgent ?? 'unknown',
  });
};

export interface McpAppPreviewCreateRequest {
  readonly host: McpAppHostContext;
  readonly input: McpAppJsonValue;
  readonly previewProfile: McpAppPreviewProfile;
  readonly result: McpAppJsonValue;
  readonly toolName: string;
}

export interface McpAppRelayFrame {
  readonly allow: string;
  readonly documentPolicy?: Readonly<{
    readonly allow: string;
    readonly approvedPermissions: McpAppJsonValue;
    readonly revision: number;
    readonly warnings: readonly McpAppJsonValue[];
  }>;
  readonly policy: Readonly<{
    readonly contentSecurityPolicy: string;
    readonly iframeAllow: string;
    readonly permissionsPolicy: string;
  }>;
  readonly referrerPolicy: 'no-referrer';
  readonly relay: Readonly<{ readonly maxMessageBytes: number; readonly maxQueuedMessages: number }>;
  readonly sandbox: 'allow-scripts allow-same-origin';
  readonly src: string;
  readonly targetOrigin: string;
}

export interface McpAppPreview {
  readonly bindingId: string;
  readonly frame?: McpAppRelayFrame;
  readonly profile: McpAppJsonValue;
  readonly resource: McpAppJsonValue;
}

export interface McpAppRouteMessages {
  readonly accepted: boolean;
  readonly lifecycle: McpAppBridgeLifecycle;
  readonly messages: readonly McpAppJsonValue[];
}

export interface McpAppRouteClose {
  readonly lifecycle: McpAppBridgeLifecycle;
  readonly message?: McpAppJsonValue;
}

export interface McpAppConsentChallenge {
  readonly expiresAt: number;
  readonly id: string;
  readonly request: McpAppJsonValue;
}

export interface McpAppConsentDecision {
  readonly approved: boolean;
  readonly messages: readonly McpAppJsonValue[];
  /** Fresh server snapshot; document-policy changes require a new iframe. */
  readonly preview: McpAppPreview;
}

export interface McpAppClientOptions {
  /** Workbench-owned foreground authentication shared by every protected browser client. */
  readonly foreground: ForegroundRouteClient;
  /** Reuses the Workbench's authenticated project event stream when it is already connected. */
  readonly projectClient?: Pick<ProjectClient, 'subscribeEvents'>;
}

export interface McpAppTrustedDocumentPolicy {
  readonly bindingId: string;
  readonly snapshot: McpAppDocumentPolicySnapshot;
}

export interface McpAppRuntimeClient {
  abandonRuntimeConsent(bindingId: string, consentId: string): void;
  closeRuntime(bindingId: string): Promise<void>;
  createRuntime(request: RuntimeCreateRequest): Promise<McpAppPreviewSnapshot>;
  createRuntimeConsent(bindingId: string, request: McpAppConsentRequest, signal?: AbortSignal): Promise<McpAppConsentCreatedResponse>;
  currentDocumentPolicy(bindingId: string): McpAppTrustedDocumentPolicy;
  decideRuntimeConsent(bindingId: string, consentId: string, decision: 'allow-once' | 'deny', signal?: AbortSignal): Promise<McpAppConsentDecisionResponse>;
  getRuntime(bindingId: string): Promise<McpAppPreviewSnapshot>;
  operateRuntime(bindingId: string, operation: McpAppBindingOperation, signal?: AbortSignal): Promise<McpAppBoundOperationResult>;
  subscribeInvalidations(listener: (details: McpAppRuntimeInvalidationDetails) => void): () => void;
}

interface Diagnostic {
  readonly code: string;
  readonly message: string;
}

const maximumPathSegmentLength = 4_096;

const throwIfAborted = (signal: AbortSignal | undefined): void => {
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
};

const runtimeResponseJson = async (response: Response): Promise<unknown> => {
  const maximumBytes = runtimeAppMessageLimits.hostToAppBytes;
  const declared = response.headers.get('content-length');
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    throw new McpAppClientError('AB8019', 'Runtime MCP App route response exceeds its transport bound.');
  }
  if (response.body === null) throw new McpAppClientError('AB8019', 'Runtime MCP App route returned an invalid response.');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw new McpAppClientError('AB8019', 'Runtime MCP App route response exceeds its transport bound.');
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  let parsed: unknown;
  try {
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    throw new McpAppClientError('AB8019', 'Runtime MCP App route returned an invalid response.');
  }
  if (finiteOrdinaryJsonByteLength(parsed, { maximumBytes, maximumDepth: 32, maximumNodes: 4_096 }) === undefined) {
    throw new McpAppClientError('AB8019', 'Runtime MCP App route returned an invalid response.');
  }
  return parsed;
};

const detachedJson = (value: unknown, ancestors = new WeakSet<object>()): McpAppJsonValue => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw new McpAppClientError('AB8016', 'Foreground MCP App data must contain finite JSON numbers.');
  }
  if (typeof value !== 'object') throw new McpAppClientError('AB8016', 'Foreground MCP App data must contain only JSON values.');
  if (ancestors.has(value)) throw new McpAppClientError('AB8016', 'Foreground MCP App data must not be cyclic.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map((entry) => detachedJson(entry, ancestors)));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new McpAppClientError('AB8016', 'Foreground MCP App data must use ordinary JSON objects.');
    }
    const copy = Object.create(null) as Record<string, McpAppJsonValue>;
    for (const [key, entry] of Object.entries(value)) copy[key] = detachedJson(entry, ancestors);
    return Object.freeze(copy);
  } finally {
    ancestors.delete(value);
  }
};

const asRecord = (value: unknown, code = 'AB8019'): Readonly<Record<string, McpAppJsonValue>> => {
  if (!isRecord(value)) throw new McpAppClientError(code, 'Foreground MCP App route returned an invalid response.');
  try {
    return detachedJson(value) as Readonly<Record<string, McpAppJsonValue>>;
  } catch {
    throw new McpAppClientError(code, 'Foreground MCP App route returned an invalid response.');
  }
};

const asArray = (value: unknown): readonly McpAppJsonValue[] => {
  if (!Array.isArray(value)) throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid response.');
  try {
    return detachedJson(value) as readonly McpAppJsonValue[];
  } catch {
    throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid response.');
  }
};

const diagnostic = (value: unknown, status: number): Diagnostic => {
  if (isRecord(value) && isRecord(value.diagnostic) && typeof value.diagnostic.code === 'string' && typeof value.diagnostic.message === 'string') {
    return { code: value.diagnostic.code, message: value.diagnostic.message };
  }
  return { code: 'AB8019', message: `Foreground MCP App request failed with HTTP ${status}.` };
};

const opaqueSegment = (value: string, name: string): string => {
  if (
    value.length === 0 || value.length > maximumPathSegmentLength || value.trim().length === 0 || value === '.' || value === '..' ||
    value.includes('/') || value.includes('\\') || value.includes('\0')
  ) throw new McpAppClientError('AB8015', `${name} is not available.`);
  return encodeURIComponent(value);
};

const lifecycle = (value: unknown): McpAppBridgeLifecycle => {
  if (value === 'created' || value === 'initializing' || value === 'initialized' || value === 'closing' || value === 'closed') return value;
  throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid lifecycle.');
};

const positiveInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const nonnegativeInteger = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

const runtimeInvalid = (message = 'Runtime MCP App route returned an invalid response.'): never => {
  throw new McpAppClientError('AB8019', message);
};

const runtimeInputInvalid = (message = 'Runtime MCP App request is not valid.'): never => {
  throw new McpAppClientError('AB8016', message);
};

const hasExactKeys: (value: Readonly<Record<string, unknown>>, keys: readonly string[]) => boolean = exactKeys;

const hasOnlyKeys: (value: Readonly<Record<string, unknown>>, keys: readonly string[]) => boolean = hasOnlyOwnKeys;

const runtimeRecord = (value: unknown, keys: readonly string[], message?: string): Readonly<Record<string, McpAppJsonValue>> => {
  const record = asRecord(value);
  if (!hasExactKeys(record, keys)) runtimeInvalid(message);
  return record;
};

const runtimeOptionalRecord = (value: unknown, keys: readonly string[], message?: string): Readonly<Record<string, McpAppJsonValue>> => {
  const record = asRecord(value);
  if (!hasOnlyKeys(record, keys)) runtimeInvalid(message);
  return record;
};

const runtimeText = (value: unknown, label: string): string => {
  if (typeof value === 'string' && value.trim().length > 0 && value.length <= maximumPathSegmentLength && !value.includes('\0')) {
    return value;
  }
  return runtimeInvalid(`Runtime MCP App route returned an invalid ${label}.`);
};

const runtimeBoundedText = (value: unknown, label: string): string => {
  if (typeof value === 'string' && value.length <= maximumPathSegmentLength && !value.includes('\0')) return value;
  return runtimeInvalid(`Runtime MCP App route returned an invalid ${label}.`);
};

const runtimeArray = (value: unknown, message = 'Runtime MCP App route returned an invalid response.'): readonly McpAppJsonValue[] => {
  if (Array.isArray(value)) return value as readonly McpAppJsonValue[];
  return runtimeInvalid(message);
};

const runtimeNumber = (value: unknown, label: string, predicate: (value: unknown) => value is number): number => {
  if (predicate(value)) return value;
  return runtimeInvalid(`Runtime MCP App route returned an invalid ${label}.`);
};

const runtimeStringOrUndefined = (value: unknown, label: string): string | undefined => {
  if (value === undefined || typeof value === 'string') return value;
  return runtimeInvalid(`Runtime MCP App route returned an invalid ${label}.`);
};

const runtimeEra = (value: unknown): 'legacy' | 'modern' | undefined => {
  if (value === undefined || value === 'legacy' || value === 'modern') return value;
  return runtimeInvalid('Runtime MCP App route returned an invalid protocol era.');
};

const runtimeProfileId = (value: unknown): 'portable' | 'chatgpt' | 'claude' => {
  if (value === 'portable' || value === 'chatgpt' || value === 'claude') return value;
  return runtimeInvalid('Runtime MCP App route returned an invalid profile.');
};

const runtimeVector = (value: unknown): McpAppPublicRuntimeVector => {
  const record = runtimeOptionalRecord(value, ['artifactEpochId', 'runtimeGenerationId', 'sourceRevision', 'stateVersion']);
  const runtimeGenerationId = runtimeText(record.runtimeGenerationId, 'runtime generation');
  const sourceRevision = runtimeText(record.sourceRevision, 'source revision');
  if (
    !nonnegativeInteger(record.stateVersion) ||
    (record.artifactEpochId !== undefined && typeof record.artifactEpochId !== 'string')
  ) runtimeInvalid('Runtime MCP App route returned an invalid runtime vector.');
  return Object.freeze({
    ...(record.artifactEpochId === undefined ? {} : { artifactEpochId: record.artifactEpochId }),
    runtimeGenerationId,
    sourceRevision,
    stateVersion: record.stateVersion,
  }) as McpAppPublicRuntimeVector;
};

const runtimeStableBinding = (value: unknown): McpRuntimeBindingIdentity => {
  const record = runtimeRecord(value, [
    'definitionDigest', 'registryRevision', 'serverDigest', 'serverName', 'sessionId', 'sessionRevision', 'target', 'transportDigest',
  ]);
  const registryRevision = runtimeNumber(record.registryRevision, 'registry revision', positiveInteger);
  const sessionRevision = runtimeNumber(record.sessionRevision, 'session revision', positiveInteger);
  return Object.freeze({
    definitionDigest: runtimeText(record.definitionDigest, 'definition digest'),
    registryRevision,
    serverDigest: runtimeText(record.serverDigest, 'server digest'),
    serverName: runtimeText(record.serverName, 'server name'),
    sessionId: runtimeText(record.sessionId, 'session id'),
    sessionRevision,
    target: runtimeText(record.target, 'target'),
    transportDigest: runtimeText(record.transportDigest, 'transport digest'),
  });
};

const runtimeBinding = (value: unknown): McpAppRuntimeBindingSnapshot => {
  const record = runtimeRecord(value, [
    'definitionDigest', 'evidence', 'id', 'profileId', 'profileVersion', 'registryRevision', 'runVector', 'serverDigest', 'serverName',
    'sessionId', 'sessionRevision', 'target', 'transportDigest',
  ]);
  const stable = runtimeStableBinding({
    definitionDigest: record.definitionDigest,
    registryRevision: record.registryRevision,
    serverDigest: record.serverDigest,
    serverName: record.serverName,
    sessionId: record.sessionId,
    sessionRevision: record.sessionRevision,
    target: record.target,
    transportDigest: record.transportDigest,
  });
  const profileId = runtimeProfileId(record.profileId);
  const profileVersion = runtimeText(record.profileVersion, 'profile version');
  const expectedVersions: Readonly<Record<typeof profileId, string>> = {
    chatgpt: 'agent-bundle:chatgpt-sim:1', claude: 'agent-bundle:claude-sim:1', portable: 'agent-bundle:mcp-apps:2026-01-26',
  };
  if (record.evidence !== 'simulated' || profileVersion !== expectedVersions[profileId]) runtimeInvalid('Runtime MCP App route returned an invalid binding profile.');
  return Object.freeze({
    ...stable,
    evidence: 'simulated',
    id: decodeURIComponent(opaqueSegment(runtimeText(record.id, 'binding id'), 'Runtime MCP App binding')),
    profileId,
    profileVersion,
    runVector: runtimeVector(record.runVector),
  }) as McpAppRuntimeBindingSnapshot;
};

const runtimeConnection = (value: unknown): Readonly<{
  readonly capabilities: Readonly<Record<string, McpAppJsonValue>> | undefined;
  readonly protocolEra: 'legacy' | 'modern' | undefined;
  readonly protocolVersion: string | undefined;
  readonly server: Readonly<{ readonly name: string; readonly version: string }> | undefined;
}> => {
  const record = runtimeRecord(value, ['capabilities', 'protocolEra', 'protocolVersion', 'server']);
  if (record.capabilities !== undefined && !isRecord(record.capabilities)) runtimeInvalid('Runtime MCP App route returned invalid server capabilities.');
  const server = record.server === undefined ? undefined : runtimeRecord(record.server, ['name', 'version']);
  const capabilities = record.capabilities === undefined ? undefined : asRecord(record.capabilities);
  const protocolEra = runtimeEra(record.protocolEra);
  const protocolVersion = runtimeStringOrUndefined(record.protocolVersion, 'protocol version');
  return Object.freeze({
    capabilities,
    protocolEra,
    protocolVersion,
    server: server === undefined ? undefined : Object.freeze({ name: runtimeText(server.name, 'server name'), version: runtimeText(server.version, 'server version') }),
  });
};

const runtimePermissions = (value: unknown): Readonly<Record<'camera' | 'clipboardWrite' | 'geolocation' | 'microphone', Readonly<Record<string, never>> | undefined>> => {
  const record = runtimeOptionalRecord(value, ['camera', 'clipboardWrite', 'geolocation', 'microphone']);
  const permissions: Record<string, Readonly<Record<string, never>>> = Object.create(null) as Record<string, Readonly<Record<string, never>>>;
  for (const key of Object.keys(record)) {
    const capability = runtimeRecord(record[key], []);
    permissions[key] = capability as Readonly<Record<string, never>>;
  }
  return Object.freeze(permissions) as Readonly<Record<'camera' | 'clipboardWrite' | 'geolocation' | 'microphone', Readonly<Record<string, never>> | undefined>>;
};

const runtimeDocumentPolicy = (value: unknown): McpAppDocumentPolicySnapshot => {
  const record = runtimeRecord(value, ['allow', 'approvedPermissions', 'revision', 'warnings']);
  const rawWarnings = runtimeArray(record.warnings, 'Runtime MCP App route returned an invalid document policy.');
  const revision = runtimeNumber(record.revision, 'document policy revision', positiveInteger);
  const warnings = rawWarnings.map((warning) => {
    const item = runtimeRecord(warning, ['code', 'value']);
    if (item.code !== 'csp-source-rejected' && item.code !== 'csp-wildcard-rejected' && item.code !== 'permission-not-consented') {
      runtimeInvalid('Runtime MCP App route returned an invalid document-policy warning.');
    }
    return Object.freeze({ code: item.code, value: runtimeText(item.value, 'document-policy warning') });
  });
  return Object.freeze({
    allow: runtimeBoundedText(record.allow, 'document-policy allow'),
    approvedPermissions: runtimePermissions(record.approvedPermissions),
    revision,
    warnings: Object.freeze(warnings),
  }) as McpAppDocumentPolicySnapshot;
};

const runtimeMetadata = (value: unknown, host = false): unknown => {
  const record = runtimeOptionalRecord(value, host ? ['claudeDomain', 'extensions', 'provenance', 'raw', 'standard'] : ['extensions', 'provenance', 'raw', 'standard']);
  if (!hasExactKeys(record, host && record.claudeDomain !== undefined
    ? ['claudeDomain', 'extensions', 'provenance', 'raw', 'standard']
    : ['extensions', 'provenance', 'raw', 'standard'])) runtimeInvalid('Runtime MCP App route returned invalid metadata inspection.');
  const raw = asRecord(record.raw);
  const standard = runtimeOptionalRecord(record.standard, ['ui']);
  const extensions = runtimeRecord(record.extensions, ['claude', 'openai']);
  const openai = asRecord(extensions.openai);
  const claude = asRecord(extensions.claude);
  const provenance = asRecord(record.provenance);
  if (!Object.keys(raw).every((key) => Object.hasOwn(provenance, key)) || Object.keys(provenance).some((key) => !Object.hasOwn(raw, key))) {
    runtimeInvalid('Runtime MCP App metadata provenance does not match its raw metadata.');
  }
  for (const value of Object.values(provenance)) {
    if (value !== 'standard' && value !== 'openai-extension' && value !== 'claude-extension' && value !== 'unclassified') {
      runtimeInvalid('Runtime MCP App route returned invalid metadata provenance.');
    }
  }
  const parsed: Record<string, McpAppJsonValue> = Object.create(null) as Record<string, McpAppJsonValue>;
  parsed.raw = raw;
  parsed.standard = Object.freeze({ ...(standard.ui === undefined ? {} : { ui: standard.ui }) });
  parsed.extensions = Object.freeze({ claude, openai });
  parsed.provenance = provenance;
  if (host && record.claudeDomain !== undefined) {
    const domain = runtimeOptionalRecord(record.claudeDomain, ['declaredDomain', 'expectedDomain', 'provenance']);
    if (!hasExactKeys(domain, domain.declaredDomain === undefined ? ['expectedDomain', 'provenance'] : ['declaredDomain', 'expectedDomain', 'provenance']) ||
      domain.provenance !== 'sha256-canonical-full-mcp-url' || typeof domain.expectedDomain !== 'string' ||
      (domain.declaredDomain !== undefined && typeof domain.declaredDomain !== 'string')) runtimeInvalid('Runtime MCP App route returned invalid Claude domain inspection.');
    parsed.claudeDomain = Object.freeze({
      ...(domain.declaredDomain === undefined ? {} : { declaredDomain: domain.declaredDomain }),
      expectedDomain: domain.expectedDomain,
      provenance: domain.provenance,
    });
  }
  return Object.freeze(parsed);
};

const runtimeHostContext = (value: unknown): unknown => {
  const record = runtimeRecord(value, [
    'availableDisplayModes', 'containerDimensions', 'deviceCapabilities', 'displayMode', 'locale', 'platform', 'safeAreaInsets', 'styles', 'theme', 'timeZone', 'toolInfo', 'userAgent',
  ]);
  const availableDisplayModes = runtimeArray(record.availableDisplayModes, 'Runtime MCP App route returned an invalid host context.');
  if (!availableDisplayModes.every((entry) => typeof entry === 'string') ||
    record.theme !== 'dark' && record.theme !== 'light') runtimeInvalid('Runtime MCP App route returned an invalid host context.');
  const dimensions = runtimeRecord(record.containerDimensions, ['height', 'width']);
  const insets = runtimeRecord(record.safeAreaInsets, ['bottom', 'left', 'right', 'top']);
  if (![dimensions.height, dimensions.width, insets.bottom, insets.left, insets.right, insets.top].every(nonnegativeInteger)) {
    runtimeInvalid('Runtime MCP App route returned an invalid host context.');
  }
  for (const key of ['displayMode', 'locale', 'platform', 'timeZone', 'userAgent'] as const) runtimeText(record[key], `host ${key}`);
  return Object.freeze({
    availableDisplayModes: Object.freeze([...availableDisplayModes]),
    containerDimensions: Object.freeze({ height: dimensions.height, width: dimensions.width }),
    deviceCapabilities: asRecord(record.deviceCapabilities),
    displayMode: record.displayMode,
    locale: record.locale,
    platform: record.platform,
    safeAreaInsets: Object.freeze({ bottom: insets.bottom, left: insets.left, right: insets.right, top: insets.top }),
    styles: asRecord(record.styles),
    theme: record.theme,
    timeZone: record.timeZone,
    toolInfo: asRecord(record.toolInfo),
    userAgent: record.userAgent,
  });
};

const runtimeConfigExtensions = (value: unknown): unknown => {
  const record = runtimeRecord(value, ['entries', 'sourceRevision']);
  const sourceRevision = runtimeText(record.sourceRevision, 'configuration source revision');
  const rawEntries = runtimeArray(record.entries, 'Runtime MCP App configuration inspection is invalid.');
  const allowedKeys = new Set(['claude', 'codex', 'portable']);
  const seen = new Set<string>();
  const entries = rawEntries.map((entry) => {
    const item = runtimeRecord(entry, ['configured', 'id', 'key', 'provenance', 'target']);
    const key = runtimeText(item.key, 'configuration extension key');
    const provenance = runtimeRecord(item.provenance, ['kind', 'sourcePath']);
    const sourcePath = runtimeText(provenance.sourcePath, 'configuration provenance path');
    const canonicalPath = sourcePath === '<external-config>' || (
      !sourcePath.startsWith('/') && !sourcePath.startsWith('\\') && !/^[A-Za-z]:[\\/]/.test(sourcePath) &&
      !sourcePath.includes('\\') && !sourcePath.includes('://') && sourcePath.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    );
    if (item.configured !== true || !allowedKeys.has(key) || seen.has(key) || item.id !== `extension:${key}` || item.target !== key ||
      provenance.kind !== 'config' || !canonicalPath) {
      runtimeInvalid('Runtime MCP App configuration inspection is invalid.');
    }
    seen.add(key);
    return Object.freeze({ configured: true, id: item.id, key, provenance: Object.freeze({ kind: 'config', sourcePath }), target: item.target });
  });
  return Object.freeze({ entries: Object.freeze(entries), sourceRevision });
};

const runtimeDescriptor = (value: unknown, profileId: McpAppProfileId, profileVersion: string): unknown => {
  const record = runtimeRecord(value, ['claimsRealHostParity', 'evidence', 'id', 'label', 'version']);
  const label = MCP_APP_PROFILE_DESCRIPTORS[profileId].label;
  if (record.claimsRealHostParity !== false || record.evidence !== 'simulated' || record.id !== profileId || record.label !== label || record.version !== profileVersion) {
    runtimeInvalid('Runtime MCP App route returned an invalid profile descriptor.');
  }
  return Object.freeze({ claimsRealHostParity: false, evidence: 'simulated', id: profileId, label, version: profileVersion });
};

const runtimeResource = (value: unknown): unknown => {
  const record = runtimeOptionalRecord(value, ['csp', 'html', 'permissions']);
  if (!hasExactKeys(record, [
    'html',
    ...(record.csp === undefined ? [] : ['csp']),
    ...(record.permissions === undefined ? [] : ['permissions']),
  ]) || typeof record.html !== 'string') runtimeInvalid('Runtime MCP App route returned an invalid App resource.');
  const csp = record.csp === undefined ? undefined : runtimeOptionalRecord(record.csp, ['baseUriDomains', 'connectDomains', 'frameDomains', 'resourceDomains']);
  if (csp !== undefined) {
    for (const domains of Object.values(csp)) {
      if (!Array.isArray(domains) || !domains.every((domain) => typeof domain === 'string')) runtimeInvalid('Runtime MCP App route returned an invalid App CSP.');
    }
  }
  return Object.freeze({
    ...(csp === undefined ? {} : { csp: Object.freeze(Object.fromEntries(Object.entries(csp).map(([key, domains]) => [key, Object.freeze([...(domains as readonly string[])])]))) }),
    html: record.html,
    ...(record.permissions === undefined ? {} : { permissions: runtimePermissions(record.permissions) }),
  });
};

const runtimeAppMeta = (value: McpAppJsonValue | undefined): boolean =>
  value === undefined || isRecord(value);

const isSdkCallToolResult = (value: unknown): boolean => isCallToolResult(value);

const runtimeAppAnnotations = (value: McpAppJsonValue | undefined): boolean => {
  if (value === undefined) return true;
  if (!isRecord(value) || !hasOnlyKeys(value, ['audience', 'lastModified', 'priority'])) return false;
  if (value.audience !== undefined && (!Array.isArray(value.audience) || !value.audience.every((role) => role === 'assistant' || role === 'user'))) return false;
  if (value.priority !== undefined && (typeof value.priority !== 'number' || value.priority < 0 || value.priority > 1)) return false;
  return value.lastModified === undefined || typeof value.lastModified === 'string';
};

const runtimeAppIcon = (value: McpAppJsonValue): boolean => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['mimeType', 'sizes', 'src', 'theme']) || typeof value.src !== 'string') return false;
  if (value.mimeType !== undefined && typeof value.mimeType !== 'string') return false;
  if (value.sizes !== undefined && (!Array.isArray(value.sizes) || !value.sizes.every((size) => typeof size === 'string'))) return false;
  return value.theme === undefined || value.theme === 'dark' || value.theme === 'light';
};

const runtimeAppIcons = (value: McpAppJsonValue | undefined): boolean =>
  value === undefined || (Array.isArray(value) && value.every(runtimeAppIcon));

const runtimeAppEmbeddedResource = (value: McpAppJsonValue): boolean => {
  if (!isRecord(value) || !hasOnlyKeys(value, ['_meta', 'blob', 'mimeType', 'text', 'uri']) || typeof value.uri !== 'string' || !runtimeAppMeta(value._meta)) return false;
  if (value.mimeType !== undefined && typeof value.mimeType !== 'string') return false;
  const hasText = Object.hasOwn(value, 'text');
  const hasBlob = Object.hasOwn(value, 'blob');
  if (hasText === hasBlob) return false;
  return hasText ? typeof value.text === 'string' : typeof value.blob === 'string';
};

const runtimeAppContent = (value: McpAppJsonValue): boolean => {
  if (!isRecord(value) || typeof value.type !== 'string') return false;
  const hasAllowedKeys = (keys: readonly string[]): boolean =>
    hasOnlyKeys(value, keys) && runtimeAppAnnotations(value.annotations) && runtimeAppMeta(value._meta);
  switch (value.type) {
    case 'text':
      return hasAllowedKeys(['type', 'text', 'annotations', '_meta']) && typeof value.text === 'string';
    case 'image':
    case 'audio':
      return hasAllowedKeys(['type', 'data', 'mimeType', 'annotations', '_meta']) && typeof value.data === 'string' && typeof value.mimeType === 'string';
    case 'resource_link': {
      if (!hasAllowedKeys(['type', 'name', 'title', 'icons', 'uri', 'description', 'mimeType', 'size', 'annotations', '_meta'])) return false;
      if (typeof value.name !== 'string' || typeof value.uri !== 'string' || !runtimeAppIcons(value.icons)) return false;
      if (value.title !== undefined && typeof value.title !== 'string') return false;
      if (value.description !== undefined && typeof value.description !== 'string') return false;
      if (value.mimeType !== undefined && typeof value.mimeType !== 'string') return false;
      return value.size === undefined || typeof value.size === 'number';
    }
    case 'resource': {
      return hasAllowedKeys(['type', 'resource', 'annotations', '_meta']) && runtimeAppEmbeddedResource(value.resource);
    }
    default:
      return false;
  }
};

/** Projects the validated App transcript without exposing a mutable route body to the renderer. */
const runtimeAppResult = (value: unknown): Readonly<Record<string, McpAppJsonValue>> => {
  const result = runtimeOptionalRecord(value, ['_meta', 'content', 'isError', 'structuredContent']);
  if (
    !Object.hasOwn(result, 'content') ||
    !Array.isArray(result.content) ||
    !isSdkCallToolResult(result) ||
    (result.isError !== undefined && typeof result.isError !== 'boolean') ||
    !runtimeAppMeta(result._meta) ||
    (result.structuredContent !== undefined && !isRecord(result.structuredContent)) ||
    !result.content.every(runtimeAppContent)
  ) runtimeInvalid('Runtime MCP App route returned an invalid App tool result.');
  return result;
};

const runtimeResult = (value: unknown): unknown => {
  const record = runtimeRecord(value, ['appVisible', 'isError', 'modelVisible']);
  const appVisible = runtimeAppResult(record.appVisible);
  if (typeof record.isError !== 'boolean' || record.isError !== (appVisible.isError === true)) {
    runtimeInvalid('Runtime MCP App route returned an invalid result inspection.');
  }
  return Object.freeze({ appVisible, isError: record.isError, modelVisible: record.modelVisible });
};

const runtimeOperationTrace = (value: unknown, binding: McpAppRuntimeBindingSnapshot): unknown => {
  const record = runtimeRecord(value, ['kind', 'operationId', 'sessionId', 'sessionRevision', 'vector']);
  if (record.kind !== 'tools/list' && record.kind !== 'resources/list' && record.kind !== 'tools/call' && record.kind !== 'resources/read') {
    runtimeInvalid('Runtime MCP App route returned an invalid operation trace.');
  }
  if (!positiveInteger(record.sessionRevision) || record.sessionId !== binding.sessionId || record.sessionRevision !== binding.sessionRevision) {
    runtimeInvalid('Runtime MCP App route returned an invalid operation trace.');
  }
  return Object.freeze({
    kind: record.kind,
    operationId: runtimeText(record.operationId, 'operation id'),
    sessionId: runtimeText(record.sessionId, 'operation session id'),
    sessionRevision: record.sessionRevision,
    vector: runtimeVector(record.vector),
  });
};

const runtimeSession = (value: unknown, binding: McpAppRuntimeBindingSnapshot): unknown => {
  const record = runtimeRecord(value, ['binding', 'connection', 'state']);
  const sessionBinding = runtimeStableBinding(record.binding);
  if (!sameRuntimeBinding(binding, sessionBinding) || record.state !== 'ready') runtimeInvalid('Runtime MCP App session does not match its binding.');
  return Object.freeze({ binding: sessionBinding, connection: runtimeConnection(record.connection), state: 'ready' });
};

const runtimeProfile = (value: unknown, binding: McpAppRuntimeBindingSnapshot, kind: 'apps' | 'fallback'): unknown => {
  const record = runtimeOptionalRecord(value, kind === 'apps'
    ? ['bootstrap', 'configExtensions', 'descriptor', 'hostContext', 'kind', 'metadata', 'permissions', 'resourceUri', 'warnings']
    : ['configExtensions', 'descriptor', 'kind', 'permissions', 'reason', 'warnings']);
  const keys = kind === 'apps'
    ? ['bootstrap', 'configExtensions', 'descriptor', 'hostContext', 'kind', 'metadata', 'permissions', 'resourceUri', 'warnings']
    : ['configExtensions', 'descriptor', 'kind', 'permissions', 'reason', 'warnings'];
  const rawWarnings = runtimeArray(record.warnings, 'Runtime MCP App route returned an invalid host profile.');
  if (!hasExactKeys(record, keys) || record.kind !== kind || !rawWarnings.every((warning) => typeof warning === 'string')) {
    runtimeInvalid('Runtime MCP App route returned an invalid host profile.');
  }
  const common = {
    configExtensions: runtimeConfigExtensions(record.configExtensions),
    descriptor: runtimeDescriptor(record.descriptor, binding.profileId, binding.profileVersion),
    kind,
    permissions: runtimePermissions(record.permissions),
    warnings: Object.freeze([...rawWarnings]),
  };
  if (kind === 'fallback') {
    if (record.reason !== 'apps-resource-invalid' && record.reason !== 'apps-resource-unavailable' && record.reason !== 'unsafe-capability-declaration') {
      runtimeInvalid('Runtime MCP App route returned an invalid fallback reason.');
    }
    return Object.freeze({ ...common, reason: record.reason });
  }
  const bootstrap = runtimeOptionalRecord(record.bootstrap, ['kind', 'script']);
  if (!hasExactKeys(bootstrap, bootstrap.kind === 'none' ? ['kind'] : ['kind', 'script']) ||
    (bootstrap.kind !== 'none' && bootstrap.kind !== 'chatgpt-widget-state-v1') ||
    (bootstrap.kind === 'chatgpt-widget-state-v1' && typeof bootstrap.script !== 'string')) runtimeInvalid('Runtime MCP App route returned an invalid App bootstrap.');
  const resourceUri = runtimeText(record.resourceUri, 'resource URI');
  if (validateMcpAppUiUri(resourceUri) === undefined) runtimeInvalid('Runtime MCP App route returned an invalid resource URI.');
  return Object.freeze({
    ...common,
    bootstrap: Object.freeze({ kind: bootstrap.kind, ...(bootstrap.script === undefined ? {} : { script: bootstrap.script }) }),
    hostContext: runtimeHostContext(record.hostContext),
    metadata: runtimeMetadata(record.metadata, true),
    resourceUri,
  });
};

const runtimePreview = (value: unknown, foregroundOrigin: string): McpAppPreviewSnapshot => {
  const record = runtimeOptionalRecord(value, ['binding', 'clientSurface', 'documentPolicy', 'kind', 'metadata', 'operations', 'profile', 'resource', 'result', 'session']);
  if (record.kind !== 'apps' && record.kind !== 'fallback') runtimeInvalid('Runtime MCP App route returned an invalid preview kind.');
  const expectedKeys = record.kind === 'apps'
    ? ['binding', 'clientSurface', 'documentPolicy', 'kind', 'metadata', 'operations', 'profile', 'resource', 'result', 'session']
    : ['binding', 'kind', 'metadata', 'operations', 'profile', 'result', 'session'];
  const rawOperations = runtimeArray(record.operations, 'Runtime MCP App route returned an invalid preview.');
  if (!hasExactKeys(record, expectedKeys)) runtimeInvalid('Runtime MCP App route returned an invalid preview.');
  const binding = runtimeBinding(record.binding);
  const metadata = runtimeRecord(record.metadata, ['resource', 'result', 'tool']);
  const base = {
    binding,
    metadata: Object.freeze({ resource: runtimeMetadata(metadata.resource), result: runtimeMetadata(metadata.result), tool: runtimeMetadata(metadata.tool) }),
    operations: Object.freeze(rawOperations.map((operation) => runtimeOperationTrace(operation, binding))),
    result: runtimeResult(record.result),
    session: runtimeSession(record.session, binding),
  };
  if (record.kind === 'fallback') return Object.freeze({ ...base, kind: 'fallback', profile: runtimeProfile(record.profile, binding, 'fallback') }) as unknown as McpAppPreviewSnapshot;
  const clientSurface = runtimeRecord(record.clientSurface, ['bootstrapUrl', 'origin']);
  const bootstrapUrl = runtimeText(clientSurface.bootstrapUrl, 'client bootstrap URL');
  const clientOrigin = origin(clientSurface.origin);
  let bootstrap: URL;
  try {
    bootstrap = new URL(bootstrapUrl);
  } catch {
    return runtimeInvalid('Runtime MCP App route returned an invalid client surface.');
  }
  if (bootstrap.origin !== clientOrigin || clientOrigin === foregroundOrigin || (bootstrap.protocol !== 'http:' && bootstrap.protocol !== 'https:')) {
    runtimeInvalid('Runtime MCP App route returned an invalid client surface.');
  }
  return Object.freeze({
    ...base,
    clientSurface: Object.freeze({ bootstrapUrl, origin: clientOrigin }),
    documentPolicy: runtimeDocumentPolicy(record.documentPolicy),
    kind: 'apps',
    profile: runtimeProfile(record.profile, binding, 'apps'),
    resource: runtimeResource(record.resource),
  }) as unknown as McpAppPreviewSnapshot;
};

const runtimeRequestRecord = (value: unknown): Readonly<Record<string, McpAppJsonValue>> => {
  try {
    return asRecord(detachedJson(value));
  } catch {
    return runtimeInputInvalid();
  }
};

const runtimeCreateRequest = (value: unknown): RuntimeCreateRequest => {
  const record = runtimeRequestRecord(value);
  if (!hasExactKeys(record, ['expectedGenerationId', 'profileId', 'runId'])) runtimeInputInvalid();
  return Object.freeze({
    expectedGenerationId: runtimeText(record.expectedGenerationId, 'runtime generation'),
    profileId: runtimeProfileId(record.profileId),
    runId: runtimeText(record.runId, 'runtime run id'),
  }) as RuntimeCreateRequest;
};

const runtimeOperationRequest = (value: unknown): McpAppBindingOperation => {
  const record = runtimeRequestRecord(value);
  if (record.kind === 'tools/list' || record.kind === 'resources/list') {
    if (!hasExactKeys(record, ['kind'])) runtimeInputInvalid();
    return Object.freeze({ kind: record.kind }) as McpAppBindingOperation;
  }
  if (record.kind === 'resources/read') {
    if (!hasExactKeys(record, ['kind', 'uri'])) runtimeInputInvalid();
    return Object.freeze({ kind: 'resources/read', uri: runtimeText(record.uri, 'resource URI') }) as McpAppBindingOperation;
  }
  if (record.kind === 'tools/call') {
    const consentId = record.consentId;
    if (!hasOnlyKeys(record, ['arguments', 'consentId', 'kind', 'name']) || typeof record.name !== 'string' ||
      (consentId !== undefined && typeof consentId !== 'string')) runtimeInputInvalid();
    return Object.freeze({
      ...(record.arguments === undefined ? {} : { arguments: record.arguments }),
      ...(consentId === undefined ? {} : { consentId: decodeURIComponent(opaqueSegment(runtimeText(consentId, 'consent id'), 'Runtime MCP App consent')) }),
      kind: 'tools/call',
      name: runtimeText(record.name, 'tool name'),
    }) as McpAppBindingOperation;
  }
  return runtimeInputInvalid('Runtime MCP App operation is not supported.');
};

const runtimeConsentRequest = (value: unknown): McpAppConsentRequest => {
  const record = runtimeRequestRecord(value);
  if (!hasExactKeys(record, ['actionFingerprint', 'capability', 'details', 'scope', 'summary']) ||
    !isMcpAppConsentCapability(record.capability) ||
    (record.scope !== 'action' && record.scope !== 'document')) runtimeInputInvalid();
  return Object.freeze({
    actionFingerprint: runtimeText(record.actionFingerprint, 'consent fingerprint'),
    capability: record.capability,
    details: record.details,
    scope: record.scope,
    summary: runtimeText(record.summary, 'consent summary'),
  }) as McpAppConsentRequest;
};

const runtimeConsentResponseRequest = (value: unknown): McpAppConsentRequest => {
  try {
    return runtimeConsentRequest(value);
  } catch {
    return runtimeInvalid('Runtime MCP App route returned an invalid consent challenge.');
  }
};

const runtimeOperationResult = (value: unknown, binding: McpAppPreviewSnapshot): McpAppBoundOperationResult => {
  const record = runtimeRecord(value, ['operationId', 'sessionId', 'sessionRevision', 'value', 'vector']);
  const vector = runtimeVector(record.vector);
  if (record.sessionId !== binding.binding.sessionId || record.sessionRevision !== binding.binding.sessionRevision) {
    runtimeInvalid('Runtime MCP App operation result does not match its binding.');
  }
  return Object.freeze({
    operationId: runtimeText(record.operationId, 'operation id'),
    sessionId: record.sessionId,
    sessionRevision: record.sessionRevision,
    value: record.value,
    vector,
  }) as McpAppBoundOperationResult;
};

const runtimeConsentChallenge = (value: unknown): McpAppConsentCreatedResponse['challenge'] => {
  const record = runtimeRecord(value, ['expiresAt', 'id', 'request']);
  if (!positiveInteger(record.expiresAt)) runtimeInvalid('Runtime MCP App route returned an invalid consent challenge.');
  return Object.freeze({ expiresAt: record.expiresAt, id: decodeURIComponent(opaqueSegment(runtimeText(record.id, 'consent id'), 'Runtime MCP App consent')), request: runtimeConsentResponseRequest(record.request) }) as unknown as McpAppConsentCreatedResponse['challenge'];
};

const runtimeGrant = (
  value: unknown,
  bindingId: string,
  consentId: string,
  challenge: RuntimeConsentChallenge,
): NonNullable<McpAppConsentDecisionResponse['grant']> => {
  const record = runtimeRecord(value, ['authorizationId', 'bindingId', 'capability', 'challengeId', 'scope']);
  if (record.bindingId !== bindingId || record.challengeId !== consentId || record.capability !== challenge.capability || record.scope !== challenge.scope ||
    !isMcpAppConsentCapability(record.capability)) runtimeInvalid('Runtime MCP App route returned an invalid consent grant.');
  return Object.freeze({
    authorizationId: runtimeText(record.authorizationId, 'authorization id'),
    bindingId,
    capability: record.capability,
    challengeId: decodeURIComponent(opaqueSegment(runtimeText(record.challengeId, 'consent id'), 'Runtime MCP App consent')),
    scope: record.scope,
  }) as unknown as NonNullable<McpAppConsentDecisionResponse['grant']>;
};

const trustedDocumentPolicies = new WeakSet<McpAppTrustedDocumentPolicy>();

interface RuntimeAdmission {
  readonly binding?: McpAppPreviewSnapshot;
  readonly bindingGeneration: number | undefined;
  readonly bindingInvalidationEpoch: number;
  readonly bindingId: string | undefined;
  readonly generation: number;
}

interface RuntimeCloseAttempt {
  readonly binding: McpAppPreviewSnapshot;
  readonly bindingGeneration: number;
  readonly bindingId: string;
  dispatched: boolean;
  readonly generation: number;
  manuallyClosed: boolean;
  serverRestarted: boolean;
}

interface RuntimeConsentChallenge {
  readonly binding: McpAppPreviewSnapshot;
  readonly capability: McpAppConsentRequest['capability'];
  readonly id: string;
  readonly scope: 'action' | 'document';
}

const sameDocumentPolicy = (left: McpAppDocumentPolicySnapshot, right: McpAppDocumentPolicySnapshot): boolean => {
  const permissionKeys = ['camera', 'clipboardWrite', 'geolocation', 'microphone'] as const;
  return left.allow === right.allow &&
    left.revision === right.revision &&
    permissionKeys.every((key) => (left.approvedPermissions[key] === undefined) === (right.approvedPermissions[key] === undefined)) &&
    sameDocumentPolicyWarnings(left, right);
};

const sameDocumentPolicyWarnings = (left: McpAppDocumentPolicySnapshot, right: McpAppDocumentPolicySnapshot): boolean =>
  left.warnings.length === right.warnings.length &&
  left.warnings.every((warning, index) => warning.code === right.warnings[index]?.code && warning.value === right.warnings[index]?.value);

const runtimeConsentScope = (capability: McpAppConsentRequest['capability']): 'action' | 'document' =>
  capability === 'camera' || capability === 'clipboard-write' || capability === 'geolocation' || capability === 'microphone'
    ? 'document'
    : 'action';

const runtimePolicyPermission = (capability: McpAppConsentRequest['capability']): 'camera' | 'clipboardWrite' | 'geolocation' | 'microphone' | undefined => {
  if (capability === 'clipboard-write') return 'clipboardWrite';
  if (capability === 'camera' || capability === 'geolocation' || capability === 'microphone') return capability;
  return undefined;
};

const initialDocumentPolicy = (snapshot: McpAppDocumentPolicySnapshot): boolean =>
  snapshot.allow === '' && snapshot.revision === 1 && snapshot.warnings.length === 0 &&
  ['camera', 'clipboardWrite', 'geolocation', 'microphone'].every((key) => snapshot.approvedPermissions[key as keyof typeof snapshot.approvedPermissions] === undefined);

const origin = (value: unknown): string => {
  if (typeof value !== 'string') throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid frame origin.');
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid frame origin.');
  }
  if (parsed.origin !== value || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
    throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid frame origin.');
  }
  return value;
};

const frame = (value: unknown, foregroundOrigin: string): McpAppRelayFrame => {
  const snapshot = asRecord(value);
  const policy = asRecord(snapshot.policy);
  const relay = asRecord(snapshot.relay);
  const documentPolicy = snapshot.documentPolicy === undefined ? undefined : asRecord(snapshot.documentPolicy);
  const documentPolicyAllow = documentPolicy?.allow;
  const documentPolicyRevision = documentPolicy?.revision;
  const parsedDocumentPolicy: McpAppRelayFrame['documentPolicy'] = documentPolicy === undefined ? undefined : (() => {
    if (
      typeof documentPolicyAllow !== 'string' || documentPolicyAllow !== snapshot.allow || !positiveInteger(documentPolicyRevision) ||
      !isRecord(documentPolicy.approvedPermissions) || !Array.isArray(documentPolicy.warnings)
    ) throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid document policy.');
    return Object.freeze({
      allow: documentPolicyAllow,
      approvedPermissions: documentPolicy.approvedPermissions,
      revision: documentPolicyRevision,
      warnings: asArray(documentPolicy.warnings),
    });
  })();
  if (
    typeof snapshot.allow !== 'string' || typeof policy.contentSecurityPolicy !== 'string' || typeof policy.iframeAllow !== 'string' ||
    typeof policy.permissionsPolicy !== 'string' || snapshot.referrerPolicy !== 'no-referrer' ||
    !positiveInteger(relay.maxMessageBytes) || !positiveInteger(relay.maxQueuedMessages) ||
    snapshot.sandbox !== 'allow-scripts allow-same-origin' || typeof snapshot.src !== 'string'
  ) throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid frame.');
  const targetOrigin = origin(snapshot['targetOrigin']);
  if (targetOrigin === foregroundOrigin) {
    throw new McpAppClientError('AB8019', 'Foreground MCP App frame must use a distinct proxy origin.');
  }
  let source: URL;
  try {
    source = new URL(snapshot.src);
  } catch {
    throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid frame.');
  }
  if (source.origin !== targetOrigin) throw new McpAppClientError('AB8019', 'Foreground MCP App frame must use its declared target origin.');
  return Object.freeze({
    allow: snapshot.allow,
    ...(parsedDocumentPolicy === undefined ? {} : { documentPolicy: parsedDocumentPolicy }),
    policy: Object.freeze({
      contentSecurityPolicy: policy.contentSecurityPolicy,
      iframeAllow: policy.iframeAllow,
      permissionsPolicy: policy.permissionsPolicy,
    }),
    referrerPolicy: 'no-referrer',
    relay: Object.freeze({ maxMessageBytes: relay.maxMessageBytes, maxQueuedMessages: relay.maxQueuedMessages }),
    sandbox: 'allow-scripts allow-same-origin',
    src: snapshot.src,
    targetOrigin,
  });
};

const preview = (value: unknown, foregroundOrigin: string): McpAppPreview => {
  const snapshot = asRecord(value);
  if (typeof snapshot.bindingId !== 'string') throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid preview.');
  const bindingId = opaqueSegment(snapshot.bindingId, 'MCP App binding');
  if (snapshot.profile === undefined || snapshot.resource === undefined) {
    throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid preview.');
  }
  return Object.freeze({
    bindingId: decodeURIComponent(bindingId),
    ...(snapshot.frame === undefined ? {} : { frame: frame(snapshot.frame, foregroundOrigin) }),
    profile: snapshot.profile,
    resource: snapshot.resource,
  });
};

const messages = (value: unknown): McpAppRouteMessages => {
  const snapshot = asRecord(value);
  if (typeof snapshot.accepted !== 'boolean') throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid message response.');
  return Object.freeze({ accepted: snapshot.accepted, lifecycle: lifecycle(snapshot.lifecycle), messages: asArray(snapshot.messages) });
};

const close = (value: unknown): McpAppRouteClose => {
  const snapshot = asRecord(value);
  return Object.freeze({
    lifecycle: lifecycle(snapshot.lifecycle),
    ...(snapshot.message === undefined ? {} : { message: snapshot.message }),
  });
};

const closeOptions = (value: Readonly<{ readonly id: McpAppRequestId; readonly reason?: string }>): Readonly<{ readonly id: McpAppRequestId; readonly reason?: string }> => {
  if (!validRequestId(value.id) || (value.reason !== undefined && (typeof value.reason !== 'string' || value.reason.trim().length === 0))) {
    throw new McpAppClientError('AB8016', 'MCP App close options are not valid.');
  }
  return Object.freeze({ id: value.id, ...(value.reason === undefined ? {} : { reason: value.reason }) });
};

const validRequestId = (value: unknown): value is McpAppRequestId =>
  value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));

/** Credential-memory-only browser client for binding-scoped MCP App routes. */
export class McpAppClient implements McpAppRuntimeClient {
  readonly #foreground: ForegroundRouteClient;
  readonly #runtimeCloseAttempts = new Map<string, RuntimeCloseAttempt>();
  readonly #runtimeConsentChallenges = new Map<string, Map<string, RuntimeConsentChallenge>>();
  readonly #invalidations = new Set<(details: McpAppRuntimeInvalidationDetails) => void>();
  readonly #runtimeBindings = new Map<string, McpAppPreviewSnapshot>();
  readonly #runtimeBindingGenerations = new Map<string, number>();
  readonly #runtimePolicies = new Map<string, McpAppTrustedDocumentPolicy>();
  readonly #unsubscribeProjectEvents: (() => void) | undefined;
  #lastRuntimeEventSequence = -1;
  #runtimeBindingInvalidationEpoch = 0;
  #runtimeDisposed = false;
  #runtimeGeneration = 0;

  constructor(options: McpAppClientOptions) {
    this.#foreground = options.foreground;
    this.#unsubscribeProjectEvents = options.projectClient?.subscribeEvents((event) => this.#onProjectEvent(event));
  }

  async createRuntime(request: RuntimeCreateRequest): Promise<McpAppPreviewSnapshot> {
    const submitted = runtimeCreateRequest(request);
    const admission = this.#admitRuntime();
    const foregroundOrigin = await this.#foregroundOrigin();
    this.#assertRuntimeAdmission(admission);
    const response = await this.#json('/api/runtime/apps', {
      body: JSON.stringify(submitted),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }, admission);
    this.#assertRuntimeAdmission(admission);
    const body = runtimeRecord(response, ['preview']);
    const snapshot = runtimePreview(body.preview, foregroundOrigin);
    if (snapshot.binding.runVector.runtimeGenerationId !== submitted.expectedGenerationId || snapshot.binding.profileId !== submitted.profileId) {
      runtimeInvalid('Runtime MCP App preview does not match its create request.');
    }
    if (snapshot.kind === 'apps' && !initialDocumentPolicy(snapshot.documentPolicy)) {
      runtimeInvalid('Runtime MCP App create preview must start with the initial document policy.');
    }
    this.#assertRuntimeCreateAdmission(admission, snapshot.binding.id);
    return this.#installRuntimePreview(snapshot);
  }

  async getRuntime(bindingId: string): Promise<McpAppPreviewSnapshot> {
    const id = decodeURIComponent(opaqueSegment(bindingId, 'Runtime MCP App binding'));
    const admission = this.#admitRuntime(id);
    const foregroundOrigin = await this.#foregroundOrigin();
    this.#assertRuntimeAdmission(admission);
    const response = await this.#json(`/api/runtime/apps/${opaqueSegment(id, 'Runtime MCP App binding')}`, {}, admission);
    this.#assertRuntimeAdmission(admission);
    const body = runtimeRecord(response, ['preview']);
    const snapshot = runtimePreview(body.preview, foregroundOrigin);
    if (snapshot.binding.id !== id) runtimeInvalid('Runtime MCP App preview does not match its requested binding.');
    this.#assertRuntimeAdmission(admission);
    return this.#installRuntimePreview(snapshot);
  }

  async operateRuntime(bindingId: string, operation: McpAppBindingOperation, signal?: AbortSignal): Promise<McpAppBoundOperationResult> {
    const id = decodeURIComponent(opaqueSegment(bindingId, 'Runtime MCP App binding'));
    const admission = this.#admitRuntime(id);
    const binding = admission.binding;
    if (binding === undefined) throw new McpAppClientError('AB8015', 'Runtime MCP App binding is not available.');
    const response = await this.#json(`/api/runtime/apps/${opaqueSegment(id, 'Runtime MCP App binding')}/operations`, {
      body: JSON.stringify(runtimeOperationRequest(operation)),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      ...(signal === undefined ? {} : { signal }),
    }, admission, undefined, true);
    this.#assertRuntimeAdmission(admission);
    const body = runtimeRecord(response, ['result']);
    this.#assertRuntimeAdmission(admission);
    return runtimeOperationResult(body.result, binding);
  }

  async createRuntimeConsent(bindingId: string, request: McpAppConsentRequest, signal?: AbortSignal): Promise<McpAppConsentCreatedResponse> {
    throwIfAborted(signal);
    const id = decodeURIComponent(opaqueSegment(bindingId, 'Runtime MCP App binding'));
    const admission = this.#admitRuntime(id);
    const binding = admission.binding;
    if (binding === undefined) throw new McpAppClientError('AB8015', 'Runtime MCP App binding is not available.');
    const submitted = runtimeConsentRequest(request);
    const response = await this.#json(`/api/runtime/apps/${opaqueSegment(id, 'Runtime MCP App binding')}/consents`, {
      body: JSON.stringify(submitted),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      ...(signal === undefined ? {} : { signal }),
    }, admission);
    throwIfAborted(signal);
    this.#assertRuntimeAdmission(admission);
    const body = runtimeRecord(response, ['challenge', 'documentPolicy']);
    const policy = runtimeDocumentPolicy(body.documentPolicy);
    const challenge = runtimeConsentChallenge(body.challenge);
    const current = this.#runtimePolicies.get(id);
    if (current === undefined || challenge.request.capability !== submitted.capability || challenge.request.scope !== runtimeConsentScope(submitted.capability) ||
      !sameDocumentPolicy(policy, current.snapshot)) runtimeInvalid('Runtime MCP App consent challenge does not match its current authority.');
    this.#assertRuntimeAdmission(admission);
    this.#storeRuntimeConsentChallenge(id, challenge, binding);
    return Object.freeze({ challenge, documentPolicy: policy }) as McpAppConsentCreatedResponse;
  }

  abandonRuntimeConsent(bindingId: string, consentId: string): void {
    const binding = this.#runtimeBindings.get(bindingId);
    if (binding === undefined) return;
    this.#discardRuntimeConsentChallenge(bindingId, consentId, binding);
  }

  async decideRuntimeConsent(
    bindingId: string,
    consentId: string,
    decision: 'allow-once' | 'deny',
    signal?: AbortSignal,
  ): Promise<McpAppConsentDecisionResponse> {
    throwIfAborted(signal);
    const id = decodeURIComponent(opaqueSegment(bindingId, 'Runtime MCP App binding'));
    const admission = this.#admitRuntime(id);
    const binding = admission.binding;
    if (binding === undefined) throw new McpAppClientError('AB8015', 'Runtime MCP App binding is not available.');
    const consent = decodeURIComponent(opaqueSegment(consentId, 'Runtime MCP App consent'));
    if (decision !== 'allow-once' && decision !== 'deny') runtimeInputInvalid('Runtime MCP App consent decision is not valid.');
    const challenge = this.#claimRuntimeConsentChallenge(id, consent, binding);
    const response = await this.#json(`/api/runtime/apps/${opaqueSegment(id, 'Runtime MCP App binding')}/consents/${opaqueSegment(consent, 'Runtime MCP App consent')}`, {
      body: JSON.stringify({ decision }), headers: { 'content-type': 'application/json' }, method: 'POST',
      ...(signal === undefined ? {} : { signal }),
    }, admission);
    throwIfAborted(signal);
    this.#assertRuntimeAdmission(admission);
    const body = runtimeOptionalRecord(response, ['documentPolicy', 'grant']);
    if (!hasExactKeys(body, body.grant === undefined ? ['documentPolicy'] : ['documentPolicy', 'grant'])) runtimeInvalid();
    const policy = runtimeDocumentPolicy(body.documentPolicy);
    if (decision === 'deny' && body.grant !== undefined) runtimeInvalid('Runtime MCP App denied consent must not contain a grant.');
    const grant = body.grant === undefined ? undefined : runtimeGrant(body.grant, id, consent, challenge);
    if (decision === 'allow-once' && grant === undefined) runtimeInvalid('Runtime MCP App approved consent must contain a grant.');
    const current = this.#runtimePolicies.get(id);
    if (current === undefined) throw new McpAppClientError('AB8015', 'Runtime MCP App document policy is not available.');
    if (decision === 'deny' || challenge.scope === 'action') {
      if (!sameDocumentPolicy(policy, current.snapshot)) runtimeInvalid('Runtime MCP App consent decision changed an ineligible document policy.');
    } else {
      if (grant === undefined || !this.#isDocumentPolicyAdvance(current.snapshot, policy, challenge.capability)) {
        runtimeInvalid('Runtime MCP App consent decision did not advance its document policy canonically.');
      }
    }
    this.#assertRuntimeAdmission(admission);
    if (!sameDocumentPolicy(policy, current.snapshot)) this.#installDocumentPolicy(id, policy, binding);
    return Object.freeze({
      documentPolicy: policy,
      ...(grant === undefined ? {} : { grant }),
    }) as McpAppConsentDecisionResponse;
  }

  currentDocumentPolicy(bindingId: string): McpAppTrustedDocumentPolicy {
    const id = decodeURIComponent(opaqueSegment(bindingId, 'Runtime MCP App binding'));
    const policy = this.#runtimePolicies.get(id);
    if (policy === undefined) throw new McpAppClientError('AB8015', 'Runtime MCP App document policy is not available.');
    return policy;
  }

  subscribeInvalidations(listener: (details: McpAppRuntimeInvalidationDetails) => void): () => void {
    if (typeof listener !== 'function') throw new McpAppClientError('AB8016', 'Runtime MCP App invalidation listener is not valid.');
    this.#invalidations.add(listener);
    return () => this.#invalidations.delete(listener);
  }

  async closeRuntime(bindingId: string): Promise<void> {
    const id = decodeURIComponent(opaqueSegment(bindingId, 'Runtime MCP App binding'));
    const attempt = this.#admitRuntimeClose(id);
    try {
      const response = await this.#json(`/api/runtime/apps/${opaqueSegment(id, 'Runtime MCP App binding')}`, { method: 'DELETE' }, undefined, attempt);
      this.#assertRuntimeCloseAdmission(attempt);
      const body = runtimeRecord(response, ['closed']);
      if (body.closed !== true) runtimeInvalid('Runtime MCP App route returned an invalid close response.');
      this.#assertRuntimeCloseAdmission(attempt);
      this.#completeRuntimeClose(attempt);
    } catch (error) {
      if (
        attempt.serverRestarted &&
        (!attempt.dispatched || (error instanceof McpAppClientError && error.code === 'AB8022'))
      ) {
        this.#completeRuntimeClose(attempt);
        return;
      }
      throw error;
    }
  }

  /** Releases the optional shared event subscription and revokes every local runtime authority. */
  disposeRuntime(): void {
    if (this.#runtimeDisposed) return;
    this.#runtimeDisposed = true;
    this.#unsubscribeProjectEvents?.();
    this.#invalidateAll('runtime-shutdown');
  }

  /** Revokes instance-bound runtime authority while keeping the shared project subscription reusable. */
  resetRuntimeForForegroundReplacement(): void {
    if (this.#runtimeDisposed) return;
    this.#lastRuntimeEventSequence = -1;
    this.#invalidateAll('session-restarted');
    this.#runtimeBindingGenerations.clear();
    this.#runtimeBindingInvalidationEpoch = 0;
  }

  async create(sessionId: string, request: McpAppPreviewCreateRequest): Promise<McpAppPreview> {
    const foregroundOrigin = await this.#foregroundOrigin();
    return preview(asRecord(await this.#json(`/api/mcp/sessions/${opaqueSegment(sessionId, 'MCP session')}/apps`, {
      body: JSON.stringify(detachedJson(request)),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })).preview, foregroundOrigin);
  }

  async message(bindingId: string, message: McpAppJsonValue, signal?: AbortSignal): Promise<McpAppRouteMessages> {
    return messages(await this.#json(`${this.#bindingPath(bindingId)}/messages`, {
      body: JSON.stringify({ message: detachedJson(message) }),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
      signal,
    }));
  }

  async consentChallenges(bindingId: string): Promise<readonly McpAppConsentChallenge[]> {
    const body = asRecord(await this.#json(`${this.#bindingPath(bindingId)}/consent`));
    const values = asArray(body.challenges);
    const challenges = values.map((value) => {
      const challenge = asRecord(value);
      if (typeof challenge.id !== 'string' || !positiveInteger(challenge.expiresAt) || challenge.request === undefined) {
        throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid consent challenge.');
      }
      return Object.freeze({ expiresAt: challenge.expiresAt, id: challenge.id, request: challenge.request });
    });
    return Object.freeze(challenges);
  }

  async decideConsent(bindingId: string, challengeId: string, approved: boolean): Promise<McpAppConsentDecision> {
    const foregroundOrigin = await this.#foregroundOrigin();
    opaqueSegment(challengeId, 'MCP App consent challenge');
    if (typeof approved !== 'boolean') throw new McpAppClientError('AB8016', 'MCP App consent decision is not valid.');
    const body = asRecord(await this.#json(`${this.#bindingPath(bindingId)}/consent`, {
      body: JSON.stringify({ approved, challengeId }), headers: { 'content-type': 'application/json' }, method: 'POST',
    }));
    if (typeof body.approved !== 'boolean') throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid consent decision.');
    return Object.freeze({ approved: body.approved, messages: asArray(body.messages), preview: preview(body.preview, foregroundOrigin) });
  }

  async close(bindingId: string, options: Readonly<{ readonly id: McpAppRequestId; readonly reason?: string }>): Promise<McpAppRouteClose> {
    return close(await this.#json(`${this.#bindingPath(bindingId)}/close`, {
      body: JSON.stringify(detachedJson(closeOptions(options))),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    }));
  }

  async forceClose(bindingId: string): Promise<boolean> {
    const response = asRecord(await this.#json(this.#bindingPath(bindingId), { method: 'DELETE' }));
    if (response.closed !== true || response.lifecycle !== 'closed') {
      throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid close response.');
    }
    return true;
  }

  #admitRuntime(bindingId?: string): RuntimeAdmission {
    if (this.#runtimeDisposed) throw new McpAppClientError('AB8015', 'Runtime MCP App client is closed.');
    const admission: RuntimeAdmission = Object.freeze({
      binding: bindingId === undefined ? undefined : this.#runtimeBindings.get(bindingId),
      bindingGeneration: bindingId === undefined ? undefined : this.#runtimeBindingGeneration(bindingId),
      bindingInvalidationEpoch: this.#runtimeBindingInvalidationEpoch,
      bindingId,
      generation: this.#runtimeGeneration,
    });
    return admission;
  }

  #admitRuntimeClose(bindingId: string): RuntimeCloseAttempt {
    const existing = this.#runtimeCloseAttempts.get(bindingId);
    if (existing !== undefined) {
      this.#assertRuntimeCloseAdmission(existing);
      return existing;
    }
    const admission = this.#admitRuntime(bindingId);
    if (admission.binding === undefined || admission.bindingGeneration === undefined) {
      throw new McpAppClientError('AB8015', 'Runtime MCP App binding is not available.');
    }
    const attempt: RuntimeCloseAttempt = {
      binding: admission.binding,
      bindingGeneration: admission.bindingGeneration,
      bindingId,
      dispatched: false,
      generation: admission.generation,
      manuallyClosed: false,
      serverRestarted: false,
    };
    this.#runtimeCloseAttempts.set(bindingId, attempt);
    return attempt;
  }

  #assertRuntimeAdmission(admission: RuntimeAdmission): void {
    if (this.#runtimeDisposed || admission.generation !== this.#runtimeGeneration) {
      throw new McpAppClientError('AB8015', 'Runtime MCP App authority is no longer current.');
    }
    if (admission.bindingId === undefined) return;
    if (admission.bindingGeneration !== this.#runtimeBindingGeneration(admission.bindingId) ||
      this.#runtimeBindings.get(admission.bindingId) !== admission.binding) {
      throw new McpAppClientError('AB8015', 'Runtime MCP App authority is no longer current.');
    }
  }

  #assertRuntimeCreateAdmission(admission: RuntimeAdmission, bindingId: string): void {
    this.#assertRuntimeAdmission(admission);
    if (this.#runtimeBindingGeneration(bindingId) > admission.bindingInvalidationEpoch) {
      throw new McpAppClientError('AB8015', 'Runtime MCP App authority is no longer current.');
    }
  }

  #assertRuntimeCloseAdmission(attempt: RuntimeCloseAttempt): void {
    if (this.#runtimeDisposed || this.#runtimeCloseAttempts.get(attempt.bindingId) !== attempt) {
      throw new McpAppClientError('AB8015', 'Runtime MCP App close authority is no longer current.');
    }
    if (attempt.manuallyClosed || attempt.serverRestarted) return;
    if (attempt.generation !== this.#runtimeGeneration || attempt.bindingGeneration !== this.#runtimeBindingGeneration(attempt.bindingId) ||
      this.#runtimeBindings.get(attempt.bindingId) !== attempt.binding) {
      throw new McpAppClientError('AB8015', 'Runtime MCP App close authority is no longer current.');
    }
  }

  #completeRuntimeClose(attempt: RuntimeCloseAttempt): void {
    this.#runtimeCloseAttempts.delete(attempt.bindingId);
    if (!attempt.manuallyClosed && !attempt.serverRestarted) this.#revokeRuntimeBinding(attempt.bindingId);
  }

  #runtimeBindingGeneration(bindingId: string): number {
    return this.#runtimeBindingGenerations.get(bindingId) ?? 0;
  }

  #advanceRuntimeBinding(bindingId: string): void {
    this.#runtimeBindingInvalidationEpoch += 1;
    this.#runtimeBindingGenerations.set(bindingId, this.#runtimeBindingInvalidationEpoch);
  }

  #storeRuntimeConsentChallenge(bindingId: string, challenge: McpAppConsentCreatedResponse['challenge'], binding: McpAppPreviewSnapshot): void {
    const existing = this.#runtimeConsentChallenges.get(bindingId) ?? new Map<string, RuntimeConsentChallenge>();
    if (existing.has(challenge.id)) runtimeInvalid('Runtime MCP App consent challenge is already current.');
    existing.set(challenge.id, Object.freeze({
      binding,
      capability: challenge.request.capability,
      id: challenge.id,
      scope: challenge.request.scope,
    }));
    this.#runtimeConsentChallenges.set(bindingId, existing);
  }

  #claimRuntimeConsentChallenge(bindingId: string, consentId: string, binding: McpAppPreviewSnapshot): RuntimeConsentChallenge {
    const challenges = this.#runtimeConsentChallenges.get(bindingId);
    const challenge = challenges?.get(consentId);
    if (challenge === undefined || challenge.binding !== binding) {
      throw new McpAppClientError('AB8015', 'Runtime MCP App consent challenge is not available.');
    }
    challenges!.delete(consentId);
    if (challenges!.size === 0) this.#runtimeConsentChallenges.delete(bindingId);
    return challenge;
  }

  #discardRuntimeConsentChallenge(bindingId: string, consentId: string, binding: McpAppPreviewSnapshot): void {
    const challenges = this.#runtimeConsentChallenges.get(bindingId);
    if (challenges?.get(consentId)?.binding !== binding) return;
    challenges.delete(consentId);
    if (challenges.size === 0) this.#runtimeConsentChallenges.delete(bindingId);
  }

  #isDocumentPolicyAdvance(
    current: McpAppDocumentPolicySnapshot,
    next: McpAppDocumentPolicySnapshot,
    capability: McpAppConsentRequest['capability'],
  ): boolean {
    const permission = runtimePolicyPermission(capability);
    if (permission === undefined) return false;
    if (sameDocumentPolicy(current, next)) return current.approvedPermissions[permission] !== undefined;
    if (current.approvedPermissions[permission] !== undefined || next.approvedPermissions[permission] === undefined ||
      next.revision !== current.revision + 1 || !sameDocumentPolicyWarnings(current, next)) return false;
    const keys = ['camera', 'clipboardWrite', 'geolocation', 'microphone'] as const;
    return keys.every((key) => key === permission
      ? current.approvedPermissions[key] === undefined && next.approvedPermissions[key] !== undefined
      : (next.approvedPermissions[key] !== undefined) === (current.approvedPermissions[key] !== undefined));
  }

  #policyForBinding(
    bindingId: string,
    snapshot: McpAppDocumentPolicySnapshot,
    binding: McpAppPreviewSnapshot,
  ): McpAppTrustedDocumentPolicy {
    if (binding.kind !== 'apps') throw new McpAppClientError('AB8019', 'Runtime MCP App fallback does not have a document policy.');
    const resourcePermissions = binding.resource.permissions;
    const allowed = [
      ['camera', 'camera'],
      ['clipboardWrite', 'clipboard-write'],
      ['geolocation', 'geolocation'],
      ['microphone', 'microphone'],
    ] as const;
    const expectedAllow = allowed.filter(([key]) => snapshot.approvedPermissions[key] !== undefined).map(([, directive]) => directive).join('; ');
    if (snapshot.allow !== expectedAllow || allowed.some(([key]) => snapshot.approvedPermissions[key] !== undefined && resourcePermissions?.[key] === undefined)) {
      runtimeInvalid('Runtime MCP App document policy exceeds its bound resource.');
    }
    const current = this.#runtimePolicies.get(bindingId);
    if (current !== undefined) {
      if (snapshot.revision < current.snapshot.revision) runtimeInvalid('Runtime MCP App document policy revision is stale.');
      if (snapshot.revision === current.snapshot.revision) {
        if (sameDocumentPolicy(snapshot, current.snapshot)) return current;
        runtimeInvalid('Runtime MCP App document policy revision conflicts with the current policy.');
      }
    }
    const policy = Object.freeze({ bindingId, snapshot }) as McpAppTrustedDocumentPolicy;
    trustedDocumentPolicies.add(policy);
    return policy;
  }

  #installRuntimePreview(snapshot: McpAppPreviewSnapshot): McpAppPreviewSnapshot {
    const policy = snapshot.kind === 'apps' ? this.#policyForBinding(snapshot.binding.id, snapshot.documentPolicy, snapshot) : undefined;
    this.#runtimeBindings.set(snapshot.binding.id, snapshot);
    if (policy !== undefined) this.#runtimePolicies.set(snapshot.binding.id, policy);
    else this.#runtimePolicies.delete(snapshot.binding.id);
    return snapshot;
  }

  #installDocumentPolicy(bindingId: string, snapshot: McpAppDocumentPolicySnapshot, binding: McpAppPreviewSnapshot): McpAppTrustedDocumentPolicy {
    const policy = this.#policyForBinding(bindingId, snapshot, binding);
    this.#runtimePolicies.set(bindingId, policy);
    return policy;
  }

  #revokeRuntimeBinding(
    bindingId: string,
    details?: McpAppRuntimeInvalidationDetails,
    preserveCloseAttempt = false,
  ): void {
    this.#advanceRuntimeBinding(bindingId);
    const known = this.#runtimeBindings.has(bindingId);
    this.#runtimeBindings.delete(bindingId);
    this.#runtimePolicies.delete(bindingId);
    this.#runtimeConsentChallenges.delete(bindingId);
    if (!preserveCloseAttempt) this.#runtimeCloseAttempts.delete(bindingId);
    if (details === undefined || !known) return;
    for (const listener of [...this.#invalidations]) {
      try {
        listener(details);
      } catch {
        // Invalidation listeners are observers; one cannot retain a revoked binding.
      }
    }
  }

  #invalidateAll(reason: McpAppRuntimeInvalidationDetails['reason']): void {
    this.#runtimeGeneration += 1;
    this.#runtimeCloseAttempts.clear();
    this.#runtimeConsentChallenges.clear();
    const invalidations = [...this.#runtimeBindings.values()].map((snapshot) => Object.freeze({
      bindingId: snapshot.binding.id,
      reason,
      sessionId: snapshot.binding.sessionId,
      sessionRevision: snapshot.binding.sessionRevision,
      state: 'revoked' as const,
    }) as McpAppRuntimeInvalidationDetails);
    for (const details of invalidations) {
      this.#advanceRuntimeBinding(details.bindingId);
      this.#runtimeBindings.delete(details.bindingId);
      this.#runtimePolicies.delete(details.bindingId);
      for (const listener of [...this.#invalidations]) {
        try {
          listener(details);
        } catch {
          // Invalidation listeners are observers; one cannot retain a revoked binding.
        }
      }
    }
  }

  #onProjectEvent(event: ProjectEventMessage): void {
    if (this.#runtimeDisposed) return;
    if (event.type === 'replay.gap') {
      this.#invalidateAll('registry-replay-gap');
      return;
    }
    if (event.type !== 'runtime.event' || event.sequence <= this.#lastRuntimeEventSequence) return;
    this.#lastRuntimeEventSequence = event.sequence;
    const payload = event.payload;
    if (!isRecord(payload) || payload.type !== 'runtime.app.updated') return;
    if (!hasExactKeys(payload, ['details', 'mcpSessionId', 'mcpSessionRevision', 'providerSessionId', 'type'])) {
      this.#invalidateAll('registry-replay-gap');
      return;
    }
    let details: McpAppRuntimeInvalidationDetails;
    try {
      const raw = runtimeRecord(payload.details, ['bindingId', 'reason', 'sessionId', 'sessionRevision', 'state']);
      if (raw.reason !== 'manual-close' && raw.reason !== 'registry-replay-gap' && raw.reason !== 'restart-failed' && raw.reason !== 'runtime-shutdown' && raw.reason !== 'session-closed' && raw.reason !== 'session-restarted' ||
        raw.state !== 'revoked' || !positiveInteger(raw.sessionRevision)) runtimeInvalid('Runtime MCP App invalidation is invalid.');
      const sessionId = runtimeText(raw.sessionId, 'session id');
      if (runtimeText(payload.mcpSessionId, 'MCP session id') !== sessionId ||
        payload.mcpSessionRevision !== raw.sessionRevision || !positiveInteger(payload.mcpSessionRevision) ||
        runtimeText(payload.providerSessionId, 'provider session id').length === 0) runtimeInvalid('Runtime MCP App invalidation does not match its runtime event envelope.');
      details = Object.freeze({
        bindingId: decodeURIComponent(opaqueSegment(runtimeText(raw.bindingId, 'binding id'), 'Runtime MCP App binding')),
        reason: raw.reason,
        sessionId,
        sessionRevision: raw.sessionRevision,
        state: 'revoked',
      }) as McpAppRuntimeInvalidationDetails;
    } catch {
      this.#invalidateAll('registry-replay-gap');
      return;
    }
    const known = this.#runtimeBindings.get(details.bindingId);
    if (known === undefined) {
      this.#revokeRuntimeBinding(details.bindingId);
      return;
    }
    if (known.binding.sessionId !== details.sessionId || known.binding.sessionRevision !== details.sessionRevision) {
      this.#invalidateAll('registry-replay-gap');
      return;
    }
    const attempt = this.#runtimeCloseAttempts.get(details.bindingId);
    const preserveCloseAttempt = attempt !== undefined && attempt.binding === known &&
      ((details.reason === 'manual-close' && attempt.dispatched) || details.reason === 'session-restarted');
    if (preserveCloseAttempt && details.reason === 'manual-close') attempt.manuallyClosed = true;
    if (preserveCloseAttempt && details.reason === 'session-restarted') attempt.serverRestarted = true;
    this.#revokeRuntimeBinding(details.bindingId, details, preserveCloseAttempt);
  }

  async #json(
    path: string,
    init: RequestInit = {},
    admission?: RuntimeAdmission,
    closeAttempt?: RuntimeCloseAttempt,
    runtimeOperation = false,
  ): Promise<unknown> {
    const response = await this.#request(path, init, admission, closeAttempt);
    const body: unknown = runtimeOperation
      ? await runtimeResponseJson(response)
      : await response.json().catch(() => {
        throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid response.');
      });
    if (!response.ok) {
      const detail = diagnostic(body, response.status);
      throw new McpAppClientError(detail.code, detail.message);
    }
    try {
      return detachedJson(body);
    } catch {
      throw new McpAppClientError('AB8019', 'Foreground MCP App route returned an invalid response.');
    }
  }

  async #request(
    path: string,
    init: RequestInit = {},
    admission?: RuntimeAdmission,
    closeAttempt?: RuntimeCloseAttempt,
  ): Promise<Response> {
    if (admission !== undefined) this.#assertRuntimeAdmission(admission);
    if (closeAttempt !== undefined) {
      this.#assertRuntimeCloseAdmission(closeAttempt);
      if (closeAttempt.serverRestarted && !closeAttempt.dispatched) {
        throw new McpAppClientError('AB8022', 'Runtime MCP App preview was revoked.');
      }
    }
    try {
      return await this.#foreground.protectedRequest(
        path,
        init,
        admission === undefined && closeAttempt === undefined ? undefined : () => {
          if (admission !== undefined) this.#assertRuntimeAdmission(admission);
          if (closeAttempt !== undefined) {
            this.#assertRuntimeCloseAdmission(closeAttempt);
            if (closeAttempt.serverRestarted && !closeAttempt.dispatched) {
              throw new McpAppClientError('AB8022', 'Runtime MCP App preview was revoked.');
            }
            closeAttempt.dispatched = true;
          }
        },
      );
    } catch (error) {
      throw this.#foregroundError(error);
    }
  }

  async #foregroundOrigin(): Promise<string> {
    try {
      return await this.#foreground.sessionOrigin();
    } catch (error) {
      throw this.#foregroundError(error);
    }
  }

  #foregroundError(error: unknown): McpAppClientError | unknown {
    if (error instanceof McpAppClientError) return error;
    if (error instanceof ForegroundRouteClientError) return new McpAppClientError(error.code, error.message);
    return error;
  }

  #bindingPath(bindingId: string): string {
    return `/api/mcp/apps/${opaqueSegment(bindingId, 'MCP App binding')}`;
  }
}

/** True only for the current opaque policy handle held by this exact browser client. */
export const isCurrentMcpAppDocumentPolicy = (
  client: Pick<McpAppRuntimeClient, 'currentDocumentPolicy'>,
  value: unknown,
): value is McpAppTrustedDocumentPolicy => {
  if (!isRecord(value) || typeof value.bindingId !== 'string') return false;
  const policy = value as unknown as McpAppTrustedDocumentPolicy;
  if (!trustedDocumentPolicies.has(policy)) return false;
  try {
    return client.currentDocumentPolicy(policy.bindingId) === policy;
  } catch {
    return false;
  }
};

export const assertCurrentMcpAppDocumentPolicy = (
  client: Pick<McpAppRuntimeClient, 'currentDocumentPolicy'>,
  value: unknown,
): McpAppTrustedDocumentPolicy => {
  if (isCurrentMcpAppDocumentPolicy(client, value)) return value;
  throw new McpAppClientError('AB8019', 'Runtime MCP App document policy is no longer current.');
};

export class McpAppClientError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'McpAppClientError';
    this.code = code;
  }
}
