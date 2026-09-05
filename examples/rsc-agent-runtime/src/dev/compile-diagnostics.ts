import type { Rspack } from '@rsbuild/core';
import { formatRspackStatsError, rspackStatsErrors } from 'agent-bundle/api';

/**
 * The `AB8206` detail for a rejected development compile: a headline with the
 * error count, then one `file:line:col: message` line per Rspack error — the
 * path relative to the project root, the position as far as the stats entry
 * knows it, ANSI colour and the SWC code frame stripped — read by the same
 * `agent-bundle/api` helpers the framework's own `AB4770` diagnostics use.
 */
export const describeRspackCompileErrors = (stats: Rspack.StatsCompilation, projectRoot: string): string => {
  const lines = rspackStatsErrors(stats).map((error) => formatRspackStatsError(error, projectRoot));
  if (lines.length === 0) return 'RSC runtime compile reported errors, but Rspack stats carried no error details.';
  return `RSC runtime compile reported ${String(lines.length)} error(s):\n${lines.join('\n')}`;
};
