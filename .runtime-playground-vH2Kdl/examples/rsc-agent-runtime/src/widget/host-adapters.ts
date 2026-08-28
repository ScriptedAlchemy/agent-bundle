export interface HostContext {
  [key: string]: unknown;
  safeAreaInsets?: {
    bottom: number;
    left: number;
    right: number;
    top: number;
  };
}

export interface WidgetStateAdapter {
  kind: 'openai' | 'portable';
  persist(selectedEventId: string): void;
  restore(validEventIds: readonly string[]): string | undefined;
}

type OpenAiCapability = {
  setWidgetState: (state: { selectedEventId: string }) => unknown;
  widgetState: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const portableAdapter: WidgetStateAdapter = {
  kind: 'portable',
  persist: () => undefined,
  restore: () => undefined,
};

const openAiCapability = (host: { openai?: unknown } | undefined): OpenAiCapability | undefined => {
  if (!isRecord(host?.openai)) {
    return undefined;
  }
  const { setWidgetState, widgetState } = host.openai;
  if (typeof setWidgetState !== 'function' || !isRecord(widgetState)) {
    return undefined;
  }
  return { setWidgetState: setWidgetState as OpenAiCapability['setWidgetState'], widgetState };
};

/** Feature-detects documented state methods; no host name or user-agent is inspected. */
export const createWidgetStateAdapter = (host: { openai?: unknown } | undefined): WidgetStateAdapter => {
  const capability = openAiCapability(host);
  if (capability === undefined) {
    return portableAdapter;
  }

  return {
    kind: 'openai',
    persist(selectedEventId) {
      try {
        capability.setWidgetState({ selectedEventId });
      } catch {
        // Host state is an optional presentation enhancement.
      }
    },
    restore(validEventIds) {
      const selectedEventId = capability.widgetState.selectedEventId;
      return typeof selectedEventId === 'string' && validEventIds.includes(selectedEventId)
        ? selectedEventId
        : undefined;
    },
  };
};

const inset = (value: unknown): string => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? `${value}px` : '0px');

export const safeAreaCustomProperties = (context: HostContext | undefined): Record<string, string> => ({
  '--timeline-safe-area-bottom': inset(context?.safeAreaInsets?.bottom),
  '--timeline-safe-area-left': inset(context?.safeAreaInsets?.left),
  '--timeline-safe-area-right': inset(context?.safeAreaInsets?.right),
  '--timeline-safe-area-top': inset(context?.safeAreaInsets?.top),
});
