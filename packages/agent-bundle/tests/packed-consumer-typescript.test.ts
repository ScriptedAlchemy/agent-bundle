import { execFile as executeFile } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import { isolatedCommandEnvironment } from '../../../rstest.worker-isolation.ts';
import { cachedNpmInstallArguments, sharedPackedTarball } from './support/shared-pack.ts';

const execFile = promisify(executeFile);
const workspaceRoot = process.cwd();

const workspaceTypeScriptVersion = async (): Promise<string> => {
  const manifest = JSON.parse(await readFile(join(workspaceRoot, 'package.json'), 'utf8')) as {
    readonly devDependencies: Readonly<Record<string, string>>;
  };
  return manifest.devDependencies['typescript']!;
};

/**
 * #381: the route-config parser ships bundled inside the package, so an npm
 * consumer that installs agent-bundle beside its own `typescript` keeps its
 * own `tsc` bin. Under npm an aliased dependency still contributes its `bin`
 * entries and wins the `.bin/tsc` link race, which silently ran an old
 * TypeScript over the consumer's tsconfig.
 */
it('never shadows the consumer\'s tsc bin from a packed npm install', async () => {
  const { tarball } = await sharedPackedTarball('agent-bundle');
  const typescriptVersion = await workspaceTypeScriptVersion();

  const consumerRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-tsc-'));
  try {
    await writeFile(join(consumerRoot, 'package.json'), '{"name":"packed-tsc-consumer","private":true,"type":"module"}\n');
    await execFile(
      'npm',
      ['install', ...cachedNpmInstallArguments, '--save-dev', `typescript@${typescriptVersion}`, tarball],
      { cwd: consumerRoot, env: isolatedCommandEnvironment() },
    );

    // The bin link is the consumer's own TypeScript, and no aliased copy was hoisted beside it.
    const tscLink = await readlink(join(consumerRoot, 'node_modules', '.bin', 'tsc'));
    expect(tscLink.replaceAll('\\', '/')).toBe('../typescript/bin/tsc');
    await expect(access(join(consumerRoot, 'node_modules', 'typescript-5'))).rejects.toThrow();
    const installedTypeScript = JSON.parse(
      await readFile(join(consumerRoot, 'node_modules', 'typescript', 'package.json'), 'utf8'),
    ) as { readonly version: string };
    expect(installedTypeScript.version).toBe(typescriptVersion);
    const { stdout: reportedVersion } = await execFile(
      join(consumerRoot, 'node_modules', '.bin', 'tsc'),
      ['--version'],
      { cwd: consumerRoot, env: isolatedCommandEnvironment() },
    );
    expect(reportedVersion).toContain(typescriptVersion);

    // The packed package still parses route config statically, so the bundled
    // parser — not a consumer-visible dependency — is what does that work.
    const installedManifest = JSON.parse(
      await readFile(join(consumerRoot, 'node_modules', 'agent-bundle', 'package.json'), 'utf8'),
    ) as { readonly dependencies: Readonly<Record<string, string>> };
    expect(Object.keys(installedManifest.dependencies)).not.toContain('typescript-5');
    const projectRoot = join(consumerRoot, 'project');
    const routePath = join(projectRoot, 'src', 'mcp', 'demo', 'tools', 'status.ts');
    await mkdir(dirname(routePath), { recursive: true });
    await Promise.all([
      writeFile(join(projectRoot, 'package.json'), '{"name":"packed-tsc-project","private":true,"type":"module","version":"1.0.0"}\n'),
      writeFile(join(projectRoot, 'agent-bundle.config.ts'), [
        "export default { plugin: { name: 'packed-tsc-project' }, targets: ['portable'] };",
        '',
      ].join('\n')),
      writeFile(routePath, [
        "export const config = { annotations: { readOnlyHint: true }, description: 'Read status.' } satisfies { description: string };",
        'export const inputSchema = {};',
        'export const resultSchema = {};',
        'export default async () => undefined;',
        '',
      ].join('\n')),
    ]);
    const { stdout: inspected } = await execFile(
      join(consumerRoot, 'node_modules', '.bin', 'agent-bundle'),
      ['inspect', '--routes', '--json', '--root', projectRoot],
      { cwd: projectRoot, env: isolatedCommandEnvironment() },
    );
    expect(JSON.stringify(JSON.parse(inspected))).toContain('"tool:demo/status"');
    expect(inspected).toContain('Read status.');
  } finally {
    await rm(consumerRoot, { force: true, recursive: true });
  }
}, 120_000);
