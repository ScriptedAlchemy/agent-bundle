import { describe, expect, it } from '@rstest/core';

import { WEB_HOST_SEED_ELEMENT_ID, type WebHostPageSeed } from '../src/web-host/browser/seed.ts';
import { renderWebHostPage, WEB_HOST_TOKEN_HEADER, webHostContentSecurityPolicy } from '../src/web-host/page.ts';

/**
 * The shared host document (`web-host/page.ts`) as `agent-bundle serve-app`
 * and `<plugin> web` render it: the seed must survive the `<script>` element
 * it is embedded in whatever the tool result contains, the title must not
 * become markup, and the page script must arrive verbatim.
 */

const seed: WebHostPageSeed = {
  autoApprove: ['call-tool'],
  input: { service: 'compiler' },
  previewProfile: 'portable',
  result: { structuredContent: { service: 'compiler', status: 'healthy' } },
  sessionId: 'session-1',
  title: 'status/status',
  token: 'token-1',
  tokenHeader: WEB_HOST_TOKEN_HEADER,
  toolName: 'show-status',
};

const script = "'use strict';\nconst seed = JSON.parse(document.getElementById('agent-bundle-web-host-seed').textContent);\n";

const seedElementOf = (html: string): string => {
  const match = new RegExp(`<script type="application/json" id="${WEB_HOST_SEED_ELEMENT_ID}">([^<]*)</script>`, 'u').exec(html);
  if (match?.[1] === undefined) throw new Error('The host document carries no seed element.');
  return match[1];
};

describe('renderWebHostPage', () => {
  it('embeds the seed as JSON the page reads back unchanged, and the script verbatim', () => {
    const html = renderWebHostPage({ script, seed });
    expect(html.startsWith('<!doctype html>\n<html lang="en">')).toBe(true);
    expect(JSON.parse(seedElementOf(html))).toEqual(seed);
    expect(html).toContain(`<script>${script}</script>`);
    expect(html).toContain('<title>status/status</title>');
    expect(html).toContain('<h1>status/status</h1>');
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
  });

  it('keeps a hostile tool result from terminating the seed element', () => {
    const hostile = {
      ...seed,
      result: { content: [{ text: '</script><script>alert(1)</script> line\u2028break\u2029 <!-- comment', type: 'text' }] },
      title: 'status/</script>',
    };
    const html = renderWebHostPage({ script, seed: hostile });
    const json = seedElementOf(html);
    // No `<` can appear inside the element, so neither `</script>` nor `<!--` can be tokenized there.
    expect(json).not.toContain('<');
    expect(json).not.toContain('\u2028');
    expect(json).not.toContain('\u2029');
    expect(json).toContain('\\u003c/script>');
    expect(json).toContain('\\u2028');
    expect(JSON.parse(json)).toEqual(hostile);
    // Exactly two script elements: the seed and the page script.
    expect(html.match(/<script[\s>]/gu)).toHaveLength(2);
  });

  it('escapes the title wherever it is rendered as text', () => {
    const html = renderWebHostPage({ script, seed: { ...seed, title: `<b>"status" & 'app'</b>` } });
    expect(html).toContain('<title>&lt;b&gt;&quot;status&quot; &amp; &#39;app&#39;&lt;/b&gt;</title>');
    expect(html).toContain('<h1>&lt;b&gt;&quot;status&quot; &amp; &#39;app&#39;&lt;/b&gt;</h1>');
    expect(html).not.toContain('<b>');
  });

  it('keeps the element ids the page script binds to', () => {
    const html = renderWebHostPage({ script, seed });
    for (const id of ['status', 'frame-host', 'consent', 'consent-list', 'fallback', 'fallback-reason', 'fallback-input', 'fallback-result']) {
      expect(html).toContain(`id="${id}"`);
    }
    expect(html).toContain('<main id="frame-host" aria-label="MCP App" hidden></main>');
  });

  it('refuses a page script that could close its own element', () => {
    expect(() => renderWebHostPage({ script: "document.write('</script><script>alert(1)</script>')", seed }))
      .toThrow(/must not contain "<\/script"/u);
    expect(() => renderWebHostPage({ script: "const s = '</SCRIPT>';", seed })).toThrow(/must not contain "<\/script"/u);
  });
});

describe('webHostContentSecurityPolicy', () => {
  it('frames only the sandbox origin and can itself be framed by no one', () => {
    const policy = webHostContentSecurityPolicy('http://127.0.0.1:4567');
    const directives = policy.split('; ');
    expect(directives).toContain("frame-ancestors 'none'");
    expect(directives).toContain('frame-src http://127.0.0.1:4567');
    expect(directives).toContain("default-src 'none'");
    expect(directives).toContain("connect-src 'self'");
    expect(directives).toContain("base-uri 'none'");
    expect(directives).toContain("form-action 'none'");
    expect(directives).toContain("script-src 'unsafe-inline'");
    expect(directives).toContain("style-src 'unsafe-inline'");
    expect(policy).not.toContain('frame-src http://127.0.0.1:4567 ');
  });
});

it('names the standalone token header the page presents', () => {
  expect(WEB_HOST_TOKEN_HEADER).toBe('x-agent-bundle-web-host');
  expect(WEB_HOST_SEED_ELEMENT_ID).toBe('agent-bundle-web-host-seed');
});
