import { describe, expect, it } from '@rstest/core';

import {
  audioData,
  audioMimeType,
  baselineText,
  imageData,
  imageMimeType,
  resourceMimeType,
  resourceName,
  resourceUri,
} from '../fixtures/target-capabilities/rich-content.ts';
import * as RichContentRoute from '../fixtures/target-capabilities/rich-content.ts';
import {
  AgentTestError,
  createTargetCapabilityFixture,
  expectDocument,
  projectTargetCapabilities,
  renderRouteEvents,
  type RenderedRouteEvents,
} from '../../src/test/index.ts';

const renderRichContent = (): Promise<RenderedRouteEvents> => renderRouteEvents(RichContentRoute, {
  routeId: 'tool:fixtures/rich-content',
});

const fixture = (
  overrides: Partial<Parameters<typeof createTargetCapabilityFixture>[0]> = {},
) => createTargetCapabilityFixture({
  audio: true,
  image: true,
  progress: true,
  resource: true,
  richContentFallback: 'fail',
  ...overrides,
});

describe('route-unit target-capability projection', () => {
  it('asserts rich Agent Document nodes without treating them as text', async () => {
    const rendered = await renderRichContent();

    expectDocument(rendered)
      .toHaveNodeKinds(['result', 'text', 'image', 'audio', 'resource'])
      .toContainText(baselineText)
      .toContainImage({ data: imageData, mimeType: imageMimeType })
      .toContainAudio({ data: audioData, mimeType: audioMimeType })
      .toContainResource({ mimeType: resourceMimeType, name: resourceName, uri: resourceUri });
  });

  it('projects supported rich content and requested progress through the runtime projector', async () => {
    const projected = await projectTargetCapabilities(await renderRichContent(), fixture());

    expect(projected.content).toEqual([
      { text: baselineText, type: 'text' },
      { data: imageData, mimeType: imageMimeType, type: 'image' },
      { data: audioData, mimeType: audioMimeType, type: 'audio' },
      { mimeType: resourceMimeType, name: resourceName, type: 'resource_link', uri: resourceUri },
    ]);
    expect(projected.progress).toEqual([{
      message: 'projecting rich content',
      progress: 1,
      progressToken: 'agent-bundle-target-capability-fixture',
      total: 1,
    }]);
    expect(projected.provenance.proofLevel).toBe('route-unit');
    expect(projected.structuredContent).toEqual({ fixture: 'target-capabilities' });
  });

  it('uses exact text fallbacks and leaks no denied rich block', async () => {
    const projected = await projectTargetCapabilities(await renderRichContent(), fixture({
      audio: false,
      image: false,
      progress: false,
      resource: false,
      richContentFallback: 'text',
    }));

    expect(projected.content).toEqual([
      { text: baselineText, type: 'text' },
      { text: `[image ${imageMimeType}]`, type: 'text' },
      { text: `[audio ${audioMimeType}]`, type: 'text' },
      { text: `[resource ${resourceName} ${resourceUri}]`, type: 'text' },
    ]);
    expect(projected.content.every((block) => block.type === 'text')).toBe(true);
    expect(projected.progress).toEqual([]);
  });

  it.each([
    ['image', { image: false }],
    ['audio', { audio: false }],
    ['resource', { resource: false }],
  ] as const)('fails closed and identifies denied %s content', async (kind, denied) => {
    const error = await projectTargetCapabilities(
      await renderRichContent(),
      fixture({ ...denied, progress: false }),
    ).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(AgentTestError);
    expect(error).toMatchObject({ code: 'unsupported-rich-content' });
    expect((error as AgentTestError).message).toContain(`offending kind: ${kind}`);
    expect((error as AgentTestError).message).toContain('route-unit');
  });

  it('records text as the immutable baseline capability', () => {
    expect(fixture()).toMatchObject({
      audio: true,
      image: true,
      progress: true,
      resource: true,
      richContentFallback: 'fail',
      text: true,
    });
  });
});
