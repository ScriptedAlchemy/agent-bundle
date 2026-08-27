import { expect, it } from '@rstest/core';

import { SkillClient } from '../src/skill-client.ts';

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
});

const sourceDocument = Object.freeze({
  base: Object.freeze({ kind: 'source' as const, skillId: 'skill:review' }),
  body: '# Review\n',
  description: 'Review implementation changes.',
  diagnostics: Object.freeze([Object.freeze({
    code: 'AB3001',
    generatedPath: 'generated/SKILL.md',
    message: 'A Skill warning.',
    recovery: 'Fix the Skill.',
    severity: 'warning' as const,
    sourcePath: 'skills/review/SKILL.md',
    target: 'portable',
  })]),
  frontmatter: Object.freeze({
    description: 'Review implementation changes.',
    nested: Object.freeze({ tags: Object.freeze(['review', 'safe']) }),
    version: '1.0.0',
  }),
  id: 'skill:review',
  markdown: '---\ndescription: Review implementation changes.\n---\n# Review\n',
  name: 'review',
  provenance: Object.freeze({ kind: 'config' as const, sourcePath: 'agent-bundle.config.ts' }),
  resources: Object.freeze([Object.freeze({ bytes: 42, relativePath: 'assets/diagram.svg' })]),
  targets: Object.freeze(['portable']),
});

const generatedDocument = Object.freeze({
  base: Object.freeze({ epochId: 'epoch-01', kind: 'generated' as const, skillId: 'skill:review', target: 'portable' }),
  body: '# Review\n',
  description: 'Review implementation changes.',
  diagnostics: Object.freeze([]),
  frontmatter: Object.freeze({ description: 'Review implementation changes.', version: '1.0.0' }),
  id: 'skill:review',
  markdown: '---\ndescription: Review implementation changes.\n---\n# Review\n',
  name: 'review',
  resources: Object.freeze([Object.freeze({ bytes: 42, relativePath: 'assets/diagram.svg' })]),
});

it('reads source and explicit generated documents only from typed workbench routes', async () => {
  const calls: string[] = [];
  const client = new SkillClient({
    fetch: async (input) => {
      calls.push(String(input));
      return response({ document: String(input).includes('/epochs/') ? generatedDocument : sourceDocument });
    },
  });

  await expect(client.source('skill:review')).resolves.toMatchObject({ id: 'skill:review' });
  await expect(client.generated('epoch-01', 'portable', 'skill:review')).resolves.toMatchObject({ id: 'skill:review' });
  expect(calls).toEqual([
    '/api/skills/source/skill%3Areview',
    '/api/skills/epochs/epoch-01/portable/skill%3Areview',
  ]);
});

it('turns an unavailable generated target into an explicit browser-state error', async () => {
  const client = new SkillClient({
    fetch: async () => response({ diagnostic: { code: 'SKILL_TARGET_UNAVAILABLE', message: 'Artifact target is not available in this epoch.' } }, 404),
  });

  await expect(client.generated('epoch-01', 'portable', 'skill:review')).rejects.toMatchObject({
    code: 'SKILL_TARGET_UNAVAILABLE',
    message: 'Artifact target is not available in this epoch.',
  });
});

it('decodes and freezes canonical detached Skill DTOs from source and generated routes', async () => {
  const client = new SkillClient({
    fetch: async (input) => String(input).includes('/epochs/')
      ? response({ document: generatedDocument })
      : String(input).endsWith('/source')
        ? response({ diagnostics: [], skills: [sourceDocument] })
        : response({ document: sourceDocument }),
  });

  await expect(client.source('skill:review')).resolves.toEqual(sourceDocument);
  await expect(client.generated('epoch-01', 'portable', 'skill:review')).resolves.toEqual(generatedDocument);
  await expect(client.sourceTree()).resolves.toEqual({ diagnostics: [], skills: [sourceDocument] });

  const document = await client.source('skill:review');
  expect(Object.isFrozen(document)).toBe(true);
  expect(Object.isFrozen(document.base)).toBe(true);
  expect(Object.isFrozen(document.diagnostics)).toBe(true);
  expect(Object.isFrozen(document.frontmatter)).toBe(true);
  expect(Object.isFrozen(document.resources)).toBe(true);
});

it('rejects versioned, superset, and malformed nested Skill document DTOs', async () => {
  const invalidDocuments = [
    { ...sourceDocument, schemaVersion: 1 },
    { ...sourceDocument, version: '1' },
    { ...sourceDocument, base: { ...sourceDocument.base, untrusted: true } },
    { ...sourceDocument, diagnostics: [{ ...sourceDocument.diagnostics[0]!, severity: 'fatal' }] },
    { ...sourceDocument, resources: [{ ...sourceDocument.resources[0]!, bytes: '42' }] },
  ];

  for (const document of invalidDocuments) {
    const client = new SkillClient({ fetch: async () => response({ document }) });
    await expect(client.source('skill:review')).rejects.toMatchObject({
      code: 'SKILL_RESPONSE_INVALID',
      message: 'Skill route returned an invalid response.',
    });
  }
});

it('rejects extra Skill tree wrapper fields and malformed nested Skill DTOs', async () => {
  const extraWrapper = new SkillClient({
    fetch: async () => response({ diagnostics: [], schemaVersion: 1, skills: [sourceDocument] }),
  });
  await expect(extraWrapper.sourceTree()).rejects.toMatchObject({ code: 'SKILL_RESPONSE_INVALID' });

  const malformedDocument = new SkillClient({
    fetch: async () => response({ document: { ...sourceDocument, provenance: { kind: 'config' } } }),
  });
  await expect(malformedDocument.source('skill:review')).rejects.toMatchObject({ code: 'SKILL_RESPONSE_INVALID' });
});
