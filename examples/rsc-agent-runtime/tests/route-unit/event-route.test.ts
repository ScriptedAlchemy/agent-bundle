import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, expect, it } from '@rstest/core';
import { expectDocument, renderRoute, testManifest } from 'agent-bundle/test';

/**
 * The route-unit proof level for the demo's PostToolUse migration: the hook is
 * a compiled `src/events/tool/after.tsx` route, and it renders through the same
 * renderer and request scope every other route uses. Native wrapper delivery
 * and the host response projection are proven by the artifact suites; this is
 * not host or process evidence.
 */
const manifest = testManifest();
const fixture = resolve(import.meta.dirname, '../fixtures/events/claude-post-tool-use.json');

let workspace: string;
let previousStateFile: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-event-route-'));
  previousStateFile = process.env.AGENT_RUNTIME_STATE_FILE;
  process.env.AGENT_RUNTIME_STATE_FILE = join(workspace, 'state.json');
});

afterEach(async () => {
  if (previousStateFile === undefined) delete process.env.AGENT_RUNTIME_STATE_FILE;
  else process.env.AGENT_RUNTIME_STATE_FILE = previousStateFile;
  await rm(workspace, { force: true, recursive: true });
});

it('compiles the PostToolUse hook as a real event route rather than configuration', () => {
  expect(manifest.proofLevel).toBe('route-unit');
  expect(manifest.diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([]);
  expect(manifest.routes['event:tool/after']).toMatchObject({
    kind: 'event-route',
    relativePath: 'src/events/tool/after.tsx',
  });
});

it('renders a native Claude PostToolUse envelope into the document the host projects from', async () => {
  const native = JSON.parse(await readFile(fixture, 'utf8')) as Record<string, unknown>;
  const rendered = await renderRoute('event:tool/after', {
    input: {
      canonical: {
        event: 'tool/after',
        idempotencyKey: 'route-unit-claude-write',
        observedAt: '2026-09-01T00:00:00.000Z',
        provenance: {
          host: 'claude',
          hostContractRevision: 'route-unit',
          nativeEvent: 'PostToolUse',
          source: 'native',
        },
        sequence: 1,
      },
      native: { ...native, cwd: workspace },
    },
  });

  expect(rendered.invocation.kind).toBe('event');
  expectDocument(rendered)
    .toHaveStatus('success')
    .toHaveNodeKinds(['result', 'context'])
    .toContainContext('Recorded claude-note.txt from claude. Shared state now contains 1 edit.');
  expect(rendered.provenance).toMatchObject({ kind: 'event-route', proofLevel: 'route-unit' });
});
