import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import type { Diagnostic } from '../../agent-bundle/src/core/diagnostics.ts';
import type {
  ArtifactEpochDiff,
  ArtifactInspection,
  ArtifactInspectionFile,
} from '../../agent-bundle/src/dev/types.ts';
import { ArtifactClient } from '../src/artifacts/artifact-client.ts';
import {
  ArtifactEpochDiffView,
  ArtifactInspectionView,
  ArtifactsPage,
  compareArtifactEpochs,
  inspectArtifactEpoch,
} from '../src/artifacts/artifacts-page.tsx';
import { artifactViewFor } from '../src/artifacts/artifacts-model.ts';

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
  provenance: [{
    outputPath: 'claude/hooks/session-start.mjs',
    sourceInputs: [{ path: 'hooks/session-start.ts', sha256: 'b'.repeat(64) }],
  }],
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
  targets: [{
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
  }],
};

const diff: ArtifactEpochDiff = {
  added: [{ after: agents, path: 'claude/AGENTS.md' }],
  baseEpochId: 'epoch-1',
  candidateEpochId: 'epoch-2',
  changed: [{ after: wrapper, before: { ...wrapper, bytes: 400, sha256: 'd'.repeat(64) }, path: 'claude/hooks/session-start.mjs' }],
  removed: [],
  unchanged: [],
};

const diagnostics: readonly Diagnostic[] = [{
  code: 'AB4301',
  message: 'MCP server "review" declares an entry path that is not emitted.',
  recovery: 'Correct the MCP server configuration and referenced source files, then inspect again.',
  severity: 'error',
  target: 'claude',
}];

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
});

const sessionFetch = (reply: (url: string) => Response): typeof fetch => async (input) => {
  const url = String(input);
  if (url === '/api/project/session') return response({ origin: 'http://127.0.0.1:5173', token: 'foreground-token' });
  return reply(url);
};

const readyView = artifactViewFor({
  diagnostics: [],
  diff: undefined,
  epochId: 'epoch-2',
  inspection,
  selectedTarget: 'claude',
});

it('renders the epoch identity, artifact tree, runtime metadata, and provenance', () => {
  const markup = renderToStaticMarkup(createElement(ArtifactInspectionView, { view: readyView }));

  expect(markup).toContain('Epoch identity');
  expect(markup).toContain('Artifact tree');
  expect(markup).toContain('Runtime');
  expect(markup).toContain('Provenance');
  expect(markup).toContain('revision-9');
  expect(markup).toContain('config-digest');
  expect(markup).toContain('claude/hooks/session-start.mjs');
  expect(markup).toContain('0755');
  expect(markup).toContain('session-start · sessionStart · claude');
  expect(markup).toContain('review · stdio · claude');
  expect(markup).toContain('claude/.mcp.json');
  expect(markup).toContain('hooks/session-start.ts');
  expect(markup).toContain('a'.repeat(64));
});

it('renders artifact validation diagnostics as a visible alert', () => {
  const markup = renderToStaticMarkup(createElement(ArtifactInspectionView, {
    view: artifactViewFor({
      diagnostics,
      diff: undefined,
      epochId: 'epoch-2',
      inspection: undefined,
      selectedTarget: undefined,
    }),
  }));

  expect(markup).toContain('role="alert"');
  expect(markup).toContain('AB4301');
  expect(markup).toContain('declares an entry path that is not emitted');
  expect(markup).toContain('Correct the MCP server configuration');
});

it('renders each diff group with its count and both epoch digests', () => {
  const markup = renderToStaticMarkup(createElement(ArtifactEpochDiffView, {
    view: artifactViewFor({ diagnostics: [], diff, epochId: 'epoch-2', inspection, selectedTarget: undefined }),
  }));

  expect(markup).toContain('Added');
  expect(markup).toContain('Removed');
  expect(markup).toContain('Changed');
  expect(markup).toContain('Unchanged');
  expect(markup).toContain('epoch-1');
  expect(markup).toContain('claude/AGENTS.md');
  expect(markup).toContain('d'.repeat(64));
});

it('states that no epoch comparison has been requested yet', () => {
  const markup = renderToStaticMarkup(createElement(ArtifactEpochDiffView, { view: readyView }));

  expect(markup).toContain('No epoch comparison has been requested.');
});

it('renders no inspection controls when no epoch is active', () => {
  const client = new ArtifactClient({
    fetch: async () => { throw new Error('No epoch may issue an artifact inspection request.'); },
  });
  const markup = renderToStaticMarkup(createElement(ArtifactsPage, { client, epochId: undefined }));

  expect(markup).toContain('No artifact epoch is active');
  expect(markup).not.toContain('id="artifact-target"');
  expect(markup).not.toContain('id="artifact-diff-base"');
});

it('renders the target and epoch comparison controls for an active epoch', () => {
  const client = new ArtifactClient({ fetch: sessionFetch(() => response({ inspection })) });
  const markup = renderToStaticMarkup(createElement(ArtifactsPage, { client, epochId: 'epoch-2' }));

  expect(markup).toContain('id="artifact-target"');
  expect(markup).toContain('id="artifact-diff-base"');
  expect(markup).toContain('Compare epochs');
});

it('turns a validation failure into renderable diagnostics instead of an opaque error', async () => {
  const client = new ArtifactClient({
    fetch: sessionFetch(() => response({
      diagnostic: { code: 'AB8064', message: 'Artifact epoch failed validation.' },
      diagnostics,
    }, 422)),
  });

  const result = await inspectArtifactEpoch(client, 'epoch-2');

  expect(result.inspection).toBeUndefined();
  expect(result.diagnostics).toEqual(diagnostics);
  expect(result.error).toBe('Artifact epoch failed validation.');
});

it('reports a transport failure as an error with no diagnostics', async () => {
  const client = new ArtifactClient({ fetch: sessionFetch(() => response({}, 503)) });

  const result = await inspectArtifactEpoch(client, 'epoch-2');

  expect(result.diagnostics).toEqual([]);
  expect(result.error).toContain('HTTP 503');
});

it('compares an authored base epoch against the active epoch, never two authored ids', async () => {
  const urls: string[] = [];
  const client = new ArtifactClient({
    fetch: sessionFetch((url) => {
      urls.push(url);
      return response({ diff });
    }),
  });

  await expect(compareArtifactEpochs(client, ' epoch-1 ', 'epoch-2')).resolves.toMatchObject({ baseEpochId: 'epoch-1' });

  expect(urls).toEqual(['/api/artifacts/diff?base=epoch-1&candidate=epoch-2']);
});

it('issues no comparison request for a blank base epoch id', async () => {
  const client = new ArtifactClient({
    fetch: sessionFetch(() => { throw new Error('A blank base epoch id may not issue a diff request.'); }),
  });

  await expect(compareArtifactEpochs(client, '   ', 'epoch-2')).resolves.toBeUndefined();
});
