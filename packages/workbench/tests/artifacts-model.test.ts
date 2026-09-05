import { expect, it } from '@rstest/core';

import type { Diagnostic } from '../../agent-bundle/src/core/diagnostics.ts';
import type {
  ArtifactEpochDiff,
  ArtifactInspection,
  ArtifactInspectionFile,
  ArtifactInspectionProjection,
} from '../../agent-bundle/src/dev/types.ts';
import {
  artifactDiffViewFor,
  artifactEpochIdentityRowsFor,
  artifactProvenanceRowsFor,
  artifactTreeRowsFor,
  artifactViewFor,
} from '../src/artifacts/artifacts-model.ts';

const wrapper: ArtifactInspectionFile = {
  bytes: 512,
  kind: 'generated',
  mode: 0o755,
  path: 'hooks/session-start.mjs',
  sha256: 'a'.repeat(64),
  sourceInputs: [{ path: 'hooks/session-start.ts', sha256: 'b'.repeat(64) }],
};

const agents: ArtifactInspectionFile = {
  bytes: 128,
  kind: 'copy',
  path: 'AGENTS.md',
  sha256: 'c'.repeat(64),
  sourceInputs: [],
};

/** The service emits directories before files; the model must order regardless of arrival order. */
const projection: ArtifactInspectionProjection = {
  documents: {
    marketplace: '.claude-plugin/marketplace.json',
    plugin: '.claude-plugin/plugin.json',
  },
  host: 'claude',
  marketplace: 'fixture-marketplace',
  tree: {
    children: [
      { file: agents, kind: 'file', name: 'AGENTS.md', path: 'AGENTS.md' },
      {
        children: [{ file: wrapper, kind: 'file', name: 'session-start.mjs', path: 'hooks/session-start.mjs' }],
        kind: 'directory',
        name: 'hooks',
        path: 'hooks',
      },
    ],
    kind: 'directory',
    name: 'claude',
    path: '.',
  },
};

const inspection: ArtifactInspection = {
  application: {
    distribution: { channels: ['local'] },
    events: [{
      event: 'sessionStart',
      hooks: [{ host: 'claude', kind: 'event-route', path: 'hooks/session-start.mjs', timeout: 30 }],
      id: 'event:session-start',
    }],
    hooks: [],
    hosts: [{
      builtIn: true,
      documents: [{ kind: 'plugin', path: '.claude-plugin/plugin.json' }],
      host: 'claude',
      marketplace: 'fixture-marketplace',
    }],
    identity: { id: 'application:fixture', name: 'fixture', version: '1.2.3' },
    scripts: [],
    servers: [{
      apps: [],
      entry: 'mcp/review/server.mjs',
      hosts: ['claude'],
      id: 'mcp:review',
      kind: 'compiled',
      name: 'review',
      prompts: [],
      resources: [],
      tools: [{ id: 'tool:review/run', name: 'tool:review/run' }],
      transport: 'stdio',
    }],
  },
  epochId: 'epoch-2',
  files: [agents, wrapper],
  project: {
    configDigest: 'config-digest',
    configPath: '/workspace/agent-bundle.config.ts',
    modelDigest: 'model-digest',
    revision: 'revision-9',
    sourceInputs: [{ path: 'hooks/session-start.ts', sha256: 'b'.repeat(64) }],
  },
  provenance: [
    { outputPath: 'hooks/session-start.mjs', sourceInputs: [{ path: 'hooks/session-start.ts', sha256: 'b'.repeat(64) }] },
    { outputPath: 'AGENTS.md', sourceInputs: [] },
  ],
  projections: [projection],
  runtime: {
    bins: [{ file: wrapper, hosts: ['claude'], name: 'fixture' }],
    executables: [wrapper],
    hooks: [{
      event: 'sessionStart',
      file: wrapper,
      id: 'hook:session-start',
      kind: 'event-route',
      name: 'session-start',
      path: 'hooks/session-start.mjs',
      target: 'claude',
      timeout: 30,
    }],
    mcpServers: [{
      apps: [],
      entryPaths: ['mcp/review/server.mjs'],
      kind: 'compiled',
      manifestPath: '.mcp.json',
      name: 'review',
      target: 'claude',
    }],
    scripts: [],
  },
};

const diff: ArtifactEpochDiff = {
  added: [{ after: agents, path: 'AGENTS.md' }],
  baseEpochId: 'epoch-1',
  candidateEpochId: 'epoch-2',
  changed: [{ after: wrapper, before: { ...wrapper, bytes: 400, sha256: 'd'.repeat(64) }, path: 'hooks/session-start.mjs' }],
  removed: [{ before: { ...agents, path: 'claude/LEGACY.md' }, path: 'claude/LEGACY.md' }],
  unchanged: [{ after: agents, before: agents, path: 'claude/README.md' }],
};

const diagnostics: readonly Diagnostic[] = [{
  code: 'AB4301',
  message: 'MCP server "review" declares an entry path that is not emitted.',
  recovery: 'Correct the MCP server configuration and referenced source files, then inspect again.',
  severity: 'error',
  target: 'claude',
}];

it('flattens one projection tree into ordered directory and file rows', () => {
  const rows = artifactTreeRowsFor(projection);

  expect(rows.map((row) => row.path)).toEqual([
    '.',
    'hooks',
    'hooks/session-start.mjs',
    'AGENTS.md',
  ]);
  expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 1]);
  expect(rows[0]).toMatchObject({ entry: 'directory', name: 'claude' });
  expect(rows[0]?.sha256).toBeUndefined();
  expect(rows[2]).toMatchObject({
    bytes: 512,
    entry: 'file',
    kind: 'generated',
    mode: '0755',
    name: 'session-start.mjs',
    sha256: 'a'.repeat(64),
  });
  expect(rows[3]?.mode).toBeUndefined();
  expect(Object.isFrozen(rows)).toBe(true);
});

it('derives epoch identity rows from the inspection and its project context', () => {
  expect(artifactEpochIdentityRowsFor(inspection)).toEqual([
    { label: 'Build ID', value: 'epoch-2' },
    { label: 'Project revision', value: 'revision-9' },
    { label: 'Config digest', value: 'config-digest' },
    { label: 'Model digest', value: 'model-digest' },
    { label: 'Config path', value: '/workspace/agent-bundle.config.ts' },
    { label: 'Emitted files', value: '2' },
  ]);
});

it('orders provenance rows by output path and keeps their declared source inputs', () => {
  const rows = artifactProvenanceRowsFor(inspection.provenance);

  expect(rows.map((row) => row.outputPath)).toEqual(['AGENTS.md', 'hooks/session-start.mjs']);
  expect(rows[0]?.sourceInputs).toEqual([]);
  expect(rows[1]?.sourceInputs).toEqual([{ path: 'hooks/session-start.ts', sha256: 'b'.repeat(64) }]);
});

it('groups an epoch diff into counted added, removed, changed, and unchanged rows', () => {
  const view = artifactDiffViewFor(diff);

  expect(view.groups.map((group) => group.change)).toEqual(['added', 'removed', 'changed', 'unchanged']);
  expect(view.groups.map((group) => group.count)).toEqual([1, 1, 1, 1]);
  expect(view.groups[0]?.rows[0]).toMatchObject({
    afterBytes: 128,
    afterSha256: 'c'.repeat(64),
    change: 'added',
    path: 'AGENTS.md',
  });
  expect(view.groups[0]?.rows[0]?.beforeSha256).toBeUndefined();
  expect(view.groups[1]?.rows[0]).toMatchObject({ change: 'removed', path: 'claude/LEGACY.md' });
  expect(view.groups[1]?.rows[0]?.afterSha256).toBeUndefined();
  expect(view.groups[2]?.rows[0]).toMatchObject({
    afterBytes: 512,
    afterSha256: 'a'.repeat(64),
    beforeBytes: 400,
    beforeSha256: 'd'.repeat(64),
  });
  expect(view.summary).toContain('epoch-1');
  expect(view.summary).toContain('epoch-2');
  expect(Object.isFrozen(view)).toBe(true);
});

it('derives a ready view bound to the selected projection', () => {
  const view = artifactViewFor({
    diagnostics: [],
    diff: undefined,
    epochId: 'epoch-2',
    inspection,
    selectedProjection: 'claude',
  });

  expect(view.state).toBe('ready');
  expect(view.projections.map((option) => option.host)).toEqual(['claude']);
  expect(view.selected?.host).toBe('claude');
  expect(view.tree.map((row) => row.path)).toContain('hooks/session-start.mjs');
  expect(view.application?.servers).toHaveLength(1);
  expect(view.application?.events).toHaveLength(1);
  expect(view.application?.hosts).toHaveLength(1);
  expect(view.provenance).toHaveLength(2);
  expect(view.identity[0]).toEqual({ label: 'Build ID', value: 'epoch-2' });
  expect(view.summary).toContain('fixture@1.2.3 build epoch-2');
  expect(view.diagnostics).toEqual([]);
  expect(Object.isFrozen(view)).toBe(true);
});

it('falls back to the first declared projection when the selection names none', () => {
  const view = artifactViewFor({
    diagnostics: [],
    diff: undefined,
    epochId: 'epoch-2',
    inspection,
    selectedProjection: 'codex',
  });

  expect(view.selected?.host).toBe('claude');
});

it('surfaces validation diagnostics instead of an inspection', () => {
  const view = artifactViewFor({
    diagnostics,
    diff: undefined,
    epochId: 'epoch-2',
    inspection: undefined,
    selectedProjection: undefined,
  });

  expect(view.state).toBe('diagnostics');
  expect(view.diagnostics).toEqual(diagnostics);
  expect(view.tree).toEqual([]);
  expect(view.summary).toContain('failed validation');
});

it('reports the empty and no-active-epoch states', () => {
  const empty = artifactViewFor({
    diagnostics: [],
    diff: undefined,
    epochId: 'epoch-2',
    inspection: undefined,
    selectedProjection: undefined,
  });
  const missing = artifactViewFor({
    diagnostics: [],
    diff: undefined,
    epochId: undefined,
    inspection: undefined,
    selectedProjection: undefined,
  });

  expect(empty.state).toBe('empty');
  expect(empty.selected).toBeUndefined();
  expect(empty.summary).toContain('Generated output has not been loaded');
  expect(missing.state).toBe('no-epoch');
  expect(missing.summary).toContain('No successful build is available');
});

it('keeps a loaded diff on the view alongside the inspection', () => {
  const view = artifactViewFor({
    diagnostics: [],
    diff,
    epochId: 'epoch-2',
    inspection,
    selectedProjection: undefined,
  });

  expect(view.diff?.baseEpochId).toBe('epoch-1');
  expect(view.diff?.groups).toHaveLength(4);
});
