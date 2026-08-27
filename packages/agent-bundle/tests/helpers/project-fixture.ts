import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

export interface ProjectFixture {
  configPath: string;
  imagePath: string;
  root: string;
  skillDir: string;
  skillMarkdown: string;
  skillSource: string;
}

export interface ProjectFixtureOptions {
  /**
   * Raw agent-bundle.config.ts source. When set (or when files is set), the fixture
   * writes only this config plus the given files instead of the default defineConfig
   * project layout with its agent-bundle module shim.
   */
  config?: string;
  /** Files written relative to the fixture root, replacing the default skill tree. */
  files?: Readonly<Record<string, string | Uint8Array>>;
  /** Temp-directory prefix. Defaults to 'agent-bundle-config-'. */
  prefix?: string;
  skills?: string[];
}

const sourceEntryPoint = resolve(
  process.cwd(),
  'packages/agent-bundle/src/index.ts',
);

export const createProjectFixture = async (
  options: ProjectFixtureOptions = {},
): Promise<ProjectFixture> => {
  const root = await mkdtemp(join(tmpdir(), options.prefix ?? 'agent-bundle-config-'));
  const skillDir = join(root, 'skills/review');
  const skillSource = join(skillDir, 'SKILL.md');
  const imagePath = join(skillDir, 'assets/diagram.png');
  const configPath = join(root, 'agent-bundle.config.ts');

  if (options.config !== undefined || options.files !== undefined) {
    const files = options.files ?? {};
    await Promise.all([configPath, ...Object.keys(files).map((relativePath) => join(root, relativePath))]
      .map((path) => mkdir(dirname(path), { recursive: true })));
    await Promise.all([
      ...(options.config === undefined ? [] : [writeFile(configPath, options.config)]),
      ...Object.entries(files).map(([relativePath, contents]) => writeFile(join(root, relativePath), contents)),
    ]);
    const skillMarkdown = files['skills/review/SKILL.md'];
    return {
      configPath,
      imagePath,
      root,
      skillDir,
      skillMarkdown: typeof skillMarkdown === 'string' ? skillMarkdown : '',
      skillSource,
    };
  }

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
  await rm(root, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
};
