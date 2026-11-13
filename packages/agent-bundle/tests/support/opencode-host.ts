import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { expect } from '@rstest/core';

const execute = promisify(execFile);
const delay = async (milliseconds = 50): Promise<void> => {
  await new Promise((resolve) => { setTimeout(resolve, milliseconds); });
};

export const writeOpenCodeFixture = async (root: string): Promise<void> => {
  await Promise.all([
    mkdir(join(root, 'src', 'commands'), { recursive: true }),
    mkdir(join(root, 'src', 'events', 'prompt'), { recursive: true }),
    mkdir(join(root, 'src', 'events', 'session'), { recursive: true }),
    mkdir(join(root, 'src', 'mcp', 'library', 'tools'), { recursive: true }),
    mkdir(join(root, 'src', 'skills', 'movie-library'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, 'package.json'), `${JSON.stringify({
      dependencies: { '@agent-bundle/runtime': 'latest', 'agent-bundle': 'latest', zod: '^4.0.0' },
      name: 'opencode-native-acceptance-fixture',
      private: true,
      type: 'module',
      version: '1.0.0',
    }, null, 2)}\n`),
    writeFile(join(root, 'agent-bundle.config.ts'), `export default {
  bin: { 'movie-library-install': './src/install-bin.ts' },
  commands: {
    'find-movie': { description: 'Find a movie' },
    positionals: { description: 'Check positional expansion' },
  },
  plugin: { name: 'movie-library', description: 'Native OpenCode acceptance fixture' },
  targets: ['opencode'],
};\n`),
    writeFile(join(root, 'src', 'install-bin.ts'), [
      "import { runInstallCli } from 'agent-bundle/install';",
      "import { fileURLToPath } from 'node:url';",
      '',
      'const code = await runInstallCli(process.argv.slice(2), {',
      "  from: fileURLToPath(new URL('..', import.meta.url)),",
      "  name: 'movie-library-install',",
      '});',
      'process.exitCode = code;',
      '',
    ].join('\n')),
    writeFile(join(root, 'src', 'commands', 'find-movie.md'), 'Use $ARGUMENTS.'),
    writeFile(join(root, 'src', 'commands', 'positionals.md'), '$1 / $10'),
    writeFile(join(root, 'src', 'events', 'session', 'start.tsx'), [
      "import { Agent } from '@agent-bundle/runtime';",
      '',
      'export default function SessionStart() {',
      '  return <Agent.Result><Agent.Context>Native movie session context</Agent.Context></Agent.Result>;',
      '}',
      '',
    ].join('\n')),
    writeFile(join(root, 'src', 'events', 'prompt', 'submit.tsx'), [
      "import { Agent } from '@agent-bundle/runtime';",
      '',
      'export default function PromptSubmit({ canonical }) {',
      '  const prompt = canonical.payload.prompt?.value ?? "";',
      "  return <Agent.Result value={{ outcome: 'deny', reason: prompt }} />;",
      '}',
      '',
    ].join('\n')),
    writeFile(join(root, 'src', 'mcp', 'library', 'tools', 'native-echo.tsx'), [
      "import { defineTool } from 'agent-bundle/routes';",
      "import { Agent } from '@agent-bundle/runtime';",
      "import { z } from 'zod';",
      '',
      'export const inputSchema = z.object({ text: z.string() }).strict();',
      'export const resultSchema = z.object({ text: z.string() }).strict();',
      '',
      'export default defineTool({',
      "  description: 'Echo through the generated MCP server.',",
      '  inputSchema,',
      '  resultSchema,',
      '}, async (input) => (',
      '  <Agent.Result value={{ text: input.text }}>',
      '    <Agent.Text>{input.text}</Agent.Text>',
      '  </Agent.Result>',
      '));',
      '',
    ].join('\n')),
    writeFile(join(root, 'src', 'skills', 'movie-library', 'SKILL.md'), [
      '---',
      'name: movie-library',
      'description: Search the local movie library.',
      '---',
      'Use the generated MCP tools before answering movie questions.',
      '',
    ].join('\n')),
  ]);
};

export interface OpenCodeNativeAcceptanceReport {
  readonly commands: readonly string[];
  readonly mcp: readonly Readonly<{ readonly name?: unknown; readonly status?: { readonly status?: string } }>[];
  readonly promptResults: readonly string[];
  readonly session: string;
  readonly skill: string;
  readonly version?: string;
}

export const runOpenCodeNativeAcceptance = async (options: {
  readonly binary: string;
  readonly pluginRoot: string;
  readonly workingDirectory: string;
}): Promise<OpenCodeNativeAcceptanceReport> => {
  const environment = {
    ...process.env,
    OPENCODE_PASSWORD: randomBytes(24).toString('hex'),
  } as NodeJS.ProcessEnv;
  const isolationRoot = await mkdtempAcceptanceRoot();
  for (const [key, name] of [
    ['XDG_CONFIG_HOME', 'config'],
    ['XDG_DATA_HOME', 'data'],
    ['XDG_CACHE_HOME', 'cache'],
    ['XDG_STATE_HOME', 'state'],
  ] as const) {
    environment[key] = join(isolationRoot, name);
  }
  const child = spawn(options.binary, ['serve', '--stdio', '--port', '0'], {
    cwd: options.workingDirectory,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stderr: Buffer[] = [];
  child.stderr.on('data', (chunk: Buffer) => { stderr.push(chunk); });
  const lines = createInterface({ input: child.stdout });
  let serverUrl: string | undefined;
  const invoke = async (
    operation: string,
    data?: unknown,
    parameters: readonly string[] = [],
  ): Promise<any> => JSON.parse((await execute(options.binary, [
    'api',
    '--server',
    serverUrl!,
    operation,
    ...parameters,
    ...(data === undefined ? [] : ['--data', JSON.stringify(data)]),
  ], {
    cwd: options.workingDirectory,
    env: environment,
    maxBuffer: 2 * 1024 * 1024,
    timeout: 15_000,
  })).stdout);
  try {
    const [handshake] = await once(lines, 'line');
    serverUrl = (JSON.parse(handshake) as { readonly url: string }).url;
    const deadline = Date.now() + 20_000;
    let commands: { readonly data: readonly { readonly name: string }[] };
    do {
      commands = await invoke('command.list');
      if (commands.data.some((command) => command.name === 'find-movie')) break;
      if (Date.now() > deadline) throw new Error(`Generated commands were not registered: ${Buffer.concat(stderr)}`);
      await delay();
    } while (true);
    const commandNames = commands.data.map((command) => command.name).sort();
    expect(commandNames).toEqual(expect.arrayContaining(['find-movie', 'positionals']));

    const skills = await invoke('skill.list');
    const skill = skills.data.find((entry: { readonly id?: unknown }) => entry.id === 'movie-library');
    expect(skill, `Native skill registration missing: ${Buffer.concat(stderr)}`).toBeDefined();

    const session = await invoke('session.create', { title: 'Native OpenCode acceptance' });
    const sessionID = session.data.id as string;
    let instructions: { readonly data: readonly { readonly key: string; readonly value: string }[] };
    const contextDeadline = Date.now() + 20_000;
    do {
      instructions = await invoke('experimental.session.instructions.entry.list', undefined, ['--param', `sessionID=${sessionID}`]);
      if (instructions.data.some((entry) => entry.value === 'Native movie session context') && instructions.data.every((entry) => /^agent-bundle-[0-9a-f]{24}$/u.test(entry.key))) break;
      if (Date.now() > contextDeadline) throw new Error(`session.created context did not reach instructions: ${Buffer.concat(stderr)}`);
      await delay();
    } while (true);

    let mcp: { readonly data: OpenCodeNativeAcceptanceReport['mcp'] };
    const mcpDeadline = Date.now() + 20_000;
    do {
      mcp = await invoke('mcp.list');
      if (mcp.data.some((server) => server.name === 'library' && server.status?.status === 'connected')) break;
      if (Date.now() > mcpDeadline) throw new Error(`Generated MCP did not connect: ${Buffer.concat(stderr)}`);
      await delay();
    } while (true);
    const mcpData = mcp.data;
    expect(mcpData.some((server) => server.name === 'library' && server.status?.status === 'connected')).toBe(true);

    const promptResults: string[] = [];
    for (const [name, expected] of [
      ['find-movie', 'Use $& $$.'],
      ['positionals', 'one / ten'],
    ] as const) {
      try {
        await invoke('session.command', {
          name,
          text: name === 'find-movie' ? '$& $$' : 'one two three four five six seven eight nine ten',
        }, ['--param', `sessionID=${sessionID}`]);
        throw new Error(`Expected ${name} to stop before inference.`);
      } catch (error) {
        const response = JSON.parse((error as { readonly stdout?: string }).stdout ?? '{}') as {
          readonly _tag?: string;
          readonly message?: string;
        };
        expect(response._tag).toBe('CommandExecutionError');
        expect(response.message).toBe(expected);
        promptResults.push(expected);
      }
    }
    return Object.freeze({
      commands: Object.freeze(commandNames),
      mcp: mcpData,
      promptResults: Object.freeze(promptResults),
      session: sessionID,
      skill: 'movie-library',
    });
  } finally {
    lines.close();
    child.kill('SIGTERM');
    await once(child, 'exit');
  }
};

const mkdtempAcceptanceRoot = async (): Promise<string> => {
  const { mkdtemp } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  return mkdtemp(join(tmpdir(), 'agent-bundle-opencode-native-host-'));
};

export const assertCompiledOpenCodeMcp = async (
  entry: string,
  expectedText: string,
): Promise<readonly string[]> => {
  const transport = new StdioClientTransport({ args: [entry], command: process.execPath, stderr: 'pipe' });
  const diagnostics: Buffer[] = [];
  transport.stderr?.on('data', (chunk: Buffer) => { diagnostics.push(chunk); });
  const client = new Client({ name: 'opencode-native-acceptance', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toContain('native-echo');
    const result = await client.callTool({
      arguments: { text: expectedText },
      name: 'native-echo',
    });
    expect(result.content).toEqual([{ type: 'text', text: expectedText }]);
    return Object.freeze(tools.tools.map((tool) => tool.name));
  } catch (error) {
    throw new Error(`Compiled native MCP invocation failed: ${String(error)}\n${Buffer.concat(diagnostics)}`, { cause: error });
  } finally {
    await client.close();
  }
};

export const readOpenCodeVersion = async (binary: string): Promise<string | undefined> => {
  const result = await execute(binary, ['--version'], { timeout: 5_000 });
  return /[vV]?(\d+\.\d+\.\d+)/u.exec(`${result.stdout}${result.stderr}`)?.[1];
};
