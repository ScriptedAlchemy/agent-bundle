import { WEB_HOST_SEED_ELEMENT_ID, type WebHostPageSeed } from './browser/seed.ts';

/** Shared header for a standalone host's per-launch credential. */
export const WEB_HOST_TOKEN_HEADER = 'x-agent-bundle-web-host';

export interface RenderWebHostPageOptions {
  readonly script: string;
  readonly seed: WebHostPageSeed;
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);

/** JSON that is safe inside a `<script>` element: no `<` can terminate the element or open a comment. */
const scriptJson = (value: unknown): string =>
  JSON.stringify(value).replace(/</gu, '\\u003c').replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029');

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

/**
 * The host document's Content-Security-Policy. `frame-ancestors` does not
 * inherit from `default-src`: without it, a page on another origin could
 * frame this consent-bearing document on a fixed `--port` and clickjack its
 * Allow/Deny controls. Only the sandbox proxy's origin may be framed.
 */
export const webHostContentSecurityPolicy = (sandboxOrigin: string): string => [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  `frame-src ${sandboxOrigin}`,
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
].join('; ');

export const renderWebHostPage = ({ script, seed }: RenderWebHostPageOptions): string => {
  if (/<\/script/iu.test(script)) throw new Error('The web host page script must not contain "</script".');
  return [
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
    `<script type="application/json" id="${WEB_HOST_SEED_ELEMENT_ID}">${scriptJson(seed)}</script>`,
    `<script>${script}</script>`,
    '</body>',
    '</html>',
    '',
  ].join('\n');
};
