import { expect, it } from '@rstest/core';

import { SkillClient } from '../src/skill-client.ts';

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  headers: { 'content-type': 'application/json' },
  status,
});

it('reads source and explicit generated documents only from typed workbench routes', async () => {
  const calls: string[] = [];
  const client = new SkillClient({
    fetch: async (input) => {
      calls.push(String(input));
      return response({ document: { body: '# Review', id: 'skill:review' } });
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
