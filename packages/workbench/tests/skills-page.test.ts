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

it('renders a selected Skill with explicit Rendered, Source, and unavailable Generated states', () => {
  const markup = renderToStaticMarkup(createElement(SkillDocumentPanel, {
    generated: { state: 'unavailable', summary: 'No artifact epoch is active.' },
    onTabChange: () => undefined,
    selected: document,
    tab: 'rendered',
  }));

  expect(markup).toContain('Rendered');
  expect(markup).toContain('Source');
  expect(markup).toContain('Generated');
  expect(markup).toContain('Source base');
  expect(markup).toContain('Resource tree');
  expect(markup).toContain('Reviews changes');
  expect(markup).toContain('/api/skills/source/skill%3Areview/resources/guide.md');
});

it('gives each Skill view a complete roving-tab and labelled-tabpanel contract', () => {
  const markup = renderToStaticMarkup(createElement(SkillDocumentPanel, {
    generated: { state: 'unavailable', summary: 'No artifact epoch is active.' },
    onTabChange: () => undefined,
    selected: document,
    tab: 'rendered',
  }));

  expect(markup).toContain('role="tablist"');
  expect(markup).toContain('role="tab"');
  expect(markup).toContain('aria-controls="skill-review-panel-rendered"');
  expect(markup).toContain('id="skill-review-tab-rendered"');
  expect(markup).toContain('tabindex="0"');
  expect(markup).toContain('tabindex="-1"');
  expect(markup).toContain('role="tabpanel"');
  expect(markup).toContain('id="skill-review-panel-rendered"');
  expect(markup).toContain('aria-labelledby="skill-review-tab-rendered"');
});
