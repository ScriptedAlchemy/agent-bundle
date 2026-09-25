import type { McpAppJsonValue } from './mcp-app-binding-service.ts';
import type { McpAppConsentCapability } from './mcp-app-consent.ts';

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
