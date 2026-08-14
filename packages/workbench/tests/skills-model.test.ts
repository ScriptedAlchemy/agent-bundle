import { expect, it } from '@rstest/core';

import {
  generatedSkillPath,
  resourceUrlFor,
  sourceSkillPath,
} from '../src/skills-model.ts';

it('builds document and resource URLs from opaque source and generated bases', () => {
  const source = { kind: 'source' as const, skillId: 'skill:review notes' };
  const generated = {
    epochId: 'epoch-01',
    kind: 'generated' as const,
    skillId: 'skill:review notes',
    target: 'portable',
  };

  expect(sourceSkillPath(source.skillId)).toBe('/api/skills/source/skill%3Areview%20notes');
  expect(generatedSkillPath(generated.epochId, generated.target, generated.skillId)).toBe(
    '/api/skills/epochs/epoch-01/portable/skill%3Areview%20notes',
  );
  expect(resourceUrlFor(source, 'assets/diagram one.png', ['assets/diagram one.png'])).toBe(
    '/api/skills/source/skill%3Areview%20notes/resources/assets/diagram%20one.png',
  );
  expect(resourceUrlFor(generated, 'assets/diagram one.png', ['assets/diagram one.png'])).toBe(
    '/api/skills/epochs/epoch-01/portable/skill%3Areview%20notes/resources/assets/diagram%20one.png',
  );
  expect(resourceUrlFor(source, 'assets/diagram%20one.png', ['assets/diagram one.png'])).toBe(
    '/api/skills/source/skill%3Areview%20notes/resources/assets/diagram%20one.png',
  );
});

it('does not turn traversal, encoded separators, or file URLs into browser links', () => {
  const base = { kind: 'source' as const, skillId: 'skill:review' };

  expect(resourceUrlFor(base, '../outside.md', [])).toBeUndefined();
  expect(resourceUrlFor(base, 'assets%2Fdiagram.png', [])).toBeUndefined();
  expect(resourceUrlFor(base, 'file:///secret.txt', [])).toBeUndefined();
  expect(resourceUrlFor(base, 'https://example.com/guide', [])).toBe('https://example.com/guide');
  expect(resourceUrlFor(base, '#details', [])).toBe('#details');
  expect(resourceUrlFor(base, 'unknown.md', ['guide.md'])).toBeUndefined();
});
