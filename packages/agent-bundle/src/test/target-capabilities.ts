import type * as AgentRuntime from '@agent-bundle/runtime';
import type {
  McpProgressNotificationParams,
  McpRichContentFallback,
  McpRichContentKind,
} from '@agent-bundle/runtime';

import { AgentTestError, captured } from './errors.ts';
import { ROUTE_UNIT_PROOF_LEVEL } from './manifest.ts';
import type { McpContentBlock } from './mcp.ts';
import type { RenderedRouteEvents } from './render.ts';
import type { RenderedRouteProvenance } from './types.ts';

const progressToken = 'agent-bundle-target-capability-fixture';

/**
 * The capabilities one route-unit fixture explicitly advertises. Text is not
 * configurable because MCP text is the projector's always-supported baseline.
 * Progress is separate from document content: it controls whether the real MCP
 * event-stream projector receives a progress token and notification sink.
 */
export interface TargetCapabilityFixtureInput {
  readonly audio: boolean;
  readonly image: boolean;
  readonly progress: boolean;
  readonly resource: boolean;
  readonly richContentFallback: McpRichContentFallback;
}

/**
 * An explicit target-capability fixture for route-unit projection.
 *
 * This is projection-layer proof only. It does not open an MCP transport,
 * start a packed process, or prove that a host accepts any projected block.
 */
export interface TargetCapabilityFixture extends TargetCapabilityFixtureInput {
  readonly proofLevel: typeof ROUTE_UNIT_PROOF_LEVEL;
  readonly text: true;
}

/** The real MCP projector's output plus any progress notifications it emitted. */
export interface TargetCapabilityProjection {
  readonly content: readonly McpContentBlock[];
  readonly isError: boolean;
  readonly progress: readonly McpProgressNotificationParams[];
  readonly provenance: RenderedRouteProvenance;
  readonly structuredContent?: unknown;
}

const booleanCapability = (
  input: TargetCapabilityFixtureInput,
  key: 'audio' | 'image' | 'progress' | 'resource',
): boolean => {
  const value = input[key];
  if (typeof value === 'boolean') return value;
  throw new AgentTestError('invalid-input', 'A target-capability fixture must explicitly advertise or deny every capability.', {
    details: [
      `capability:   ${key}`,
      `received:     ${captured(value)}`,
    ],
    recovery: `Pass ${key}: true or ${key}: false to createTargetCapabilityFixture().`,
  });
};

/**
 * Creates an immutable, explicit fixture. No rich capability defaults to
 * supported: callers must choose every boolean and the fallback policy.
 */
export const createTargetCapabilityFixture = (
  input: TargetCapabilityFixtureInput,
): TargetCapabilityFixture => {
  if (input.richContentFallback !== 'fail' && input.richContentFallback !== 'text') {
    throw new AgentTestError('invalid-input', 'A target-capability fixture requires a real MCP rich-content fallback policy.', {
      details: [`received:     ${captured(input.richContentFallback)}`],
      recovery: 'Pass richContentFallback: "fail" or richContentFallback: "text".',
    });
  }
  return Object.freeze({
    audio: booleanCapability(input, 'audio'),
    image: booleanCapability(input, 'image'),
    progress: booleanCapability(input, 'progress'),
    proofLevel: ROUTE_UNIT_PROOF_LEVEL,
    resource: booleanCapability(input, 'resource'),
    richContentFallback: input.richContentFallback,
    text: true as const,
  });
};

interface Projector {
  readonly projectMcpRenderStream: typeof AgentRuntime.projectMcpRenderStream;
}

let projectorPromise: Promise<Projector> | undefined;

/**
 * The runtime is an optional peer, so the public `agent-bundle/test` entry must
 * remain importable for manifest-only tests without loading it. Projection is
 * the point where the peer becomes required, matching the existing render and
 * in-memory helpers.
 */
const loadProjector = async (): Promise<Projector> => {
  projectorPromise ??= import('@agent-bundle/runtime')
    .then((runtime) => ({ projectMcpRenderStream: runtime.projectMcpRenderStream }))
    .catch((error: unknown) => {
      projectorPromise = undefined;
      throw error;
    });
  return projectorPromise;
};

const eventStream = (
  rendered: RenderedRouteEvents,
): ReadableStream<AgentRuntime.AgentRenderEvent> => new ReadableStream({
  start(controller) {
    for (const event of rendered.events) controller.enqueue(event);
    controller.close();
  },
});

const richProjectionError = (
  error: unknown,
): { readonly code: 'unsupported-rich-content'; readonly kind?: McpRichContentKind } | undefined => {
  if (
    typeof error !== 'object'
    || error === null
    || !('code' in error)
    || error.code !== 'unsupported-rich-content'
  ) return undefined;
  const kind = 'kind' in error && (
    error.kind === 'audio'
    || error.kind === 'image'
    || error.kind === 'resource'
  ) ? error.kind : undefined;
  return { code: 'unsupported-rich-content', ...(kind === undefined ? {} : { kind }) };
};

/**
 * Reprojects a real route render-event stream through the runtime's
 * `projectMcpRenderStream`, using exactly the capabilities and fallback the
 * fixture advertises.
 *
 * Proof level: `route-unit`. The events came from the real Agent renderer and
 * the projection is real, but no MCP transport, packed artifact, or host is
 * involved. A denied rich block either becomes the runtime's exact text
 * placeholder or fails closed; this helper never marks it as accepted.
 */
export const projectTargetCapabilities = async (
  rendered: RenderedRouteEvents,
  fixture: TargetCapabilityFixture,
): Promise<TargetCapabilityProjection> => {
  const progress: McpProgressNotificationParams[] = [];
  try {
    const projector = await loadProjector();
    const projected = await projector.projectMcpRenderStream(eventStream(rendered), {
      capabilities: {
        audio: fixture.audio,
        image: fixture.image,
        resource: fixture.resource,
      },
      richContentFallback: fixture.richContentFallback,
      ...(fixture.progress
        ? {
          progressToken,
          sendProgress: async (params: McpProgressNotificationParams) => {
            progress.push(params);
          },
        }
        : {}),
    });
    return Object.freeze({
      content: Object.freeze(projected.result.content as readonly McpContentBlock[]),
      isError: projected.result.isError === true,
      progress: Object.freeze([...progress]),
      provenance: rendered.provenance,
      ...(projected.result.structuredContent === undefined
        ? {}
        : { structuredContent: projected.result.structuredContent }),
    });
  } catch (error) {
    const richError = richProjectionError(error);
    if (richError !== undefined) {
      throw new AgentTestError(
        'unsupported-rich-content',
        'The target-capability fixture denied rich MCP content and the runtime projector failed closed.',
        {
          cause: error,
          details: [
            `offending kind: ${richError.kind ?? 'unknown'}`,
            `fixture:       ${captured(fixture)}`,
          ],
          provenance: rendered.provenance,
          recovery: richError.kind === undefined
            ? 'Advertise the required rich capability, or choose richContentFallback: "text".'
            : `Advertise ${richError.kind}: true, or choose richContentFallback: "text".`,
        },
      );
    }
    throw new AgentTestError('projection-failed', 'The route-unit target-capability projection failed.', {
      cause: error,
      details: [`cause:        ${error instanceof Error ? error.message : String(error)}`],
      provenance: rendered.provenance,
      recovery: 'Install @agent-bundle/runtime and project a completed renderRouteEvents() result.',
    });
  }
};
