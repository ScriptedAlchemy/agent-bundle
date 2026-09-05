#!/usr/bin/env node
// Post-build link and anchor check over website/doc_build (issue #590, P2).
//
// Rspress's dead-link and dead-anchor checks inspect only mdast link/definition/
// image nodes, so frontmatter `hero.actions[].link`/`features[].link`, `_nav.json`
// links, raw `<a href>` in Markdown, `<Link href>` JSX, and every generated page
// (TypeDoc, the reference copies) are unchecked — and with the persistent Rspack
// cache a dead anchor into an unchanged page passes on a warm build. This walks
// the emitted HTML one file at a time, resolves every site-internal `href`/`src`
// (plus `og:url`/`og:image` content, canonical/alternate links, and sitemap
// `<loc>`s) to a file under doc_build honouring `cleanUrls`, and requires every
// `#fragment` on an HTML target to name an `id` in that file. The llms.txt and
// `.md` copies are build assets that resolve like any other file. No dependencies.
//
// Usage: node scripts/check-built-links.mjs [--dir <doc_build>] [--help]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = '/agent-bundle/';
const ORIGIN = 'https://scriptedalchemy.github.io';
const TAG = /<(a|link|script|img|source|iframe|meta)\b([^>]*)>/gi;
const ATTRIBUTE = /([a-zA-Z:-]+)\s*=\s*"([^"]*)"/g;
const ID = /\s(?:id|name)="([^"]*)"/g;
const SKIPPED_SCHEMES = /^(?:mailto:|javascript:|tel:|data:|https?:\/\/|\/\/)/i;

const usage = `Usage: node scripts/check-built-links.mjs [--dir <doc_build>]
  --dir <dir>  built site to walk (default: website/doc_build)
  --help       print this message`;

const parseArgs = argv => {
  const options = { dir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'doc_build') };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--help' || argv[index] === '-h') return { help: true };
    if (argv[index] === '--dir' && argv[index + 1]) options.dir = path.resolve(argv[(index += 1)]);
    else if (argv[index].startsWith('--dir=')) options.dir = path.resolve(argv[index].slice(6));
    else throw new Error(`unknown argument: ${argv[index]}`);
  }
  return options;
};

const walk = dir =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .flatMap(entry => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));

const decode = value => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};
const unescapeHtml = value => value.replace(/&amp;/g, '&').replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"');

/** URLs named by a page: `href`/`src` of the interesting tags, `og:url`/`og:image` meta content, sitemap `<loc>`s. */
const collectUrls = (file, html) => {
  const urls = [];
  if (file.endsWith('.xml')) for (const [, loc] of html.matchAll(/<loc>([^<]*)<\/loc>/g)) urls.push(loc);
  else
    for (const [, tag, rawAttributes] of html.matchAll(TAG)) {
      const attributes = Object.fromEntries([...rawAttributes.matchAll(ATTRIBUTE)].map(([, name, value]) => [name.toLowerCase(), value]));
      if (tag.toLowerCase() === 'meta') {
        if (/^og:(?:url|image)$/.test(attributes.property ?? '') && attributes.content) urls.push(attributes.content);
      } else {
        for (const key of ['href', 'src']) if (attributes[key]) urls.push(attributes[key]);
      }
    }
  return urls.map(unescapeHtml);
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return void console.log(usage);
  if (!fs.existsSync(path.join(options.dir, 'index.html'))) throw new Error(`${options.dir} has no index.html; build the site first`);
  const files = walk(options.dir).filter(file => file.endsWith('.html') || file.endsWith('sitemap.xml'));
  const idsByFile = new Map();
  const idsOf = file => {
    if (!idsByFile.has(file)) idsByFile.set(file, new Set([...fs.readFileSync(file, 'utf8').matchAll(ID)].map(([, id]) => decode(id))));
    return idsByFile.get(file);
  };
  const existsCache = new Map();
  const isFile = file => {
    if (!existsCache.has(file)) existsCache.set(file, fs.existsSync(file) && fs.statSync(file).isFile());
    return existsCache.get(file);
  };
  /**
   * cleanUrls resolution: verbatim file, then `x.html`, then `x/index.html`. A
   * candidate that escapes doc_build (`/agent-bundle/../package.json`, or an
   * encoded `..`) is not a page even when the file exists on disk.
   */
  const insideBuild = file => file.startsWith(`${options.dir}${path.sep}`);
  const resolveTarget = pathname => {
    const relative = decode(pathname.slice(BASE.length)).replace(/^\/+/, '');
    const candidates = relative === '' || relative.endsWith('/') ? [`${relative}index.html`] : [relative, `${relative}.html`, `${relative}/index.html`];
    return candidates.map(candidate => path.resolve(options.dir, candidate)).find(file => insideBuild(file) && isFile(file)) ?? null;
  };
  const broken = new Map();
  let links = 0;
  let anchors = 0;
  for (const file of files) {
    const html = fs.readFileSync(file, 'utf8');
    const pagePath = `/${path.relative(options.dir, file).split(path.sep).join('/')}`;
    if (file.endsWith('.html')) idsByFile.set(file, new Set([...html.matchAll(ID)].map(([, id]) => decode(id))));
    for (const raw of collectUrls(file, html)) {
      let url = raw.trim();
      if (url === '' || url === '#') continue;
      if (url.startsWith(ORIGIN)) url = url.slice(ORIGIN.length) || '/';
      if (SKIPPED_SCHEMES.test(url)) continue;
      links += 1;
      const hash = url.indexOf('#');
      const fragment = hash === -1 ? '' : decode(url.slice(hash + 1));
      let pathname = (hash === -1 ? url : url.slice(0, hash)).replace(/\?.*$/, '');
      if (pathname === '' && fragment === '') continue;
      if (pathname !== '' && !pathname.startsWith('/')) pathname = path.posix.resolve(path.posix.dirname(`${BASE}${pagePath.slice(1)}`), pathname);
      const target = pathname === '' ? file : pathname.startsWith(BASE) ? resolveTarget(pathname) : null;
      const key = pathname === '' ? `${pagePath}${url}` : url;
      const report = reason => {
        if (!broken.has(key)) broken.set(key, `${key} — ${reason} (e.g. in ${pagePath})`);
      };
      if (target === null) {
        report(pathname.startsWith(BASE) ? 'no file under doc_build' : `outside the ${BASE} base`);
        continue;
      }
      if (fragment === '' || !target.endsWith('.html')) continue;
      anchors += 1;
      if (!idsOf(target).has(fragment)) report(`no id="${fragment}" in ${path.relative(options.dir, target)}`);
    }
  }
  for (const line of [...broken.values()].sort()) console.log(line);
  console.log(`${broken.size} broken links / ${anchors} anchors checked (${links} internal links across ${files.length} files under ${options.dir})`);
  if (broken.size > 0) process.exitCode = 1;
};

try {
  main();
} catch (error) {
  console.error(`check-built-links: ${error.message}`);
  process.exitCode = 2;
}
