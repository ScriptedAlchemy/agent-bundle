import type { Diagnostic } from '../core/diagnostics.ts';
import { MAX_ROUTE_RENDER_ELAPSED_MS } from './public.ts';
import type { CompiledAgentRoute } from './types.ts';

/** The validated render budget of one route, as the compiled graph carries it. */
export interface RouteRenderBudget {
  readonly maxElapsedMs: number;
}

const RENDER_KEYS: ReadonlySet<string> = new Set(['maxElapsedMs']);

const renderError = (message: string, sourcePath: string): Diagnostic => ({
  code: 'AB4835',
  message,
  recovery: `Declare config.render as { maxElapsedMs: <positive integer of milliseconds, at most ${String(MAX_ROUTE_RENDER_ELAPSED_MS)}> }, or omit it to keep the runtime default of 60000.`,
  severity: 'error',
  sourcePath,
});

export interface ValidatedRouteRenderConfig {
  readonly diagnostics: readonly Diagnostic[];
  /** Present only when `config.render` is declared and valid. */
  readonly render?: RouteRenderBudget;
}

/**
 * Interprets a route's statically extracted `config.render` (#454): absent
 * means the runtime defaults; declared, it must be an object whose only key
 * is `maxElapsedMs`, a positive safe integer of milliseconds no larger than
 * {@link MAX_ROUTE_RENDER_ELAPSED_MS}. `describe` names the route kind in
 * the message (`MCP route`, `CLI route`).
 */
export const validateRouteRenderConfig = (
  route: CompiledAgentRoute,
  describe: string,
): ValidatedRouteRenderConfig => {
  const declared = route.config['render'];
  if (declared === undefined) return { diagnostics: [] };
  const relativePath = route.provenance.relativePath;
  if (typeof declared !== 'object' || declared === null || Array.isArray(declared)) {
    return {
      diagnostics: [renderError(`${describe} ${relativePath} config.render must be an object.`, route.source)],
    };
  }
  const unknown = Object.keys(declared).filter((key) => !RENDER_KEYS.has(key));
  if (unknown.length > 0) {
    return {
      diagnostics: [renderError(
        `${describe} ${relativePath} config.render declares unknown key${unknown.length === 1 ? '' : 's'} ${unknown.map((key) => JSON.stringify(key)).join(', ')}; only maxElapsedMs is accepted.`,
        route.source,
      )],
    };
  }
  const maxElapsedMs = (declared as { readonly maxElapsedMs?: unknown }).maxElapsedMs;
  if (maxElapsedMs === undefined) return { diagnostics: [] };
  if (typeof maxElapsedMs !== 'number' || !Number.isSafeInteger(maxElapsedMs) || maxElapsedMs <= 0) {
    return {
      diagnostics: [renderError(
        `${describe} ${relativePath} config.render.maxElapsedMs must be a positive integer of milliseconds.`,
        route.source,
      )],
    };
  }
  if (maxElapsedMs > MAX_ROUTE_RENDER_ELAPSED_MS) {
    return {
      diagnostics: [renderError(
        `${describe} ${relativePath} config.render.maxElapsedMs ${String(maxElapsedMs)} exceeds the framework ceiling of ${String(MAX_ROUTE_RENDER_ELAPSED_MS)} (24 hours).`,
        route.source,
      )],
    };
  }
  return { diagnostics: [], render: Object.freeze({ maxElapsedMs }) };
};

/**
 * The render limits a compiled route config asks for at run time: the
 * generated MCP server and the test harness read the compiled `config`, which
 * the build already validated, so this reader only picks the well-formed
 * value and ignores anything else.
 */
export const routeRenderLimits = (
  config: Readonly<Record<string, unknown>>,
): RouteRenderBudget | undefined => {
  const declared = config['render'];
  if (typeof declared !== 'object' || declared === null) return undefined;
  const maxElapsedMs = (declared as { readonly maxElapsedMs?: unknown }).maxElapsedMs;
  if (typeof maxElapsedMs !== 'number' || !Number.isSafeInteger(maxElapsedMs) || maxElapsedMs <= 0) return undefined;
  return Object.freeze({ maxElapsedMs });
};
