import type { McpSessionInspectorConfig } from '../../../agent-bundle/src/contracts/mcp-session.ts';
import { isHttpUrl } from '../client-helpers.ts';
import { deepFreeze } from '../freeze.ts';

export type McpInspectorLaunchPhase = 'idle' | 'starting' | 'ready' | 'error';

export interface McpInspectorLaunchDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface McpInspectorLaunchModel {
  /** Present only while `phase === 'error'`. */
  readonly diagnostic?: McpInspectorLaunchDiagnostic;
  readonly phase: McpInspectorLaunchPhase;
  /** The Inspector's tokenized base URL; present only while `phase === 'ready'`. */
  readonly url?: string;
}

export type McpInspectorLaunchEvent =
  | Readonly<{ readonly type: 'launch' }>
  | Readonly<{ readonly type: 'running'; readonly url: string }>
  | Readonly<{ readonly type: 'stopped' }>
  | Readonly<{ readonly diagnostic: McpInspectorLaunchDiagnostic; readonly type: 'failed' }>;

const idleModel: McpInspectorLaunchModel = Object.freeze({ phase: 'idle' });
const startingModel: McpInspectorLaunchModel = Object.freeze({ phase: 'starting' });

export const createMcpInspectorLaunchModel = (): McpInspectorLaunchModel => idleModel;

/**
 * Pure launch-state reducer. Every result is frozen, and a transition that
 * would not change the model returns the same object so the controller can
 * skip publishing it.
 */
export const reduceMcpInspectorLaunch = (
  model: McpInspectorLaunchModel,
  event: McpInspectorLaunchEvent,
): McpInspectorLaunchModel => {
  switch (event.type) {
    case 'launch':
      return model.phase === 'starting' ? model : startingModel;
    case 'running':
      if (model.phase === 'ready' && model.url === event.url) return model;
      return Object.freeze({ phase: 'ready', url: event.url });
    case 'stopped':
      // A launch in flight owns the outcome; a stale status poll must not reset it.
      if (model.phase === 'starting' || model.phase === 'idle') return model;
      return idleModel;
    case 'failed':
      if (
        model.phase === 'error'
        && model.diagnostic?.code === event.diagnostic.code
        && model.diagnostic.message === event.diagnostic.message
      ) return model;
      return deepFreeze({
        diagnostic: { code: event.diagnostic.code, message: event.diagnostic.message },
        phase: 'error',
      });
    default: {
      const exhaustive: never = event;
      throw new TypeError(`Unknown MCP Inspector launch event: ${String(exhaustive)}`);
    }
  }
};

/**
 * Inspector 2.x deep link (`serverUrl`, `transport`, `autoConnect`). Only a
 * `streamable-http` session can be pre-connected; Inspector 2.x no longer
 * spawns a process from a URL, so the link never carries a command, its
 * arguments, a working directory, or environment.
 */
export const mcpInspectorDeepLink = (inspectorUrl: string, config: McpSessionInspectorConfig | undefined): string => {
  let url: URL;
  try {
    url = new URL(inspectorUrl);
  } catch {
    return inspectorUrl;
  }
  const token = url.searchParams.get('MCP_INSPECTOR_API_TOKEN');
  if (
    config?.launch.kind === 'streamable-http'
    && token !== null && token.length > 0
    && isHttpUrl(config.launch.url)
  ) {
    url.searchParams.set('serverUrl', config.launch.url);
    url.searchParams.set('transport', 'http');
    url.searchParams.set('autoConnect', token);
  }
  return url.href;
};
