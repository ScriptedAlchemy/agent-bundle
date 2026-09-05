import { mkdir, mkdtemp, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

import { afterEach, expect, it } from '@rstest/core';

import { build } from '../src/api.ts';
import { parseArtifactManifest } from '../src/build/manifest.ts';
import { sha256Hex } from '../src/core/digest.ts';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const writeProjectFile = async (root: string, path: string, contents: string): Promise<void> => {
  const output = join(root, path);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, contents);
};

/**
 * A project with every surface whose generated wrapper imports a virtual
 * module as a namespace: a routed MCP server (its route registry module is
 * what Rspack names in a `// NAMESPACE OBJECT` comment), event routes for
 * three hosts, a routed CLI command, and a bundled script.
 */
const writeProject = async (root: string): Promise<void> => {
  // The audiobook example's installed tree supplies @agent-bundle/runtime, react, and zod.
  await symlink(join(process.cwd(), 'examples', 'audiobook-curator', 'node_modules'), join(root, 'node_modules'), 'dir');
  await Promise.all([
    writeProjectFile(root, 'package.json', JSON.stringify({
      dependencies: {
        '@agent-bundle/runtime': 'workspace:*',
        '@modelcontextprotocol/server': '2.0.0',
        react: '19.2.8',
        zod: '4.4.3',
      },
      name: 'reproducible-fixture',
      type: 'module',
      version: '1.0.0',
    })),
    writeProjectFile(root, 'agent-bundle.config.ts', [
      "import { defineConfig } from 'agent-bundle/config';",
      'export default defineConfig({',
      "  plugin: { description: 'Reproducible build fixture.', name: 'reproducible-fixture', version: '1.0.0' },",
      "  targets: ['claude', 'codex', 'cursor', 'portable'],",
      '});',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/mcp/harness/tools/lookup.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { z } from 'zod';",
      "export const config = { annotations: { readOnlyHint: true }, description: 'Looks up one value.' };",
      'export const inputSchema = z.object({ message: z.string().default("ready") }).strict();',
      "export const resultSchema = z.object({ message: z.string() }).strict();",
      'export default async function Lookup({ input }) {',
      '  return <Agent.Result value={{ message: input.message }}><Agent.Markdown>{`Lookup: ${input.message}`}</Agent.Markdown></Agent.Result>;',
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/events/session/start.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "export const config = { targets: ['claude', 'codex', 'cursor'] };",
      'export default async function SessionStart() {',
      '  return <Agent.Result value={{ started: true }}><Agent.Context>session started</Agent.Context></Agent.Result>;',
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/cli/report.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { z } from 'zod';",
      "export const config = { description: 'Render a report.', positionals: ['root'] };",
      'export const inputSchema = z.object({ root: z.string().min(1) }).strict();',
      'export const resultSchema = z.object({ root: z.string() }).strict();',
      'export default async function Report({ input }) {',
      '  return <Agent.Result value={{ root: input.root }}><Agent.Markdown>{`Report for ${input.root}.`}</Agent.Markdown></Agent.Result>;',
      '}',
      '',
    ].join('\n')),
    writeProjectFile(root, 'src/scripts/summarize.tsx', [
      "import { Agent } from '@agent-bundle/runtime';",
      'export default async function Summarize({ argv }) {',
      '  return <Agent.Result value={{ arguments: argv.length }}><Agent.Text>{`Summarized ${String(argv.length)} arguments.`}</Agent.Text></Agent.Result>;',
      '}',
      '',
    ].join('\n')),
  ]);
};

/** Every regular file under `root`, as POSIX paths relative to it, with its SHA-256. */
const digestTree = async (root: string): Promise<ReadonlyMap<string, string>> => {
  const digests = new Map<string, string>();
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) digests.set(relative(root, path).replaceAll('\\', '/'), sha256Hex(await readFile(path)));
    }
  };
  await walk(root);
  return digests;
};

/**
 * Two builds of one unchanged source tree — into two different output
 * directories, each through its own per-build staging directory
 * (`.<output>.stage-XXXXXX`) — emit byte-identical artifacts: the same
 * manifest, the same file digests, the same bytes. Nothing in an emitted
 * bundle may name the staging directory, the output directory, or any
 * absolute path of the machine that built it; the generated-module
 * namespace Rspack names in its module comments derives from the project
 * root alone.
 */
it('emits byte-identical artifacts from two builds of one source into two output directories', { timeout: 240_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-reproducible-'));
  roots.push(root);
  // Completed outputs move out of the project between builds so the second
  // build's source snapshot (and so its project revision) is the first's.
  const parked = await mkdtemp(join(tmpdir(), 'agent-bundle-reproducible-outputs-'));
  roots.push(parked);
  await writeProject(root);

  const outputs: string[] = [];
  const manifests: string[] = [];
  const stageTokens: string[] = [];
  for (const name of ['first-output', 'second-output']) {
    const output = join(root, name);
    const result = await build({ output, root });
    expect(result.diagnostics.filter((entry) => entry.severity === 'error')).toEqual([]);
    manifests.push(await readFile(join(output, 'agent-bundle.manifest.json'), 'utf8'));
    // The build staged under a directory named after this output; that
    // token is what a reproducible artifact must never contain.
    stageTokens.push(`.${name}.stage-`);
    const parkedOutput = join(parked, name);
    await rename(output, parkedOutput);
    outputs.push(parkedOutput);
  }

  const [first, second] = outputs as [string, string];
  const [firstManifest, secondManifest] = manifests as [string, string];
  expect(secondManifest).toBe(firstManifest);
  const manifest = parseArtifactManifest(firstManifest);
  expect(manifest.files.length).toBeGreaterThan(0);

  const [firstDigests, secondDigests] = await Promise.all([digestTree(first), digestTree(second)]);
  expect([...secondDigests.keys()].sort()).toEqual([...firstDigests.keys()].sort());
  const differing = [...firstDigests].filter(([path, digest]) => secondDigests.get(path) !== digest).map(([path]) => path);
  expect(differing).toEqual([]);
  // The manifest's own digests describe exactly these bytes.
  for (const file of manifest.files) {
    expect(firstDigests.get(file.path)).toBe(file.sha256);
  }

  // Every compiled surface is present, and the route registry the MCP
  // entry imports as a namespace is named by its project-rooted virtual
  // path — not by the staged directory, the output directory, or the machine.
  const bundles = [...firstDigests.keys()].filter((path) => path.endsWith('.mjs'));
  expect(bundles.some((path) => /^mcp\/mcp-harness-[a-f\d]{8}\.mjs$/u.test(path))).toBe(true);
  expect(bundles).toEqual(expect.arrayContaining([
    'hooks/event-route-session-start.mjs',
    'hooks/event-route-session-start.cursor.mjs',
    'bin/reproducible-fixture.mjs',
    'scripts/summarize.mjs',
  ]));
  const forbidden = [root, parked, '.artifact.stage-', ...stageTokens];
  for (const path of bundles) {
    const source = await readFile(join(first, path), 'utf8');
    for (const token of forbidden) {
      expect(source, `${path} names ${token}`).not.toContain(token);
    }
  }
  const mcpEntry = bundles.find((path) => /^mcp\/mcp-harness-[a-f\d]{8}\.mjs$/u.test(path))!;
  expect(await readFile(join(first, mcpEntry), 'utf8')).toMatch(/NAMESPACE OBJECT: \.\/\.agent-bundle-virtual\/mcp-harness-[a-f\d]{8}-\d+\.mjs/u);
});
