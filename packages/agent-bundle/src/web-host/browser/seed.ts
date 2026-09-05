import type {
  McpAppConsentCapability,
  McpAppJsonValue,
  McpAppProfileId,
} from '../../contracts/mcp-apps.ts';

export const WEB_HOST_SEED_ELEMENT_ID = 'agent-bundle-web-host-seed';

export interface WebHostPageSeed {
  readonly autoApprove: readonly McpAppConsentCapability[];
  readonly input: McpAppJsonValue;
  /** Opaque per-page id of the opening call, set by hosts that serve many pages over one session (dev `/web`). */
  readonly opening?: string;
  /** Fail-closed reason an automatic mutating opening was not repeated. */
  readonly openingNotice?: string;
  readonly previewProfile: McpAppProfileId;
  readonly result: McpAppJsonValue;
  readonly sessionId: string;
  readonly title: string;
  readonly token: string;
  readonly tokenHeader: string;
  readonly toolName: string;
}
