import { execFile as executeFile } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from '@rstest/core';

import { requestEventRuntime } from '../src/events/ipc.ts';
import { compileTestManifest } from '../src/test/manifest.ts';
import { runPackedContractMatrix } from '../src/test/contract.ts';
import {
  openPackedMcpServer,
  removeProjectSource,
  type PackedMcpSession,
} from '../src/test/packed.ts';
import { routeHarnessPackedContractFixtures } from './support/contract-matrix-fixtures.ts';
import { cachedNpmInstallArguments, installedEnvironment, sharedPackedTarball } from './support/shared-pack.ts';

const execFile = promisify(executeFile);
const fixtureRoot = resolve(import.meta.dirname, '../fixtures/route-harness');

interface McpJson {
  readonly mcpServers: Readonly<Record<string, {
    readonly args: readonly [string, ...string[]];
    readonly env?: Readonly<Record<string, string>>;
  }>>;
}

/**
 * The `packed-deleted-source` proof level, and the repository's single packed
 * proof journey for the consumer test harness (#103 cost rule).
 *
 * One tarball (the run-level shared pack), one install, one artifact build,
 * one verified source removal, and two spawned servers over that same built
 * artifact. The second spawn exists only to prove workspace-durable state and
 * notices survive a process restart; every other route stays in one session.
 *
 * The generated entry runs as a separate operating-system process, out of a
 * built artifact, over real stdio framing after the project source and config
 * are verified absent. Its MCP App resource therefore comes from the inline
 * artifact registry, not the deleted source tree. The `mcp-in-memory` level
 * (tests/projection/) covers the same route protocol surface at a fraction of
 * the cost and explicitly does not claim any of this.
 */
it('serves compiled routes and durable state across packed process restarts', async () => {
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
    const serverConfig = manifest.mcpServers['harness']!;
    // Claude Code expands ${CLAUDE_PLUGIN_ROOT} to the installed plugin root
    // before it spawns the server; the test stands in for the host there.
    const expandPluginRoot = (value: string): string =>
      value.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
    const entry = expandPluginRoot(serverConfig.args[0]);
    const serverEnvironment = Object.fromEntries(
      Object.entries(serverConfig.env ?? {}).map(([key, value]) => [key, expandPluginRoot(value)]),
    );
    expect(serverConfig.env).toMatchObject({
      AGENT_BUNDLE_PLUGIN_ROOT: '${CLAUDE_PLUGIN_ROOT}',
    });
    const env = {
      ...installedEnvironment(),
      ...serverEnvironment,
    } as Record<string, string>;
    const worker = entry.replace(/\.mjs$/u, '-flight.mjs');
    const workerSource = await readFile(worker, 'utf8');
    expect(workerSource).toContain('node:sqlite');
    expect(workerSource).toContain('createSqliteStateDriver');
    expect(workerSource).toContain('AGENT_BUNDLE_PLUGIN_ROOT');
    expect(workerSource).toMatch(/new URL\(["']\.\.["'], import\.meta\.url\)/u);
    const harnessManifest = await compileTestManifest({ root: project });
    const artifactManifest = JSON.parse(
      await readFile(join(artifact, 'agent-bundle.manifest.json'), 'utf8'),
    ) as { readonly project: { readonly revision: string } };
    const eventRuntimeEndpointId =
      `${artifactManifest.project.revision}:claude:${dirname(dirname(resolve(entry)))}`;
    const deletedSource = await removeProjectSource({ projectRoot: project });

    const firstSession = await openPackedMcpServer({
      cwd: project,
      deletedSource,
      entry,
      env,
    });
    let secondSession: PackedMcpSession | undefined;
    let noticeId: string;
    try {
      expect(firstSession.provenance.proofLevel).toBe('packed-deleted-source');
      expect(firstSession.provenance.pid).toBeGreaterThan(0);
      expect(firstSession.provenance.sourceRemoved).toEqual(['agent-bundle.config.ts', 'src']);

      const tools = await firstSession.client.listTools();
      expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
        'catalog',
        'context',
        'echo',
        'journal',
        'lifecycle',
        'mutation-probe',
        'publish-notice',
        'strict-report',
        'ticket',
        'tooling',
        'unavailable',
        'wait',
      ]);
      const resources = await firstSession.client.listResources();
      expect(resources.resources).toEqual(expect.arrayContaining([
        expect.objectContaining({ mimeType: 'text/markdown', uri: 'harness://notes' }),
        expect.objectContaining({ mimeType: 'text/html;profile=mcp-app', uri: 'ui://harness/panel' }),
      ]));

      await expect(firstSession.client.callTool({ arguments: { message: 'packed' }, name: 'echo' }))
        .resolves.toMatchObject({
          content: [{ text: '# Echo\n\npacked', type: 'text' }, { text: expect.stringContaining('workspace:'), type: 'text' }],
          structuredContent: { message: 'packed', operationId: 'tool:harness/echo' },
        });
      await expect(firstSession.client.callTool({ arguments: {}, name: 'context' }))
        .resolves.toMatchObject({
          structuredContent: {
            actor: { reason: 'not-provided', state: 'unavailable' },
            host: {
              source: 'native',
              state: 'available',
              value: { name: 'agent-bundle-packed-proof' },
            },
            session: { reason: 'not-provided', state: 'unavailable' },
            workspace: {
              source: 'derived',
              state: 'available',
              value: { root: project },
            },
          },
        });
      await expect(firstSession.client.callTool({ arguments: { genre: 'mystery' }, name: 'catalog' }))
        .resolves.toMatchObject({
          content: [
            { text: 'catalog: mystery', type: 'text' },
            { text: '## mystery\n\n- Piranesi\n- Solaris', type: 'text' },
          ],
          structuredContent: { genre: 'mystery', titles: ['Piranesi', 'Solaris'] },
        });
      await expect(firstSession.client.callTool({
        arguments: { note: 'packed durable proof' },
        name: 'journal',
      })).resolves.toMatchObject({
        structuredContent: { entries: [{ note: 'packed durable proof' }], revision: 1 },
      });
      const published = await firstSession.client.callTool({
        arguments: { message: 'cross-process notice', recipientSession: 'proof-session' },
        name: 'publish-notice',
      });
      expect(published).toMatchObject({
        structuredContent: { noticeId: expect.any(String), state: 'pending' },
      });
      noticeId = String((published.structuredContent as { noticeId: string }).noticeId);
      await expect(firstSession.client.callTool({ arguments: {}, name: 'unavailable' }))
        .resolves.toMatchObject({ isError: true, structuredContent: { available: false } });
      await expect(firstSession.client.readResource({ uri: 'harness://notes' })).resolves.toEqual({
        contents: [{ mimeType: 'text/markdown', text: '# Notes for harness://notes', uri: 'harness://notes' }],
      });
      const panel = await firstSession.client.readResource({ uri: 'ui://harness/panel' });
      expect(panel.contents[0]).toMatchObject({
        mimeType: 'text/html;profile=mcp-app',
        uri: 'ui://harness/panel',
      });
      const panelContent = panel.contents[0];
      if (panelContent === undefined || !('text' in panelContent)) {
        throw new TypeError('The embedded panel resource did not return inline text.');
      }
      expect(panelContent.text).toContain('route-harness panel');
      expect(panelContent.text).toMatch(/<script\b/iu);
      expect(panelContent.text).not.toMatch(/<(?:script|link)\b[^>]+(?:src|href)=/iu);
      await expect(firstSession.client.getPrompt({
        arguments: { note: 'chapter one' },
        name: 'summarize',
      })).resolves.toEqual({
        messages: [{ content: { text: 'Summarize chapter one', type: 'text' }, role: 'user' }],
      });
      const matrixReport = await runPackedContractMatrix({
        eventRuntime: { endpointId: eventRuntimeEndpointId },
        fixtures: routeHarnessPackedContractFixtures(),
        manifest: harnessManifest,
        restart: async () => {
          await firstSession.close();
          secondSession = await openPackedMcpServer({
            cwd: project,
            deletedSource,
            entry,
            env,
          });
          return secondSession;
        },
        server: 'harness',
        session: firstSession,
      });
      expect(matrixReport.provenance.proofLevel).toBe('packed-deleted-source');
      // No fixture names the app route: the packed level auto-covers it (#401).
      expect(matrixReport.routes['app:harness/panel']?.checks.coverage).toEqual({
        reason: expect.stringContaining('auto-covered'),
        status: 'passed',
      });
      expect(matrixReport.routes['app:harness/panel']?.checks['surface-completeness']).toEqual({
        status: 'passed',
      });
      expect(matrixReport.routes['app:harness/panel']?.checks.sweep).toEqual({
        status: 'passed',
      });
      expect(matrixReport.routes['tool:harness/lifecycle']?.checks['restart-durability']).toEqual({
        status: 'passed',
      });
      expect(matrixReport.checks['runtime-instance-identity']).toEqual({
        status: 'passed',
      });
      expect(matrixReport.routes['tool:harness/lifecycle']?.checks['state-catalog']).toEqual({
        status: 'passed',
      });
      expect(matrixReport.routes['tool:harness/lifecycle']?.checks['lifecycle-serialized-round-trip']).toEqual({
        reason: expect.stringContaining('packed sessions cannot load project route modules'),
        status: 'not-applicable',
      });
      expect(firstSession.stderr()).not.toContain('"jsonrpc"');
    } finally {
      await firstSession.close();
    }

    const stateRoot = join(pluginRoot, 'state');
    expect(await readdir(stateRoot)).toEqual(expect.arrayContaining([
      expect.stringMatching(/\.sqlite$/u),
    ]));

    if (secondSession === undefined) throw new TypeError('Contract matrix did not restart the packed session.');
    try {
      await expect(secondSession.client.callTool({ arguments: {}, name: 'journal' }))
        .resolves.toMatchObject({
          structuredContent: { entries: [{ note: 'packed durable proof' }], revision: 6 },
        });
      let eventResponse: unknown;
      try {
        eventResponse = await requestEventRuntime({
          artifactEpoch: artifactManifest.project.revision,
          endpointId: eventRuntimeEndpointId,
          event: 'tool/after',
          hostContractRevision: 'packed-proof',
          native: {
            cwd: project,
            hook_event_name: 'PostToolUse',
            session_id: 'proof-session',
            tool_input: { proof: true },
            tool_name: 'Write',
            tool_response: { ok: true },
            tool_use_id: 'packed-proof',
            transcript_path: join(project, 'transcript.jsonl'),
          },
          signal: AbortSignal.timeout(10_000),
          target: 'claude',
          timeoutMs: 10_000,
        });
      } catch (error) {
        throw new Error(
          `Packed event route failed: ${error instanceof Error ? error.message : String(error)}\nserver stderr:\n${secondSession.stderr()}`,
          { cause: error },
        );
      }
      expect(JSON.stringify(eventResponse)).toContain('actor unavailable:not-provided');
      expect(JSON.stringify(eventResponse)).toContain(noticeId);
      expect(JSON.stringify(eventResponse)).toContain('cross-process notice');
      expect(secondSession.stderr()).not.toContain('"jsonrpc"');
    } finally {
      await secondSession.close();
    }
  } finally {
    await rm(consumer, { force: true, recursive: true });
  }
}, 300_000);
