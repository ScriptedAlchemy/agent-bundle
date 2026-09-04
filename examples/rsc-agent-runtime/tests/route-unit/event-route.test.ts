import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, expect, it } from '@rstest/core';
import { createEventRouteInput, expectDocument, renderRoute, testManifest } from 'agent-bundle/test';

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
let previousProbeFile: string | undefined;

beforeEach(async () => {
  workspace = await mkdtemp(join(tmpdir(), 'rsc-agent-runtime-event-route-'));
  previousStateFile = process.env.AGENT_RUNTIME_STATE_FILE;
  previousProbeFile = process.env.AGENT_RUNTIME_HOOK_PROBE_FILE;
  process.env.AGENT_RUNTIME_STATE_FILE = join(workspace, 'state.json');
});

afterEach(async () => {
  if (previousStateFile === undefined) delete process.env.AGENT_RUNTIME_STATE_FILE;
  else process.env.AGENT_RUNTIME_STATE_FILE = previousStateFile;
  if (previousProbeFile === undefined) delete process.env.AGENT_RUNTIME_HOOK_PROBE_FILE;
  else process.env.AGENT_RUNTIME_HOOK_PROBE_FILE = previousProbeFile;
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
    // The harness validates the Claude envelope and projects `canonical.payload`
    // (cwd, sessionId, toolName, toolInput) exactly as the artifact's wrapper does.
    input: createEventRouteInput('tool/after', { ...native, cwd: workspace }, { host: 'claude' }),
  });

  expect(rendered.invocation.kind).toBe('event');
  expectDocument(rendered)
    .toHaveStatus('success')
    .toHaveNodeKinds(['result', 'context'])
    .toContainContext('Recorded claude-note.txt from claude. Shared state now contains 1 edit.');
  expect(rendered.provenance).toMatchObject({ kind: 'event-route', proofLevel: 'route-unit' });
});

it('appends a value-free eval hook probe when AGENT_RUNTIME_HOOK_PROBE_FILE is set', async () => {
  const probeFile = join(workspace, 'hook-probe.jsonl');
  process.env.AGENT_RUNTIME_HOOK_PROBE_FILE = probeFile;
  const native = JSON.parse(await readFile(fixture, 'utf8')) as Record<string, unknown>;

  await renderRoute('event:tool/after', {
    // The harness validates the Claude envelope and projects `canonical.payload`
    // (cwd, sessionId, toolName, toolInput) exactly as the artifact's wrapper does.
    input: createEventRouteInput('tool/after', { ...native, cwd: workspace }, { host: 'claude' }),
  });

  const probe = JSON.parse(await readFile(probeFile, 'utf8'));
  expect(probe).toEqual({
    commandLaunched: true,
    exitStatus: 0,
    toolInputKeys: ['file_path'],
    toolInputValueTypes: { file_path: 'string' },
    toolName: 'Write',
    topLevelKeys: ['cwd', 'hook_event_name', 'session_id', 'tool_input', 'tool_name', 'tool_response', 'tool_use_id', 'transcript_path'],
    topLevelValueTypes: {
      cwd: 'string',
      hook_event_name: 'string',
      session_id: 'string',
      tool_input: 'object',
      tool_name: 'string',
      tool_response: 'object',
      tool_use_id: 'string',
      transcript_path: 'string',
    },
  });
  expect(await readFile(probeFile, 'utf8')).not.toContain('claude-note.txt');
});
