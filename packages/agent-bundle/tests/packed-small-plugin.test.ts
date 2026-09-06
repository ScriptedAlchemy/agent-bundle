import { execFile as executeFile } from 'node:child_process';
import { access, cp, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import {
  cachedNpmInstallArguments,
  installedEnvironment,
  sharedPackedTarball,
} from './support/shared-pack.ts';

const execFile = promisify(executeFile);
const examples = resolve(process.cwd(), 'examples');

interface ArtifactManifest {
  readonly executables: {
    readonly bins: readonly unknown[];
    readonly hooks: readonly { readonly host: string; readonly id: string; readonly path: string }[];
    readonly mcpServers: readonly unknown[];
    readonly scripts: readonly unknown[];
  };
  readonly files: readonly { readonly path: string }[];
  readonly web?: unknown;
}

const artifactFiles = async (root: string): Promise<readonly string[]> =>
  (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)))
    .sort();

const run = (
  cli: string,
  root: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<{ readonly stderr: string; readonly stdout: string }> =>
  execFile(cli, [...args], { cwd: root, env });

const assertSmallRuntime = async (
  artifact: string,
  expectedHooks: number,
): Promise<ArtifactManifest> => {
  const manifest = JSON.parse(await readFile(join(artifact, 'agent-bundle.manifest.json'), 'utf8')) as ArtifactManifest;
  const files = await artifactFiles(artifact);
  expect(files).toHaveLength(manifest.files.length + 1);
  expect(manifest.executables.bins).toEqual([]);
  expect(manifest.executables.mcpServers).toEqual([]);
  expect(manifest.executables.scripts).toEqual([]);
  expect(manifest.executables.hooks).toHaveLength(expectedHooks);
  expect(manifest).not.toHaveProperty('web');
  expect(files).not.toEqual(expect.arrayContaining([
    expect.stringMatching(/(?:^|\/)mcp(?:-apps)?\//u),
    expect.stringMatching(/-flight\.mjs$/u),
    expect.stringMatching(/(?:^|\/)(?:app-renderer|flight|notices?|sqlite|state)(?:\/|\.|-|$)/u),
  ]));
  expect(files.filter((path) => /(?:^|\/)\.?mcp(?:-apps)?(?:\.json|\/)/u.test(path))).toEqual([]);
  if (expectedHooks === 0) {
    expect(files.filter((path) => /hooks\.json$/u.test(path))).toEqual([]);
  }
  return manifest;
};

it('keeps packed static and plain-hook plugins free of undeclared runtimes', async () => {
  const { tarball } = await sharedPackedTarball('agent-bundle');
  const consumer = await mkdtemp(join(tmpdir(), 'agent-bundle-small-plugin-'));
  const staticRoot = join(consumer, 'static');
  const hookRoot = join(consumer, 'plain-hook');
  const processTrace = join(consumer, 'plugin-processes.txt');
  const processTracer = join(consumer, 'trace-plugin-process.cjs');

  try {
    await Promise.all([
      writeFile(processTrace, ''),
      writeFile(processTracer, [
        "const { appendFileSync } = require('node:fs');",
        "const { sep } = require('node:path');",
        "if (process.argv[1]?.includes(`${sep}hooks${sep}`)) appendFileSync(process.env.AGENT_BUNDLE_PROCESS_TRACE, `${process.pid} ${process.argv[1]}\\n`);",
        '',
      ].join('\n')),
    ]);
    const baseEnvironment = installedEnvironment();
    const environment = {
      ...baseEnvironment,
      AGENT_BUNDLE_PROCESS_TRACE: processTrace,
      NODE_OPTIONS: [baseEnvironment.NODE_OPTIONS, `--require=${processTracer}`].filter(Boolean).join(' '),
    };
    await Promise.all([
      cp(join(examples, 'skills-starter'), staticRoot, {
        filter: (source) => !['.agent-bundle', 'node_modules'].includes(basename(source)),
        recursive: true,
      }),
      cp(join(examples, 'skills-starter'), hookRoot, {
        filter: (source) => !['.agent-bundle', 'node_modules'].includes(basename(source)),
        recursive: true,
      }),
    ]);
    await Promise.all([staticRoot, hookRoot].map((root) =>
      writeFile(join(root, 'package.json'), JSON.stringify({ private: true, type: 'module' }))));
    await mkdir(join(hookRoot, 'src', 'hooks'), { recursive: true });
    await Promise.all([
      cp(
        join(examples, 'hooks-and-scripts', 'src', 'hooks', 'session-start.ts'),
        join(hookRoot, 'src', 'hooks', 'session-start.ts'),
      ),
      cp(
        join(examples, 'hooks-and-scripts', 'src', 'release-context.ts'),
        join(hookRoot, 'src', 'release-context.ts'),
      ),
    ]);
    const hookConfig = (await readFile(join(hookRoot, 'agent-bundle.config.ts'), 'utf8'))
      .replace(
        '  plugin:',
        "  hooks: { sessionStart: { handler: './src/hooks/session-start.ts', targets: ['codex'] } },\n  plugin:",
      )
      .replace("name: 'skills-starter'", "name: 'skills-starter-hook'");
    await writeFile(join(hookRoot, 'agent-bundle.config.ts'), hookConfig);
    await Promise.all([staticRoot, hookRoot].map((root) =>
      execFile('npm', ['install', ...cachedNpmInstallArguments, tarball], {
        cwd: root,
        env: environment,
      })));

    for (const [root, expectedHooks] of [[staticRoot, 0], [hookRoot, 1]] as const) {
      const cli = join(root, 'node_modules', '.bin', 'agent-bundle');
      const artifact = join(root, 'artifact');
      const relocated = join(root, 'relocated');
      const { stdout: inspection } = await run(cli, root, ['inspect', '--json', '--root', root], environment);
      const model = (JSON.parse(inspection) as { readonly model: {
        readonly mcpApps: readonly unknown[];
        readonly mcpServers: readonly unknown[];
        readonly state?: unknown;
      } }).model;
      expect(model.mcpApps).toEqual([]);
      expect(model.mcpServers).toEqual([]);
      expect(model).not.toHaveProperty('state');
      await run(cli, root, ['build', '--root', root, '--output', artifact], environment);
      await run(cli, root, ['validate', '--root', root, '--artifact', artifact], environment);
      const manifest = await assertSmallRuntime(artifact, expectedHooks);
      await rename(artifact, relocated);
      await run(cli, root, ['validate', '--root', root, '--artifact', relocated], environment);

      if (expectedHooks === 0) {
        expect(await readFile(processTrace, 'utf8')).toBe('');
        const authored = (await readdir(join(root, 'src'), { recursive: true, withFileTypes: true }))
          .filter((entry) => entry.isFile())
          .map((entry) => entry.name);
        expect(authored.some((name) => /\.[jt]sx$/u.test(name))).toBe(false);
        const rebuilt = join(root, 'rebuilt');
        const commandSource = join(root, 'src', 'commands', 'review-release.md');
        await writeFile(commandSource, `${await readFile(commandSource, 'utf8')}\nReport the selected host projection.\n`);
        await run(cli, root, ['build', '--root', root, '--output', rebuilt], environment);
        await expect(readFile(join(rebuilt, 'commands', 'review-release.md'), 'utf8'))
          .resolves.toContain('Report the selected host projection.');
        await rm(join(root, 'src', 'rules', 'release-safety.mdc'));
        await run(cli, root, ['build', '--root', root, '--output', rebuilt], environment);
        await expect(access(join(rebuilt, 'rules', 'release-safety.mdc'))).rejects.toThrow();
        continue;
      }

      const hook = manifest.executables.hooks.find((entry) => entry.host === 'codex');
      if (hook === undefined) throw new Error('Packed plain-hook artifact has no Codex hook executable.');
      const { stdout } = await run(cli, root, [
        'hooks', 'simulate', '--json', '--root', root, '--artifact', relocated,
        '--target', hook.host, '--hook', hook.id,
        '--input', JSON.stringify({
          cwd: root,
          sessionId: 'packed-small',
          source: 'acceptance',
          transcriptPath: join(root, 'transcript.jsonl'),
        }),
      ], environment);
      expect(JSON.parse(stdout)).toMatchObject({
        additionalContext: expect.stringContaining('packed-small'),
        outcome: 'continue',
      });
      expect((await readFile(processTrace, 'utf8')).trim().split('\n')).toEqual([
        expect.stringContaining(hook.path),
      ]);
    }
  } finally {
    await rm(consumer, { force: true, recursive: true });
  }
}, 180_000);
