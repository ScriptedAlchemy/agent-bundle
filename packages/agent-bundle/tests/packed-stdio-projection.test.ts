import { execFile as executeFile } from 'node:child_process';
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import { openPackedMcpServer } from '../src/test/packed.ts';
import { cachedNpmInstallArguments, installedEnvironment, sharedPackedTarball } from './support/shared-pack.ts';

const execFile = promisify(executeFile);
const fixtureRoot = resolve(import.meta.dirname, '../fixtures/route-harness');

interface McpJson {
  readonly mcpServers: Readonly<Record<string, { readonly args: readonly [string, ...string[]] }>>;
}

/**
 * The `packed-stdio` proof level, and the repository's single packed proof
 * journey for the consumer test harness (#103 stage 2 cost rule).
 *
 * One tarball (the run-level shared pack), one install, one artifact build,
 * one spawned server. Every per-route assertion runs inside that one client
 * session, because a second spawn would double the only cost this level has
 * and prove the same thing twice.
 *
 * This is the only harness level that is process evidence: the generated
 * entry runs as a separate operating-system process, out of a built artifact,
 * over real stdio framing. The `mcp-in-memory` level (tests/projection/)
 * covers the same protocol surface at a fraction of the cost and explicitly
 * does not claim any of this.
 */
it('serves every compiled route from a packed install over real stdio', async () => {
  const [agentBundle, runtime] = await Promise.all([
    sharedPackedTarball('agent-bundle'),
    sharedPackedTarball('runtime'),
  ]);
  const consumer = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-stdio-'));
  const project = join(consumer, 'project');
  const artifact = join(project, 'artifact');

  try {
    await cp(fixtureRoot, project, { recursive: true });
    await execFile('npm', ['install', ...cachedNpmInstallArguments,
      agentBundle.tarball,
      runtime.tarball,
      'react@19.2.8',
      'react-dom@19.2.8',
      'zod@4.4.3',
    ], { cwd: project, env: installedEnvironment() });

    // The fixture selects `claude`, the only target whose capabilities cover
    // its event route; Claude Code reads `.mcp.json` at the plugin root.
    const cli = join(project, 'node_modules', '.bin', 'agent-bundle');
    await execFile(cli, ['build', '--root', project, '--output', artifact], {
      cwd: project,
      env: installedEnvironment(),
    });

    const pluginRoot = join(artifact, 'claude');
    const manifest = JSON.parse(await readFile(join(pluginRoot, '.mcp.json'), 'utf8')) as McpJson;
    // Claude Code expands ${CLAUDE_PLUGIN_ROOT} to the installed plugin root
    // before it spawns the server; the test stands in for the host there.
    const entry = manifest.mcpServers['harness']!.args[0].replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);

    await using session = await openPackedMcpServer({ cwd: project, entry, env: installedEnvironment() as Record<string, string> });

    expect(session.provenance.proofLevel).toBe('packed-stdio');
    expect(session.provenance.pid).toBeGreaterThan(0);

    const tools = await session.client.listTools();
    expect(tools.tools.map((tool) => tool.name).sort()).toEqual(['catalog', 'echo', 'unavailable']);

    // Per-route assertions iterate inside this one session: the packed cost is
    // the spawn, not the calls.
    await expect(session.client.callTool({ arguments: { message: 'packed' }, name: 'echo' }))
      .resolves.toMatchObject({
        content: [{ text: '# Echo\n\npacked', type: 'text' }, { text: expect.stringContaining('workspace:'), type: 'text' }],
        structuredContent: { message: 'packed', operationId: 'tool:harness/echo' },
      });
    await expect(session.client.callTool({ arguments: { genre: 'mystery' }, name: 'catalog' }))
      .resolves.toMatchObject({
        content: [
          { text: 'catalog: mystery', type: 'text' },
          { text: '## mystery\n\n- Piranesi\n- Solaris', type: 'text' },
        ],
        structuredContent: { genre: 'mystery', titles: ['Piranesi', 'Solaris'] },
      });
    await expect(session.client.callTool({ arguments: {}, name: 'unavailable' }))
      .resolves.toMatchObject({ isError: true, structuredContent: { available: false } });
    await expect(session.client.readResource({ uri: 'harness://notes' })).resolves.toEqual({
      contents: [{ mimeType: 'text/markdown', text: '# Notes for harness://notes', uri: 'harness://notes' }],
    });
    await expect(session.client.getPrompt({ arguments: { note: 'chapter one' }, name: 'summarize' })).resolves.toEqual({
      messages: [{ content: { text: 'Summarize chapter one', type: 'text' }, role: 'user' }],
    });

    // The generated entry keeps stdout for the protocol; anything the routes or
    // the warm worker print has to arrive on stderr instead.
    expect(session.stderr()).not.toContain('"jsonrpc"');
  } finally {
    await rm(consumer, { force: true, recursive: true });
  }
}, 300_000);
