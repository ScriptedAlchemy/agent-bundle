import { expect, it } from '@rstest/core';

import type { Diagnostic } from '../../agent-bundle/src/core/diagnostics.ts';
import type {
  ArtifactEpochDiff,
  ArtifactInspection,
  ArtifactInspectionFile,
  ArtifactInspectionTarget,
} from '../../agent-bundle/src/dev/types.ts';
import {
  artifactDiffViewFor,
  artifactEpochIdentityRowsFor,
  artifactProvenanceRowsFor,
  artifactRuntimeViewFor,
  artifactTreeRowsFor,
  artifactViewFor,
} from '../src/artifacts/artifacts-model.ts';

const wrapper: ArtifactInspectionFile = {
  bytes: 512,
  kind: 'generated',
  mode: 0o755,
  path: 'claude/hooks/session-start.mjs',
  sha256: 'a'.repeat(64),
  sourceInputs: [{ path: 'hooks/session-start.ts', sha256: 'b'.repeat(64) }],
};

const agents: ArtifactInspectionFile = {
  bytes: 128,
  kind: 'copy',
  path: 'claude/AGENTS.md',
  sha256: 'c'.repeat(64),
  sourceInputs: [],
};

/** The service emits directories before files; the model must order regardless of arrival order. */
const target: ArtifactInspectionTarget = {
  name: 'claude',
  tree: {
    children: [
      { file: agents, kind: 'file', name: 'AGENTS.md', path: 'claude/AGENTS.md' },
      {
        children: [{ file: wrapper, kind: 'file', name: 'session-start.mjs', path: 'claude/hooks/session-start.mjs' }],
        kind: 'directory',
        name: 'hooks',
        path: 'claude/hooks',
      },
    ],
    kind: 'directory',
    name: 'claude',
    path: 'claude',
  },
};

const inspection: ArtifactInspection = {
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
    { outputPath: 'claude/hooks/session-start.mjs', sourceInputs: [{ path: 'hooks/session-start.ts', sha256: 'b'.repeat(64) }] },
    { outputPath: 'claude/AGENTS.md', sourceInputs: [] },
  ],
  runtime: {
    executables: [wrapper],
    hooks: [{
      event: 'sessionStart',
      file: wrapper,
      id: 'hook:session-start',
      name: 'session-start',
      path: 'claude/hooks/session-start.mjs',
      target: 'claude',
      timeout: 30,
    }],
    mcpServers: [{
      entryPaths: ['claude/mcp/review/server.mjs'],
      kind: 'stdio',
      manifestPath: 'claude/.mcp.json',
      name: 'review',
      target: 'claude',
    }],
    scripts: [],
  },
  targets: [target],
};

const diff: ArtifactEpochDiff = {
  added: [{ after: agents, path: 'claude/AGENTS.md' }],
  baseEpochId: 'epoch-1',
  candidateEpochId: 'epoch-2',
  changed: [{ after: wrapper, before: { ...wrapper, bytes: 400, sha256: 'd'.repeat(64) }, path: 'claude/hooks/session-start.mjs' }],
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

it('flattens one target tree into ordered directory and file rows', () => {
  const rows = artifactTreeRowsFor(target);

  expect(rows.map((row) => row.path)).toEqual([
    'claude',
    'claude/hooks',
    'claude/hooks/session-start.mjs',
    'claude/AGENTS.md',
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

it('derives runtime rows for hooks, MCP servers, and executables', () => {
  const runtime = artifactRuntimeViewFor(inspection.runtime);

  expect(runtime.hooks).toEqual([{
    bytes: 512,
    event: 'sessionStart',
    key: 'claude/hook:session-start',
    label: 'session-start · sessionStart · claude',
    path: 'claude/hooks/session-start.mjs',
    sha256: 'a'.repeat(64),
    target: 'claude',
    timeout: 30,
  }]);
  expect(runtime.mcpServers).toEqual([{
    entryPaths: ['claude/mcp/review/server.mjs'],
    key: 'claude/review',
    kind: 'stdio',
    label: 'review · stdio · claude',
    manifestPath: 'claude/.mcp.json',
    target: 'claude',
  }]);
  expect(runtime.executables).toEqual([{
    bytes: 512,
    key: 'claude/hooks/session-start.mjs',
    kind: 'generated',
    mode: '0755',
    path: 'claude/hooks/session-start.mjs',
    sha256: 'a'.repeat(64),
  }]);
  expect(Object.isFrozen(runtime)).toBe(true);
});

it('orders provenance rows by output path and keeps their declared source inputs', () => {
  const rows = artifactProvenanceRowsFor(inspection.provenance);

  expect(rows.map((row) => row.outputPath)).toEqual(['claude/AGENTS.md', 'claude/hooks/session-start.mjs']);
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
    path: 'claude/AGENTS.md',
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

it('derives a ready view bound to the selected target', () => {
  const view = artifactViewFor({
    diagnostics: [],
    diff: undefined,
    epochId: 'epoch-2',
    inspection,
    selectedTarget: 'claude',
  });

  expect(view.state).toBe('ready');
  expect(view.targets.map((option) => option.name)).toEqual(['claude']);
  expect(view.selected?.name).toBe('claude');
  expect(view.tree.map((row) => row.path)).toContain('claude/hooks/session-start.mjs');
  expect(view.hooks).toHaveLength(1);
  expect(view.mcpServers).toHaveLength(1);
  expect(view.executables).toHaveLength(1);
  expect(view.provenance).toHaveLength(2);
  expect(view.identity[0]).toEqual({ label: 'Build ID', value: 'epoch-2' });
  expect(view.summary).toContain('epoch-2');
  expect(view.diagnostics).toEqual([]);
  expect(Object.isFrozen(view)).toBe(true);
});

it('falls back to the first declared target when the selection names none', () => {
  const view = artifactViewFor({
    diagnostics: [],
    diff: undefined,
    epochId: 'epoch-2',
    inspection,
    selectedTarget: 'codex',
  });

  expect(view.selected?.name).toBe('claude');
});

it('surfaces validation diagnostics instead of an inspection', () => {
  const view = artifactViewFor({
    diagnostics,
    diff: undefined,
    epochId: 'epoch-2',
    inspection: undefined,
    selectedTarget: undefined,
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
    selectedTarget: undefined,
  });
  const missing = artifactViewFor({
    diagnostics: [],
    diff: undefined,
    epochId: undefined,
    inspection: undefined,
    selectedTarget: undefined,
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
    selectedTarget: undefined,
  });

  expect(view.diff?.baseEpochId).toBe('epoch-1');
  expect(view.diff?.groups).toHaveLength(4);
});
