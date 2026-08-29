import type { CallToolResult, Tool } from '@modelcontextprotocol/client';
import React, {
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  type Ref,
  type RefObject,
} from 'react';

/**
 * First-party MCP App renderer, adapted from the MCP Inspector's AppRenderer
 * (modelcontextprotocol/inspector 672f9f41, MIT). The Workbench previously
 * vendored the Inspector; only this renderer survived the removal, retyped
 * against the shapes the preview pipeline compiles against. The Workbench has
 * no design-token system, so the host advertises no styles - apps use their
 * own defaults, which the ext-apps spec permits - and the theme derives from
 * the system color scheme.
 */

export type McpAppRendererDisplayMode = 'fullscreen' | 'inline' | 'pip';

export type McpAppRendererJsonArray = readonly McpAppRendererJsonValue[];

export interface McpAppRendererJsonObject {
  readonly [key: string]: McpAppRendererJsonValue;
}

export type McpAppRendererJsonValue =
  | null
  | boolean
  | number
  | string
  | McpAppRendererJsonArray
  | McpAppRendererJsonObject;

export type McpAppRendererTool = Tool;

export interface McpAppRendererMessage {
  readonly content: readonly McpAppRendererJsonValue[];
  readonly role: 'user';
}

export interface McpAppRendererHostContext {
  readonly availableDisplayModes?: readonly McpAppRendererDisplayMode[];
  readonly containerDimensions?: Readonly<{ readonly height: number; readonly width: number }>;
  readonly displayMode?: McpAppRendererDisplayMode;
  readonly theme?: 'dark' | 'light';
}

export interface AppRendererBridge {
  addEventListener(type: 'initialized', listener: () => void): void;
  addEventListener(type: 'loggingmessage', listener: (params: Readonly<{ readonly data: McpAppRendererJsonValue; readonly level: string; readonly logger?: string }>) => void): void;
  addEventListener(type: 'sizechange', listener: (params: Readonly<{ readonly height?: number; readonly width?: number }>) => void): void;
  close(): Promise<void>;
  onmessage?: (params: McpAppRendererMessage) => Promise<Readonly<{ readonly isError?: true }>>;
  onrequestdisplaymode?: (params: Readonly<{ readonly mode: McpAppRendererDisplayMode }>) => Promise<Readonly<{ readonly mode: McpAppRendererDisplayMode }>>;
  sendHostContextChange(context: Partial<McpAppRendererHostContext>): Promise<void>;
  sendToolCancelled(params: Readonly<{ readonly reason: string }>): Promise<void>;
  sendToolInput(params: Readonly<{ readonly arguments: Record<string, McpAppRendererJsonValue> }>): Promise<void>;
  sendToolInputPartial(params: Readonly<{ readonly arguments: Record<string, McpAppRendererJsonValue> }>): Promise<void>;
  sendToolResult(result: CallToolResult): Promise<void>;
  teardownResource(params: Readonly<Record<string, never>>): Promise<Readonly<Record<string, never>>>;
}

/**
 * Constructs the bridge for a freshly mounted sandbox iframe. Wrap with
 * `useCallback` (or hoist out of render) - the renderer treats a new factory
 * identity as a signal to tear down the current bridge and rebuild, so an
 * unstable factory will thrash the iframe on every render.
 */
export type BridgeFactory = (
  iframe: HTMLIFrameElement,
  tool: McpAppRendererTool,
) => AppRendererBridge | Promise<AppRendererBridge>;

export interface AppRendererHandle {
  sendToolCancelled(reason: string): Promise<void>;
  sendToolInput(args: Record<string, McpAppRendererJsonValue>): Promise<void>;
  sendToolResult(result: CallToolResult): Promise<void>;
  teardown(): Promise<void>;
}

/**
 * High-level lifecycle of a running app, surfaced so a host (or an automated
 * driver polling a `data-app-status` attribute) can wait for the right moment:
 * `loading` while the bridge is being built and the view's `ui/initialize`
 * handshake is in flight; `ready` once the view has fired
 * `notifications/initialized`; `error` when the bridge factory throws or
 * rejects (no live view to wait on).
 */
export type AppRendererStatus = 'error' | 'loading' | 'ready';

export interface AppRendererProps {
  readonly bridgeFactory: BridgeFactory;
  /**
   * Current host display mode for the app frame. Pushed to the running view
   * whenever it changes (e.g. Maximize/Restore), so an app can adapt its
   * layout to inline vs fullscreen.
   */
  readonly displayMode?: McpAppRendererDisplayMode;
  readonly onAppStatusChange?: (status: AppRendererStatus) => void;
  readonly onError?: (error: Error) => void;
  /** Called for each MCP log notification the running view emits. */
  readonly onLog?: (params: Readonly<{ readonly data: McpAppRendererJsonValue; readonly level: string; readonly logger?: string }>) => void;
  /**
   * Called when the running view submits a user-role message via
   * `ui/message`. The renderer returns the spec-required empty result on the
   * host's behalf, so the callback is fire-and-forget.
   */
  readonly onMessage?: (params: McpAppRendererMessage) => void;
  /**
   * Handles a view-originated `ui/request-display-mode`. Return the mode the
   * host actually applied - the spec lets the host decline an unsupported
   * mode by returning its current one.
   */
  readonly onRequestDisplayMode?: (requested: McpAppRendererDisplayMode) => McpAppRendererDisplayMode;
  /** Reports the view's rendered content size so the host can fit the frame. */
  readonly onSizeChange?: (size: Readonly<{ readonly height?: number; readonly width?: number }>) => void;
  /**
   * Ordered tool-input fragments to replay before the complete `tool-input`,
   * exercising widgets that render progressively. Captured at bridge-build
   * time so prop churn never rebuilds the iframe.
   */
  readonly partialInputs?: readonly Readonly<Record<string, McpAppRendererJsonValue>>[];
  /**
   * The host-controlled box the app renders within, used to derive
   * `hostContext.containerDimensions`. This MUST be an element whose size is
   * driven by the host's layout and NOT by the view's own size reports -
   * otherwise the two signals couple into a feedback loop. Falls back to the
   * iframe element when omitted.
   */
  readonly containerRef?: RefObject<HTMLElement | null>;
  readonly ref?: Ref<AppRendererHandle>;
  readonly sandboxPath: string;
  readonly tool: McpAppRendererTool;
}

const currentTheme = (): 'dark' | 'light' =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

const measureContainerDimensions = (
  element: HTMLElement,
): Readonly<{ readonly height: number; readonly width: number }> | undefined => {
  if (typeof element.getBoundingClientRect !== 'function') return undefined;
  const rect = element.getBoundingClientRect();
  const width = Math.round(rect.width);
  const height = Math.round(rect.height);
  if (width <= 0 || height <= 0) return undefined;
  return { height, width };
};

/**
 * Read the live host UI state for the bridge handshake - the single place
 * that decides which fields the host seeds. Optional fields are omitted (not
 * set undefined) so the bridge's diff stays accurate; subsequent live changes
 * are pushed by the renderer's observers as partial host-context changes. The
 * seed assumes the app opens inline; the live displayMode push carries any
 * subsequent inline-fullscreen transition.
 */
export const snapshotHostContext = (
  container: HTMLElement | null,
  availableDisplayModes: readonly McpAppRendererDisplayMode[],
): McpAppRendererHostContext => {
  const containerDimensions = container === null ? undefined : measureContainerDimensions(container);
  return {
    availableDisplayModes: [...availableDisplayModes],
    ...(containerDimensions === undefined ? {} : { containerDimensions }),
    displayMode: 'inline',
    theme: currentTheme(),
  };
};

const toError = (value: unknown): Error => value instanceof Error ? value : new Error(String(value));

const disposeBridge = async (bridge: AppRendererBridge): Promise<void> => {
  // Best-effort: still close the transport even if teardownResource fails,
  // otherwise the iframe unmount would leak MessagePort listeners.
  try {
    await bridge.teardownResource({});
  } catch {
    /* swallow - closing transport below is the load-bearing step */
  }
  try {
    await bridge.close();
  } catch {
    /* swallow - already disposing */
  }
};

/**
 * Bridge lifecycle (the interlocking refs below):
 *
 *   mount -> build (buildId++) -> factory(iframe, tool) -async-> bridgeRef set
 *                                                               | on "initialized"
 *                                                               v -> flushPending
 *   cleanup -> scheduleDispose() --microtask--> dispose (unless cancelled)
 *                     ^                                  |
 *                     +-- re-setup with SAME inputs -----+  cancel + REUSE bridge
 *
 * - `buildId` (monotonic): a bridge resolved from an older build self-disposes.
 * - `disposeScheduled`: a dispose is queued (microtask); a synchronous
 *   re-setup (StrictMode double-invoke, or a transient re-render) cancels it
 *   and reuses the live bridge instead of rebuilding (rebuild double-loads
 *   the sandbox and races the app handshake). A re-setup with CHANGED inputs
 *   disposes + rebuilds.
 * - `lastDeps`: distinguishes "same inputs -> reuse" from "changed -> rebuild".
 * - `initialized`: gates flushing buffered input/result until the view is ready.
 * - `pendingInput`/`pendingResult`: latest-wins buffer for host-initiated open.
 * - `teardownStarted`: makes the imperative teardown() idempotent vs unmount.
 */
export const AppRenderer = ({
  bridgeFactory,
  containerRef,
  displayMode,
  onAppStatusChange,
  onError,
  onLog,
  onMessage,
  onRequestDisplayMode,
  onSizeChange,
  partialInputs,
  ref,
  sandboxPath,
  tool,
}: AppRendererProps): React.ReactNode => {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const bridgeRef = useRef<AppRendererBridge | null>(null);
  const initializedRef = useRef(false);
  const pendingPartialsRef = useRef<readonly Readonly<Record<string, McpAppRendererJsonValue>>[]>([]);
  const pendingInputRef = useRef<Record<string, McpAppRendererJsonValue> | null>(null);
  const pendingResultRef = useRef<CallToolResult | null>(null);
  const teardownStartedRef = useRef(false);
  const buildIdRef = useRef(0);
  const disposeScheduledRef = useRef(false);
  const lastDepsRef = useRef<Readonly<{
    bridgeFactory: BridgeFactory;
    sandboxPath: string;
    tool: McpAppRendererTool;
  }> | null>(null);
  const onErrorRef = useRef(onError);
  const onAppStatusChangeRef = useRef(onAppStatusChange);
  const onSizeChangeRef = useRef(onSizeChange);
  const displayModeRef = useRef(displayMode);
  const onRequestDisplayModeRef = useRef(onRequestDisplayMode);
  const onMessageRef = useRef(onMessage);
  const onLogRef = useRef(onLog);
  const partialInputsRef = useRef(partialInputs);
  useEffect(() => {
    onErrorRef.current = onError;
    onAppStatusChangeRef.current = onAppStatusChange;
    onSizeChangeRef.current = onSizeChange;
    displayModeRef.current = displayMode;
    onRequestDisplayModeRef.current = onRequestDisplayMode;
    onMessageRef.current = onMessage;
    onLogRef.current = onLog;
    partialInputsRef.current = partialInputs;
  });

  // Flush buffered tool input/result to the view, but only once the bridge
  // exists AND the view has signalled `initialized`. The spec requires tool
  // input/result to arrive after initialization, yet a host-initiated open
  // fires before the iframe's app has loaded - so the latest values buffer
  // and release when the view is ready. Input is always sent before result.
  const flushPending = useCallback(() => {
    const bridge = bridgeRef.current;
    if (bridge === null || !initializedRef.current) return;
    for (const args of pendingPartialsRef.current) {
      void bridge.sendToolInputPartial({ arguments: { ...args } });
    }
    pendingPartialsRef.current = [];
    if (pendingInputRef.current !== null) {
      const args = pendingInputRef.current;
      pendingInputRef.current = null;
      void bridge.sendToolInput({ arguments: args });
    }
    if (pendingResultRef.current !== null) {
      const result = pendingResultRef.current;
      pendingResultRef.current = null;
      void bridge.sendToolResult(result);
    }
  }, []);

  // Dispose the live bridge, but deferred to a microtask. React StrictMode
  // runs effects setup->cleanup->setup synchronously in dev; deferring lets
  // the re-setup cancel the disposal and keep the SAME bridge, instead of
  // tearing it down and rebuilding. A rebuild here spins up a second
  // transport that re-posts sandbox-resource-ready (the sandbox loads the app
  // twice) and races the app's ui/initialize handshake.
  const scheduleDispose = useCallback(() => {
    disposeScheduledRef.current = true;
    queueMicrotask(() => {
      if (!disposeScheduledRef.current) return;
      disposeScheduledRef.current = false;
      buildIdRef.current += 1;
      const bridge = bridgeRef.current;
      bridgeRef.current = null;
      initializedRef.current = false;
      lastDepsRef.current = null;
      pendingPartialsRef.current = [];
      if (bridge !== null) void disposeBridge(bridge);
    });
  }, []);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (iframe === null) return undefined;

    const previous = lastDepsRef.current;
    const sameInputs =
      previous !== null &&
      previous.bridgeFactory === bridgeFactory &&
      previous.sandboxPath === sandboxPath &&
      previous.tool === tool;

    // A disposal scheduled by the immediately-preceding cleanup means this is
    // a synchronous re-setup. If the inputs are identical (StrictMode's
    // double-invoke, or a transient re-render) keep the live bridge: cancel
    // the disposal and re-deliver any buffered input/result to it.
    /* v8 ignore next 4 -- StrictMode's replayed effect body is invisible to coverage. */
    if (disposeScheduledRef.current && sameInputs) {
      disposeScheduledRef.current = false;
      flushPending();
      return scheduleDispose;
    }

    // Otherwise this is a real (re)build. If a disposal was pending (inputs
    // changed), run it synchronously before building the replacement.
    if (disposeScheduledRef.current) {
      disposeScheduledRef.current = false;
      buildIdRef.current += 1;
      const old = bridgeRef.current;
      bridgeRef.current = null;
      initializedRef.current = false;
      if (old !== null) void disposeBridge(old);
    }

    lastDepsRef.current = { bridgeFactory, sandboxPath, tool };
    const buildId = buildIdRef.current + 1;
    buildIdRef.current = buildId;
    teardownStartedRef.current = false;
    initializedRef.current = false;
    onAppStatusChangeRef.current?.('loading');
    // Snapshot the staged partial-input fragments for THIS bridge build (read
    // via the ref so the prop is not a dep - adding/removing fragments must
    // not rebuild the iframe).
    pendingPartialsRef.current = [...(partialInputsRef.current ?? [])];

    let pending: Promise<AppRendererBridge>;
    try {
      pending = Promise.resolve(bridgeFactory(iframe, tool));
    } catch (error) {
      onAppStatusChangeRef.current?.('error');
      onErrorRef.current?.(toError(error));
      return scheduleDispose;
    }

    pending
      .then((bridge) => {
        if (buildIdRef.current !== buildId) {
          void disposeBridge(bridge);
          return;
        }
        bridgeRef.current = bridge;
        // Registered before the inner app can finish loading, so the view's
        // `initialized` signal is never missed.
        bridge.addEventListener('initialized', () => {
          initializedRef.current = true;
          onAppStatusChangeRef.current?.('ready');
          // The factory already seeded theme/displayMode into the handshake
          // hostContext; only containerDimensions can plausibly differ
          // between bridge construction and initialization (layout settles).
          const container = containerRef?.current ?? iframeRef.current;
          const containerDimensions = container === null ? undefined : measureContainerDimensions(container);
          if (containerDimensions !== undefined) {
            void bridge.sendHostContextChange({ containerDimensions });
          }
          flushPending();
        });
        bridge.addEventListener('sizechange', (size) => {
          onSizeChangeRef.current?.(size);
        });
        bridge.addEventListener('loggingmessage', (params) => {
          onLogRef.current?.(params);
        });
        // Handle ui/request-display-mode: the host decides what mode actually
        // applies. With no handler the request is declined by returning the
        // current host-side mode.
        bridge.onrequestdisplaymode = async ({ mode }) => {
          const handler = onRequestDisplayModeRef.current;
          const applied = handler === undefined ? (displayModeRef.current ?? 'inline') : handler(mode);
          return { mode: applied };
        };
        // Handle ui/message: surface the submitted content and return the
        // spec-required empty result. With no handler the submission is
        // declined by returning isError.
        bridge.onmessage = async (params) => {
          const handler = onMessageRef.current;
          if (handler === undefined) return { isError: true };
          handler(params);
          return {};
        };
        flushPending();
      })
      .catch((error: unknown) => {
        if (buildIdRef.current !== buildId) return;
        onAppStatusChangeRef.current?.('error');
        onErrorRef.current?.(toError(error));
      });

    return scheduleDispose;
    // `containerRef` is listed for exhaustive-deps completeness, but a change
    // to its identity does NOT force a rebuild: the `sameInputs` check above
    // ignores it, and the `initialized` handler reads `containerRef?.current`
    // lazily. The other deps are the real rebuild keys.
  }, [
    bridgeFactory,
    sandboxPath,
    tool,
    containerRef,
    flushPending,
    scheduleDispose,
  ]);

  // Theme: the Workbench has no theme system of its own, so the system color
  // scheme is the only live theme signal; forward changes to the running view
  // once it has initialized.
  useEffect(() => {
    if (typeof window === 'undefined' || window.matchMedia === undefined) return undefined;
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (): void => {
      if (!initializedRef.current) return;
      void bridgeRef.current?.sendHostContextChange({ theme: currentTheme() });
    };
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);

  // Container size: observes the host-controlled container (or the iframe as
  // a fallback) - NOT an element whose height is driven by the view's own
  // size reports, which would couple the two signals into a feedback loop.
  // Gated on the view's `initialized` signal; a 0x0 (not-yet-laid-out)
  // measurement and a value-equal repeat are both skipped.
  useEffect(() => {
    const target = containerRef?.current ?? iframeRef.current;
    if (typeof ResizeObserver === 'undefined' || target === null) return undefined;
    let last: Readonly<{ readonly height: number; readonly width: number }> | undefined;
    const observer = new ResizeObserver(() => {
      if (!initializedRef.current) return;
      const next = measureContainerDimensions(target);
      if (next === undefined) return;
      if (last !== undefined && last.width === next.width && last.height === next.height) return;
      last = next;
      void bridgeRef.current?.sendHostContextChange({ containerDimensions: next });
    });
    observer.observe(target);
    return () => observer.disconnect();
  }, [containerRef]);

  // Display mode: pushes whenever the prop changes (Maximize/Restore). Gated
  // on `initialized` for the same reason as the other host-context pushes.
  useEffect(() => {
    if (displayMode === undefined) return;
    if (!initializedRef.current) return;
    void bridgeRef.current?.sendHostContextChange({ displayMode });
  }, [displayMode]);

  useImperativeHandle(
    ref,
    () => ({
      async sendToolCancelled(reason) {
        const bridge = bridgeRef.current;
        if (bridge === null) return;
        await bridge.sendToolCancelled({ reason });
      },
      async sendToolInput(args) {
        // Buffered (latest-wins) and released by flushPending once the view
        // is initialized - the handle may be invoked before the bridge
        // resolves.
        pendingInputRef.current = args;
        flushPending();
      },
      async sendToolResult(result) {
        pendingResultRef.current = result;
        flushPending();
      },
      async teardown() {
        const bridge = bridgeRef.current;
        if (bridge === null || teardownStartedRef.current) return;
        teardownStartedRef.current = true;
        // Null the ref synchronously so a concurrent unmount cleanup cannot
        // see a still-live bridge and dispose it a second time. Bumping the
        // build id makes any in-flight factory self-dispose, and clearing the
        // pending-dispose flag/cached deps prevents the deferred dispose from
        // acting on an already torn-down bridge.
        buildIdRef.current += 1;
        disposeScheduledRef.current = false;
        lastDepsRef.current = null;
        bridgeRef.current = null;
        initializedRef.current = false;
        pendingInputRef.current = null;
        pendingResultRef.current = null;
        await disposeBridge(bridge);
      },
    }),
    [flushPending],
  );

  // The iframe deliberately has no `sandbox` attribute: `sandboxPath`
  // resolves to the host's own trusted same-origin sandbox page, which then
  // loads the untrusted MCP App content into a nested sandboxed iframe.
  // Sandboxing this outer frame would block the postMessage bridge.
  return (
    <iframe
      ref={iframeRef}
      src={sandboxPath}
      style={{ border: 0, display: 'block', height: '100%', width: '100%' }}
      title={tool.title ?? tool.name}
    />
  );
};
