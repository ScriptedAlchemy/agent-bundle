import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import { SkillDocumentPanel } from '../src/skills-page.tsx';

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
    onViewChange: () => undefined,
    selected: generatedDocument,
    view: 'markdown',
  }));

  expect([...markup.matchAll(/role="tablist"/gu)]).toHaveLength(2);
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
