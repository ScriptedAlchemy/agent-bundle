import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';
import {
  createTargetCapabilityFixture,
  expectDocument,
  projectTargetCapabilities,
  renderRouteEvents,
} from 'agent-bundle/test';

const documentText = (value: unknown): string => JSON.stringify(value);

it('streams library analysis after the audit shell while preserving the canonical receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'curator-route-unit-streaming-'));
  try {
    const library = join(directory, 'library');
    await mkdir(library, { recursive: true });
    await writeFile(join(library, 'Shared title.mp3'), 'tiny');
    await writeFile(join(library, 'Shared title.flac'), 'somewhat larger');

    const rendered = await renderRouteEvents('tool:curator/audit_library', {
      input: { concurrency: 1, sources: [library] },
    });
    const intermediateDocuments = rendered.events.flatMap((event) => {
      switch (event.type) {
        case 'shell':
        case 'replace':
          return [event.document];
        case 'complete':
        case 'error':
        case 'progress':
          return [];
        default: {
          const unhandled: never = event;
          throw new Error(`Unhandled render event: ${JSON.stringify(unhandled)}`);
        }
      }
    });

    expect(intermediateDocuments.some((document) =>
      documentText(document).includes('Analyzing duplicate and multipart groups')
      && documentText(document).includes('"kind":"progress"'))).toBe(true);
    expectDocument(rendered)
      .toContainMarkdown('**Reclaimable bytes:** 4')
      .toContainMarkdown(`- ${join(library, 'Shared title.flac')}\n- ${join(library, 'Shared title.mp3')}`)
      .toContainContext('Duplicate candidate group')
      .toHaveValue(rendered.result);
    expect(rendered.result).toEqual(rendered.document.value);
    expect(rendered.result).toMatchObject({
      duplicateCandidates: [{ files: [join(library, 'Shared title.flac'), join(library, 'Shared title.mp3')] }],
      operation: 'library-audit',
      summary: { files: 2 },
    });

    const projected = await projectTargetCapabilities(
      rendered,
      createTargetCapabilityFixture({
        audio: false,
        image: false,
        progress: true,
        resource: false,
        richContentFallback: 'text',
      }),
    );

    // The route never calls `progress.report()`: the streamed Suspense fallback
    // alone is what the MCP projector announces (agent-bundle#448).
    expect(rendered.events.some((event) => event.type === 'progress')).toBe(false);
    expect(projected.progress).toEqual([{
      message: 'Analyzing duplicate and multipart groups',
      progress: 0,
      progressToken: 'agent-bundle-target-capability-fixture',
    }]);
    expect(projected.structuredContent).toEqual(rendered.document.value);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
});
