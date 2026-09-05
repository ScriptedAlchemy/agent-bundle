import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import {
  SkillDocumentPanel,
  SkillEvalCoverage,
  SkillFrontmatter,
  skillGenerationSummaryFor,
  SkillResourceTree,
} from '../src/application/skill-document-panel.tsx';
import { skillIdFor, SkillWorkspace } from '../src/application/skill-workspace.tsx';
import { clients, skillLeaf, status, toolLeaf } from './support/workspace-fixtures.ts';

const document = {
  base: { kind: 'source' as const, skillId: 'skill:review' },
  body: '# Review\n\nUse [guide](guide.md).\n',
  diagnostics: [],
  frontmatter: { description: 'Reviews changes', name: 'review' },
  id: 'skill:review',
  markdown: '---\nname: review\ndescription: Reviews changes\n---\n# Review\n\nUse [guide](guide.md).\n',
  name: 'review',
  provenance: { kind: 'conventional' as const, sourcePath: 'skills/review/SKILL.md' },
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
  expect(markup).toContain('data-testid="rendered-document"');
  expect(markup).toContain('# Generated review');
  expect(markup).not.toContain('Reviews changes');
});

it('describes identical and adapted host output without implying a transformation', () => {
  expect(skillGenerationSummaryFor(document, { ...generatedDocument, markdown: document.markdown }, 'portable')).toEqual({
    kind: 'identical',
    message: 'This target keeps the authored instructions unchanged. Agent Bundle only changes the portable package layout.',
  });
  expect(skillGenerationSummaryFor(document, generatedDocument, 'claude')).toEqual({
    kind: 'modified',
    message: 'Generated output differs from the authored Skill for claude. Review the generated document before shipping.',
  });
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
});

it('explains when generated output intentionally matches the authored Skill', () => {
  const markup = renderToStaticMarkup(createElement(SkillDocumentPanel, {
    document: 'generated',
    onDocumentChange: () => undefined,
    onTargetChange: () => undefined,
    onViewChange: () => undefined,
    selected: generatedDocument,
    target: 'portable',
    targetNames: ['portable'],
    translationSummary: 'Unchanged for portable — this target ships the authored Skill document as written.',
    view: 'rendered',
  }));

  expect(markup).toContain('Unchanged for portable');
  expect(markup).toContain('ships the authored Skill document as written');
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

it('renders the resource tree with served links, the frontmatter with document details, and eval coverage badges', () => {
  const resources = renderToStaticMarkup(createElement(SkillResourceTree, { document: generatedDocument }));
  expect(resources).toContain('aria-label="Resource tree"');
  expect(resources).toContain('/api/skills/epochs/epoch-01/portable/skill%3Areview/resources/portable-guide.md');
  const sourceResources = renderToStaticMarkup(createElement(SkillResourceTree, { document }));
  expect(sourceResources).toContain('/api/skills/source/skill%3Areview/resources/guide.md');

  const frontmatter = renderToStaticMarkup(createElement(SkillFrontmatter, { selected: generatedDocument }));
  expect(frontmatter).toContain('aria-label="Parsed frontmatter"');
  expect(frontmatter).toContain('Generated review instructions');
  expect(frontmatter).toContain('Document details');
  expect(frontmatter).toContain('Build ID');
  expect(frontmatter).toContain('epoch-01');

  const coverage = renderToStaticMarkup(createElement(SkillEvalCoverage, {
    coverage: {
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
  }));
  expect(coverage).toContain('aria-label="Eval coverage"');
  expect(coverage).toContain('Direct 1');
  expect(coverage).toContain('Indirect 0');
  expect(coverage).toContain('Negative 1');
  expect(coverage).toContain('review-suite / activates-on-request');
  expect(coverage).toContain('skill-coverage-badge--direct');
  expect(coverage).toContain('skill-coverage-badge--negative');
});

it('reports eval coverage loading and unavailable states without listing cases', () => {
  const loading = renderToStaticMarkup(createElement(SkillEvalCoverage, { coverage: { state: 'loading' } }));
  const unavailable = renderToStaticMarkup(createElement(SkillEvalCoverage, {
    coverage: { state: 'unavailable', summary: 'Eval coverage is unavailable because authored suites could not be loaded.' },
  }));

  expect(loading).toContain('Loading eval coverage…');
  expect(unavailable).toContain('Eval coverage is unavailable because authored suites could not be loaded.');
  expect(unavailable).not.toContain('skill-coverage-badge');
});

it('mounts the rendered document as the center with the inspector closed, and names the served skill id', () => {
  expect(skillIdFor(skillLeaf)).toBe('skill:review');
  expect(skillIdFor(toolLeaf)).toBeUndefined();

  const markup = renderToStaticMarkup(createElement(SkillWorkspace, { clients: clients(), leaf: skillLeaf, status }));

  expect(markup).toContain('data-testid="route-workspace"');
  expect(markup).toContain('aria-label="Skill document"');
  expect(markup).toContain('>Source</button>');
  expect(markup).toContain('>Generated</button>');
  expect(markup).toContain('Loading the authored Skill…');
  expect(markup).toContain('data-testid="inspector-toggle"');
  expect(markup).not.toContain('aria-label="Resource tree"');
});
