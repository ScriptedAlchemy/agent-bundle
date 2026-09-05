import type {
  McpAppJsonValue,
  McpAppRelayFrame,
  McpAppRouteClose,
  McpAppRouteMessages,
} from '../../contracts/mcp-apps.ts';
import { isPlainRecord } from '../../contracts/strict-json.ts';
import { isMcpAppConsentCapability } from '../../dev/mcp-apps/mcp-app-consent.ts';
import {
  createMcpAppFrameRelay,
  type McpAppFrameRelay,
  type McpAppFrameRelayRoutes,
} from './frame-relay.ts';
import { WEB_HOST_SEED_ELEMENT_ID, type WebHostPageSeed } from './seed.ts';

interface ConsentChallenge {
  readonly id: string;
  readonly request?: Readonly<{
    readonly capability?: string;
    readonly details?: McpAppJsonValue;
    readonly summary?: string;
  }>;
}

interface Preview {
  readonly bindingId: string;
  readonly frame?: McpAppRelayFrame;
  readonly resource: McpAppJsonValue;
}

interface ConsentDecision {
  readonly messages?: readonly McpAppJsonValue[];
  readonly preview?: Readonly<{ readonly frame?: McpAppRelayFrame }>;
}

const seedElement = document.getElementById(WEB_HOST_SEED_ELEMENT_ID)!;
const seed: WebHostPageSeed = JSON.parse(seedElement.textContent!);
const status = document.getElementById('status')!;
const frameHost = document.getElementById('frame-host')!;
const consentPanel = document.getElementById('consent')!;
const consentList = document.querySelector<HTMLOListElement>('#consent-list')!;
const fallbackPanel = document.getElementById('fallback')!;
const fallbackReason = document.getElementById('fallback-reason')!;
const fallbackInput = document.getElementById('fallback-input')!;
const fallbackResult = document.getElementById('fallback-result')!;

const setStatus = (text: string, tone = 'info'): void => {
  status.textContent = text;
  status.dataset.tone = tone;
};

const api = async <Result>(method: string, path: string, body?: unknown): Promise<Result> => {
  const response = await fetch(path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      [seed.tokenHeader]: seed.token,
    },
    method,
  });
  const text = await response.text();
  let json: unknown;
  try {
    json = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    json = undefined;
  }
  if (!response.ok) {
    const detail = isPlainRecord(json) &&
      isPlainRecord(json.diagnostic) &&
      typeof json.diagnostic.code === 'string' &&
      typeof json.diagnostic.message === 'string'
      ? `${json.diagnostic.code}: ${json.diagnostic.message}`
      : `${response.status} ${response.statusText}`;
    throw new Error(detail);
  }
  return json as Result;
};

const showFallback = (reason: string, input: McpAppJsonValue, result: McpAppJsonValue): void => {
  frameHost.hidden = true;
  fallbackPanel.hidden = false;
  fallbackReason.textContent = reason;
  fallbackInput.textContent = JSON.stringify(input, null, 2);
  fallbackResult.textContent = JSON.stringify(result, null, 2);
};

const browserHostContext = (): McpAppJsonValue => ({
  availableDisplayModes: ['inline'],
  containerDimensions: {
    height: Math.max(0, window.innerHeight),
    width: Math.max(0, window.innerWidth),
  },
  deviceCapabilities: {},
  displayMode: 'inline',
  locale: navigator.language || 'en',
  platform: 'web',
  safeAreaInsets: { bottom: 0, left: 0, right: 0, top: 0 },
  styles: {},
  theme: window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  userAgent: navigator.userAgent || 'unknown',
});

const revisionOf = (frame: McpAppRelayFrame | undefined): number =>
  frame?.documentPolicy?.revision ?? 0;

const start = async (): Promise<void> => {
  setStatus(`Binding ${seed.toolName} to the App…`);
  const created = await api<Readonly<{ readonly preview: Preview }>>(
    'POST',
    `/api/mcp/sessions/${encodeURIComponent(seed.sessionId)}/apps`,
    {
      host: browserHostContext(),
      ...(seed.opening === undefined ? {} : { opening: seed.opening }),
      previewProfile: seed.previewProfile,
      toolName: seed.toolName,
    },
  );
  const preview = created.preview;
  const bindingPath = `/api/mcp/apps/${encodeURIComponent(preview.bindingId)}`;
  let closed = false;

  window.addEventListener('pagehide', () => {
    if (closed) return;
    closed = true;
    fetch(bindingPath, {
      headers: { [seed.tokenHeader]: seed.token },
      keepalive: true,
      method: 'DELETE',
    }).catch(() => undefined);
  });

  if (
    preview.frame === undefined ||
    !isPlainRecord(preview.resource) ||
    preview.resource.kind !== 'resource' ||
    typeof preview.resource.html !== 'string'
  ) {
    const reason = isPlainRecord(preview.resource) && typeof preview.resource.reason === 'string'
      ? preview.resource.reason
      : 'no-sandbox-frame';
    showFallback(reason, seed.input, seed.result);
    setStatus(
      `Interactive App rendering is unavailable (${reason}); showing the tool result instead.`,
      'warn',
    );
    return;
  }

  const resource = preview.resource;
  const iframe = document.createElement('iframe');
  iframe.title = seed.title;
  let frame = preview.frame;
  let relay: McpAppFrameRelay | undefined;
  let refreshConsent: () => Promise<void> = async () => undefined;

  const routes: McpAppFrameRelayRoutes = {
    close: async (_bindingId, options) =>
      api<McpAppRouteClose>('POST', `${bindingPath}/close`, options),
    forceClose: async () => {
      const response = await api<Readonly<{ readonly closed: boolean }>>('DELETE', bindingPath);
      closed = response.closed;
      return response.closed;
    },
    message: async (_bindingId, message) => {
      const response = await api<McpAppRouteMessages>(
        'POST',
        `${bindingPath}/messages`,
        { message },
      );
      if (
        isPlainRecord(message) &&
        Object.hasOwn(message, 'id') &&
        typeof message.method === 'string' &&
        response.messages.length === 0
      ) void refreshConsent();
      if (response.lifecycle === 'closed') {
        closed = true;
        setStatus('The MCP App binding closed.', 'warn');
      }
      return response;
    },
  };

  const reportRelayError = (error: Error): void => {
    setStatus(`MCP App relay failed: ${error.message}`, 'error');
  };

  const mount = (nextFrame: McpAppRelayFrame): void => {
    relay?.detach();
    frame = nextFrame;
    iframe.setAttribute('allow', frame.allow);
    iframe.setAttribute('referrerpolicy', frame.referrerPolicy);
    iframe.setAttribute('sandbox', frame.sandbox);
    iframe.src = 'about:blank';
    relay = createMcpAppFrameRelay({
      bindingId: preview.bindingId,
      frame,
      iframe,
      onError: reportRelayError,
      resource,
      routes,
      window,
    });
    relay.start();
    iframe.src = frame.src;
  };

  const decide = async (challengeId: string, approved: boolean): Promise<void> => {
    try {
      const response = await api<ConsentDecision>('POST', `${bindingPath}/consent`, {
        approved,
        challengeId,
      });
      if (closed) return;
      const nextFrame = response.preview?.frame;
      if (nextFrame !== undefined && revisionOf(nextFrame) !== revisionOf(frame)) mount(nextFrame);
      else if (response.messages !== undefined) relay?.deliverHostMessages(response.messages);
      await refreshConsent();
    } catch (error) {
      setStatus(
        `Consent decision failed: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
    }
  };

  const renderChallenges = (challenges: readonly ConsentChallenge[]): void => {
    consentList.replaceChildren();
    const visible: ConsentChallenge[] = [];
    for (const challenge of challenges) {
      const capability = challenge.request?.capability;
      if (isMcpAppConsentCapability(capability) && seed.autoApprove.includes(capability)) {
        void decide(challenge.id, true);
        continue;
      }
      visible.push(challenge);
    }
    consentPanel.hidden = visible.length === 0;
    for (const challenge of visible) {
      const item = document.createElement('li');
      const summary = document.createElement('span');
      summary.textContent = challenge.request?.summary ?? 'Allow MCP App action?';
      const details = document.createElement('code');
      details.textContent = JSON.stringify(challenge.request?.details);
      const allow = document.createElement('button');
      allow.type = 'button';
      allow.textContent = 'Allow';
      allow.addEventListener('click', () => { void decide(challenge.id, true); });
      const deny = document.createElement('button');
      deny.type = 'button';
      deny.textContent = 'Deny';
      deny.addEventListener('click', () => { void decide(challenge.id, false); });
      item.append(summary, details, allow, deny);
      consentList.append(item);
    }
  };

  refreshConsent = async () => {
    if (closed) return;
    const response = await api<Readonly<{ readonly challenges?: readonly ConsentChallenge[] }>>(
      'GET',
      `${bindingPath}/consent`,
    );
    renderChallenges(response.challenges ?? []);
  };

  window.addEventListener('message', (event) => {
    if (
      closed ||
      event.source !== iframe.contentWindow ||
      event.origin !== frame.targetOrigin ||
      !isPlainRecord(event.data) ||
      event.data.method !== 'ui/notifications/sandbox-proxy-ready' ||
      Object.hasOwn(event.data, 'id')
    ) return;
    setStatus(`Serving ${seed.title} over the bound session.`, 'ok');
  });

  frameHost.replaceChildren(iframe);
  frameHost.hidden = false;
  mount(frame);
  await refreshConsent();
};

void start().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  setStatus(`MCP App preview failed: ${message}`, 'error');
  showFallback('preview-error', seed.input, seed.result);
});
