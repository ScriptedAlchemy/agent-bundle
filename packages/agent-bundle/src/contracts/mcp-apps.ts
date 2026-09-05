import type { McpAppJsonValue } from '../dev/mcp-app-metadata.ts';
import type { McpAppBridgeLifecycle } from '../dev/mcp-apps/mcp-app-bridge.ts';

/** Browser-safe MCP App and Runtime App wire contracts used by Workbench. */
export { MCP_APP_PROFILE_DESCRIPTORS } from '../dev/mcp-app-profile-descriptors.ts';
export type { McpAppProfileId } from '../dev/mcp-app-profile-descriptors.ts';
export {
  validateMcpAppDownloadContents,
  validateMcpAppExternalUrl,
  validateMcpAppUiUri,
} from '../dev/mcp-app-action-validation.ts';
export type { McpAppValidatedDownload } from '../dev/mcp-app-action-validation.ts';
export {
  runtimeAppFiniteOrdinaryJsonByteLength,
  runtimeAppMessageLimits,
} from '../dev/runtime-app-message-limits.ts';
export type { McpAppBridgeMessage } from '../dev/mcp-apps/mcp-app-bridge.ts';
export type { McpAppBridgeLifecycle } from '../dev/mcp-apps/mcp-app-bridge.ts';
export type { McpAppJsonValue } from '../dev/mcp-app-metadata.ts';
export type {
  McpAppBoundOperationResult,
  McpAppPublicRuntimeVector,
  McpAppRuntimeBindingSnapshot,
} from '../dev/mcp-app-runtime-binding-service.ts';
export type {
  CreateMcpAppPreviewRequest,
  McpAppBindingOperation,
  McpAppConsentCreatedResponse,
  McpAppConsentDecisionResponse,
  McpAppPreviewAppsSnapshot,
  McpAppPreviewSnapshot,
  McpAppRuntimeInvalidationDetails,
} from '../dev/mcp-app-runtime-preview-service.ts';
export { isMcpAppConsentCapability } from '../dev/mcp-apps/mcp-app-consent.ts';
export type { McpAppConsentCapability } from '../dev/mcp-apps/mcp-app-consent.ts';
export type {
  McpAppConsentChallenge,
  McpAppConsentRequest,
  McpAppDocumentPolicySnapshot,
} from '../dev/mcp-apps/mcp-app-sandbox.ts';

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

export interface McpAppRouteMessages {
  readonly accepted: boolean;
  readonly lifecycle: McpAppBridgeLifecycle;
  readonly messages: readonly McpAppJsonValue[];
}

export interface McpAppRouteClose {
  readonly lifecycle: McpAppBridgeLifecycle;
  readonly message?: McpAppJsonValue;
}
