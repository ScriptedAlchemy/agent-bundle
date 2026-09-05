import { isAbsolute, relative, sep } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import type { Rspack } from '@rsbuild/core';

/**
 * Renders Rspack error stats as one `file:line:col: message` line per error
 * so the provider's `AB8206` diagnostic names the failing module and location
 * instead of only reporting that a compile failed. Pure: no I/O, no logging.
 */

/** Rspack's own `loc` is 1-based: `"1:1-41"` is line 1, column 1. */
const locPattern = /^(\d+):(\d+)/u;
/** The SWC/miette frame header (`╭─[3:6]`) is the fallback when `loc` is absent. */
const frameLocationPattern = /╭─\[(\d+):(\d+)\]/u;
/** Code-frame source lines: `       3 │ const = ;`. */
const codeFrameLinePattern = /^\s*\d+\s*│/u;
/** miette box glyphs: frame headers, pointers, borders, and underline runs. */
const glyphPattern = /╭─\[[^\]]*\]|╰─▶|[×│·▲]|[╭╰╯╮├┬┴┼─]+/gu;

export interface RspackErrorLocation {
  readonly column: number;
  readonly line: number;
}

const stripAnsi = (text: string): string => stripVTControlCharacters(text);

/** `builtin:swc-loader??ruleSet[1].rules[2]!/abs/src/a.ts` → `/abs/src/a.ts`. */
const stripLoaderChain = (identifier: string): string => identifier.slice(identifier.lastIndexOf('!') + 1);

/**
 * The module an error belongs to, mirroring Rsbuild's own `resolveFileName`
 * precedence; project-relative with forward slashes when inside the project
 * root, absolute otherwise, `undefined` when Rspack named no module.
 */
export const rspackErrorFile = (error: Rspack.StatsError, projectRoot: string): string | undefined => {
  const raw = error.file
    ?? error.moduleName
    ?? (error.moduleIdentifier === undefined ? undefined : stripLoaderChain(error.moduleIdentifier));
  if (raw === undefined || raw.length === 0) return undefined;
  if (!isAbsolute(raw)) return raw.replace(/^\.\//u, '');
  const relativePath = relative(projectRoot, raw);
  if (relativePath.length === 0 || relativePath.startsWith('..') || isAbsolute(relativePath)) return raw;
  return relativePath.split(sep).join('/');
};

export const rspackErrorLocation = (error: Rspack.StatsError): RspackErrorLocation | undefined => {
  const loc = error.loc === undefined ? null : locPattern.exec(error.loc);
  const match = loc ?? frameLocationPattern.exec(stripAnsi(error.message));
  if (match === null) return undefined;
  return Object.freeze({ column: Number(match[2]), line: Number(match[1]) });
};

/**
 * The error text without ANSI colour, miette box drawing, or the code frame:
 * the remaining lines trimmed and joined with a single space.
 */
export const rspackErrorText = (message: string): string => stripAnsi(message)
  .split(/\r?\n/u)
  .filter((line) => !codeFrameLinePattern.test(line))
  .map((line) => line.replace(glyphPattern, ' ').replace(/\s+/gu, ' ').trim())
  .filter((line) => line.length > 0)
  .join(' ');

/**
 * Every error in a Stats or MultiStats JSON. A MultiStats document already
 * lists its children's errors at the top level, so children are only walked
 * when that list is empty; concatenating both would double-count.
 */
export const rspackStatsErrors = (stats: Rspack.StatsCompilation): readonly Rspack.StatsError[] => {
  if (stats.errors !== undefined && stats.errors.length > 0) return stats.errors;
  return (stats.children ?? []).flatMap(rspackStatsErrors);
};

export const formatRspackStatsError = (error: Rspack.StatsError, projectRoot: string): string => {
  const text = rspackErrorText(error.message);
  const file = rspackErrorFile(error, projectRoot);
  if (file === undefined) return text;
  const location = rspackErrorLocation(error);
  return location === undefined
    ? `${file}: ${text}`
    : `${file}:${String(location.line)}:${String(location.column)}: ${text}`;
};

/**
 * The `AB8206` detail: a headline with the error count, then one
 * `file:line:col: message` line per error.
 */
export const describeRspackCompileErrors = (stats: Rspack.StatsCompilation, projectRoot: string): string => {
  const lines = rspackStatsErrors(stats).map((error) => formatRspackStatsError(error, projectRoot));
  if (lines.length === 0) return 'RSC runtime compile reported errors, but Rspack stats carried no error details.';
  return `RSC runtime compile reported ${String(lines.length)} error(s):\n${lines.join('\n')}`;
};
