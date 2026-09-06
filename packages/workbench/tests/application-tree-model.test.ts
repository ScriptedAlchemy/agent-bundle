import { expect, it } from '@rstest/core';

import type { ArtifactInspection } from '../../agent-bundle/src/contracts/artifacts.ts';
import type { RouteManifest } from '../../agent-bundle/src/contracts/routes.ts';
import type { SkillDocumentTree } from '../../agent-bundle/src/contracts/skills.ts';
import { applicationLeaves, applicationTreeFor } from '../src/application/application-tree-model.ts';

const digest = 'd'.repeat(64);
const file = {
  bytes: 1,
  kind: 'generated' as const,
  path: 'portable/scripts/configured.mjs',
  sha256: digest,
  sourceInputs: [],
};

const manifest: RouteManifest = {
  diagnostics: [],
  digest,
  events: [],
  providers: [],
  scripts: [],
  servers: [],
  sourceRevision: digest,
};

const skillTree: SkillDocumentTree = {
  diagnostics: [],
  skills: [{
    base: { kind: 'source', skillId: 'skill:review' },
    body: '# Review',
    diagnostics: [],
    frontmatter: { description: 'Review changes', name: 'review' },
    id: 'skill:review',
    markdown: '# Review',
    name: 'Review changes',
    provenance: { kind: 'conventional', sourcePath: 'skills/review/SKILL.md' },
    resources: [],
  }],
  staticDocuments: [],
};

const inspection: ArtifactInspection = {
  application: {
    distribution: { channels: ['local'], payloads: [] },
    events: [],
    hooks: [{
      hooks: [{ event: 'session/start', id: 'hook:configured', kind: 'config', name: 'configured-hook', path: 'hooks/configured.mjs' }],
      host: 'claude',
    }],
    hosts: [
      { builtIn: true, documents: [{ kind: 'plugin', path: '.claude-plugin/plugin.json' }], host: 'claude' },
      { builtIn: true, documents: [{ kind: 'plugin', path: 'plugin.json' }], host: 'portable' },
    ],
    identity: { id: 'application:fixture', name: 'fixture', version: '1.0.0' },
    scripts: [{ hosts: ['portable'], id: 'script:configured', mode: 'bundle', name: 'configured', path: file.path }],
    servers: [],
  },
  epochId: 'epoch-a',
  files: [],
  project: {
    configDigest: digest,
    configPath: 'agent-bundle.config.ts',
    modelDigest: digest,
    revision: digest,
    sourceInputs: [],
  },
  projections: [],
  provenance: [],
  runtime: {
    bins: [],
    executables: [],
    hooks: [{
      event: 'session/start',
      file,
      id: 'hook:configured',
      kind: 'config',
      name: 'configured-hook',
      path: 'hooks/configured.mjs',
      target: 'claude',
    }],
    mcpServers: [{
      apps: [],
      entryPaths: [],
      kind: 'remote',
      manifestPath: 'mcp.json',
      name: 'external',
      target: 'portable',
      transport: 'streamable-http',
    }],
    scripts: [{
      file,
      id: 'script:configured',
      mode: 'bundle',
      name: 'configured',
      target: 'portable',
    }],
  },
};

it('adapts Workbench skill and artifact sources into the shared pure tree', () => {
  const tree = applicationTreeFor({
    inspection,
    manifest,
    skillTree,
    state: 'current',
  });

  expect(tree.state).toBe('fresh');
  const mcp = tree.groups.find((group) => group.kind === 'mcp');
  if (mcp?.kind !== 'mcp') throw new Error('Expected an MCP group.');
  expect(mcp.servers.map((server) => [server.server, server.mode])).toEqual([['external', 'streamable-http']]);
  expect(applicationLeaves(tree).map((leaf) => ({
    description: leaf.description,
    kind: leaf.ref.kind,
    label: leaf.label,
    source: leaf.source,
  }))).toEqual([
    {
      description: 'configured in agent-bundle.config, no route module',
      kind: 'event',
      label: 'session/start',
      source: 'hooks/configured.mjs',
    },
    {
      description: 'configured in agent-bundle.config, no route module',
      kind: 'script',
      label: 'configured',
      source: 'portable/scripts/configured.mjs',
    },
    {
      description: undefined,
      kind: 'skill',
      label: 'Review changes',
      source: 'skills/review/SKILL.md',
    },
  ]);
});

it('maps stale and unavailable route catalog states without hiding auxiliary leaves', () => {
  expect(applicationTreeFor({ manifest, state: 'stale' }).state).toBe('stale');
  const unavailable = applicationTreeFor({
    message: 'Route manifest is not available.',
    skillTree,
    state: 'unavailable',
  });

  expect(unavailable.state).toBe('unavailable');
  expect(unavailable.message).toBe('Route manifest is not available.');
  expect(applicationLeaves(unavailable).map((leaf) => leaf.label)).toEqual(['Review changes']);
});
