import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import type { ProjectStatus } from '../../agent-bundle/src/dev/types.ts';
import { SkillClient } from '../src/skill-client.ts';
import { SkillDocumentPanel, SkillsPage } from '../src/skills-page.tsx';

const document = {
  base: { kind: 'source' as const, skillId: 'skill:review' },
  body: '# Review\n\nUse [guide](guide.md).\n',
  diagnostics: [],
  frontmatter: { description: 'Reviews changes', name: 'review' },
  id: 'skill:review',
  markdown: '---\nname: review\ndescription: Reviews changes\n---\n# Review\n\nUse [guide](guide.md).\n',
  name: 'review',
  resources: [{ bytes: 8, relativePath: 'guide.md' }],
  targets: ['portable'],
};

const generatedDocument = {
  base: { epochId: 'epoch-01', kind: 'generated' as const, skillId: 'skill:review', target: 'portable' },
  body: '# Generated review\n\nUse [portable guide](portable-guide.md).\n',
  diagnostics: [],
  frontmatter: { description: 'Generated review instructions', name: 'review' },
  id: 'skill:review',
  markdown: '---\nname: review\ndescription: Generated review instructions\n---\n# Generated review\n\nUse [portable guide](portable-guide.md).\n',
  name: 'review',
  resources: [{ bytes: 17, relativePath: 'portable-guide.md' }],
};

it('renders independent document and view selectors for the generated Markdown document', () => {
  const markup = renderToStaticMarkup(createElement(SkillDocumentPanel, {
    document: 'generated',
    onDocumentChange: () => undefined,
    onTargetChange: () => undefined,
    onViewChange: () => undefined,
    selected: generatedDocument,
    target: 'portable',
    targetNames: ['portable'],
    view: 'markdown',
  }));

  expect([...markup.matchAll(/role="tablist"/gu)]).toHaveLength(2);
  expect(markup).toContain('>Document<');
  expect(markup).toContain('>View<');
  expect(markup).toContain('>Target<');
  expect(markup).toContain('aria-label="Skill document"');
  expect(markup).toContain('aria-label="Document view"');
  expect(markup).toContain('Generated document · epoch-01/portable');
  expect(markup).toContain('Generated review instructions');
  expect(markup).toContain('# Generated review');
  expect(markup).not.toContain('Reviews changes');
  expect(markup).toContain('Resource tree');
  expect(markup).toContain('/api/skills/epochs/epoch-01/portable/skill%3Areview/resources/portable-guide.md');
});

it('renders source raw Markdown from the selected source document', () => {
  const markup = renderToStaticMarkup(createElement(SkillDocumentPanel, {
    document: 'source',
    onDocumentChange: () => undefined,
    onViewChange: () => undefined,
    selected: document,
    view: 'markdown',
  }));

  expect(markup).toContain('Source document · review');
  expect(markup).toContain('---\nname: review');
  expect(markup).toContain('/api/skills/source/skill%3Areview/resources/guide.md');
});

it('gives both two-option groups a complete roving-tab and labelled-tabpanel contract', () => {
  const markup = renderToStaticMarkup(createElement(SkillDocumentPanel, {
    document: 'source',
    onDocumentChange: () => undefined,
    onViewChange: () => undefined,
    selected: document,
    view: 'rendered',
  }));
  const controls = [...markup.matchAll(/aria-controls="([^"]+)"/gu)].map((match) => match[1]);

  expect(controls).toEqual([
    'skill-review-panel',
    'skill-review-panel',
    'skill-review-panel',
    'skill-review-panel',
  ]);
  expect(markup).toContain('id="skill-review-document-tab-source"');
  expect(markup).toContain('id="skill-review-document-tab-generated"');
  expect(markup).toContain('id="skill-review-view-tab-rendered"');
  expect(markup).toContain('id="skill-review-view-tab-markdown"');
  expect(markup).toContain('tabindex="0"');
  expect(markup).toContain('tabindex="-1"');
  expect(markup).toContain('role="tabpanel"');
  expect(markup).toContain('id="skill-review-panel"');
  expect(markup).toContain('aria-labelledby="skill-review-document-tab-source skill-review-view-tab-rendered"');
});

it('keeps the source and generated document selector available without an active epoch or selected document', () => {
  const status: ProjectStatus = {
    artifact: { state: 'missing' },
    build: { state: 'idle' },
    source: { diagnostics: [], state: 'unknown' },
  };
  const client = new SkillClient({ fetch: async () => { throw new Error('Effects do not run during server rendering.'); } });

  const markup = renderToStaticMarkup(createElement(SkillsPage, { client, status }));

  expect(markup).toContain('aria-label="Skill document"');
  expect(markup).toContain('>Source</button>');
  expect(markup).toContain('>Generated</button>');
  expect(markup).toContain('Loading source Skills…');
});

it('keeps generated document navigation and its target available while no generated document is selected', () => {
  const markup = renderToStaticMarkup(createElement(SkillDocumentPanel, {
    document: 'generated',
    onDocumentChange: () => undefined,
    onTargetChange: () => undefined,
    onViewChange: () => undefined,
    selected: undefined,
    summary: 'Loading portable from epoch epoch-01…',
    target: 'portable',
    targetNames: ['portable'],
    view: 'rendered',
  }));

  expect(markup).toContain('>Document<');
  expect(markup).toContain('>View<');
  expect(markup).toContain('>Target<');
  expect([...markup.matchAll(/role="tablist"/gu)]).toHaveLength(2);
  expect(markup).toContain('Loading portable from epoch epoch-01…');
  expect(markup).toContain('id="skill-skills-panel"');
  expect(markup).toContain('aria-controls="skill-skills-panel"');
  expect(markup).toContain('aria-labelledby="skill-skills-document-tab-generated skill-skills-view-tab-rendered"');
});
