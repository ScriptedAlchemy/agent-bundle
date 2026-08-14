import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export interface ProjectFixture {
  configPath: string;
  imagePath: string;
  root: string;
  skillDir: string;
  skillMarkdown: string;
  skillSource: string;
}

export interface ProjectFixtureOptions {
  skills?: string[];
}

const sourceEntryPoint = resolve(
  process.cwd(),
  'packages/agent-bundle/src/index.ts',
);

export const createProjectFixture = async (
  options: ProjectFixtureOptions = {},
): Promise<ProjectFixture> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-config-'));
  const skillDir = join(root, 'skills/review');
  const skillSource = join(skillDir, 'SKILL.md');
  const imagePath = join(skillDir, 'assets/diagram.png');
  const configPath = join(root, 'agent-bundle.config.ts');
  const skills = options.skills === undefined ? 'undefined' : JSON.stringify(options.skills);
  const skillMarkdown = [
    '---',
    'name: review',
    'description: Reviews changes',
    '---',
    '# Review',
    '',
    'Use the attached [diagram](assets/diagram.png).',
    '',
  ].join('\n');

  await Promise.all([
    mkdir(join(root, 'node_modules/agent-bundle'), { recursive: true }),
    mkdir(join(skillDir, 'assets'), { recursive: true }),
    mkdir(join(skillDir, 'scripts'), { recursive: true }),
  ]);

  await Promise.all([
    writeFile(join(root, '.gitignore'), '*.log\n'),
    writeFile(
      join(root, 'node_modules/agent-bundle/package.json'),
      JSON.stringify({
        name: 'agent-bundle',
        type: 'module',
        exports: './index.ts',
      }),
    ),
    writeFile(
      join(root, 'node_modules/agent-bundle/index.ts'),
      `export { defineConfig } from ${JSON.stringify(sourceEntryPoint)};\n`,
    ),
    writeFile(
      configPath,
      [
        "import { defineConfig } from 'agent-bundle';",
        '',
        'export default defineConfig(async ({',
        '  command,',
        '  mode,',
        '  projectRoot,',
        '  selectedTargets,',
        '}) => ({',
        "  plugin: { name: 'review', version: '1.0.0' },",
        `  skills: ${skills},`,
        '  fixtureContext: { command, mode, projectRoot, selectedTargets },',
        '}));',
        '',
      ].join('\n'),
    ),
    writeFile(skillSource, skillMarkdown),
    writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47])),
    writeFile(join(skillDir, 'debug.log'), 'ignore me\n'),
    writeFile(join(skillDir, 'scripts/check.ts'), 'export const review = true;\n'),
  ]);

  return { configPath, imagePath, root, skillDir, skillMarkdown, skillSource };
};

export const removeProjectFixture = async (root: string): Promise<void> => {
  await rm(root, { force: true, recursive: true });
};
