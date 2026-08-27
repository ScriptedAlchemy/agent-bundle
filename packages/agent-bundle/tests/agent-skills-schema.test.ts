import { readFile } from 'node:fs/promises';

import { expect, it } from '@rstest/core';

import { sha256Hex } from '../src/core/digest.ts';
import {
  agentSkillsSchemaRevision,
  validateAgentSkillsFrontmatter,
} from '../src/schemas/agent-skills/contract.ts';

interface ContractFixtureCase {
  readonly frontmatter: unknown;
  readonly issues: readonly {
    readonly field?: string;
    readonly instancePath: string;
    readonly keyword: string;
    readonly message: string;
  }[];
  readonly name: string;
}

interface ContractFixture {
  readonly cases: readonly ContractFixtureCase[];
  readonly revision: string;
}

const fixtureUrl = new URL('../fixtures/contracts/agent-skills/frontmatter-validation.json', import.meta.url);
const provenanceUrl = new URL('../src/schemas/agent-skills/PROVENANCE.json', import.meta.url);
const schemaUrl = new URL('../src/schemas/agent-skills/frontmatter.schema.json', import.meta.url);

it('validates every pinned Agent Skills frontmatter contract case with stable issues', async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8')) as ContractFixture;

  expect(fixture.revision).toBe(agentSkillsSchemaRevision.sourceRevision);
  for (const testCase of fixture.cases) {
    expect(validateAgentSkillsFrontmatter(testCase.frontmatter), testCase.name).toEqual(
      testCase.issues,
    );
  }
});

it('pins the schema and provenance to immutable upstream source artifacts', async () => {
  const [schema, provenanceText] = await Promise.all([
    readFile(schemaUrl),
    readFile(provenanceUrl, 'utf8'),
  ]);
  const provenance = JSON.parse(provenanceText) as {
    readonly derivedSchema: { readonly bytes: number; readonly sha256: string };
    readonly normativeTextWinsOnConflict: boolean;
    readonly referenceValidator: { readonly bytes: number; readonly path: string; readonly sha256: string; readonly url: string };
    readonly sourceRevision: string;
    readonly specification: { readonly bytes: number; readonly path: string; readonly sha256: string; readonly url: string };
  };

  expect(agentSkillsSchemaRevision).toEqual(Object.freeze({
    schemaSha256: provenance.derivedSchema.sha256,
    sourceRevision: '69ef37e9424c0a7ea9dd2293b559e43ec8176379',
    specification: provenance.specification.url,
  }));
  expect(provenance.normativeTextWinsOnConflict).toBe(true);
  expect(provenance.specification).toEqual({
    bytes: 7166,
    path: 'docs/specification.mdx',
    sha256: 'b9079c0c10b7930e8c6a20ff2bc10cda2a3343c55185120e3f1116a1a529b220',
    url: 'https://raw.githubusercontent.com/agentskills/agentskills/69ef37e9424c0a7ea9dd2293b559e43ec8176379/docs/specification.mdx',
  });
  expect(provenance.referenceValidator).toEqual({
    bytes: 5154,
    path: 'skills-ref/src/skills_ref/validator.py',
    sha256: 'b5ee3d8537c83c959c31c2cb080a5227646ede5aea545f1ac835ed3c4645f6c5',
    url: 'https://raw.githubusercontent.com/agentskills/agentskills/69ef37e9424c0a7ea9dd2293b559e43ec8176379/skills-ref/src/skills_ref/validator.py',
  });
  expect(schema.byteLength).toBe(provenance.derivedSchema.bytes);
  expect(sha256Hex(schema)).toBe(provenance.derivedSchema.sha256);
});

it('validates entirely offline without calling fetch', () => {
  const originalFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', {
    configurable: true,
    value: () => {
      throw new Error('validation must not use the network');
    },
    writable: true,
  });

  try {
    expect(validateAgentSkillsFrontmatter({
      description: 'Validate a pinned local schema.',
      name: 'offline-validation',
    })).toEqual([]);
  } finally {
    Object.defineProperty(globalThis, 'fetch', {
      configurable: true,
      value: originalFetch,
      writable: true,
    });
  }
});
