import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { execFile as executeFile, spawn } from 'node:child_process';
import { cp, mkdtemp, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, expect, it } from '@rstest/core';

import { build } from '../src/api.ts';
import { eventRuntimeEndpoint } from '../src/events/ipc.ts';

const execFile = promisify(executeFile);
const exampleRoot = resolve(import.meta.dirname, '../../../examples/worktree-proximity');
const sessionId = 'root-session';

interface ActorStatus {
  readonly id: string;
  readonly kind: 'child' | 'root';
  readonly parentSessionId?: string;
  readonly provenance: {
    readonly id: 'derived' | 'native' | 'registry';
    readonly parentSessionId?: 'derived' | 'native' | 'registry';
    readonly worktreeRoot?: 'derived' | 'native';
  };
  readonly status: 'active' | 'stopped';
  readonly worktreeRoot?: string;
}

interface StatusResult {
  readonly activeActivities: number;
  readonly actors: readonly ActorStatus[];
  readonly notices: {
    readonly pending: number;
    readonly reason?: string;
    readonly state: 'available' | 'unavailable';
    readonly total: number;
  };
  readonly reason?: string;
  readonly refusals: number;
  readonly revision: number;
  readonly state: 'available' | 'unavailable';
}

interface JourneyFixture {
  readonly endpoint: string;
  readonly entry: string;
  readonly hooks: {
    readonly afterTool: string;
    readonly agentStart: string;
    readonly beforeTool: string;
    readonly sessionStart: string;
  };
  readonly pluginRoot: string;
  readonly repoRoot: string;
  readonly tempRoot: string;
  readonly worktreeA: string;
  readonly worktreeB: string;
}

interface ServerSession {
  readonly client: Client;
  readonly diagnostics: () => string;
  readonly pid: number;
  readonly stop: () => Promise<void>;
}

let fixture: JourneyFixture;
let liveSession: ServerSession | undefined;

const environment = (
  extra: Readonly<Record<string, string>>,
): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return { ...env, ...extra };
};

const runGit = async (
  cwd: string,
  ...args: readonly string[]
): Promise<string> => {
  const result = await execFile('git', args, { cwd, encoding: 'utf8' });
  return result.stdout.trim();
};

const runHook = async (
  entry: string,
  cwd: string,
  input: Readonly<Record<string, unknown>>,
  env: Readonly<Record<string, string>>,
): Promise<Readonly<Record<string, unknown>> | undefined> => new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, [entry], {
    cwd,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, 15_000);
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });
  child.once('error', (error) => {
    clearTimeout(timeout);
    reject(error);
  });
  child.once('close', (code) => {
    clearTimeout(timeout);
    if (timedOut) {
      reject(new Error(`Generated hook timed out.\nstderr:\n${stderr}`));
      return;
    }
    if (code !== 0) {
      reject(new Error(`Generated hook exited with code ${String(code)}.\nstderr:\n${stderr}`));
      return;
    }
    const output = stdout.trim();
    resolvePromise(output === '' ? undefined : JSON.parse(output) as Readonly<Record<string, unknown>>);
  });
  child.stdin.end(JSON.stringify(input));
});

const startServer = async (): Promise<ServerSession> => {
  const client = new Client({ name: 'worktree-proximity-journeys', version: '0.0.0' });
  const transport = new StdioClientTransport({
    args: [fixture.entry],
    command: process.execPath,
    cwd: fixture.repoRoot,
    env: environment({ AGENT_BUNDLE_PLUGIN_ROOT: fixture.pluginRoot }),
    stderr: 'pipe',
  });
  let diagnostics = '';
  transport.stderr?.on('data', (chunk) => { diagnostics += String(chunk); });
  try {
    await client.connect(transport);
  } catch (error) {
    throw new Error(`Worktree proximity server failed to connect.\nstderr:\n${diagnostics}`, { cause: error });
  }
  const pid = transport.pid;
  if (pid === null) throw new Error('Expected the stdio transport to expose its server process id.');
  return {
    client,
    diagnostics: () => diagnostics,
    pid,
    stop: async () => {
      await client.close();
    },
  };
};

const callStatus = async (client: Client): Promise<StatusResult> => {
  const response = await client.callTool(
    { arguments: {}, name: 'status' },
    { signal: AbortSignal.timeout(10_000) },
  );
  const result = response.structuredContent as unknown;
  expect(result).toBeDefined();
  expect(Object.keys(result as Record<string, unknown>).sort()).toEqual([
    'activeActivities',
    'actors',
    'notices',
    'refusals',
    'revision',
    'state',
  ]);
  return result as StatusResult;
};

const hookText = (
  output: Readonly<Record<string, unknown>> | undefined,
): string => JSON.stringify(output) ?? '';

beforeAll(async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'worktree-proximity-journeys-'));
  const repoRoot = join(tempRoot, 'repo');
  const worktreeA = join(tempRoot, 'worktree-a');
  const worktreeB = join(tempRoot, 'worktree-b');
  const projectRoot = join(tempRoot, 'project');
  const artifactRoot = join(projectRoot, 'artifact');
  await mkdir(join(repoRoot, 'src'), { recursive: true });
  await runGit(tempRoot, 'init', '--initial-branch=main', repoRoot);
  await runGit(repoRoot, 'config', 'user.email', 'journeys@example.invalid');
  await runGit(repoRoot, 'config', 'user.name', 'Journey Fixture');
  await writeFile(join(repoRoot, 'src', 'shared.ts'), 'export const shared = true;\n');
  await runGit(repoRoot, 'add', '.');
  await runGit(repoRoot, 'commit', '-m', 'fixture');
  await runGit(repoRoot, 'worktree', 'add', '-b', 'journey-a', worktreeA);
  await runGit(repoRoot, 'worktree', 'add', '-b', 'journey-b', worktreeB);
  await mkdir(projectRoot, { recursive: true });
  await Promise.all([
    cp(join(exampleRoot, 'agent-bundle.config.ts'), join(projectRoot, 'agent-bundle.config.ts')),
    cp(join(exampleRoot, 'package.json'), join(projectRoot, 'package.json')),
    cp(join(exampleRoot, 'src'), join(projectRoot, 'src'), { recursive: true }),
    symlink(join(exampleRoot, 'node_modules'), join(projectRoot, 'node_modules'), 'dir'),
  ]);

  const compiled = await build({
    output: artifactRoot,
    root: projectRoot,
    targets: ['claude'],
  });
  const mcp = compiled.build.compiledMcpEntries.find((entry) => entry.target === 'claude');
  if (mcp === undefined) throw new Error('Expected a generated Claude MCP entry.');
  const hook = (event: string): string => {
    const compiledHook = compiled.build.compiledHooks.find(
      (entry) => entry.target === 'claude' && entry.event === event,
    );
    if (compiledHook === undefined) throw new Error(`Expected a generated Claude ${event} hook.`);
    return compiledHook.output;
  };
  const pluginRoot = dirname(dirname(resolve(mcp.output)));
  const endpointId = `${compiled.build.manifest.project.revision}:claude:${pluginRoot}`;
  fixture = {
    endpoint: eventRuntimeEndpoint(endpointId),
    entry: mcp.output,
    hooks: {
      afterTool: hook('afterTool'),
      agentStart: hook('agentStart'),
      beforeTool: hook('beforeTool'),
      sessionStart: hook('sessionStart'),
    },
    pluginRoot,
    repoRoot,
    tempRoot,
    worktreeA,
    worktreeB,
  };
}, 120_000);

afterAll(async () => {
  await liveSession?.stop();
  if (fixture !== undefined) {
    await rm(fixture.tempRoot, { force: true, recursive: true });
  }
});

it('proves worktree proximity journeys across real processes and linked worktrees', { timeout: 120_000 }, async () => {
  const rootHead = await runGit(fixture.repoRoot, 'rev-parse', 'HEAD');
  expect(await runGit(fixture.worktreeA, 'rev-parse', 'HEAD')).toBe(rootHead);
  expect(await runGit(fixture.worktreeB, 'rev-parse', 'HEAD')).toBe(rootHead);
  expect(await runGit(fixture.worktreeA, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('journey-a');
  expect(await runGit(fixture.worktreeB, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('journey-b');
  const commonDir = resolve(
    fixture.repoRoot,
    await runGit(fixture.repoRoot, 'rev-parse', '--git-common-dir'),
  );
  for (const worktree of [fixture.worktreeA, fixture.worktreeB]) {
    const worktreeCommonDir = resolve(worktree, await runGit(worktree, 'rev-parse', '--git-common-dir'));
    const worktreeGitDir = resolve(worktree, await runGit(worktree, 'rev-parse', '--git-dir'));
    expect(worktreeCommonDir).toBe(commonDir);
    expect(worktreeGitDir).not.toBe(commonDir);
  }

  liveSession = await startServer();
  expect(liveSession.pid).toBeGreaterThan(0);
  await expect(stat(fixture.endpoint)).resolves.toMatchObject({ mode: expect.any(Number) });
  // This client call carries no `_meta` correlation, so its lineage is
  // unresolved and it is nobody's publisher: the published-notice count is
  // honestly zero for it, never the ledger's total.
  await expect(callStatus(liveSession.client)).resolves.toEqual({
    activeActivities: 0,
    actors: [],
    notices: {
      acknowledged: 0,
      attempted: 0,
      expired: 0,
      pending: 0,
      state: 'available',
      total: 0,
      unavailable: 0,
      withdrawn: 0,
    },
    refusals: 0,
    revision: 0,
    state: 'available',
  });

  const hookEnvironment = environment({ AGENT_BUNDLE_PLUGIN_ROOT: fixture.pluginRoot });
  const transcriptPath = join(fixture.repoRoot, 'transcript.jsonl');
  await runHook(fixture.hooks.sessionStart, fixture.repoRoot, {
    cwd: fixture.repoRoot,
    hook_event_name: 'SessionStart',
    session_id: sessionId,
    source: 'startup',
    transcript_path: transcriptPath,
  }, hookEnvironment);
  // Claude spawns a subagent from the root's `Agent` tool call: its PreToolUse
  // opens the spawn window the shared runtime's lineage registry places the
  // following `SubagentStart` under, and every one of the child's later hook
  // payloads carries its `agent_id`
  // (fixtures/host-lineage/claude-2.1.259-orchestration.ndjson). The registry
  // resolves that id as the child's lineage conversation — the axis the
  // proximity notice is addressed to.
  const spawn = async (agentId: string, worktree: string): Promise<void> => {
    await runHook(fixture.hooks.beforeTool, fixture.repoRoot, {
      cwd: fixture.repoRoot,
      hook_event_name: 'PreToolUse',
      session_id: sessionId,
      tool_input: { prompt: `work in ${worktree}`, subagent_type: 'implementation' },
      tool_name: 'Agent',
      tool_use_id: `spawn-${agentId}`,
      transcript_path: transcriptPath,
    }, hookEnvironment);
    await runHook(fixture.hooks.agentStart, worktree, {
      agent_id: agentId,
      agent_type: 'implementation',
      cwd: worktree,
      hook_event_name: 'SubagentStart',
      session_id: sessionId,
      transcript_path: transcriptPath,
    }, hookEnvironment);
  };
  await spawn('agent-a', fixture.worktreeA);
  await spawn('agent-b', fixture.worktreeB);

  const intentA = {
    agent_id: 'agent-a',
    cwd: fixture.worktreeA,
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    tool_input: { deps: 'deps:react', file_path: 'src/shared.ts' },
    tool_name: 'Edit',
    tool_use_id: 'intent-a',
    transcript_path: transcriptPath,
  } as const;
  const intentB = {
    agent_id: 'agent-b',
    cwd: fixture.worktreeB,
    hook_event_name: 'PreToolUse',
    session_id: sessionId,
    tool_input: { deps: 'deps:zod', file_path: 'src/shared.ts' },
    tool_name: 'Edit',
    tool_use_id: 'intent-b',
    transcript_path: transcriptPath,
  } as const;
  const firstIntent = await runHook(
    fixture.hooks.beforeTool,
    fixture.worktreeA,
    intentA,
    hookEnvironment,
  );
  expect(hookText(firstIntent)).not.toContain('Proximity warning');

  const warning =
    `Proximity warning for agent-b: Worktrees ${fixture.worktreeB} and ${fixture.worktreeA} both intend to change path src/shared.ts.`;
  const secondIntent = await runHook(
    fixture.hooks.beforeTool,
    fixture.worktreeB,
    intentB,
    hookEnvironment,
  );
  expect(hookText(secondIntent)).toContain(warning);

  // Only agent-a's own conversation admits the notice: an event in worktree A
  // that the runtime cannot place under agent-a (no `agent_id`) is not it.
  const notAgentA = await runHook(fixture.hooks.afterTool, fixture.worktreeA, {
    cwd: fixture.worktreeA,
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    tool_input: { file_path: 'src/other.ts' },
    tool_name: 'Edit',
    tool_response: { ok: true },
    tool_use_id: 'not-agent-a-after',
    transcript_path: transcriptPath,
  }, hookEnvironment);
  expect(hookText(notAgentA)).not.toContain('Directed proximity notice');

  const delivered = await runHook(fixture.hooks.afterTool, fixture.worktreeA, {
    agent_id: 'agent-a',
    cwd: fixture.worktreeA,
    hook_event_name: 'PostToolUse',
    session_id: sessionId,
    tool_input: { file_path: 'src/shared.ts' },
    tool_name: 'Edit',
    tool_response: { ok: true },
    tool_use_id: 'intent-a-after',
    transcript_path: transcriptPath,
  }, hookEnvironment);
  expect(hookText(delivered)).toContain(
    `Directed proximity notice (attempted, next-event): Worktrees ${fixture.worktreeB} and ${fixture.worktreeA} both intend to change path src/shared.ts.`,
  );

  const beforeReplay = await callStatus(liveSession.client);
  expect(beforeReplay.activeActivities).toBe(1);
  await runHook(
    fixture.hooks.beforeTool,
    fixture.worktreeB,
    intentB,
    hookEnvironment,
  );
  await expect(callStatus(liveSession.client)).resolves.toEqual(beforeReplay);

  const beforeMalformedEnvelope = await callStatus(liveSession.client);
  // Required-identity host contracts fail closed in the generated wrapper; the
  // route-unit suite proves route-level refusal for hosts that omit identity.
  await expect(runHook(fixture.hooks.agentStart, fixture.worktreeA, {
    agent_type: 'fixture-without-identity',
    cwd: fixture.worktreeA,
    hook_event_name: 'SubagentStart',
    session_id: sessionId,
    transcript_path: transcriptPath,
  }, hookEnvironment)).rejects.toThrow(
    /Generated hook exited with code [1-9]\d*\.[\s\S]*native agent_id must be a nonempty string/u,
  );
  await expect(callStatus(liveSession.client)).resolves.toEqual(beforeMalformedEnvelope);

  const expectedActors: readonly ActorStatus[] = [
    {
      id: `session:${sessionId}`,
      kind: 'root',
      provenance: { id: 'native', worktreeRoot: 'native' },
      status: 'active',
      worktreeRoot: fixture.repoRoot,
    },
    // Placed under the root by the runtime's lineage registry (the spawning
    // `Agent` call opened the window), so the child's identity and its
    // parent carry the registry's provenance rather than the raw envelope's.
    {
      id: 'agent-a',
      kind: 'child',
      parentSessionId: sessionId,
      provenance: {
        id: 'registry',
        parentSessionId: 'registry',
        worktreeRoot: 'native',
      },
      status: 'active',
      worktreeRoot: fixture.worktreeA,
    },
    {
      id: 'agent-b',
      kind: 'child',
      parentSessionId: sessionId,
      provenance: {
        id: 'registry',
        parentSessionId: 'registry',
        worktreeRoot: 'native',
      },
      status: 'active',
      worktreeRoot: fixture.worktreeB,
    },
  ];
  const beforeRestart = await callStatus(liveSession.client);
  expect(beforeRestart).toMatchObject({
    activeActivities: 1,
    actors: expectedActors,
    refusals: 0,
    state: 'available',
  });
  expect(beforeRestart.revision).toBeGreaterThan(0);

  const firstPid = liveSession.pid;
  await liveSession.stop();
  liveSession = undefined;
  expect(() => process.kill(firstPid, 0)).toThrow();

  liveSession = await startServer();
  expect(liveSession.pid).not.toBe(firstPid);
  await expect(stat(fixture.endpoint)).resolves.toMatchObject({ mode: expect.any(Number) });
  const afterRestart = await callStatus(liveSession.client);
  expect(afterRestart).toEqual(beforeRestart);
  expect(afterRestart).toMatchObject({
    activeActivities: 1,
    actors: expectedActors,
    refusals: 0,
    state: 'available',
  });
  expect(liveSession.diagnostics()).not.toContain('"jsonrpc"');
});
