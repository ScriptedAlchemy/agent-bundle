#!/usr/bin/env node
// Locale drift check for website/docs (issue #590, P2).
//
// Rspress's `languageParity` compares only the SET of `.md`/`.mdx` paths under
// each locale, so a `zh/` page whose code samples, diagnostic codes, tables, or
// section structure fell behind its `en/` twin — or a `_meta.json`/`_nav.json`
// whose entries or link targets diverged — still builds green. This script
// walks every authored `en/**` page (skipping the TypeDoc `api/` tree and the
// four build-time reference copies) and fails when the `zh/` twin is missing,
// has a different number of fenced code blocks, a fence whose code differs
// (comments in `sh`/`bash`/`ts`/`tsx`/`js`/`json` fences are stripped first so
// translated comments do not count; `text`/`md` fences compare verbatim), a
// different set of `ABnnnn` codes, a different table-row count, or an h2/h3
// count that drifts by more than two. `_meta.json`/`_nav.json` must have the
// same entries in the same order with the same `link`/`activeMatch` targets
// modulo the `/zh` locale prefix. No dependencies; Node >= 22.
//
// Usage: node scripts/check-locale-drift.mjs [--root <docs-dir>] [--help]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HEADING_TOLERANCE = 2;
const SOURCE_LOCALE = 'en';
const TARGET_LOCALE = 'zh';
const SKIPPED_DIRS = new Set(['api']);
const GENERATED_PAGES = new Set([
  'reference/hosts.md',
  'reference/events.md',
  'reference/notices.md',
  'reference/diagnostics.md',
]);
const HASH_COMMENT_LANGS = new Set(['sh', 'bash', 'shell', 'zsh']);
const SLASH_COMMENT_LANGS = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonc']);
// Tree listings (`text` fences) annotate entries with a trailing ` # note`;
// only that trailing form is stripped there, the lines themselves compare verbatim.
const TRAILING_HASH_ONLY_LANGS = new Set(['text']);
// Twoslash directives are comments syntactically but change what renders.
const TWOSLASH_DIRECTIVE = /^\s*\/\/\s*(?:---cut|@|\^\?|\^\|)/;
// `/* … */` preceded by whitespace or line start; a glob like `src/**/*.ts` is left alone.
const BLOCK_COMMENT = /(?<=^|\s)\/\*[\s\S]*?\*\//gm;
const TRANSLATED_KEYS = new Set(['text', 'label']);
const LOCALE_PREFIXED_KEYS = new Set(['link', 'activeMatch']);

const usage = `Usage: node scripts/check-locale-drift.mjs [--root <docs-dir>]

Compares every authored ${SOURCE_LOCALE}/ page and _meta.json/_nav.json with its ${TARGET_LOCALE}/ twin.
  --root <dir>  docs root holding ${SOURCE_LOCALE}/ and ${TARGET_LOCALE}/ (default: website/docs)
  --help        print this message`;

const parseArgs = argv => {
  const options = { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs') };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--root') {
      const value = argv[index + 1];
      if (!value) throw new Error('--root requires a directory');
      options.root = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg.startsWith('--root=')) {
      options.root = path.resolve(arg.slice('--root='.length));
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return options;
};

const toPosix = relative => relative.split(path.sep).join('/');

/** Sorted relative paths of every file under `dir` matching `matches`, skipping SKIPPED_DIRS at any depth. */
const walk = (dir, matches, prefix = '') => {
  const found = [];
  if (!fs.existsSync(dir)) return found;
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (SKIPPED_DIRS.has(entry.name)) continue;
      found.push(...walk(path.join(dir, entry.name), matches, relative));
    } else if (matches(entry.name)) {
      found.push(relative);
    }
  }
  return found.sort();
};

const isPage = name => /\.mdx?$/.test(name);
const isMetaFile = name => name === '_meta.json' || name === '_nav.json';

/** Drops comment-only lines and trailing ` # …` / ` // …` comments for the languages that have them. */
const normalizeCodeLine = (line, lang) => {
  if (HASH_COMMENT_LANGS.has(lang)) {
    if (/^\s*#(?!!)/.test(line)) return '';
    return line.replace(/\s+#.*$/, '').trimEnd();
  }
  if (TRAILING_HASH_ONLY_LANGS.has(lang)) return line.replace(/\s+#.*$/, '').trimEnd();
  if (SLASH_COMMENT_LANGS.has(lang)) {
    if (TWOSLASH_DIRECTIVE.test(line)) return line.trimEnd();
    if (/^\s*\/\//.test(line)) return '';
    return line.replace(/\s+\/\/.*$/, '').trimEnd();
  }
  return line.trimEnd();
};

/** The comparable lines of a fence: block comments removed, then each line normalized, blanks dropped. */
const comparableLines = fence => {
  const body = fence.raw.join('\n');
  const stripped = SLASH_COMMENT_LANGS.has(fence.lang) ? body.replace(BLOCK_COMMENT, '') : body;
  return stripped
    .split('\n')
    .map(line => normalizeCodeLine(line, fence.lang))
    .filter(line => line.trim() !== '');
};

/**
 * Splits a page into the facts the twin must share. Fenced blocks are tracked
 * so a `# comment` in a shell fence is not counted as a heading and a `| a |`
 * line inside a text fence is not counted as a table row.
 */
const analyzePage = source => {
  const lines = source.split(/\r?\n/);
  const fences = [];
  let headings = 0;
  let tableRows = 0;
  let open = null;
  let inFrontmatter = lines[0] === '---';
  for (let index = inFrontmatter ? 1 : 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (inFrontmatter) {
      if (line === '---') inFrontmatter = false;
      continue;
    }
    if (open) {
      const close = new RegExp(`^\\s*${open.marker[0]}{${open.marker.length},}\\s*$`);
      if (close.test(line)) {
        open = null;
        continue;
      }
      open.raw.push(line.startsWith(open.indent) ? line.slice(open.indent.length) : line);
      continue;
    }
    const opener = /^(\s*)(`{3,}|~{3,})([^`\s]*)\s*(.*)$/.exec(line);
    if (opener) {
      const info = `${opener[3]} ${opener[4]}`.trim().replace(/\s+/g, ' ');
      open = { indent: opener[1], marker: opener[2], lang: opener[3], info, raw: [] };
      fences.push(open);
      continue;
    }
    if (/^#{2,3}\s+\S/.test(line)) headings += 1;
    if (/^\s*\|.*\|\s*$/.test(line)) tableRows += 1;
  }
  const codes = new Set(source.match(/\bAB\d{4}\b/g) ?? []);
  return {
    fences: fences.map(fence => ({ info: fence.info, lang: fence.lang, lines: comparableLines(fence) })),
    headings,
    tableRows,
    codes,
  };
};

const setDifference = (a, b) => [...a].filter(item => !b.has(item)).sort();

const comparePages = (relative, en, zh, failures) => {
  const fail = message => failures.push(`${SOURCE_LOCALE}/${relative}: ${message}`);
  if (en.fences.length !== zh.fences.length) {
    fail(`fenced code block count differs (en=${en.fences.length}, zh=${zh.fences.length})`);
  } else {
    en.fences.forEach((fence, index) => {
      const twin = zh.fences[index];
      const label = `fence #${index + 1} (${fence.info || 'no language'})`;
      if (fence.info !== twin.info) {
        fail(`${label} info string differs (en=${JSON.stringify(fence.info)}, zh=${JSON.stringify(twin.info)})`);
        return;
      }
      if (fence.lines.length !== twin.lines.length) {
        fail(`${label} line count differs after comment stripping (en=${fence.lines.length}, zh=${twin.lines.length})`);
        return;
      }
      const at = fence.lines.findIndex((line, lineIndex) => line !== twin.lines[lineIndex]);
      if (at !== -1) {
        fail(`${label} code differs at code line ${at + 1} (en=${JSON.stringify(fence.lines[at])}, zh=${JSON.stringify(twin.lines[at])})`);
      }
    });
  }
  const onlyEn = setDifference(en.codes, zh.codes);
  const onlyZh = setDifference(zh.codes, en.codes);
  if (onlyEn.length > 0 || onlyZh.length > 0) {
    fail(`diagnostic code set differs (en=${onlyEn.length ? `+${onlyEn.join(' ')}` : '='}, zh=${onlyZh.length ? `+${onlyZh.join(' ')}` : '='})`);
  }
  if (en.tableRows !== zh.tableRows) {
    fail(`table row count differs (en=${en.tableRows}, zh=${zh.tableRows})`);
  }
  if (Math.abs(en.headings - zh.headings) > HEADING_TOLERANCE) {
    fail(`h2/h3 heading count differs by more than ${HEADING_TOLERANCE} (en=${en.headings}, zh=${zh.headings})`);
  }
};

/** Structural shape of a _meta.json/_nav.json value: translated labels removed, locale prefix stripped from links. */
const shapeOf = (value, locale) => {
  if (Array.isArray(value)) return value.map(item => shapeOf(item, locale));
  if (value && typeof value === 'object') {
    const shaped = {};
    for (const [key, item] of Object.entries(value)) {
      if (TRANSLATED_KEYS.has(key)) continue;
      shaped[key] =
        LOCALE_PREFIXED_KEYS.has(key) && typeof item === 'string' && locale !== SOURCE_LOCALE
          ? item.replace(new RegExp(`^/${locale}(?=/|$)`), '') || '/'
          : shapeOf(item, locale);
    }
    return shaped;
  }
  return value;
};

const compareMeta = (relative, enSource, zhSource, failures) => {
  const fail = message => failures.push(`${SOURCE_LOCALE}/${relative}: ${message}`);
  let en;
  let zh;
  try {
    en = JSON.parse(enSource);
    zh = JSON.parse(zhSource);
  } catch (error) {
    fail(`invalid JSON (${error.message})`);
    return;
  }
  const enShape = JSON.stringify(shapeOf(en, SOURCE_LOCALE), null, 0);
  const zhShape = JSON.stringify(shapeOf(zh, TARGET_LOCALE), null, 0);
  if (enShape === zhShape) return;
  const enEntries = Array.isArray(en) ? en : [en];
  const zhEntries = Array.isArray(zh) ? zh : [zh];
  if (enEntries.length !== zhEntries.length) {
    fail(`entry count differs (en=${enEntries.length}, zh=${zhEntries.length})`);
    return;
  }
  const at = enEntries.findIndex(
    (entry, index) => JSON.stringify(shapeOf(entry, SOURCE_LOCALE)) !== JSON.stringify(shapeOf(zhEntries[index], TARGET_LOCALE)),
  );
  fail(
    `entry ${at + 1} differs in keys, order, or link targets (en=${JSON.stringify(shapeOf(enEntries[at], SOURCE_LOCALE))}, zh=${JSON.stringify(shapeOf(zhEntries[at], TARGET_LOCALE))})`,
  );
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage);
    return;
  }
  const enRoot = path.join(options.root, SOURCE_LOCALE);
  const zhRoot = path.join(options.root, TARGET_LOCALE);
  if (!fs.existsSync(enRoot) || !fs.existsSync(zhRoot)) {
    throw new Error(`${options.root} must contain ${SOURCE_LOCALE}/ and ${TARGET_LOCALE}/`);
  }
  const failures = [];
  const pages = walk(enRoot, isPage).filter(relative => !GENERATED_PAGES.has(toPosix(relative)));
  for (const relative of pages) {
    const twin = path.join(zhRoot, relative);
    if (!fs.existsSync(twin)) {
      failures.push(`${SOURCE_LOCALE}/${relative}: missing ${TARGET_LOCALE}/ twin (en=present, zh=absent)`);
      continue;
    }
    comparePages(relative, analyzePage(fs.readFileSync(path.join(enRoot, relative), 'utf8')), analyzePage(fs.readFileSync(twin, 'utf8')), failures);
  }
  const metaFiles = walk(enRoot, isMetaFile);
  for (const relative of metaFiles) {
    const twin = path.join(zhRoot, relative);
    if (!fs.existsSync(twin)) {
      failures.push(`${SOURCE_LOCALE}/${relative}: missing ${TARGET_LOCALE}/ twin (en=present, zh=absent)`);
      continue;
    }
    compareMeta(relative, fs.readFileSync(path.join(enRoot, relative), 'utf8'), fs.readFileSync(twin, 'utf8'), failures);
  }
  for (const failure of failures.sort()) console.log(failure);
  if (failures.length > 0) {
    console.log(`locale drift: ${failures.length} failure(s) across ${pages.length} page pair(s) and ${metaFiles.length} meta file(s) under ${options.root}`);
    process.exitCode = 1;
    return;
  }
  console.log(`locale drift: 0 failures across ${pages.length} page pair(s) and ${metaFiles.length} meta file(s) under ${options.root}`);
};

try {
  main();
} catch (error) {
  console.error(`check-locale-drift: ${error.message}`);
  process.exitCode = 2;
}
