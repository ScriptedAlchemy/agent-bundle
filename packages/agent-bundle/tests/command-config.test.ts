import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import {
  discoverProject,
  normalizeProject,
  parseCommand,
  validateSource,
  type CommandDocument,
  type DiscoveredProject,
  type LoadedConfig,
} from '../src/config/index.ts';
import type { AgentBundleConfig } from '../src/core/types.ts';

const loadedProject = (
  root: string,
  targets: readonly string[],
): LoadedConfig => ({
  config: {
    plugin: { name: 'command-fixture', version: '1.0.0' },
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
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-commands-'));
  try {
    await writeFile(
      join(root, 'agent-bundle.config.ts'),
      "export default { plugin: { name: 'command-fixture', version: '1.0.0' } };\n",
    );
    await run(root);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

it('accepts body-only commands and retains exact authored bytes', async () => {
  await withProject(async (root) => {
    const source = join(root, 'commands', 'review.md');
    const markdown = '# Review\r\n\r\nCheck the staged diff.';
    await mkdir(join(root, 'commands'));
    await writeFile(source, markdown);

    const command = await parseCommand(source);

    expect(command).toMatchObject({
      body: markdown,
      diagnostics: [],
      frontmatter: {},
      markdown,
      source,
    });
    expect(command).not.toHaveProperty('authoredTargets');
  });
});

it('peels targets and accepts only the closed canonical frontmatter schema', async () => {
  await withProject(async (root) => {
    await mkdir(join(root, 'commands'));
    const validSource = join(root, 'commands', 'review.md');
    await writeFile(
      validSource,
      [
        '---',
        'description: Review staged changes',
        'argumentHint: "[path]"',
        'allowedTools:',
        '  - Read',
        '  - Grep',
        'model: sonnet',
        'disableModelInvocation: true',
        'targets:',
        '  - claude',
        '---',
        '# Review',
        '',
      ].join('\n'),
    );
    const valid = await parseCommand(validSource);
    expect(valid.diagnostics).toEqual([]);
    expect(valid.frontmatter).toEqual({
      allowedTools: ['Read', 'Grep'],
      argumentHint: '[path]',
      description: 'Review staged changes',
      disableModelInvocation: true,
      model: 'sonnet',
    });
    expect(valid.authoredTargets).toEqual(['claude']);

    const stringTools = join(root, 'commands', 'string-tools.md');
    await writeFile(stringTools, '---\nallowedTools: Read, Grep\n---\nReview.\n');
    expect((await parseCommand(stringTools)).frontmatter).toEqual({ allowedTools: 'Read, Grep' });

    const invalidSource = join(root, 'commands', 'invalid.md');
    await writeFile(
      invalidSource,
      [
        '---',
        'description: 42',
        'argumentHint: false',
        'allowedTools: [""]',
        'model: true',
        'disableModelInvocation: no',
        'targets: claude',
        'extra: hidden',
        '---',
        '# Invalid',
        '',
      ].join('\n'),
    );
    const invalid = await parseCommand(invalidSource);
    expect(invalid.diagnostics.map(({ code }) => code)).toEqual([
      'AB4922',
      'AB4923',
      'AB4923',
      'AB4923',
      'AB4923',
      'AB4923',
      'AB4923',
    ]);
    expect(invalid.frontmatter).toEqual({});
    expect(invalid).not.toHaveProperty('authoredTargets');
  });
});

it('reports unreadable files and malformed YAML with fresh command diagnostics', async () => {
  await withProject(async (root) => {
    const missing = join(root, 'commands', 'missing.md');
    expect((await parseCommand(missing)).diagnostics).toEqual([
      expect.objectContaining({ code: 'AB4920', severity: 'error', sourcePath: missing }),
    ]);

    const malformed = join(root, 'commands', 'malformed.md');
    await mkdir(join(root, 'commands'));
    await writeFile(malformed, '---\nallowedTools: [unterminated\n---\n# Broken\n');
    expect((await parseCommand(malformed)).diagnostics).toEqual([
      expect.objectContaining({ code: 'AB4921', severity: 'error', sourcePath: malformed }),
    ]);
  });
});

it('discovers flat non-ignored commands deterministically and omits the collection when empty', async () => {
  await withProject(async (root) => {
    await mkdir(join(root, 'commands'));
    await Promise.all([
      writeFile(join(root, '.gitignore'), 'commands/ignored.md\n'),
      writeFile(join(root, 'commands', 'zeta.md'), '# Zeta\n'),
      writeFile(join(root, 'commands', 'alpha.md'), '# Alpha\n'),
      writeFile(join(root, 'commands', 'ignored.md'), '# Ignored\n'),
    ]);
    const config: AgentBundleConfig = {
      plugin: { name: 'command-fixture', version: '1.0.0' },
    };

    const discovered = await discoverProject(root, config);
    expect(discovered.commands?.map((command) => command.source)).toEqual([
      join(root, 'commands', 'alpha.md'),
      join(root, 'commands', 'zeta.md'),
    ]);

    await rm(join(root, 'commands'), { recursive: true });
    expect(await discoverProject(root, config)).not.toHaveProperty('commands');
  });
});

it('normalizes peeled targets and reports unknown, unavailable, and duplicate commands', async () => {
  await withProject(async (root) => {
    const command = (
      source: string,
      authoredTargets?: readonly string[],
    ): CommandDocument => ({
      ...(authoredTargets === undefined ? {} : { authoredTargets }),
      body: '# Command\n',
      diagnostics: [],
      frontmatter: { description: 'Command prompt' },
      markdown: '---\ndescription: Command prompt\n---\n# Command\n',
      source,
    });
    const registry = createDefaultRegistry();
    const claudeLoaded = loadedProject(root, ['claude']);
    const claudeCommand = command(join(root, 'commands', 'review.md'), ['claude']);
    const discovered: DiscoveredProject = { commands: [claudeCommand], skills: [] };
    const model = await normalizeProject(claudeLoaded, discovered, registry);

    expect(model.commands).toEqual([{
      body: '# Command\n',
      frontmatter: { description: 'Command prompt' },
      id: 'command:review',
      markdown: '---\ndescription: Command prompt\n---\n# Command\n',
      name: 'review',
      provenance: { kind: 'conventional', sourcePath: claudeCommand.source },
      source: claudeCommand.source,
      targets: ['claude'],
    }]);

    const unknown = command(join(root, 'commands', 'unknown.md'), ['cursor']);
    expect(validateSource(claudeLoaded, { commands: [unknown], skills: [] }, registry)).toEqual([
      expect.objectContaining({ code: 'AB4924', sourcePath: unknown.source }),
    ]);

    const codexLoaded = loadedProject(root, ['codex']);
    const unavailable = command(join(root, 'commands', 'unavailable.md'), ['codex']);
    expect(validateSource(codexLoaded, { commands: [unavailable], skills: [] }, registry)).toEqual([
      expect.objectContaining({
        code: 'AB4925',
        message: expect.stringContaining('unavailable'),
        sourcePath: unavailable.source,
      }),
    ]);

    const duplicateFirst = command(join(root, 'first', 'duplicate.md'));
    const duplicateSecond = command(join(root, 'second', 'duplicate.md'));
    expect(validateSource(
      claudeLoaded,
      { commands: [duplicateFirst, duplicateSecond], skills: [] },
      registry,
    )).toContainEqual(expect.objectContaining({
      code: 'AB4926',
      sourcePath: duplicateSecond.source,
    }));
  });
});
