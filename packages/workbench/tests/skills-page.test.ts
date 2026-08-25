import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import { EvalClient } from '../src/evals/eval-client.ts';
import { SkillClient } from '../src/skill-client.ts';
import { SkillDocumentPanel, SkillsPage, SkillTree } from '../src/skills-page.tsx';

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
  expect(markup).toContain('Generated for portable');
  expect(markup).toContain('Generated · epoch-01/portable');
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

  expect(markup).toContain('Authored SKILL.md');
  expect(markup).toContain('---\nname: review');
  expect(markup).toContain('/api/skills/source/skill%3Areview/resources/guide.md');
});

it('explains the authored, generated, resource, and eval-coverage views', () => {
  const markup = renderToStaticMarkup(createElement(SkillsPage, {
    client: new SkillClient(),
    evalClient: new EvalClient(),
    status: {
      artifact: { state: 'missing' },
      build: { state: 'idle' },
      source: { diagnostics: [], state: 'unknown' },
    },
  }));

  expect(markup).toContain('authored SKILL.md');
  expect(markup).toContain('linked resources');
  expect(markup).toContain('immutable host-generated document');
  expect(markup).toContain('authored eval coverage');
});

it('tells authors how to add their first Skill', () => {
  const markup = renderToStaticMarkup(createElement(SkillTree, {
    onSelect: () => undefined,
    selectedId: undefined,
    tree: { diagnostics: [], skills: [] },
  }));

  expect(markup).toContain('Add a Skill path to agent-bundle.config.ts');
});

it('explains when the selected generated target has no Skills', () => {
  const markup = renderToStaticMarkup(createElement(SkillTree, {
    kind: 'generated',
    onSelect: () => undefined,
    selectedId: undefined,
    tree: { diagnostics: [], skills: [] },
  }));

  expect(markup).toContain('No generated Skills are available for this target.');
  expect(markup).not.toContain('No authored Skills are available.');
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

it('renders eval coverage with per-case kind badges beneath the resource tree', () => {
  const markup = renderToStaticMarkup(createElement(SkillDocumentPanel, {
    document: 'source',
    evalCoverage: {
      coverage: {
        direct: 1,
        entries: [
          { caseId: 'activates-on-request', kinds: ['direct'], suite: 'review-suite' },
          { caseId: 'stays-quiet', kinds: ['negative'], suite: 'review-suite' },
        ],
        indirect: 0,
        negative: 1,
      },
      state: 'ready',
    },
    onDocumentChange: () => undefined,
    onViewChange: () => undefined,
    selected: document,
    view: 'rendered',
  }));

  expect(markup).toContain('aria-label="Eval coverage"');
  expect(markup).toContain('Direct 1');
  expect(markup).toContain('Indirect 0');
  expect(markup).toContain('Negative 1');
  expect(markup).toContain('review-suite / activates-on-request');
  expect(markup).toContain('skill-coverage-badge--direct');
  expect(markup).toContain('skill-coverage-badge--negative');
});

it('reports eval coverage loading and unavailable states without listing cases', () => {
  const loading = renderToStaticMarkup(createElement(SkillDocumentPanel, {
    document: 'source',
    evalCoverage: { state: 'loading' },
    onDocumentChange: () => undefined,
    onViewChange: () => undefined,
    selected: document,
    view: 'rendered',
  }));
  const unavailable = renderToStaticMarkup(createElement(SkillDocumentPanel, {
    document: 'source',
    evalCoverage: { state: 'unavailable', summary: 'Eval coverage is unavailable because authored suites could not be loaded.' },
    onDocumentChange: () => undefined,
    onViewChange: () => undefined,
    selected: document,
    view: 'rendered',
  }));

  expect(loading).toContain('Loading eval coverage…');
  expect(unavailable).toContain('Eval coverage is unavailable because authored suites could not be loaded.');
  expect(unavailable).not.toContain('skill-coverage-badge');
});

it('keeps generated document navigation and its target available while no generated document is selected', () => {
  const markup = renderToStaticMarkup(createElement(SkillDocumentPanel, {
    document: 'generated',
    onDocumentChange: () => undefined,
    onTargetChange: () => undefined,
    onViewChange: () => undefined,
    selected: undefined,
    summary: 'Loading portable from the current build…',
    target: 'portable',
    targetNames: ['portable'],
    view: 'rendered',
  }));

  expect(markup).toContain('>Document<');
  expect(markup).toContain('>View<');
  expect(markup).toContain('>Target<');
  expect([...markup.matchAll(/role="tablist"/gu)]).toHaveLength(2);
  expect(markup).toContain('Loading portable from the current build…');
  expect(markup).toContain('id="skill-skills-panel"');
  expect(markup).toContain('aria-controls="skill-skills-panel"');
  expect(markup).toContain('aria-labelledby="skill-skills-document-tab-generated skill-skills-view-tab-rendered"');
});
