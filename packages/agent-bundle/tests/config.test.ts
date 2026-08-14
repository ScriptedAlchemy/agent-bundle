import { expect, it } from '@rstest/core';

import {
  discoverProject,
  loadConfig,
  parseSkill,
} from '../src/config/index.ts';
import {
  createProjectFixture,
  removeProjectFixture,
} from './helpers/project-fixture.ts';

it('loads an async TypeScript config and discovers its conventional skill files', async () => {
  const fixture = await createProjectFixture();

  try {
    const loaded = await loadConfig({
      root: fixture.root,
      command: 'build',
      mode: 'production',
      targets: ['claude', 'codex'],
    });

    expect(loaded.configPath).toBe(fixture.configPath);
    expect(loaded.context).toEqual({
      command: 'build',
      mode: 'production',
      projectRoot: fixture.root,
      selectedTargets: ['claude', 'codex'],
    });
    expect(loaded.config.fixtureContext).toEqual({
      command: 'build',
      mode: 'production',
      projectRoot: fixture.root,
      selectedTargets: ['claude', 'codex'],
    });

    const discovered = await discoverProject(fixture.root, loaded.config);
    expect(discovered.skills).toHaveLength(1);

    const [skill] = discovered.skills;
    expect(skill).toMatchObject({
      body: '# Review\n\nUse the attached [diagram](assets/diagram.png).\n',
      diagnostics: [],
      dir: fixture.skillDir,
      frontmatter: {
        description: 'Reviews changes',
        name: 'review',
      },
      source: fixture.skillSource,
    });
    expect(skill.resources).toEqual([
      {
        bytes: 108,
        relativePath: 'SKILL.md',
        source: fixture.skillSource,
      },
      {
        bytes: 4,
        relativePath: 'assets/diagram.png',
        source: fixture.imagePath,
      },
      {
        bytes: 28,
        relativePath: 'scripts/check.ts',
        source: `${fixture.skillDir}/scripts/check.ts`,
      },
    ]);
  } finally {
    await removeProjectFixture(fixture.root);
  }
});

it('honors an explicit empty skills list instead of conventional discovery', async () => {
  const fixture = await createProjectFixture({ skills: [] });

  try {
    const loaded = await loadConfig({
      root: fixture.root,
      command: 'build',
      mode: 'production',
      targets: [],
    });

    await expect(discoverProject(fixture.root, loaded.config)).resolves.toEqual({
      skills: [],
    });
  } finally {
    await removeProjectFixture(fixture.root);
  }
});

it('parses a skill directly with project-relative ignore rules', async () => {
  const fixture = await createProjectFixture();

  try {
    const skill = await parseSkill(fixture.skillDir);

    expect(skill.resources.map((resource) => resource.relativePath)).toEqual([
      'SKILL.md',
      'assets/diagram.png',
      'scripts/check.ts',
    ]);
  } finally {
    await removeProjectFixture(fixture.root);
  }
});
