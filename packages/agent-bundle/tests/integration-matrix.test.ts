import { execFile as executeFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { build, inspect, invokeMcp, listHooks, listMcp, simulateHook, validate } from '../src/api.ts';

const execFile = promisify(executeFile);
const fixturesRoot = join(process.cwd(), 'fixtures', 'integration');
const fixtureRoot = join(fixturesRoot, 'comprehensive');

it('builds the checked-in fixture matrix from a path with spaces', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-integration-matrix-'));
  const root = join(parent, 'project with spaces');
  const output = join(root, 'artifact');
  await cp(fixtureRoot, root, { recursive: true });
  await mkdir(join(root, 'node_modules'), { recursive: true });
  await symlink(
    join(process.cwd(), 'node_modules', '@modelcontextprotocol'),
    join(root, 'node_modules', '@modelcontextprotocol'),
    'dir',
  );

  try {
    await expect(readFile(join(root, 'package.json'), 'utf8').then(JSON.parse)).resolves.toMatchObject({
      devDependencies: { '@modelcontextprotocol/server': '2.0.0' },
    });
    const inspection = await inspect({ root });
    expect(inspection.model).toMatchObject({
      metadata: { name: 'integration-fixture' },
      scripts: [
        { mode: 'bundle', name: 'bundle' },
        { mode: 'copy', name: 'python' },
        { mode: 'copy', name: 'shell' },
      ],
      targets: [{ name: 'portable' }, { name: 'codex' }, { name: 'claude' }],
    });

    await build({ output, root });
    await expect(validate({ artifact: output, root })).resolves.toEqual({ diagnostics: [] });

    const generatedShell = join(output, 'portable', 'scripts', 'shell.sh');
    const generatedPython = join(output, 'portable', 'scripts', 'python.py');
    await expect(execFile(generatedShell, [], { cwd: root })).resolves.toMatchObject({ stdout: 'shell fixture\n' });
    await expect(execFile('python3', [generatedPython], { cwd: root })).resolves.toMatchObject({ stdout: 'python fixture\n' });
    expect((await stat(generatedShell)).mode & 0o777).toBe(0o751);
    expect((await stat(generatedPython)).mode & 0o777).toBe(0o711);

    const bundled = await import(pathToFileURL(join(output, 'portable', 'scripts', 'bundle.mjs')).href);
    expect(bundled.bundleMessage).toBe('bundled fixture');
    await expect(readFile(join(output, 'portable', 'scripts', 'bundle.mjs'), 'utf8')).resolves.not.toMatch(
      /from\s+['"]agent-bundle(?:\/[^'"]*)?['"]/,
    );

    await expect(readFile(join(output, 'portable', 'skills', 'review', 'references', 'guide.txt'), 'utf8')).resolves.toBe(
      'fixture reference\n',
    );
    await expect(readFile(join(output, 'portable', 'skills', 'review', 'assets', 'binary.bin'))).resolves.toEqual(
      await readFile(join(root, 'skills', 'review', 'assets', 'binary.bin')),
    );

    const [portableMcp, codexMcp, claudeMcp, codexHooks, claudeHooks, codexMarketplace, claudeMarketplace] =
      await Promise.all([
        readFile(join(output, 'portable', 'mcp.json'), 'utf8').then((value) => JSON.parse(value)),
        readFile(join(output, 'codex', '.mcp.json'), 'utf8').then((value) => JSON.parse(value)),
        readFile(join(output, 'claude', '.mcp.json'), 'utf8').then((value) => JSON.parse(value)),
        readFile(join(output, 'codex', 'hooks', 'hooks.json'), 'utf8').then((value) => JSON.parse(value)),
        readFile(join(output, 'claude', 'hooks', 'hooks.json'), 'utf8').then((value) => JSON.parse(value)),
        readFile(join(output, 'codex', '.agents', 'plugins', 'marketplace.json'), 'utf8').then((value) => JSON.parse(value)),
        readFile(join(output, 'claude', '.claude-plugin', 'marketplace.json'), 'utf8').then((value) => JSON.parse(value)),
      ]);
    expect(portableMcp.mcpServers['remote-http']).toEqual({
      headers: { 'X-Fixture': 'integration' },
      type: 'streamable-http',
      url: 'https://mcp.example.test/stream',
    });
    expect(codexMcp.mcpServers['remote-http']).toEqual({
      headers: { 'X-Fixture': 'integration' },
      type: 'streamable-http',
      url: 'https://mcp.example.test/stream',
    });
    expect(claudeMcp.mcpServers['remote-http']).toEqual({
      headers: { 'X-Fixture': 'integration' },
      type: 'http',
      url: 'https://mcp.example.test/stream',
    });
    expect(codexMarketplace).toMatchObject({
      name: 'integration-fixture-marketplace',
      plugins: [{ name: 'integration-fixture', source: { path: './', source: 'local' } }],
    });
    expect(claudeMarketplace).toMatchObject({
      name: 'integration-fixture-marketplace',
      owner: { name: 'integration-fixture' },
      plugins: [{ name: 'integration-fixture', source: './' }],
    });
    for (const [hooksDocument, description, command] of [
      [codexHooks, 'Codex native integration hook', 'echo codex-native'],
      [claudeHooks, 'Claude native integration hook', 'echo claude-native'],
    ]) {
      expect(hooksDocument).toMatchObject({ description });
      expect(hooksDocument.hooks.SessionStart).toEqual(expect.arrayContaining([
        expect.objectContaining({ hooks: [expect.objectContaining({ command, type: 'command' })] }),
      ]));
    }

    const localMcpPath = portableMcp.mcpServers.local.args[0] as string;
    await expect(readFile(join(output, 'portable', localMcpPath), 'utf8')).resolves.toContain('ordinary local import');
    const localTools = await listMcp({ artifact: output, root, server: 'local', target: 'portable' });
    expect(localTools.tools).toMatchObject([{
      _meta: { ui: { resourceUri: 'ui://integration-fixture/dashboard-v1.html' } },
      name: 'show-dashboard',
    }]);
    const localInvocation = await invokeMcp({
      artifact: output,
      input: {},
      root,
      server: 'local',
      target: 'portable',
      tool: 'show-dashboard',
    });
    expect(localInvocation.result).toMatchObject({
      _meta: { ui: { resourceUri: 'ui://integration-fixture/dashboard-v1.html' } },
      content: [{ text: 'dashboard ready: ordinary local import', type: 'text' }],
      structuredContent: { resourceUri: 'ui://integration-fixture/dashboard-v1.html', view: 'dashboard' },
    });

    const client = new Client({ name: 'integration-matrix', version: '1.0.0' });
    await client.connect(new StdioClientTransport({
      args: [join(output, 'portable', localMcpPath)],
      command: process.execPath,
      stderr: 'pipe',
    }));
    try {
      await expect(client.listResources()).resolves.toMatchObject({
        resources: [{
          _meta: { ui: { prefersBorder: true, resourceUri: 'ui://integration-fixture/dashboard-v1.html' } },
          mimeType: 'text/html;profile=mcp-app',
          name: 'dashboard',
          uri: 'ui://integration-fixture/dashboard-v1.html',
        }],
      });
      await expect(client.readResource({ uri: 'ui://integration-fixture/dashboard-v1.html' })).resolves.toMatchObject({
        contents: [{
          mimeType: 'text/html;profile=mcp-app',
          text: expect.stringContaining('integration dashboard'),
          uri: 'ui://integration-fixture/dashboard-v1.html',
        }],
      });
    } finally {
      await client.close();
    }

    const hooks = await listHooks({ artifact: output, root });
    expect(hooks).toHaveLength(2);
    await expect(simulateHook({
      artifact: output,
      hook: hooks[0]!.id,
      input: {
        cwd: root,
        sessionId: 'matrix',
        source: 'fixture',
        transcriptPath: join(root, 'transcript.json'),
      },
      root,
      target: hooks[0]!.target,
    })).resolves.toEqual({ additionalContext: 'hook:fixture', outcome: 'continue' });
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
}, 60_000);

it('builds the checked-in portable skills-only fixture', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-skills-only-'));
  const root = join(parent, 'skills-only');
  const output = join(root, 'artifact');
  await cp(join(fixturesRoot, 'skills-only'), root, { recursive: true });

  try {
    await expect(inspect({ root })).resolves.toMatchObject({
      model: { scripts: [], targets: [{ name: 'portable' }] },
    });
    await build({ output, root });
    await expect(readFile(join(output, 'portable', 'skills', 'portable-skill', 'SKILL.md'), 'utf8')).resolves.toBe(
      '---\nname: portable-skill\ndescription: A portable skills-only fixture.\n---\n# Portable skill\n\nRead [the guide](references/guide.txt) before using the asset.\n',
    );
    await expect(readFile(join(output, 'portable', 'skills', 'portable-skill', 'references', 'guide.txt'), 'utf8')).resolves.toBe(
      'portable guide\n',
    );
    await expect(readFile(join(output, 'portable', 'skills', 'portable-skill', 'assets', 'binary.bin'))).resolves.toEqual(
      await readFile(join(root, 'skills', 'portable-skill', 'assets', 'binary.bin')),
    );
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});

it('reports checked-in unsupported-capability and canonical-collision diagnostics', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-bundle-negative-fixtures-'));
  const unsupportedRoot = join(parent, 'unsupported');
  const collisionRoot = join(parent, 'collision');
  await Promise.all([
    cp(join(fixturesRoot, 'unsupported-capability'), unsupportedRoot, { recursive: true }),
    cp(join(fixturesRoot, 'canonical-collision'), collisionRoot, { recursive: true }),
  ]);

  try {
    const [unsupported, collision] = await Promise.all([
      validate({ root: unsupportedRoot }),
      validate({ root: collisionRoot }),
    ]);
    expect(unsupported.diagnostics.map((diagnostic) => diagnostic.code)).toContain('AB4204');
    expect(collision.diagnostics.map((diagnostic) => diagnostic.code)).toContain('AB4408');
  } finally {
    await rm(parent, { force: true, recursive: true });
  }
});
