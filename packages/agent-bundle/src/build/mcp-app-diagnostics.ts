import type { Rspack } from '@rsbuild/core';
import { isAbsolute, resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

import type { Diagnostic } from '../core/diagnostics.ts';
import { MAX_APP_HTML_BYTES } from '../core/mcp-app-limits.ts';
import { isInside, toPosixRelative } from '../core/paths.ts';
import { formatByteSize } from '../core/strings.ts';

/**
 * The `AB477x` family: what the MCP App view compiler reports about one
 * Rspack environment (one App) after reading its stats. `AB4770` errors fail
 * the compile through a `DiagnosticError`; `AB4771` warnings and the
 * `AB4772` size advisory ride `CompiledMcpAppsResult.diagnostics`. The
 * mapping is pure so the message shapes are unit-testable without a build;
 * `mcp-apps.ts` feeds it the stats its compile-time collector recorded.
 */
export const mcpAppCompileErrorCode = 'AB4770';
export const mcpAppCompileWarningCode = 'AB4771';
export const mcpAppSizeAdvisoryCode = 'AB4772';

/**
 * Which profile the view compiler emits. `production` is the artifact
 * profile every `agent-bundle build` ships; `development` is the Workbench
 * dev-loop profile (readable, unminified output), still self-contained.
 */
export type McpAppCompileMode = 'development' | 'production';

/** The emitted size of one self-contained MCP App HTML document. */
export interface McpAppOutputSize {
  /** UTF-8 bytes of the emitted HTML as written to the artifact. */
  readonly bytes: number;
  /** Bytes of the same document after gzip, the size a compressing transport would carry. */
  readonly gzipBytes: number;
}

/**
 * Emitted bytes at which a production view draws the `AB4772` advisory. The
 * framework floor for any view using `@modelcontextprotocol/ext-apps` (its
 * SDK, both `zod` generations, `zod-to-json-schema`) measured 437 kB; this is
 * roughly 2.4× that floor and half the {@link MAX_APP_HTML_BYTES} host bound.
 */
export const MCP_APP_HTML_ADVISORY_BYTES = 1_048_576;

/** How many `AB4770` diagnostics one App renders before the tail summarises the rest. */
export const MCP_APP_COMPILE_ERROR_CAP = 20;

/** How many modules the `AB4772` advisory names. */
const largestModuleCount = 5;

/**
 * Rspack warnings the App compile does not surface as `AB4771`. Every entry
 * cites the warning text it matches and why that text is noise for a
 * self-contained view. Empty today: Rsbuild already switches the
 * `performance.hints` asset-size warnings off, and no other warning has been
 * observed on a view that compiles.
 */
export const ignoredMcpAppCompileWarnings: readonly RegExp[] = Object.freeze([]);

const compileErrorRecovery =
  'Fix the reported error in the named file and rebuild; run `agent-bundle build` for the full message.';
const compileWarningRecovery =
  'Address the reported warning in the named file and rebuild; run `agent-bundle build` for the full message.';
const sizeAdvisoryRecovery =
  'Trim the largest modules listed and rebuild; the Workbench and serve-app hosts refuse a view above '
  + `${String(MAX_APP_HTML_BYTES / 1_048_576)} MiB.`;
const readableFallbackRecovery =
  'The preview shows the minified production build; trim the view to read its source in the Workbench.';

/** What the compiler knows about one App independent of any stats entry. */
export interface McpAppDiagnosticContext {
  /** The App name; also the name of its Rsbuild environment in stats. */
  readonly appName: string;
  /** The App's absolute browser entry source: the `sourcePath` when no module is known. */
  readonly entrySource: string;
  /** The project root, the bundler `context` every relative stats module name is anchored to. */
  readonly projectRoot: string;
}

export interface StatsErrorLocation {
  /** As printed by Rspack: `loc` columns are 1-based, SWC's miette frame columns 0-based. */
  readonly column: number;
  readonly line: number;
}

/** Ranked entry of the `AB4772` advisory: a leaf module and its stats size. */
export interface RankedModule {
  /** Project-relative, `node_modules/<package>/…`, or absolute when outside both. */
  readonly name: string;
  readonly size: number;
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

/**
 * Where an error points. Rspack's own `loc` (`"1:1-41"`) wins; otherwise the
 * SWC/miette frame inside the message: its `╭─[line:col]` header when miette
 * printed one, else the caret line under the code frame (miette omits the
 * header when the span starts on the first line, which is exactly where a
 * one-line fixture fails). Both frame forms report miette's 0-based column.
 */
export const statsErrorLocation = (error: Rspack.StatsError): StatsErrorLocation | undefined => {
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
const loaderChainTarget = (request: string): string => {
  const resource = request.split('!=!')[0] ?? request;
  const lastDelimiter = resource.lastIndexOf('!');
  return (lastDelimiter === -1 ? resource : resource.slice(lastDelimiter + 1)).replace(/\?.*$/u, '');
};

/**
 * The absolute path of the module an error belongs to, resolved the way
 * Rsbuild's `resolveFileName` does: `file`, else `moduleName` (relative to
 * the compiler context, the project root), else the resource the
 * `moduleIdentifier` loader chain ends in. `undefined` for compilation-level
 * errors that name no module.
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
const displayPath = (projectRoot: string, path: string): string =>
  isInside(projectRoot, path) ? toPosixRelative(projectRoot, path) : path;

/** miette's decorations, in the order they must go: the arrow and the frame header before the bare glyph runs. */
const mietteDecorations = /╰─▶|╭─\[[^\]\n]*\]|[×⚠│·╭╰╯╮─]+/gu;

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

/**
 * The leaves of a module list: a concatenated module reports its parts under
 * `modules` and its own size as their sum, so only the parts are ranked.
 */
const leafModules = (modules: readonly Rspack.StatsModule[]): readonly Rspack.StatsModule[] =>
  modules.flatMap((module) => (
    module.modules !== undefined && module.modules.length > 0 ? leafModules(module.modules) : [module]
  ));

/**
 * The display name of one module: everything from the last `node_modules`
 * segment on for a dependency (`node_modules/react-dom/cjs/…`, whatever the
 * package manager's layout above it), project-relative for authored source,
 * absolute for anything outside both.
 */
const moduleDisplayName = (module: Rspack.StatsModule, projectRoot: string): string | undefined => {
  const named = module.nameForCondition ?? module.name ?? module.identifier;
  if (named === undefined || named.length === 0) return undefined;
  const path = loaderChainTarget(named);
  const segments = path.split(/[\\/]/u);
  const dependencyRoot = segments.lastIndexOf('node_modules');
  if (dependencyRoot !== -1) return segments.slice(dependencyRoot).join('/');
  return displayPath(projectRoot, isAbsolute(path) ? path : resolve(projectRoot, path));
};

/** The `count` largest leaf modules by stats size, ties broken by name for a stable rendering. */
export const largestModules = (
  modules: readonly Rspack.StatsModule[],
  projectRoot: string,
  count = largestModuleCount,
): readonly RankedModule[] => Object.freeze(leafModules(modules)
  .flatMap((module): RankedModule[] => {
    const name = moduleDisplayName(module, projectRoot);
    return name === undefined ? [] : [{ name, size: module.size }];
  })
  .sort((left, right) => right.size - left.size || left.name.localeCompare(right.name))
  .slice(0, count));

type StatsSeverity = 'error' | 'warning';

const statsSeverityText: Readonly<Record<StatsSeverity, { readonly code: string; readonly recovery: string; readonly verb: string }>> = {
  error: { code: mcpAppCompileErrorCode, recovery: compileErrorRecovery, verb: 'failed to compile' },
  warning: { code: mcpAppCompileWarningCode, recovery: compileWarningRecovery, verb: 'produced a warning while compiling' },
};

/**
 * `MCP App "<name>" <verb>: <file>:<line>:<column>: <message>` — the file and
 * position only as far as the stats entry knows them. `sourcePath` is the
 * failing module, else the App's entry.
 */
const statsDiagnostic = (context: McpAppDiagnosticContext, entry: Rspack.StatsError, severity: StatsSeverity): Diagnostic => {
  const { code, recovery, verb } = statsSeverityText[severity];
  const file = statsErrorFile(entry, context.projectRoot);
  const location = statsErrorLocation(entry);
  const position = location === undefined ? '' : `:${String(location.line)}:${String(location.column)}`;
  const where = file === undefined ? '' : `${displayPath(context.projectRoot, file)}${position}: `;
  return {
    code,
    message: `MCP App ${JSON.stringify(context.appName)} ${verb}: ${where}${normalizeStatsMessage(entry.message)}`,
    recovery,
    severity,
    sourcePath: file ?? context.entrySource,
  };
};

/**
 * One `AB4770` per Rspack error of the App's environment, capped at
 * {@link MCP_APP_COMPILE_ERROR_CAP}: past the cap the last diagnostic counts
 * the rest and names the way to see them all.
 */
export const mcpAppCompileErrorDiagnostics = (
  context: McpAppDiagnosticContext,
  errors: readonly Rspack.StatsError[],
): readonly Diagnostic[] => {
  const capped = errors.length > MCP_APP_COMPILE_ERROR_CAP;
  const rendered = capped ? errors.slice(0, MCP_APP_COMPILE_ERROR_CAP - 1) : errors;
  const diagnostics = rendered.map((error) => statsDiagnostic(context, error, 'error'));
  if (capped) {
    const remaining = errors.length - rendered.length;
    diagnostics.push({
      code: mcpAppCompileErrorCode,
      message: `MCP App ${JSON.stringify(context.appName)} failed to compile: … and ${String(remaining)} more `
        + `${remaining === 1 ? 'error' : 'errors'} (run the compile with logLevel error via tools.rsbuild for the full list)`,
      recovery: compileErrorRecovery,
      severity: 'error',
      sourcePath: context.entrySource,
    });
  }
  return Object.freeze(diagnostics);
};

/**
 * The `AB4770` for a bundler rejection that left no stats error behind (a
 * compiler-level failure rather than a module's): the bundler's own message,
 * attributed to the App's entry.
 */
export const mcpAppBundlerFailureDiagnostic = (context: McpAppDiagnosticContext, failure: string): Diagnostic => ({
  code: mcpAppCompileErrorCode,
  message: `MCP App ${JSON.stringify(context.appName)} failed to compile: ${normalizeStatsMessage(failure)}`,
  recovery: compileErrorRecovery,
  severity: 'error',
  sourcePath: context.entrySource,
});

/**
 * One `AB4771` per Rspack warning of the App's environment that no
 * ignore-list pattern matches; the patterns see the normalised one-line text
 * the diagnostic would carry, so an entry reads like the message it silences.
 */
export const mcpAppCompileWarningDiagnostics = (
  context: McpAppDiagnosticContext,
  warnings: readonly Rspack.StatsError[],
  ignored: readonly RegExp[] = ignoredMcpAppCompileWarnings,
): readonly Diagnostic[] => Object.freeze(warnings
  .filter((warning) => {
    const text = normalizeStatsMessage(warning.message);
    return !ignored.some((pattern) => pattern.test(text));
  })
  .map((warning) => statsDiagnostic(context, warning, 'warning')));

/**
 * The `AB4772` size advisory for one emitted view, or nothing when the view
 * is within bounds: a production view at or above
 * {@link MCP_APP_HTML_ADVISORY_BYTES}, or a view in either mode above the
 * {@link MAX_APP_HTML_BYTES} the Workbench and serve-app hosts accept. The
 * largest leaf modules by stats size name where the bytes come from.
 */
export const mcpAppSizeDiagnostic = (
  context: McpAppDiagnosticContext,
  options: {
    readonly mode: McpAppCompileMode;
    readonly modules: readonly Rspack.StatsModule[];
    readonly size: McpAppOutputSize;
  },
): Diagnostic | undefined => {
  const aboveHostBound = options.size.bytes > MAX_APP_HTML_BYTES;
  const aboveAdvisory = options.mode === 'production' && options.size.bytes >= MCP_APP_HTML_ADVISORY_BYTES;
  if (!aboveHostBound && !aboveAdvisory) return undefined;
  const bound = aboveHostBound
    ? `, above the ${String(MAX_APP_HTML_BYTES / 1_048_576)} MiB bound the Workbench and serve-app hosts accept — the view will not render there`
    : `, above the ${String(MCP_APP_HTML_ADVISORY_BYTES / 1_048_576)} MiB advisory bound`;
  const ranked = largestModules(options.modules, context.projectRoot);
  const largest = ranked.length === 0
    ? ''
    : `; largest modules: ${ranked.map((module) => `${module.name} (${formatByteSize(module.size)})`).join(', ')}`;
  return {
    code: mcpAppSizeAdvisoryCode,
    message: `MCP App ${JSON.stringify(context.appName)} compiled to ${formatByteSize(options.size.bytes)} `
      + `(${formatByteSize(options.size.gzipBytes)} gzip)${bound}${largest}`,
    recovery: sizeAdvisoryRecovery,
    severity: 'warning',
    sourcePath: context.entrySource,
  };
};

/**
 * The `AB4772` a development compile reports when a view's readable output
 * would not render in the hosts and the production profile was emitted in
 * its place: the preview still shows the view, just not its readable source.
 */
export const mcpAppReadableFallbackDiagnostic = (
  context: McpAppDiagnosticContext,
  sizes: { readonly production: McpAppOutputSize; readonly readable: McpAppOutputSize },
): Diagnostic => ({
  code: mcpAppSizeAdvisoryCode,
  message: `MCP App ${JSON.stringify(context.appName)} readable development output compiled to `
    + `${formatByteSize(sizes.readable.bytes)}, above the ${String(MAX_APP_HTML_BYTES / 1_048_576)} MiB bound the `
    + 'Workbench and serve-app hosts accept; the preview renders the production build '
    + `(${formatByteSize(sizes.production.bytes)}, ${formatByteSize(sizes.production.gzipBytes)} gzip) instead`,
  recovery: readableFallbackRecovery,
  severity: 'warning',
  sourcePath: context.entrySource,
});
