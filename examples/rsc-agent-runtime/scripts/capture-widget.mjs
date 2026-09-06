/* global URL, document, HTMLElement, getComputedStyle, process */

import { createServer } from 'node:http';
import { access, mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { chromium } from 'playwright-core';

const exec = promisify(execFile);
const exampleRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const appRoot = join(exampleRoot, 'dist', 'app');

const timeline = (stateVersion) => ({
  edits: [
    { eventId: 'concept-1', host: 'claude', path: 'src/runtime/state.ts', recordedAt: '2026-08-14T10:24:31.000Z', sessionId: 'concept', toolName: 'Write' },
    { eventId: 'concept-2', host: 'codex', path: 'src/widget/App.tsx', recordedAt: '2026-08-14T10:21:07.000Z', sessionId: 'concept', toolName: 'Edit' },
    { eventId: 'concept-3', host: 'claude', path: 'README.md', recordedAt: '2026-08-14T10:17:42.000Z', sessionId: 'concept', toolName: 'Read' },
  ],
  stateVersion,
});

const withHeadScript = (html, script) => html.replace('</head>', `<script>${script}</script></head>`);

const openAiBootstrap = `
  window.openai = {
    get widgetState() {
      try { return JSON.parse(sessionStorage.getItem('rsc-agent-runtime-widget-state') || '{}'); } catch { return {}; }
    },
    setWidgetState(state) {
      sessionStorage.setItem('rsc-agent-runtime-widget-state', JSON.stringify(state));
    }
  };
`;

const hostHarness = () => `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body,iframe{width:100%;height:100%;margin:0;border:0;overflow:hidden}</style></head>
<body><iframe title="Claude-compatible MCP Apps host" src="/context-widget.html"></iframe>
<script>
  const snapshot = (stateVersion) => (${JSON.stringify(timeline(3))});
  snapshot(3).stateVersion = 3;
  window.addEventListener('message', (event) => {
    const message = event.data;
    if (!message || message.jsonrpc !== '2.0') return;
    if (message.method === 'ui/initialize') {
      event.source.postMessage({ jsonrpc: '2.0', id: message.id, result: {
        protocolVersion: '2026-01-26',
        hostInfo: { name: 'MCP Apps test bridge', version: '1.0.0' },
        hostCapabilities: {},
        hostContext: {
          theme: 'dark',
          platform: 'mobile',
          styles: { variables: { '--color-background-primary': '#10162a', '--color-border-primary': '#667085', '--color-text-primary': '#ffffff', '--color-text-secondary': '#d9dde7', '--font-mono': 'ui-monospace, monospace' } },
          safeAreaInsets: { top: 12, right: 8, bottom: 16, left: 8 }
        }
      } }, '*');
    } else if (message.method === 'ui/notifications/initialized') {
      event.source.postMessage({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { content: [{ type: 'text', text: JSON.stringify(snapshot(3)) }], structuredContent: snapshot(3) } }, '*');
    } else if (message.method === 'tools/call') {
      const next = snapshot(4); next.stateVersion = 4;
      event.source.postMessage({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: JSON.stringify(next) }], structuredContent: next } }, '*');
    }
  });
</script></body></html>`;

const parseArguments = (argv) => {
  const outputIndex = argv.indexOf('--output');
  const output = outputIndex === -1 ? undefined : argv[outputIndex + 1];
  if (output === undefined || output.trim() === '' || argv.length !== 2) {
    throw new Error('Usage: node scripts/capture-widget.mjs --output <desktop.png>');
  }
  return resolve(output);
};

const findChrome = async () => {
  const candidates = [process.env.CHROME_PATH, 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser'].filter(Boolean);
  for (const candidate of candidates) {
    if (candidate.includes('/')) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    try {
      const { stdout } = await exec('which', [candidate]);
      return stdout.trim();
    } catch {
      // Try the next installed browser name.
    }
  }
  throw new Error('Could not locate an installed Chrome executable. Set CHROME_PATH to use capture:widget.');
};

const sibling = (output, suffix) => {
  const extension = extname(output) || '.png';
  return join(dirname(output), `${output.slice(output.lastIndexOf('/') + 1, -extension.length)}${suffix}${extension}`);
};

const listen = (documents) => new Promise((resolvePromise, reject) => {
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const document = documents.get(path);
    if (document === undefined) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(document);
  });
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (address === null || typeof address === 'string') {
      reject(new Error('Could not allocate a loopback capture port.'));
      return;
    }
    resolvePromise({ port: address.port, server });
  });
});

const closeServer = (server) => new Promise((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())));

const waitForState = async (pageOrFrame, version) => {
  await pageOrFrame.waitForFunction(
    (expected) => document.querySelector('footer')?.textContent === `State version ${expected}`,
    version,
  );
};

const run = async () => {
  const output = parseArguments(process.argv.slice(2));
  await mkdir(dirname(output), { recursive: true });
  const [standalone, editTimeline] = await Promise.all([
    readFile(join(appRoot, 'standalone.html'), 'utf8'),
    readFile(join(appRoot, 'edit-timeline-v1.html'), 'utf8'),
  ]);
  const chrome = await findChrome();
  const documents = new Map([
    ['/standalone.html', standalone],
    ['/openai.html', withHeadScript(standalone, openAiBootstrap)],
    ['/context-widget.html', editTimeline],
  ]);
  const listener = await listen(documents);
  documents.set('/claude-context.html', hostHarness());
  const baseUrl = `http://127.0.0.1:${listener.port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath: chrome, headless: true });
    const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await desktop.goto(`${baseUrl}/standalone.html`);
    await waitForState(desktop, 3);
    await desktop.screenshot({ path: output });
    await desktop.getByRole('button', { name: 'Refresh' }).click();
    await waitForState(desktop, 4);

    const mobilePath = sibling(output, '-mobile');
    const mobile = await browser.newPage({ viewport: { width: 360, height: 640 } });
    await mobile.goto(`${baseUrl}/standalone.html`);
    await waitForState(mobile, 3);
    await mobile.screenshot({ path: mobilePath });

    const openAiPath = sibling(output, '-openai');
    const openAi = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await openAi.goto(`${baseUrl}/openai.html`);
    await waitForState(openAi, 3);
    await openAi.locator('.timeline__event').nth(1).click();
    await openAi.waitForFunction(() => document.querySelectorAll('.timeline__event')[1]?.getAttribute('aria-pressed') === 'true');
    await openAi.reload();
    await waitForState(openAi, 3);
    await openAi.waitForFunction(() => document.querySelectorAll('.timeline__event')[1]?.getAttribute('aria-pressed') === 'true');
    await openAi.screenshot({ path: openAiPath });

    const contextPath = sibling(output, '-claude-context');
    const context = await browser.newPage({ viewport: { width: 360, height: 640 } });
    await context.goto(`${baseUrl}/claude-context.html`);
    const frame = context.frames().find((candidate) => candidate.url().endsWith('/context-widget.html'));
    if (frame === undefined) {
      throw new Error('Claude-compatible host fixture did not load its MCP Apps frame.');
    }
    await waitForState(frame, 3);
    await frame.getByRole('button', { name: 'Refresh' }).click();
    await waitForState(frame, 4);
    const contextProof = await frame.evaluate(() => {
      const timeline = document.querySelector('.timeline');
      const refresh = document.querySelector('button');
      if (!(timeline instanceof HTMLElement) || !(refresh instanceof HTMLElement)) throw new Error('Expected timeline controls.');
      const computed = getComputedStyle(timeline);
      const box = refresh.getBoundingClientRect();
      return {
        horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
        nestedVerticalOverflow: computed.overflowY === 'auto' || computed.overflowY === 'scroll',
        refreshHeight: box.height,
        refreshWidth: box.width,
        safeAreaTop: computed.getPropertyValue('--timeline-safe-area-top').trim(),
        theme: document.documentElement.getAttribute('data-theme'),
      };
    });
    if (
      contextProof.horizontalOverflow ||
      contextProof.nestedVerticalOverflow ||
      contextProof.refreshWidth < 44 ||
      contextProof.refreshHeight < 44 ||
      contextProof.safeAreaTop !== '12px' ||
      contextProof.theme !== 'dark'
    ) {
      throw new Error('Claude-compatible host fixture did not apply safe areas, styles, or usable Refresh sizing.');
    }
    await context.screenshot({ path: contextPath });

    process.stdout.write(`${JSON.stringify({
      claudeContext: contextPath,
      desktop: output,
      mobile: mobilePath,
      openai: openAiPath,
      refreshChangedVersion: true,
      restoredOpenAiSelection: true,
    })}\n`);
  } finally {
    await browser?.close();
    await closeServer(listener.server);
  }
};

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
