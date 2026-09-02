import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import {
  discoverProject,
  normalizeProject,
  parseRule,
  validateSource,
  type DiscoveredProject,
  type LoadedConfig,
  type RuleDocument,
} from '../src/config/index.ts';
import type { AgentBundleConfig } from '../src/core/types.ts';

const loadedProject = (
  root: string,
  targets: readonly string[],
): LoadedConfig => ({
  config: {
    plugin: { name: 'rule-fixture', version: '1.0.0' },
    targets: [...targets],
  },
  configPath: join(root, 'agent-bundle.config.ts'),
  context: {
    command: 'build',
    mode: 'production',
    projectRoot: root,
    selectedTargets: [],
  },
});

const withProject = async (
  run: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-rules-'));
  try {
    await writeFile(
      join(root, 'agent-bundle.config.ts'),
      "export default { plugin: { name: 'rule-fixture', version: '1.0.0' } };\n",
    );
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

it('accepts body-only rules and retains exact authored bytes', async () => {
  await withProject(async (root) => {
    const source = join(root, 'src', 'rules', 'review.mdc');
    const markdown = '# Review\n\nCheck the staged diff.';
    await mkdir(join(root, 'src', 'rules'), { recursive: true });
    await writeFile(source, markdown);

    const rule = await parseRule(source);

    expect(rule).toMatchObject({
      body: markdown,
      diagnostics: [],
      emittedMarkdown: markdown,
      frontmatter: {},
      markdown,
      source,
    });
    expect(rule).not.toHaveProperty('authoredTargets');
  });
});

it('peels targets and rejects unknown frontmatter fields and malformed field shapes', async () => {
  await withProject(async (root) => {
    await mkdir(join(root, 'src', 'rules'), { recursive: true });
    const validSource = join(root, 'src', 'rules', 'cursor-only.mdc');
    const validMarkdown = [
      '---',
      'description: Cursor review guidance',
      'globs:',
      '  - "**/*.ts"',
      'alwaysApply: false',
      'targets:',
      '  - cursor',
      '---',
      '# Review',
      '',
    ].join('\n');
    await writeFile(
      validSource,
      validMarkdown,
    );
    const valid = await parseRule(validSource);
    expect(valid.diagnostics).toEqual([]);
    expect(valid.frontmatter).toEqual({
      alwaysApply: false,
      description: 'Cursor review guidance',
      globs: ['**/*.ts'],
    });
    expect(valid.authoredTargets).toEqual(['cursor']);
    expect(valid.markdown).toBe(validMarkdown);
    expect(valid.emittedMarkdown).toBe([
      '---',
      'description: Cursor review guidance',
      'globs:',
      '  - "**/*.ts"',
      'alwaysApply: false',
      '---',
      '',
      '# Review',
      '',
    ].join('\n'));
    expect(valid.emittedMarkdown).not.toContain('targets:');

    const invalidSource = join(root, 'src', 'rules', 'invalid.mdc');
    await writeFile(
      invalidSource,
      [
        '---',
        'description: 42',
        'globs: [""]',
        'alwaysApply: yes',
        'targets: cursor',
        'extra: hidden',
        '---',
        '# Invalid',
        '',
      ].join('\n'),
    );
    const invalid = await parseRule(invalidSource);
    expect(invalid.diagnostics.map(({ code }) => code)).toEqual([
      'AB4902',
      'AB4903',
      'AB4903',
      'AB4903',
      'AB4903',
    ]);
    expect(invalid.frontmatter).toEqual({});
    expect(invalid).not.toHaveProperty('authoredTargets');
  });
});

it('preserves target-free frontmatter bytes and emits target-only rules as body-only', async () => {
  await withProject(async (root) => {
    await mkdir(join(root, 'src', 'rules'), { recursive: true });
    const targetFreeSource = join(root, 'src', 'rules', 'target-free.mdc');
    const targetFreeMarkdown = '---\r\ndescription: Keep CRLF\r\n---\r\nBody without trailing newline';
    const targetOnlySource = join(root, 'src', 'rules', 'target-only.mdc');
    await Promise.all([
      writeFile(targetFreeSource, targetFreeMarkdown),
      writeFile(targetOnlySource, '---\ntargets:\n  - cursor\n---\nTarget-only body'),
    ]);

    const [targetFree, targetOnly] = await Promise.all([
      parseRule(targetFreeSource),
      parseRule(targetOnlySource),
    ]);

    expect(targetFree.emittedMarkdown).toBe(targetFreeMarkdown);
    expect(targetOnly.frontmatter).toEqual({});
    expect(targetOnly.authoredTargets).toEqual(['cursor']);
    expect(targetOnly.emittedMarkdown).toBe('Target-only body');
  });
});

it('reports malformed YAML frontmatter with a fresh rule diagnostic', async () => {
  await withProject(async (root) => {
    const source = join(root, 'src', 'rules', 'malformed.mdc');
    await mkdir(join(root, 'src', 'rules'), { recursive: true });
    await writeFile(source, '---\nglobs: [unterminated\n---\n# Broken\n');

    expect((await parseRule(source)).diagnostics).toEqual([
      expect.objectContaining({ code: 'AB4901', severity: 'error', sourcePath: source }),
    ]);
  });
});

it('discovers flat non-ignored rules deterministically and omits the collection when empty', async () => {
  await withProject(async (root) => {
    await mkdir(join(root, 'src', 'rules'), { recursive: true });
    await Promise.all([
      writeFile(join(root, '.gitignore'), 'src/rules/ignored.mdc\n'),
      writeFile(join(root, 'src', 'rules', 'zeta.mdc'), '# Zeta\n'),
      writeFile(join(root, 'src', 'rules', 'alpha.mdc'), '# Alpha\n'),
      writeFile(join(root, 'src', 'rules', 'ignored.mdc'), '# Ignored\n'),
    ]);
    const config: AgentBundleConfig = {
      plugin: { name: 'rule-fixture', version: '1.0.0' },
    };

    const discovered = await discoverProject(root, config);
    expect(discovered.rules?.map((rule) => rule.source)).toEqual([
      join(root, 'src', 'rules', 'alpha.mdc'),
      join(root, 'src', 'rules', 'zeta.mdc'),
    ]);

    await rm(join(root, 'src', 'rules'), { recursive: true });
    expect(await discoverProject(root, config)).not.toHaveProperty('rules');
  });
});

it('normalizes peeled rule targets and reports unknown, unavailable, and duplicate rules', async () => {
  await withProject(async (root) => {
    const rule = (
      source: string,
      authoredTargets?: readonly string[],
    ): RuleDocument => ({
      ...(authoredTargets === undefined ? {} : { authoredTargets }),
      body: '# Rule\n',
      diagnostics: [],
      emittedMarkdown: '---\ndescription: Rule guidance\n---\n# Rule\n',
      frontmatter: { description: 'Rule guidance' },
      markdown: '---\ndescription: Rule guidance\n---\n# Rule\n',
      source,
    });
    const registry = createDefaultRegistry();
    const cursorLoaded = loadedProject(root, ['cursor']);
    const cursorRule = rule(join(root, 'src', 'rules', 'review.mdc'), ['cursor']);
    const cursorDiscovered: DiscoveredProject = { rules: [cursorRule], skills: [] };
    const model = await normalizeProject(cursorLoaded, cursorDiscovered, registry);

    expect(model.rules).toEqual([{
      body: '# Rule\n',
      emittedMarkdown: '---\ndescription: Rule guidance\n---\n# Rule\n',
      frontmatter: { description: 'Rule guidance' },
      id: 'rule:review',
      markdown: '---\ndescription: Rule guidance\n---\n# Rule\n',
      name: 'review',
      provenance: { kind: 'conventional', sourcePath: cursorRule.source },
      source: cursorRule.source,
      targets: ['cursor'],
    }]);

    const unknown = rule(join(root, 'src', 'rules', 'unknown.mdc'), ['claude']);
    expect(validateSource(cursorLoaded, { rules: [unknown], skills: [] }, registry)).toEqual([
      expect.objectContaining({ code: 'AB4904', sourcePath: unknown.source }),
    ]);

    const claudeLoaded = loadedProject(root, ['claude']);
    const unavailable = rule(join(root, 'src', 'rules', 'unavailable.mdc'), ['claude']);
    expect(validateSource(claudeLoaded, { rules: [unavailable], skills: [] }, registry)).toEqual([
      expect.objectContaining({
        code: 'AB4905',
        message: expect.stringContaining('unavailable'),
        sourcePath: unavailable.source,
      }),
    ]);

    const duplicateFirst = rule(join(root, 'first', 'duplicate.mdc'));
    const duplicateSecond = rule(join(root, 'second', 'duplicate.mdc'));
    expect(validateSource(
      cursorLoaded,
      { rules: [duplicateFirst, duplicateSecond], skills: [] },
      registry,
    )).toContainEqual(expect.objectContaining({
      code: 'AB4906',
      sourcePath: duplicateSecond.source,
    }));
  });
});
