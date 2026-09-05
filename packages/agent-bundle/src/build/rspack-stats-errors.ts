import type { Rspack } from '@rsbuild/core';
import { isAbsolute, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import { isInside, toPosixRelative } from '../core/paths.ts';

/**
 * Reads Rspack stats errors and warnings the way Rsbuild's own reporter
 * does — which module an entry belongs to, where it points, and its message
 * as one line of prose — for every consumer that turns a compile failure into
 * a diagnostic: the MCP App view compiler's `AB4770`/`AB4771`, and projects
 * that drive Rsbuild themselves (the `rsc-agent-runtime` example's `AB8206`)
 * through the `agent-bundle/api` exports. Pure: no I/O, no logging.
 */

export interface RspackStatsErrorLocation {
  /** As printed by Rspack: `loc` columns are 1-based, SWC's miette frame columns 0-based. */
  readonly column: number;
  readonly line: number;
}

/** One stats entry, read: the module (absolute), the position, and the flattened message. */
export interface RspackStatsErrorDetail {
  /** The absolute path of the module the entry belongs to; `undefined` for compilation-level entries that name none. */
  readonly file: string | undefined;
  /** Where the entry points inside `file`, when Rspack or the SWC frame said. */
  readonly location: RspackStatsErrorLocation | undefined;
  /** The message as one line of prose: no ANSI colour, miette glyphs, or code frame. */
  readonly message: string;
}

const rspackLocation = /^(?<line>\d+):(?<column>\d+)/u;
/** miette's frame header names the span it opens: `╭─[1:10]`, or `╭─[file:1:10]`. */
const mietteFrameHeader = /╭─\[(?:[^\]\n]*:)?(?<line>\d+):(?<column>\d+)\]/u;
/** One code-frame line: a line number, the gutter, the source. */
const codeFrameLine = /^\s*(?<line>\d+)\s*│/u;
/** The marker line under a code-frame line: the gutter dot, then the span underlined with `─`. */
const codeFrameMarker = /^\s*·/u;
const codeFrameGutter = '·';
const codeFrameUnderline = '─';
/** miette's decorations, in the order they must go: the arrow and the frame header before the bare glyph runs. */
const mietteDecorations = /╰─▶|╭─\[[^\]\n]*\]|[×⚠│·╭╰╯╮─]+/gu;

/**
 * Where an entry points. Rspack's own `loc` (`"1:1-41"`) wins; otherwise the
 * SWC/miette frame inside the message: its `╭─[line:col]` header when miette
 * printed one, else the caret line under the code frame (miette omits the
 * header when the span starts on the first line, which is exactly where a
 * one-line fixture fails). Both frame forms report miette's 0-based column.
 */
export const statsErrorLocation = (error: Rspack.StatsError): RspackStatsErrorLocation | undefined => {
  const located = error.loc === undefined ? undefined : rspackLocation.exec(error.loc)?.groups;
  if (located !== undefined) return { column: Number(located.column), line: Number(located.line) };
  const message = stripVTControlCharacters(error.message);
  const header = mietteFrameHeader.exec(message)?.groups;
  if (header !== undefined) return { column: Number(header.column), line: Number(header.line) };
  const lines = message.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const frame = codeFrameLine.exec(line)?.groups;
    const marker = lines[index + 1];
    if (frame === undefined || marker === undefined || !codeFrameMarker.test(marker)) continue;
    const underline = marker.indexOf(codeFrameUnderline);
    if (underline === -1) continue;
    // The source starts two cells after the gutter (`│ ` above, `· ` below).
    const column = underline - (marker.indexOf(codeFrameGutter) + 2);
    if (column < 0) continue;
    return { column, line: Number(frame.line) };
  }
  return undefined;
};

/**
 * The request a loader chain ends in: `builtin:swc-loader??ruleSet[…]!/abs/views/status.ts`
 * names `/abs/views/status.ts`; Rspack's inline match-resource form
 * (`<resource>!=!<loaders>`) names the resource, as Rsbuild's own
 * `removeLoaderChainDelimiter` reads it. A resource query is not a path.
 */
export const loaderChainTarget = (request: string): string => {
  const resource = request.split('!=!')[0] ?? request;
  const lastDelimiter = resource.lastIndexOf('!');
  return (lastDelimiter === -1 ? resource : resource.slice(lastDelimiter + 1)).replace(/\?.*$/u, '');
};

/**
 * The absolute path of the module an entry belongs to, resolved the way
 * Rsbuild's `resolveFileName` does: `file`, else `moduleName` (relative to
 * the compiler context, the project root), else the resource the
 * `moduleIdentifier` loader chain ends in. `undefined` for compilation-level
 * entries that name no module.
 */
export const statsErrorFile = (error: Rspack.StatsError, projectRoot: string): string | undefined => {
  const named = [error.file, error.moduleName, error.moduleIdentifier]
    .find((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0);
  if (named === undefined) return undefined;
  const target = loaderChainTarget(named);
  if (target.length === 0) return undefined;
  return isAbsolute(target) ? target : resolve(projectRoot, target);
};

/** Project-relative with forward slashes inside the project root, absolute otherwise. */
export const displayPath = (projectRoot: string, path: string): string =>
  isInside(projectRoot, path) ? toPosixRelative(projectRoot, path) : path;

/**
 * One line of prose out of an Rspack message: ANSI stripped, miette's box
 * glyphs (`×` and its warning twin `⚠`, `╰─▶`, `╭─[…]`, `╰────`, `│`, `·`,
 * `─`) removed, code-frame lines (`<n> │ …`) and the marker lines under them
 * dropped, the remaining lines trimmed and joined with a single space.
 */
export const normalizeStatsMessage = (message: string): string => stripVTControlCharacters(message)
  .split(/\r?\n/u)
  .filter((line) => !codeFrameLine.test(line))
  .map((line) => line.replace(mietteDecorations, ' ').replace(/\s+/gu, ' ').trim())
  .filter((line) => line.length > 0)
  .join(' ');

/** Reads one Rspack stats error or warning: its module, position, and one-line message. */
export const describeRspackStatsError = (error: Rspack.StatsError, projectRoot: string): RspackStatsErrorDetail => Object.freeze({
  file: statsErrorFile(error, projectRoot),
  location: statsErrorLocation(error),
  message: normalizeStatsMessage(error.message),
});

/**
 * `<file>:<line>:<column>: <message>` — the file project-relative, the
 * position only as far as the entry knows it, the bare message when Rspack
 * attributed the entry to no module.
 */
export const renderRspackStatsErrorDetail = (detail: RspackStatsErrorDetail, projectRoot: string): string => {
  if (detail.file === undefined) return detail.message;
  const position = detail.location === undefined ? '' : `:${String(detail.location.line)}:${String(detail.location.column)}`;
  return `${displayPath(projectRoot, detail.file)}${position}: ${detail.message}`;
};

/** {@link describeRspackStatsError} rendered as one `file:line:column: message` line. */
export const formatRspackStatsError = (error: Rspack.StatsError, projectRoot: string): string =>
  renderRspackStatsErrorDetail(describeRspackStatsError(error, projectRoot), projectRoot);

/**
 * Every error in a Stats or MultiStats JSON document. A MultiStats document
 * already lists its children's errors at the top level, so children are only
 * walked when that list is empty; concatenating both would double-count.
 */
export const rspackStatsErrors = (stats: Rspack.StatsCompilation): readonly Rspack.StatsError[] => {
  if (stats.errors !== undefined && stats.errors.length > 0) return stats.errors;
  return (stats.children ?? []).flatMap(rspackStatsErrors);
};
