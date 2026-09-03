import { available, unavailable, type AgentLineage, type Observed } from './agent-request.js';

export type LineageHost = 'claude' | 'codex' | 'cursor';

const nativeString = (native: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = native[key];
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
};

/** Maps a negotiated MCP client name to the host whose lineage vocabulary applies. */
export const lineageHostFromClient = (clientName: string | undefined): LineageHost | undefined => {
  if (clientName === undefined) return undefined;
  if (clientName.startsWith('claude')) return 'claude';
  if (clientName.startsWith('codex')) return 'codex';
  if (clientName.startsWith('cursor')) return 'cursor';
  return undefined;
};

export interface LineageCarrier {
  /** The agent whose activity the payload describes, in the host's own id. */
  readonly conversation: string | undefined;
  readonly generation: string | undefined;
  /** The root the host names on the payload; Cursor names none on a child's events. */
  readonly root: string | undefined;
}

/**
 * Which conversation a native hook payload speaks for. Observed 2026-09-03
 * (`docs/audits/2026-09-03-host-lineage-matrix.md`): Claude and Codex put the
 * subagent in `agent_id` and keep the root in `session_id`; Cursor gives each
 * subagent a fresh `conversation_id` and never repeats the root on it.
 */
export const lineageCarrier = (
  host: LineageHost,
  native: Readonly<Record<string, unknown>>,
): LineageCarrier => {
  switch (host) {
    case 'claude':
      return {
        conversation: nativeString(native, 'agent_id') ?? nativeString(native, 'session_id'),
        generation: nativeString(native, 'prompt_id'),
        root: nativeString(native, 'session_id'),
      };
    case 'codex':
      return {
        conversation: nativeString(native, 'agent_id') ?? nativeString(native, 'session_id'),
        generation: nativeString(native, 'turn_id'),
        root: nativeString(native, 'session_id'),
      };
    case 'cursor':
      return {
        conversation: nativeString(native, 'conversation_id') ?? nativeString(native, 'session_id'),
        generation: nativeString(native, 'generation_id'),
        root: undefined,
      };
    default: {
      const unreachable: never = host;
      throw new Error(`Unhandled lineage host ${String(unreachable)}`);
    }
  }
};

/**
 * Lineage a standalone hook process can state without the registry: Claude and
 * Codex name the root on every payload, so a payload with no `agent_id` is the
 * root itself. Anything subagent-shaped — and every Cursor payload, whose
 * conversation id says nothing about depth — needs the warm runtime.
 */
export const resolveNativeLineage = (
  host: LineageHost,
  native: Readonly<Record<string, unknown>>,
): Observed<AgentLineage> => {
  const carrier = lineageCarrier(host, native);
  if (host === 'cursor' || carrier.conversation === undefined || carrier.root === undefined) {
    return unavailable('no-shared-runtime');
  }
  if (carrier.conversation !== carrier.root) return unavailable('no-shared-runtime');
  return available({
    conversation: carrier.root,
    depth: 0,
    ...(carrier.generation === undefined ? {} : { generation: carrier.generation }),
    resolution: 'native',
    root: carrier.root,
  }, 'native');
};
