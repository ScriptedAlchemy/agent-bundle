import type { CliRenderedEvent } from '../cli-entry.ts';

/**
 * Parsers for the two machine output modes the routed CLI shell and the
 * rendered-script shell share (`--json`, `--ndjson`). They throw a plain
 * `SyntaxError`; the dispatch levels wrap that into an `AgentTestError`
 * carrying their own provenance, so one parser serves both without either
 * level borrowing the other's failure identity.
 */

/** The parsed canonical JSON line a successful `--json` invocation wrote to stdout. */
export const parseCanonicalJsonLine = (stdout: string): unknown => JSON.parse(stdout) as unknown;

/** The ordered render events a successful `--ndjson` invocation wrote to stdout. */
export const parseRenderedEventLines = (stdout: string): readonly CliRenderedEvent[] => {
  const lines = stdout.endsWith('\n') ? stdout.slice(0, -1).split('\n') : stdout.split('\n');
  if (lines.length === 0 || lines.some((line) => line.trim() === '')) {
    throw new SyntaxError('NDJSON output must contain one non-empty JSON object per line.');
  }
  return Object.freeze(lines.map((line) => {
    const event = JSON.parse(line) as unknown;
    if (typeof event !== 'object' || event === null || Array.isArray(event)) {
      throw new SyntaxError('NDJSON output lines must be JSON objects.');
    }
    const record = event as Record<string, unknown>;
    if (!Number.isInteger(record['sequence'])) {
      throw new SyntaxError('NDJSON render events must carry an integer sequence.');
    }
    switch (record['type']) {
      case 'shell':
      case 'progress':
      case 'replace':
      case 'error':
      case 'complete':
        break;
      default:
        throw new SyntaxError('NDJSON output contains an unknown render-event type.');
    }
    return event as CliRenderedEvent;
  }));
};
