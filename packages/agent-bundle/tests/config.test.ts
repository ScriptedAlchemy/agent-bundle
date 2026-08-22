import { expect, it } from '@rstest/core';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  // The first jiti compile of the package source graph dominates this test; keep headroom over the 5s default.
}, 30_000);

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
      assets: [],
      skills: [],
    });
  } finally {
    await removeProjectFixture(fixture.root);
  }
}, 30_000);

it('loads sync config objects from relative and absolute explicit paths', async () => {
  const fixture = await createProjectFixture();
  const relativeConfigPath = 'configs/sync.config.ts';
  const absoluteConfigPath = join(fixture.root, relativeConfigPath);

  try {
    await mkdir(join(fixture.root, 'configs'), { recursive: true });
    await writeFile(
      absoluteConfigPath,
      "export default { plugin: { name: 'sync', version: '1.0.0' } };\n",
    );

    const options = {
      command: 'inspect',
      mode: 'development',
      root: fixture.root,
      targets: ['codex'],
    };
    const relative = await loadConfig({ ...options, configPath: relativeConfigPath });
    const absolute = await loadConfig({ ...options, configPath: absoluteConfigPath });

    expect(relative).toMatchObject({
      config: { plugin: { name: 'sync', version: '1.0.0' } },
      configPath: absoluteConfigPath,
      context: { projectRoot: fixture.root, selectedTargets: ['codex'] },
    });
    expect(absolute).toMatchObject({
      config: { plugin: { name: 'sync', version: '1.0.0' } },
      configPath: absoluteConfigPath,
      context: { projectRoot: fixture.root, selectedTargets: ['codex'] },
    });
  } finally {
    await removeProjectFixture(fixture.root);
  }
}, 30_000);

it('rejects external config paths before evaluating their modules', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-external-config-'));
  const root = join(parent, 'project');
  const external = join(parent, 'external.config.mjs');
  try {
    await mkdir(root, { recursive: true });
    await writeFile(
      external,
      "throw new Error('external config was evaluated');\n",
    );

    await expect(loadConfig({
      command: 'build',
      configPath: external,
      mode: 'production',
      root,
    })).rejects.toThrow(/outside project root/i);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
}, 30_000);

it('rejects config symlinks whose resolved targets escape the real project root before evaluation', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-symlink-config-'));
  const root = join(parent, 'project');
  const external = join(parent, 'external.config.mjs');
  const linked = join(root, 'agent-bundle.config.mjs');
  try {
    await mkdir(root, { recursive: true });
    await writeFile(external, "throw new Error('symlinked config was evaluated');\n");
    await symlink(external, linked);

    await expect(loadConfig({
      command: 'build',
      configPath: 'agent-bundle.config.mjs',
      mode: 'production',
      root,
    })).rejects.toThrow(/outside project root/i);
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
}, 30_000);

it('reloads an edited native ESM config on each load', async () => {
  const fixture = await createProjectFixture();
  const relativeConfigPath = 'configs/fresh.config.mjs';
  const configPath = join(fixture.root, relativeConfigPath);
  const options = {
    command: 'inspect',
    configPath: relativeConfigPath,
    mode: 'development',
    root: fixture.root,
    targets: [],
  };

  try {
    await mkdir(join(fixture.root, 'configs'), { recursive: true });
    await writeFile(
      configPath,
      "export default { plugin: { name: 'fresh', version: '1.0.0' } };\n",
    );

    expect((await loadConfig(options)).config.plugin).toEqual({
      name: 'fresh',
      version: '1.0.0',
    });

    await writeFile(
      configPath,
      "export default { plugin: { name: 'fresh', version: '2.0.0' } };\n",
    );

    await expect(loadConfig(options)).resolves.toMatchObject({
      config: { plugin: { name: 'fresh', version: '2.0.0' } },
      configPath,
    });
  } finally {
    await removeProjectFixture(fixture.root);
  }
}, 30_000);

it('discovers an explicit non-conventional skill path relative to the project root', async () => {
  const fixture = await createProjectFixture();
  const selectedSkillDir = join(fixture.root, 'custom/selected');

  try {
    await mkdir(selectedSkillDir, { recursive: true });
    await writeFile(
      join(selectedSkillDir, 'SKILL.md'),
      '---\nname: selected\n---\n# Selected\n',
    );

    const discovered = await discoverProject(fixture.root, {
      plugin: { name: 'review', version: '1.0.0' },
      skills: ['custom/selected'],
    });

    expect(discovered.skills).toMatchObject([
      {
        dir: selectedSkillDir,
        frontmatter: { name: 'selected' },
        source: join(selectedSkillDir, 'SKILL.md'),
      },
    ]);
  } finally {
    await removeProjectFixture(fixture.root);
  }
});

it('expands glob patterns in explicit skills entries and deduplicates overlapping matches', async () => {
  const fixture = await createProjectFixture();
  const extraSkillDir = join(fixture.root, 'custom/selected');

  try {
    await mkdir(extraSkillDir, { recursive: true });
    await writeFile(
      join(extraSkillDir, 'SKILL.md'),
      '---\nname: selected\n---\n# Selected\n',
    );

    const discovered = await discoverProject(fixture.root, {
      plugin: { name: 'review', version: '1.0.0' },
      skills: ['skills/*', 'custom/*/SKILL.md', 'custom/selected'],
    });

    expect(discovered.skills.map((skill) => skill.dir).sort()).toEqual(
      [extraSkillDir, fixture.skillDir].sort(),
    );
  } finally {
    await removeProjectFixture(fixture.root);
  }
});

it('discovers conventional root assets and strips the assets/ prefix from destinations', async () => {
  const fixture = await createProjectFixture();

  try {
    await mkdir(join(fixture.root, 'assets/fonts'), { recursive: true });
    await writeFile(join(fixture.root, 'assets/logo.svg'), '<svg/>');
    await writeFile(join(fixture.root, 'assets/fonts/mono.woff'), 'font');

    const discovered = await discoverProject(fixture.root, {
      plugin: { name: 'review', version: '1.0.0' },
    });

    expect(discovered.assets).toEqual([
      { bytes: 4, relativePath: 'fonts/mono.woff', source: join(fixture.root, 'assets/fonts/mono.woff') },
      { bytes: 6, relativePath: 'logo.svg', source: join(fixture.root, 'assets/logo.svg') },
    ]);
  } finally {
    await removeProjectFixture(fixture.root);
  }
});

it('expands explicit asset entries as files, directories, and globs while dropping missing literals', async () => {
  const fixture = await createProjectFixture();

  try {
    await mkdir(join(fixture.root, 'assets'), { recursive: true });
    await mkdir(join(fixture.root, 'branding'), { recursive: true });
    await mkdir(join(fixture.root, 'docs'), { recursive: true });
    await writeFile(join(fixture.root, 'assets/logo.svg'), '<svg/>');
    await writeFile(join(fixture.root, 'branding/logo.png'), 'png');
    await writeFile(join(fixture.root, 'docs/guide.md'), '# Guide\n');
    await writeFile(join(fixture.root, 'docs/notes.txt'), 'notes');

    const discovered = await discoverProject(fixture.root, {
      assets: ['assets/logo.svg', 'branding', 'docs/*.md', 'missing/logo.svg'],
      plugin: { name: 'review', version: '1.0.0' },
    });

    expect(discovered.assets).toEqual([
      { bytes: 6, relativePath: 'logo.svg', source: join(fixture.root, 'assets/logo.svg') },
      { bytes: 3, relativePath: 'branding/logo.png', source: join(fixture.root, 'branding/logo.png') },
      { bytes: 8, relativePath: 'docs/guide.md', source: join(fixture.root, 'docs/guide.md') },
    ]);
  } finally {
    await removeProjectFixture(fixture.root);
  }
});

it('honors an explicit empty assets list instead of conventional discovery', async () => {
  const fixture = await createProjectFixture();

  try {
    await mkdir(join(fixture.root, 'assets'), { recursive: true });
    await writeFile(join(fixture.root, 'assets/logo.svg'), '<svg/>');

    const discovered = await discoverProject(fixture.root, {
      assets: [],
      plugin: { name: 'review', version: '1.0.0' },
    });

    expect(discovered.assets).toEqual([]);
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

it('reports a diagnostic when Skill Markdown has no frontmatter', async () => {
  const fixture = await createProjectFixture();

  try {
    await writeFile(fixture.skillSource, '# Missing frontmatter\n');

    await expect(parseSkill(fixture.skillDir)).resolves.toMatchObject({
      body: '# Missing frontmatter\n',
      diagnostics: [
        {
          code: 'AB3001',
          severity: 'error',
          sourcePath: fixture.skillSource,
        },
      ],
      frontmatter: {},
    });
  } finally {
    await removeProjectFixture(fixture.root);
  }
});

it('reports a diagnostic when Skill Markdown frontmatter is malformed', async () => {
  const fixture = await createProjectFixture();

  try {
    await writeFile(fixture.skillSource, '---\nname: [\n---\n# Broken\n');

    await expect(parseSkill(fixture.skillDir)).resolves.toMatchObject({
      body: '# Broken\n',
      diagnostics: [
        {
          code: 'AB3002',
          severity: 'error',
          sourcePath: fixture.skillSource,
        },
      ],
      frontmatter: {},
    });
  } finally {
    await removeProjectFixture(fixture.root);
  }
});

it('keeps mandatory resource ignores when .gitignore re-includes their paths', async () => {
  const fixture = await createProjectFixture();

  try {
    await Promise.all([
      mkdir(join(fixture.skillDir, '.agent-bundle'), { recursive: true }),
      mkdir(join(fixture.skillDir, '.git'), { recursive: true }),
      mkdir(join(fixture.skillDir, 'dist'), { recursive: true }),
      mkdir(join(fixture.skillDir, 'node_modules'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        join(fixture.root, '.gitignore'),
        [
          '*.log',
          '!.agent-bundle',
          '!.agent-bundle/**',
          '!.git',
          '!.git/**',
          '!dist',
          '!dist/**',
          '!node_modules',
          '!node_modules/**',
          '',
        ].join('\n'),
      ),
      writeFile(join(fixture.skillDir, '.agent-bundle/state.json'), '{}\n'),
      writeFile(join(fixture.skillDir, '.git/HEAD'), 'ref: main\n'),
      writeFile(join(fixture.skillDir, 'dist/generated.js'), 'export {};\n'),
      writeFile(join(fixture.skillDir, 'node_modules/package.js'), 'export {};\n'),
    ]);

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
