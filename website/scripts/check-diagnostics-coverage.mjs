#!/usr/bin/env node
// Diagnostics contract coverage check (issue #590, P1 companion).
//
// `docs/diagnostics.md` is the diagnostics contract and the site's
// `reference/diagnostics` page is a build-time copy of it, but nothing verified
// that every code a reader meets is actually documented there: the family
// catch-all rows (`AB42xx`, `AB474x`/`AB4750`) describe an area, not a code, so
// a page could cite `AB4204` and the compiler could emit `AB6005` while the
// contract said nothing about either. This script parses the contract into the
// explicitly documented codes — a `` `ABnnnn` `` at the start of a table row or
// heading, or an explicit `` `ABnnnn`–`ABmmmm` `` range at the start of a table
// row (en dash, hyphen, or em dash) — and fails when (a) a code cited in an
// authored `website/docs/{en,zh}/**/*.mdx` page (the TypeDoc `api/` tree is
// skipped) or (b) a code literal in `packages/agent-bundle/src/**/*.ts`
// (tests excluded; `--no-src` skips this strict rule) is not covered.
//
// Usage: node scripts/check-diagnostics-coverage.mjs [--repo-root <dir>] [--src|--no-src] [--help]

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTRACT = path.join('docs', 'diagnostics.md');
const DOCS_ROOTS = [path.join('website', 'docs', 'en'), path.join('website', 'docs', 'zh')];
const SOURCE_ROOT = path.join('packages', 'agent-bundle', 'src');
const CODE = /\bAB\d{4}\b/g;
const EXPLICIT_CODE = /^`AB(\d{4})`$/;
const EXPLICIT_RANGE = /^`AB(\d{4})`\s*[–—-]\s*`AB(\d{4})`$/;
const FAMILY_WILDCARD = /^`AB[\dx]{0,3}x+`$/i;
const LOCALES = ['en', 'zh'];

const usage = `Usage: node scripts/check-diagnostics-coverage.mjs [--repo-root <dir>] [--src|--no-src]

Requires every ABnnnn code cited in website/docs/{en,zh}/**/*.mdx — and, unless --no-src,
every ABnnnn literal in packages/agent-bundle/src/**/*.ts — to be explicitly documented in
docs/diagnostics.md (a code or code range at the start of a table row, or a code heading).
  --repo-root <dir>  repository root (default: two levels above this script)
  --src / --no-src   include or skip the source-literal rule (default: --src)
  --help             print this message`;

const parseArgs = argv => {
  const options = { repoRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'), src: true };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--src') options.src = true;
    else if (arg === '--no-src') options.src = false;
    else if (arg === '--repo-root' && argv[index + 1]) options.repoRoot = path.resolve(argv[(index += 1)]);
    else if (arg.startsWith('--repo-root=')) options.repoRoot = path.resolve(arg.slice('--repo-root='.length));
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
};

/** Sorted files under `dir` accepted by `keep(relativePosixPath, name)`, pruning directories `keep` rejects. */
const walk = (dir, keep, prefix = '') => {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name, 'en'))
    .flatMap(entry => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!keep(relative, entry.name, entry.isDirectory())) return [];
      return entry.isDirectory() ? walk(path.join(dir, entry.name), keep, relative) : [path.join(dir, entry.name)];
    });
};

/**
 * The explicitly documented codes. A table row's first cell may list several
 * items separated by `,` or `/`; a row whose first cell names a family wildcard
 * (`AB42xx`, `AB474x`/`AB4750`) is a catch-all and documents nothing.
 */
const parseContract = source => {
  const codes = new Set();
  const ranges = [];
  let explicitRows = 0;
  const addRange = (from, to) => {
    ranges.push(`AB${from}–AB${to}`);
    for (let code = Number(from); code <= Number(to); code += 1) codes.add(`AB${String(code).padStart(4, '0')}`);
  };
  for (const line of source.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(`AB\d{4}`(?:\s*[–—-]\s*`AB\d{4}`)?)(?=\s|$)/.exec(line);
    const items = heading ? [heading[1]] : line.startsWith('|') ? (line.split('|')[1] ?? '').trim().split(/\s*[,/]\s*/) : [];
    if (items.length === 0 || items.some(item => FAMILY_WILDCARD.test(item))) continue;
    const parsed = items.map(item => EXPLICIT_CODE.exec(item) ?? EXPLICIT_RANGE.exec(item));
    if (parsed.some(match => match === null)) continue;
    explicitRows += 1;
    for (const match of parsed) {
      if (match.length === 2) codes.add(`AB${match[1]}`);
      else addRange(match[1], match[2]);
    }
  }
  return { codes, ranges, explicitRows };
};

/** Every distinct code literal across `files`, with the first file that cites it. */
const collectCodes = files => {
  const cited = new Map();
  for (const file of files) {
    for (const code of fs.readFileSync(file, 'utf8').match(CODE) ?? []) if (!cited.has(code)) cited.set(code, file);
  }
  return cited;
};

const isAuthoredPage = (relative, name, isDirectory) => (isDirectory ? name !== 'api' : name.endsWith('.mdx'));
const isSourceModule = (relative, name, isDirectory) =>
  isDirectory ? name !== 'tests' && name !== '__tests__' : name.endsWith('.ts') && !/\.(?:test|spec)\.ts$/.test(name);

const familyOf = code => `${code.slice(0, 4)}xx`;

const reportUncovered = (label, cited, covered, repoRoot) => {
  const uncovered = [...cited.keys()].filter(code => !covered.has(code)).sort();
  if (uncovered.length === 0) {
    console.log(`${label}: ${cited.size} distinct code(s) cited, all documented`);
    return 0;
  }
  console.log(`${label}: ${uncovered.length} of ${cited.size} distinct code(s) not documented in ${CONTRACT}:`);
  const byFamily = new Map();
  for (const code of uncovered) byFamily.set(familyOf(code), [...(byFamily.get(familyOf(code)) ?? []), code]);
  for (const [family, codes] of [...byFamily].sort()) {
    console.log(`  ${family}: ${codes.map(code => `${code} (${path.relative(repoRoot, cited.get(code)).split(path.sep).join('/')})`).join(', ')}`);
  }
  return uncovered.length;
};

const main = () => {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) return void console.log(usage);
  const contractPath = path.join(options.repoRoot, CONTRACT);
  if (!fs.existsSync(contractPath)) throw new Error(`${contractPath} not found; pass --repo-root`);
  const { codes, ranges, explicitRows } = parseContract(fs.readFileSync(contractPath, 'utf8'));
  console.log(`${CONTRACT}: ${codes.size} code(s) documented explicitly from ${explicitRows} row(s)/heading(s), ${ranges.length} range(s): ${ranges.join(', ')}`);
  const pages = DOCS_ROOTS.flatMap(root => walk(path.join(options.repoRoot, root), isAuthoredPage));
  let failures = reportUncovered(`website/docs/{${LOCALES.join(',')}}/**/*.mdx`, collectCodes(pages), codes, options.repoRoot);
  if (options.src) {
    const modules = walk(path.join(options.repoRoot, SOURCE_ROOT), isSourceModule);
    failures += reportUncovered(`${SOURCE_ROOT.split(path.sep).join('/')}/**/*.ts`, collectCodes(modules), codes, options.repoRoot);
  } else {
    console.log(`${SOURCE_ROOT.split(path.sep).join('/')}: skipped (--no-src)`);
  }
  if (failures > 0) process.exitCode = 1;
};

try {
  main();
} catch (error) {
  console.error(`check-diagnostics-coverage: ${error.message}`);
  process.exitCode = 2;
}
