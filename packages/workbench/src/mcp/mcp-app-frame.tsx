import React, { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';

import {
  createMcpAppFrameRelay,
  McpAppFrameRelayError,
  type McpAppFrameRelayRoutes,
} from '../../../agent-bundle/src/web-host/browser/frame-relay.ts';
import type { McpAppJsonValue, McpAppRelayFrame } from './mcp-app-client.ts';
import {
  assertCurrentMcpAppDocumentPolicy,
  type McpAppRuntimeClient,
  type McpAppTrustedDocumentPolicy,
} from './mcp-app-client.ts';
import { AppRenderer, type AppRendererProps, type BridgeFactory } from './app-renderer.tsx';

export interface McpAppFrameProps {
  readonly bindingId: string;
  readonly closeTimeoutMs?: number;
  readonly frame: McpAppRelayFrame;
  readonly onError?: (error: McpAppFrameRelayError) => void;
  readonly resource: McpAppJsonValue;
  readonly routes: McpAppFrameRelayRoutes;
  readonly title?: string;
}

export interface SecureAppRendererProps {
  readonly bindingId: string;
  readonly bootstrapUrl: string;
  readonly bridgeFactory: BridgeFactory;
  readonly documentPolicy: McpAppTrustedDocumentPolicy;
  /** Opaque policy authority; never serialized or passed into the iframe. */
  readonly policyClient: Pick<McpAppRuntimeClient, 'currentDocumentPolicy'>;
  readonly rendererProps: Omit<AppRendererProps, 'bridgeFactory' | 'sandboxPath'>;
}

/** Applies and immediately verifies the non-negotiable outer-frame policy. */
export const applyMcpAppFramePolicy = (
  iframe: HTMLIFrameElement,
  policy: McpAppTrustedDocumentPolicy,
): void => {
  iframe.setAttribute('allow', policy.snapshot.allow);
  iframe.setAttribute('referrerpolicy', 'no-referrer');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  if (
    iframe.getAttribute('allow') !== policy.snapshot.allow ||
    iframe.getAttribute('referrerpolicy') !== 'no-referrer' ||
    iframe.getAttribute('sandbox') !== 'allow-scripts allow-same-origin'
  ) throw new McpAppFrameRelayError('MCP App outer frame policy was not applied.');
};

// AppRenderer starts its bridge in a passive effect. This inert bridge keeps
// the first about:blank commit entirely local while the layout barrier verifies
// the frame attributes; it owns neither a Client nor a runtime binding.
const inertBridgeFactory: BridgeFactory = () => ({
  addEventListener: () => undefined,
  close: async () => undefined,
  sendHostContextChange: async () => undefined,
  sendToolCancelled: async () => undefined,
  sendToolInput: async () => undefined,
  sendToolInputPartial: async () => undefined,
  sendToolResult: async () => undefined,
  teardownResource: async () => Object.freeze({}),
});

/**
 * Renders exactly the official AppRenderer after a synchronous blank-frame
 * policy barrier. A trusted policy handle is deliberately checked during
 * render, before React can create or navigate the iframe.
 */
export const SecureAppRenderer = ({
  bindingId,
  bootstrapUrl,
  bridgeFactory,
  documentPolicy,
  policyClient,
  rendererProps,
}: SecureAppRendererProps): ReactNode => {
  const policy = assertCurrentMcpAppDocumentPolicy(policyClient, documentPolicy);
  if (policy.bindingId !== bindingId) {
    throw new McpAppFrameRelayError('MCP App document policy belongs to another binding.');
  }
  if (policyClient.currentDocumentPolicy(bindingId) !== policy) {
    throw new McpAppFrameRelayError('MCP App document policy is no longer current.');
  }
  let parsed: URL;
  try {
    parsed = new URL(bootstrapUrl);
  } catch {
    throw new McpAppFrameRelayError('MCP App bootstrap URL is invalid.');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new McpAppFrameRelayError('MCP App bootstrap URL is invalid.');
  }

  const policyKey = `${bindingId}:${policy.snapshot.revision}:${bootstrapUrl}`;
  const root = useRef<HTMLDivElement>(null);
  const [armedKey, setArmedKey] = useState<string>();
  const armed = armedKey === policyKey;
  useLayoutEffect(() => {
    const current = assertCurrentMcpAppDocumentPolicy(policyClient, documentPolicy);
    if (
      current !== policy ||
      current.bindingId !== bindingId ||
      current.snapshot.revision !== policy.snapshot.revision
    ) {
      throw new McpAppFrameRelayError('MCP App document policy changed before the frame could arm.');
    }
    const iframe = root.current?.querySelector('iframe');
    if (iframe === null || iframe === undefined) {
      throw new McpAppFrameRelayError('MCP App outer frame is unavailable.');
    }
    applyMcpAppFramePolicy(iframe, current);
    setArmedKey(policyKey);
  }, [bindingId, documentPolicy, policy, policyClient, policyKey]);

  return (
    <div ref={root}>
      <AppRenderer
        {...rendererProps}
        bridgeFactory={armed ? bridgeFactory : inertBridgeFactory}
        key={policyKey}
        sandboxPath={armed ? bootstrapUrl : 'about:blank'}
      />
    </div>
  );
};

/** A browser-owned iframe that receives only the server-issued proxy URL. */
export const McpAppFrame = ({
  bindingId,
  closeTimeoutMs,
  frame,
  onError,
  resource,
  routes,
  title = 'MCP App preview',
}: McpAppFrameProps) => {
  const iframe = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    const current = iframe.current;
    if (current === null) return undefined;
    const relay = createMcpAppFrameRelay({
      bindingId,
      ...(closeTimeoutMs === undefined ? {} : { closeTimeoutMs }),
      frame,
      iframe: current,
      ...(onError === undefined ? {} : { onError }),
      resource,
      routes,
      window,
    });
    relay.start();
    return () => { void relay.close(); };
  }, [bindingId, closeTimeoutMs, frame, onError, resource, routes]);
  return (
    <iframe
      allow={frame.allow}
      ref={iframe}
      referrerPolicy={frame.referrerPolicy}
      sandbox={frame.sandbox}
      src={frame.src}
      title={title}
    />
  );
};
