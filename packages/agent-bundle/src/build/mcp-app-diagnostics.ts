import type { Rspack } from '@rsbuild/core';
import { isAbsolute, resolve } from 'node:path';

import type { Diagnostic } from '../core/diagnostics.ts';
import { MAX_APP_HTML_BYTES } from '../core/mcp-app-limits.ts';
import { formatByteSize } from '../core/strings.ts';
import {
  describeRspackStatsError,
  displayPath,
  loaderChainTarget,
  normalizeStatsMessage,
  renderRspackStatsErrorDetail,
} from './rspack-stats-errors.ts';

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

/** Ranked entry of the `AB4772` advisory: a leaf module and its stats size. */
export interface RankedModule {
  /** Project-relative, `node_modules/<package>/…`, or absolute when outside both. */
  readonly name: string;
  readonly size: number;
}

/**
 * The leaves of a module list — what the emitted document is made of. A
 * concatenated module reports its parts under `modules` and its own size as
 * their sum, so only the parts are ranked. Those parts are also orphans of
 * the chunk graph, and the stats (recorded with `orphanModules`) list each of
 * them a second time at the top level; a top-level orphan is skipped, since
 * it is either already ranked through the module that absorbed it or emitted
 * nowhere at all (an export the bundler inlined at every use).
 */
const leafModules = (modules: readonly Rspack.StatsModule[], topLevel = true): readonly Rspack.StatsModule[] =>
  modules.flatMap((module) => {
    if (topLevel && module.orphan === true) return [];
    return module.modules !== undefined && module.modules.length > 0 ? leafModules(module.modules, false) : [module];
  });

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
  const detail = describeRspackStatsError(entry, context.projectRoot);
  return {
    code,
    message: `MCP App ${JSON.stringify(context.appName)} ${verb}: ${renderRspackStatsErrorDetail(detail, context.projectRoot)}`,
    recovery,
    severity,
    sourcePath: detail.file ?? context.entrySource,
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
  return {
    code: mcpAppSizeAdvisoryCode,
    message: `MCP App ${JSON.stringify(context.appName)} compiled to ${formatByteSize(options.size.bytes)} `
      + `(${formatByteSize(options.size.gzipBytes)} gzip)${bound}${largestModulesClause(options.modules, context.projectRoot)}`,
    recovery: sizeAdvisoryRecovery,
    severity: 'warning',
    sourcePath: context.entrySource,
  };
};

/** `; largest modules: <name> (<size>), …` — empty when the stats carried no modules. */
const largestModulesClause = (modules: readonly Rspack.StatsModule[], projectRoot: string): string => {
  const ranked = largestModules(modules, projectRoot);
  return ranked.length === 0
    ? ''
    : `; largest modules: ${ranked.map((module) => `${module.name} (${formatByteSize(module.size)})`).join(', ')}`;
};

/**
 * The `AB4772` a development compile reports when a view's readable output
 * would not render in the hosts and the production profile — which does fit
 * — was emitted in its place: the preview still shows the view, just not its
 * readable source. A replacement that itself exceeds the bound gets the plain
 * {@link mcpAppSizeDiagnostic} instead; claiming the preview renders it would
 * be false.
 */
export const mcpAppReadableFallbackDiagnostic = (
  context: McpAppDiagnosticContext,
  options: {
    readonly modules: readonly Rspack.StatsModule[];
    readonly production: McpAppOutputSize;
    readonly readable: McpAppOutputSize;
  },
): Diagnostic => ({
  code: mcpAppSizeAdvisoryCode,
  message: `MCP App ${JSON.stringify(context.appName)} readable development output compiled to `
    + `${formatByteSize(options.readable.bytes)}, above the ${String(MAX_APP_HTML_BYTES / 1_048_576)} MiB bound the `
    + 'Workbench and serve-app hosts accept; the preview renders the production build '
    + `(${formatByteSize(options.production.bytes)}, ${formatByteSize(options.production.gzipBytes)} gzip) instead`
    + largestModulesClause(options.modules, context.projectRoot),
  recovery: readableFallbackRecovery,
  severity: 'warning',
  sourcePath: context.entrySource,
});
