import { extname } from 'node:path';

import { isRecord } from '../core/strict-json.ts';
import type { AgentBundleConfig } from '../core/types.ts';
import type { CompiledAgentRoute } from '../routes/types.ts';

/**
 * The #102 stage-1 judgment of one conventional `src/scripts/` route.
 * Normalization ships exactly the `shippable` routes through the explicit
 * `scripts` pipeline; source validation reports every other state as a hard
 * error (`AB4807`-`AB4809`). Both sides share this rule so no discovered
 * script route is ever dropped silently.
 */
export type ScriptRouteJudgment =
  /** A configured `scripts` entry already uses this identity for another file. */
  | 'conflicting'
  /** Nested below the scripts root; the flat scripts artifact layout cannot place it yet. */
  | 'nested'
  /** A rendered-script module (`.tsx`/`.jsx`); needs the Agent renderer (#102 stage 3). */
  | 'rendered'
  /** A plain module directly under `src/scripts/` with an unclaimed identity. */
  | 'shippable';

const renderedScriptExtensions = new Set(['.jsx', '.tsx']);

/** The path-derived identity of one script route (`script:release/verify` -> `release/verify`). */
export const scriptRouteName = (route: CompiledAgentRoute): string =>
  route.id.slice('script:'.length);

/** The script names explicit configuration declares, tolerant of malformed config shapes. */
export const configuredScriptNames = (config: Readonly<AgentBundleConfig>): ReadonlySet<string> =>
  new Set(isRecord(config.scripts) ? Object.keys(config.scripts) : []);

export const judgeScriptRoute = (
  route: CompiledAgentRoute,
  configuredNames: ReadonlySet<string>,
): ScriptRouteJudgment => {
  if (renderedScriptExtensions.has(extname(route.source).toLowerCase())) return 'rendered';
  const name = scriptRouteName(route);
  if (name.includes('/')) return 'nested';
  return configuredNames.has(name) ? 'conflicting' : 'shippable';
};
