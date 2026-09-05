import { execFile as executeFile } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { specTypeSchemas as clientSchemas } from '@modelcontextprotocol/client';
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
it('serves compiled routes with a private runtime sibling across packed process restarts', async () => {
  const [agentBundle, runtime, markdownStream] = await Promise.all([
    sharedPackedTarball('agent-bundle-runtime-rebundle'),
    sharedPackedTarball('runtime'),
    sharedPackedTarball('markdown-stream'),
  ]);
  const consumer = await mkdtemp(join(tmpdir(), 'agent-bundle-packed-stdio-'));
  const project = join(consumer, 'project');
  const artifact = join(project, 'artifact');

  try {
    await cp(fixtureRoot, project, { recursive: true });
    // The operator `.env` probe (#469) lives in this packed copy only: the
    // shared fixture's lists stay untouched, and the packed level is the one
    // that spawns the real entry whose shell applies the layer.
    await writeFile(join(project, 'src', 'mcp', 'harness', 'tools', 'env-probe.tsx'), [
      "import { Agent } from '@agent-bundle/runtime';",
      "import { z } from 'zod';",
      '',
      "export const config = { annotations: { readOnlyHint: true }, description: 'Reports one environment variable as the server process sees it.' };",
      'export const inputSchema = z.object({ name: z.string().min(1) }).strict();',
      'export const resultSchema = z.object({ name: z.string(), value: z.string().nullable() }).strict();',
      '',
      'export default async function EnvProbe({ input }: { readonly input: z.infer<typeof inputSchema> }) {',
      '  const value = process.env[input.name] ?? null;',
      '  return (',
      '    <Agent.Result value={{ name: input.name, value }}>',
      '      <Agent.Text>{`${input.name}: ${value ?? "(unset)"}`}</Agent.Text>',
      '    </Agent.Result>',
      '  );',
      '}',
      '',
    ].join('\n'));
    await execFile('npm', ['install', ...cachedNpmInstallArguments,
      agentBundle.tarball,
      runtime.tarball,
      markdownStream.tarball,
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

    const pluginRoot = artifact;
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
      // The host exported this one; the operator file must not override it.
      HARNESS_HOST_WINS: 'from-host',
    } as Record<string, string>;
    // The operator configuration of an installed pack (#469): a file the
    // receipt never owns, beside the manifest, read by the shell at launch.
    await writeFile(join(pluginRoot, '.env'), 'HARNESS_FROM_FILE=s3cr3t-from-file\nHARNESS_HOST_WINS=from-file\n');
    await writeFile(join(pluginRoot, '.env.local'), 'HARNESS_LOCAL=from-local\n');
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
      `${artifactManifest.project.revision}:${dirname(dirname(resolve(entry)))}`;
    const deletedSource = await removeProjectSource({ projectRoot: project });

    // The artifact-hosted routed CLI and the `main`-envelope script probe
    // their own process for `request.terminal` (#511): spawned here with one
    // pipe per stream, so neither is a terminal and they share no target,
    // while the informal color and size conventions still apply to pipes.
    const colorAndSizeVariables = new Set(['CLICOLOR', 'CLICOLOR_FORCE', 'COLORTERM', 'COLUMNS', 'FORCE_COLOR', 'LINES', 'NO_COLOR']);
    const plainEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !colorAndSizeVariables.has(key)));
    const probe = async (file: string, args: readonly string[], overrides: Readonly<Record<string, string>>): Promise<unknown> => {
      const { stdout } = await execFile(process.execPath, [file, ...args], {
        cwd: project,
        env: { ...plainEnv, TERM: 'xterm-256color', ...overrides },
      });
      return JSON.parse(stdout) as unknown;
    };
    const cliBin = join(pluginRoot, 'bin', 'route-harness.mjs');
    const cliTerminal = async (overrides: Readonly<Record<string, string>>): Promise<unknown> =>
      ((await probe(cliBin, ['harness', 'context', '--yes', '--json'], overrides)) as { readonly terminal: unknown }).terminal;
    const pipe = { color: 'none', kind: 'pipe' };
    await expect(cliTerminal({})).resolves.toEqual({
      source: 'native',
      state: 'available',
      value: { hostSurface: 'cli', sharesTarget: false, stderr: pipe, stdout: pipe },
    });
    await expect(cliTerminal({ COLUMNS: '120', FORCE_COLOR: '3' })).resolves.toMatchObject({
      value: {
        stderr: { color: 'truecolor', columns: 120, kind: 'pipe' },
        stdout: { color: 'truecolor', columns: 120, kind: 'pipe' },
      },
    });
    await expect(cliTerminal({ CLICOLOR_FORCE: '1', NO_COLOR: '1' })).resolves.toMatchObject({
      // CLICOLOR_FORCE forces color on for a pipe at the advertised depth ...
      value: { stdout: { color: '256', kind: 'pipe' } },
    });
    await expect(cliTerminal({ NO_COLOR: '1' })).resolves.toMatchObject({
      // ... and NO_COLOR alone keeps it off.
      value: { stdout: pipe },
    });
    await expect(probe(join(pluginRoot, 'scripts', 'checksum.mjs'), ['--terminal'], { FORCE_COLOR: '1', LINES: '50' }))
      .resolves.toEqual({
        hostSurface: 'script',
        sharesTarget: false,
        stderr: { color: 'basic', kind: 'pipe', rows: 50 },
        stdout: { color: 'basic', kind: 'pipe', rows: 50 },
      });

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
        'env-probe',
        'fault',
        'journal',
        'layout-probe',
        'lifecycle',
        'mutation-probe',
        'plugin-root',
        'publish-notice',
        'strict-report',
        'submit',
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
            lineage: { reason: 'id-not-resolvable', state: 'unavailable' },
            session: { reason: 'not-provided', state: 'unavailable' },
            // The packed server's stdout is the protocol wire: no terminal (#511).
            terminal: {
              source: 'derived',
              state: 'available',
              value: {
                hostSurface: 'mcp',
                sharesTarget: false,
                stderr: { color: 'none', kind: 'none' },
                stdout: { color: 'none', kind: 'none' },
              },
            },
            workspace: {
              source: 'derived',
              state: 'available',
              value: { root: project },
            },
          },
        });
      // The pack's operator `.env` layer reached the server process: the file
      // fills `HARNESS_FROM_FILE` and `.env.local`'s `HARNESS_LOCAL`, the host's
      // exported `HARNESS_HOST_WINS` is untouched, and nothing was logged.
      for (const [name, value] of [
        ...(process.env['AGENT_BUNDLE_RUNTIME_REBUNDLE_FIXTURE'] === '1'
          ? [['AGENT_BUNDLE_RUNTIME_REBUNDLE_FIXTURE_EXECUTED', '1'] as const]
          : []),
        ['HARNESS_FROM_FILE', 's3cr3t-from-file'],
        ['HARNESS_LOCAL', 'from-local'],
        ['HARNESS_HOST_WINS', 'from-host'],
        ['HARNESS_ABSENT', null],
      ] as const) {
        await expect(firstSession.client.callTool({ arguments: { name }, name: 'env-probe' }))
          .resolves.toMatchObject({ structuredContent: { name, value } });
      }
      expect(firstSession.stderr()).not.toContain('s3cr3t');
      await expect(firstSession.client.callTool({ arguments: { genre: 'mystery' }, name: 'catalog' }))
        .resolves.toMatchObject({
          content: [
            { text: 'catalog: mystery', type: 'text' },
            { text: '## mystery\n\n- Piranesi\n- Solaris', type: 'text' },
          ],
          structuredContent: { genre: 'mystery', titles: ['Piranesi', 'Solaris'] },
        });
      // Task-augmented tools/call over real stdio framing (#369): the same
      // spawned process answers with a CreateTaskResult first and hands the
      // ordinary CallToolResult to tasks/result; a tool that did not opt in
      // refuses the augmentation.
      expect(firstSession.client.getServerCapabilities()?.tasks).toEqual({ cancel: {}, list: {}, requests: { tools: { call: {} } } });
      const created = await firstSession.client.request({
        method: 'tools/call',
        params: { arguments: { holdMs: 50 }, name: 'wait', task: { ttl: 60_000 } },
      }, clientSchemas.CreateTaskResult);
      expect(created.task).toMatchObject({ status: 'working', ttl: 60_000 });
      await expect(firstSession.client.request({
        method: 'tasks/result',
        params: { taskId: created.task.taskId },
      }, clientSchemas.CallToolResult)).resolves.toMatchObject({
        _meta: { 'io.modelcontextprotocol/related-task': { taskId: created.task.taskId } },
        content: [{ text: 'waited 50ms', type: 'text' }],
        structuredContent: { waitedMs: 50 },
      });
      await expect(firstSession.client.request({
        method: 'tasks/get',
        params: { taskId: created.task.taskId },
      }, clientSchemas.GetTaskResult)).resolves.toMatchObject({ status: 'completed', taskId: created.task.taskId });
      await expect(firstSession.client.request({
        method: 'tools/call',
        params: { arguments: { message: 'no task' }, name: 'echo', task: {} },
      }, clientSchemas.CreateTaskResult)).rejects.toMatchObject({ code: -32_601 });
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
        fixtures: {
          ...routeHarnessPackedContractFixtures(),
          'tool:harness/env-probe': { input: { name: 'HARNESS_FROM_FILE' }, resultCompat: 'closed' },
        },
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
      // The event route ran in the shared runtime under a hook: no terminal (#511).
      expect(JSON.stringify(eventResponse)).toContain('terminal available:derived hook/none/none');
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
