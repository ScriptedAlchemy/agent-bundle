/**
 * Fixture routes whose render suspends until a gate file appears under the
 * project's `.agent-bundle` directory, so a test can observe the authored
 * Suspense fallback on the wire before releasing the child (#686).
 */
export const gatedRouteFiles: Readonly<Record<string, string>> = Object.freeze({
  'src/gate.ts': [
    "import { existsSync } from 'node:fs';",
    "import { join } from 'node:path';",
    '',
    'export const awaitGate = async (gate, signal) => {',
    "  const path = join(process.cwd(), '.agent-bundle', gate);",
    '  while (!existsSync(path)) {',
    "    if (signal.aborted) throw new DOMException('gate abandoned', 'AbortError');",
    '    await new Promise((resolve) => setTimeout(resolve, 25));',
    '  }',
    '};',
    '',
  ].join('\n'),
  'src/mcp/status/tools/live.tsx': [
    "import { Agent } from '@agent-bundle/runtime';",
    "import { createElement, Suspense } from 'react';",
    "import { z } from 'zod';",
    "import { awaitGate } from '../../../gate.js';",
    '',
    'export const inputSchema = z.object({ gate: z.string().optional() }).strict();',
    'export const resultSchema = z.object({ done: z.boolean() }).strict();',
    'const Slow = async ({ gate, signal }) => {',
    '  if (gate !== undefined) await awaitGate(gate, signal);',
    "  return createElement(Agent.Text, null, 'stream complete');",
    '};',
    '',
    'export default async function Live({ input, signal }) {',
    "  return createElement(Agent.Result, { value: { done: true } }, createElement(Suspense, { fallback: createElement(Agent.Progress, { completed: 0, message: 'streaming', total: 1 }) }, createElement(Slow, { gate: input.gate, signal })));",
    '}',
    '',
  ].join('\n'),
});
