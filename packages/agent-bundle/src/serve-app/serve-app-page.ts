import type { McpAppJsonValue } from '../dev/mcp-apps/mcp-app-binding-service.ts';
import type { McpAppConsentCapability } from '../dev/mcp-apps/mcp-app-consent.ts';
import type { McpAppProfileId } from '../dev/mcp-app-profile-descriptors.ts';

/**
 * Everything the standalone host document needs to bind its App: the bound
 * session, the tool whose result the App opens with, and the per-launch
 * credential the authenticated MCP App routes require. It is embedded in the
 * document served at `/`, which only this process's loopback origin can read.
 */
export interface ServeAppPageSeed {
  /** Consent capabilities the operator pre-approved when launching the host. */
  readonly autoApprove: readonly McpAppConsentCapability[];
  readonly input: McpAppJsonValue;
  readonly previewProfile: McpAppProfileId;
  readonly result: McpAppJsonValue;
  readonly sessionId: string;
  readonly title: string;
  readonly token: string;
  readonly toolName: string;
}

/** The request header the host document presents on every authenticated route. */
export const SERVE_APP_TOKEN_HEADER = 'x-agent-bundle-serve-app';

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);

/** JSON that is safe inside a `<script>` element: no `<` can terminate the element or open a comment. */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</gu, '\\u003c').replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');

/**
 * The relay running inside the host document. It is the browser half of the
 * Workbench's `McpAppFrameRelay` (`packages/workbench/src/mcp/mcp-app-frame.tsx`)
 * over the same `/api/mcp/...` routes: it forwards the sandbox proxy's
 * `sandbox-proxy-ready` with the server-issued document policy, relays every
 * App frame through `POST /api/mcp/apps/<binding>/messages`, posts the
 * returned host frames back to the proxy, surfaces consent challenges, and
 * force-closes the binding when the page unloads. The document never sees
 * the MCP server; only the bridge on the other side of the routes does.
 */
const HOST_SCRIPT = String.raw`
'use strict';
const seed = JSON.parse(document.getElementById('agent-bundle-serve-app-seed').textContent);
const tokenHeader = ${JSON.stringify(SERVE_APP_TOKEN_HEADER)};
const proxyReadyMethod = 'ui/notifications/sandbox-proxy-ready';
const resourceReadyMethod = 'ui/notifications/sandbox-resource-ready';
const status = document.getElementById('status');
const frameHost = document.getElementById('frame-host');
const consentPanel = document.getElementById('consent');
const consentList = document.getElementById('consent-list');
const fallbackPanel = document.getElementById('fallback');
const fallbackReason = document.getElementById('fallback-reason');
const fallbackInput = document.getElementById('fallback-input');
const fallbackResult = document.getElementById('fallback-result');

const setStatus = (text, tone) => {
  status.textContent = text;
  status.dataset.tone = tone || 'info';
};

const api = async (method, path, body) => {
  const response = await fetch(path, {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      [tokenHeader]: seed.token,
    },
    method,
  });
  const text = await response.text();
  let json;
  try { json = text.length === 0 ? {} : JSON.parse(text); } catch { json = undefined; }
  if (!response.ok) {
    const detail = json && json.diagnostic ? json.diagnostic.code + ': ' + json.diagnostic.message : response.status + ' ' + response.statusText;
    throw new Error(detail);
  }
  return json;
};

const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const isRpc = (value) => isRecord(value) && value.jsonrpc === '2.0' && (typeof value.method === 'string' || Object.hasOwn(value, 'id'));
const byteLength = (value) => {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return Infinity; }
};

const showFallback = (reason, input, result) => {
  frameHost.hidden = true;
  fallbackPanel.hidden = false;
  fallbackReason.textContent = reason;
  fallbackInput.textContent = JSON.stringify(input, null, 2);
  fallbackResult.textContent = JSON.stringify(result, null, 2);
};

const browserHostContext = () => ({
  availableDisplayModes: ['inline'],
  containerDimensions: { height: Math.max(0, window.innerHeight), width: Math.max(0, window.innerWidth) },
  deviceCapabilities: {},
  displayMode: 'inline',
  locale: navigator.language || 'en',
  platform: 'web',
  safeAreaInsets: { bottom: 0, left: 0, right: 0, top: 0 },
  styles: {},
  theme: window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  userAgent: navigator.userAgent || 'unknown',
});

const start = async () => {
  setStatus('Binding ' + seed.toolName + ' to the App…');
  // The host already made the opening call; binding it by tool name keeps a
  // large result from travelling back through the request-body bound (#562).
  const created = await api('POST', '/api/mcp/sessions/' + encodeURIComponent(seed.sessionId) + '/apps', {
    host: browserHostContext(), previewProfile: seed.previewProfile, toolName: seed.toolName,
  });
  const preview = created.preview;
  const bindingId = preview.bindingId;
  const resource = preview.resource;
  let frame = preview.frame;
  if (!frame || !isRecord(resource) || resource.kind !== 'resource' || typeof resource.html !== 'string') {
    const reason = isRecord(resource) && typeof resource.reason === 'string' ? resource.reason : 'no-sandbox-frame';
    showFallback(reason, seed.input, seed.result);
    setStatus('Interactive App rendering is unavailable (' + reason + '); showing the tool result instead.', 'warn');
    return;
  }
  const bindingPath = '/api/mcp/apps/' + encodeURIComponent(bindingId);
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', frame.sandbox);
  iframe.referrerPolicy = frame.referrerPolicy;
  iframe.title = seed.title;
  let state = 'open';
  let resourceProvided = false;
  const queue = [];
  let processing = false;

  const post = (message, enforceLimit) => {
    const target = iframe.contentWindow;
    if (target === null) return false;
    if (enforceLimit !== false && byteLength(message) > frame.relay.maxMessageBytes) return false;
    target.postMessage(message, frame.targetOrigin);
    return true;
  };
  const postAll = (messages) => {
    for (const message of messages) {
      if (isRpc(message) && !post(message)) setStatus('MCP App proxy window is not available.', 'error');
    }
  };
  /** A document-policy revision replaces the sandbox document, exactly as the Workbench remounts its frame. */
  const mount = (nextFrame) => {
    frame = nextFrame;
    resourceProvided = false;
    iframe.allow = frame.allow;
    iframe.src = 'about:blank';
    iframe.src = frame.src;
  };
  const revisionOf = (candidate) => (candidate && candidate.documentPolicy && candidate.documentPolicy.revision) || 0;

  const renderChallenges = (challenges) => {
    consentList.replaceChildren();
    const visible = [];
    for (const challenge of challenges) {
      const capability = challenge.request && challenge.request.capability;
      if (seed.autoApprove.includes(capability)) {
        decide(challenge.id, true);
        continue;
      }
      visible.push(challenge);
    }
    consentPanel.hidden = visible.length === 0;
    for (const challenge of visible) {
      const item = document.createElement('li');
      const summary = document.createElement('span');
      summary.textContent = (challenge.request && challenge.request.summary) || 'Allow MCP App action?';
      const details = document.createElement('code');
      details.textContent = JSON.stringify(challenge.request && challenge.request.details);
      const allow = document.createElement('button');
      allow.type = 'button';
      allow.textContent = 'Allow';
      allow.addEventListener('click', () => decide(challenge.id, true));
      const deny = document.createElement('button');
      deny.type = 'button';
      deny.textContent = 'Deny';
      deny.addEventListener('click', () => decide(challenge.id, false));
      item.append(summary, details, allow, deny);
      consentList.append(item);
    }
  };
  const refreshConsent = async () => {
    if (state === 'closed') return;
    const response = await api('GET', bindingPath + '/consent');
    renderChallenges(response.challenges || []);
  };
  const decide = (challengeId, approved) => {
    api('POST', bindingPath + '/consent', { approved, challengeId })
      .then((response) => {
        if (state === 'closed') return undefined;
        const nextFrame = response.preview && response.preview.frame;
        if (nextFrame && revisionOf(nextFrame) !== revisionOf(frame)) mount(nextFrame);
        else postAll(response.messages || []);
        return refreshConsent();
      })
      .catch((error) => setStatus('Consent decision failed: ' + error.message, 'error'));
  };

  const drain = async () => {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) {
        const message = queue.shift();
        try {
          const response = await api('POST', bindingPath + '/messages', { message });
          if (state === 'closed') return;
          postAll(response.messages || []);
          if (response.lifecycle === 'closed') {
            state = 'closed';
            setStatus('The MCP App binding closed.', 'warn');
            return;
          }
          // A request the bridge answered with nothing is waiting on consent.
          if (Object.hasOwn(message, 'id') && typeof message.method === 'string' && (response.messages || []).length === 0) {
            await refreshConsent();
          }
        } catch (error) {
          setStatus('MCP App relay failed: ' + error.message, 'error');
        }
      }
    } finally {
      processing = false;
    }
  };

  window.addEventListener('message', (event) => {
    if (state === 'closed' || event.source !== iframe.contentWindow || event.origin !== frame.targetOrigin) return;
    const message = event.data;
    if (!isRpc(message) || byteLength(message) > frame.relay.maxMessageBytes) return;
    if (message.method === proxyReadyMethod && !Object.hasOwn(message, 'id')) {
      if (resourceProvided) return;
      resourceProvided = true;
      // The proxy accepts its policy only from this server-issued frame; the
      // resource declaration is never relayed as an authority.
      post({
        jsonrpc: '2.0',
        method: resourceReadyMethod,
        params: { allow: frame.allow, contentSecurityPolicy: frame.policy.contentSecurityPolicy, html: resource.html },
      }, false);
      setStatus('Serving ' + seed.title + ' over the bound session.', 'ok');
      return;
    }
    if (!resourceProvided) return;
    if (queue.length >= frame.relay.maxQueuedMessages) {
      setStatus('MCP App frame relay queue is full.', 'error');
      return;
    }
    queue.push(message);
    void drain();
  });
  window.addEventListener('pagehide', () => {
    if (state === 'closed') return;
    state = 'closed';
    fetch(bindingPath, { headers: { [tokenHeader]: seed.token }, keepalive: true, method: 'DELETE' }).catch(() => undefined);
  });
  frameHost.replaceChildren(iframe);
  frameHost.hidden = false;
  mount(frame);
  await refreshConsent();
};

start().catch((error) => {
  setStatus('MCP App preview failed: ' + error.message, 'error');
  showFallback('preview-error', seed.input, seed.result);
});
`;

const HOST_STYLE = `
:root { color-scheme: light dark; font: 14px/1.4 system-ui, sans-serif; }
html, body { height: 100%; margin: 0; overflow: hidden; }
body { display: flex; flex-direction: column; background: Canvas; color: CanvasText; }
header { align-items: center; border-bottom: 1px solid color-mix(in srgb, CanvasText 15%, transparent); display: flex; gap: 12px; padding: 8px 16px; }
header h1 { font-size: 15px; font-weight: 600; margin: 0; }
#status { color: color-mix(in srgb, CanvasText 70%, transparent); margin: 0; }
#status[data-tone="error"] { color: #c62828; }
#status[data-tone="warn"] { color: #b26a00; }
#status[data-tone="ok"] { color: #2e7d32; }
#consent { background: color-mix(in srgb, #b26a00 12%, Canvas); border-bottom: 1px solid color-mix(in srgb, #b26a00 40%, transparent); margin: 0; padding: 8px 16px; }
#consent h2 { font-size: 13px; margin: 0 0 4px; }
#consent ol { display: flex; flex-direction: column; gap: 4px; list-style: none; margin: 0; padding: 0; }
#consent li { align-items: center; display: flex; flex-wrap: wrap; gap: 8px; }
#consent code { font-size: 12px; opacity: 0.8; overflow: hidden; text-overflow: ellipsis; max-width: 40ch; white-space: nowrap; }
#frame-host { flex: 1; min-height: 0; }
#frame-host iframe { border: 0; display: block; height: 100%; width: 100%; }
#fallback { overflow: auto; padding: 16px; }
#fallback pre { background: color-mix(in srgb, CanvasText 6%, transparent); overflow: auto; padding: 8px; }
`;

/** Renders the standalone MCP App host document for one bound session. */
export const renderServeAppPage = (seed: ServeAppPageSeed): string => [
  '<!doctype html>',
  '<html lang="en">',
  '<head>',
  '<meta charset="utf-8">',
  '<meta name="viewport" content="width=device-width, initial-scale=1">',
  '<meta name="referrer" content="no-referrer">',
  `<title>${escapeHtml(seed.title)}</title>`,
  `<style>${HOST_STYLE}</style>`,
  '</head>',
  '<body>',
  '<header>',
  `<h1>${escapeHtml(seed.title)}</h1>`,
  '<p id="status" role="status" data-tone="info">Starting…</p>',
  '</header>',
  '<section id="consent" aria-label="MCP App consent" hidden>',
  '<h2>This App asks for permission</h2>',
  '<ol id="consent-list"></ol>',
  '</section>',
  '<main id="frame-host" aria-label="MCP App" hidden></main>',
  '<section id="fallback" aria-label="MCP App fallback" hidden>',
  '<p>Interactive App rendering is unavailable (<span id="fallback-reason"></span>). Showing the ordinary tool result instead.</p>',
  '<details open><summary>Tool input</summary><pre id="fallback-input"></pre></details>',
  '<details open><summary>Tool result</summary><pre id="fallback-result"></pre></details>',
  '</section>',
  `<script type="application/json" id="agent-bundle-serve-app-seed">${scriptJson(seed)}</script>`,
  `<script>${HOST_SCRIPT}</script>`,
  '</body>',
  '</html>',
  '',
].join('\n');
