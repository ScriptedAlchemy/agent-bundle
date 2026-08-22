import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { expect, it } from '@rstest/core';

import { SkillMarkdown } from '../src/skill-markdown.tsx';

const base = { kind: 'source' as const, skillId: 'skill:review' };

it('renders CommonMark and GFM while keeping HTML, JSX, and Mermaid inert', () => {
  const markup = renderToStaticMarkup(createElement(SkillMarkdown, {
    base,
    body: [
      '# Review',
      '',
      '| Name | Status |',
      '| --- | --- |',
      '| check | done |',
      '',
      '- [x] inspect',
      '',
      '<script>window.__executed = true</script>',
      '<Example value={1} />',
      '',
      '```mermaid',
      'graph TD',
      '```',
      '',
      '![Diagram](assets/diagram%20one.png)',
      '[Guide](guide.md)',
    ].join('\n'),
    resources: ['assets/diagram one.png', 'guide.md'],
  }));

  expect(markup).toContain('<table>');
  expect(markup).toContain('type="checkbox"');
  expect(markup).toContain('&lt;script&gt;window.__executed = true&lt;/script&gt;');
  expect(markup).toContain('&lt;Example value={1} /&gt;');
  expect(markup).toContain('class="skill-mermaid-code"');
  expect(markup).toContain('/api/skills/source/skill%3Areview/resources/assets/diagram%20one.png');
  expect(markup).toContain('/api/skills/source/skill%3Areview/resources/guide.md');
  expect(markup).not.toContain('window.__executed = true</script>');
});
