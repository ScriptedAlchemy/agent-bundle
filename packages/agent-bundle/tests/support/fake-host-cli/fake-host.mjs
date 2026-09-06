import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline';

const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));

const hostHome = (host) => host === 'claude'
    ? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
    : process.env.CODEX_HOME ?? join(homedir(), '.codex');

const cacheRoot = (host) => join(hostHome(host), 'plugins', 'cache');

const findInstall = async (host) => {
  const cache = cacheRoot(host);
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name === '.agent-bundle-dev.json') {
        const marker = await readJson(path);
        if (marker.host === host && marker.projectRoot === process.cwd()) {
          return join(cache, ...relative(cache, directory).split(/[\\/]/u).slice(0, 3));
        }
      }
      if (entry.isDirectory()) {
        const found = await visit(path);
        if (found !== undefined) return found;
      }
    }
    return undefined;
  };
  const install = await visit(cache);
  if (install === undefined) throw new Error(`No ${host} development install found in ${cache}.`);
  return install;
};

const installedPlugins = async (host) => {
  const cache = cacheRoot(host);
  const rows = [];
  const visit = async (directory) => {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      if (entry.isFile() && entry.name === 'plugin.json' && dirname(path).endsWith('.claude-plugin')) {
        const manifest = await readJson(path);
        const install = dirname(dirname(path));
        const [marketplace] = relative(cache, install).split('/');
        rows.push({ install, marketplace, name: manifest.name, version: manifest.version });
      }
    }
  };
  await visit(cache);
  return rows;
};

const handleHostCommand = async (host, args) => {
  const verb = args.slice(0, 4).join(' ');
  if (verb === 'plugin list --json') {
    const installed = await installedPlugins(host);
    const result = host === 'claude'
      ? installed.map((row) => ({
          enabled: true,
          id: `${row.name}@${row.marketplace}`,
          installPath: row.install,
          scope: 'user',
          version: row.version,
        }))
      : { installed: installed.map((row) => ({
          enabled: true,
          installed: true,
          pluginId: `${row.name}@${row.marketplace}`,
          version: row.version,
        })) };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (verb === 'plugin marketplace list --json') {
    const marketplaces = await readdir(cacheRoot(host), { withFileTypes: true }).catch(() => []);
    const rows = marketplaces.filter((entry) => entry.isDirectory()).map((entry) => ({ name: entry.name }));
    process.stdout.write(`${JSON.stringify(host === 'claude' ? rows : { marketplaces: rows })}\n`);
    return;
  }
  if (args.slice(0, 3).join(' ') === 'plugin marketplace add') {
    const source = args[3];
    const plugin = await readJson(join(source, '.claude-plugin', 'plugin.json'));
    const marketplace = await readJson(join(source, '.claude-plugin', 'marketplace.json'));
    const destination = join(cacheRoot(host), marketplace.name, plugin.name, plugin.version);
    await mkdir(dirname(destination), { recursive: true });
    await rm(destination, { force: true, recursive: true });
    await cp(source, destination, { recursive: true, verbatimSymlinks: true });
    return;
  }
};

const run = (command, options, input) => new Promise((resolve, reject) => {
  const child = spawn(command, options);
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0
    ? resolve()
    : reject(new Error(`${command} exited with ${code ?? signal ?? 'unknown status'}.`)));
  child.stdin.end(input);
});

const hookPayload = (host, sessionId) => ({
  cwd: process.cwd(),
  hook_event_name: 'SessionStart',
  ...(host === 'codex' ? { model: 'fake-codex', permission_mode: 'default' } : {}),
  session_id: sessionId,
  source: 'startup',
  transcript_path: join(process.cwd(), '.fake-transcript.jsonl'),
});

const runSessionStart = async (host, install, sessionId) => {
  const documentPath = host === 'codex'
    ? join(install, '.codex-plugin', 'hooks.json')
    : join(install, 'hooks', 'hooks.json');
  const document = await readJson(documentPath);
  const hook = document.hooks?.SessionStart
    ?.flatMap((group) => group.hooks ?? [])
    .find((candidate) => candidate.type === 'command');
  if (typeof hook?.command !== 'string') throw new Error(`${documentPath} has no SessionStart command.`);
  const environment = {
    ...process.env,
    AGENT_BUNDLE_PLUGIN_ROOT: install,
    CLAUDE_PLUGIN_ROOT: install,
    PLUGIN_ROOT: install,
  };
  await run(hook.command, {
    cwd: process.cwd(),
    env: environment,
    shell: true,
    stdio: ['pipe', 'ignore', 'inherit'],
  }, JSON.stringify(hookPayload(host, sessionId)));
};

const commandEnvironment = (host) => {
  if (host === 'claude') return process.env;
  return Object.fromEntries(
    ['PATH', 'HOME', 'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'TERM', 'LANG']
      .flatMap((key) => process.env[key] === undefined ? [] : [[key, process.env[key]]]),
  );
};

const mcpDocumentPath = (host, install) => host === 'codex'
  ? join(install, '.codex-plugin', 'mcp.json')
  : join(install, '.mcp.json');

const callFirstTool = async (host, install, sessionId, setChild) => {
  const document = await readJson(mcpDocumentPath(host, install));
  const server = Object.values(document.mcpServers ?? {})[0];
  if (typeof server?.command !== 'string' || !Array.isArray(server.args)) {
    throw new Error('The development MCP document has no stdio server.');
  }
  const child = spawn(server.command, server.args, {
    cwd: install,
    env: commandEnvironment(host),
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  setChild(child);
  const pending = new Map();
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    for (;;) {
      const boundary = buffered.indexOf('\n');
      if (boundary === -1) break;
      const line = buffered.slice(0, boundary).trim();
      buffered = buffered.slice(boundary + 1);
      if (line === '') continue;
      const message = JSON.parse(line);
      if (message.id !== undefined) pending.get(message.id)?.resolve(message);
    }
  });
  child.once('exit', (code, signal) => {
    const error = new Error(`MCP proxy exited with ${code ?? signal ?? 'unknown status'}.`);
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  });
  const request = (id, method, params = {}) => new Promise((resolve, reject) => {
    pending.set(id, {
      reject,
      resolve: (message) => {
        pending.delete(id);
        if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)));
        else resolve(message.result);
      },
    });
    child.stdin.write(`${JSON.stringify({ id, jsonrpc: '2.0', method, params })}\n`);
  });
  await request(1, 'initialize', {
    capabilities: {},
    clientInfo: { name: `fake-${host}`, version: '1.0.0' },
    protocolVersion: '2025-06-18',
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`);
  const listed = await request(2, 'tools/list');
  const tool = listed.tools?.[0];
  if (typeof tool?.name !== 'string') throw new Error('The development MCP server listed no tools.');
  const params = {
    arguments: {},
    name: tool.name,
    ...(host === 'codex'
      ? { _meta: { 'x-codex-turn-metadata': { session_id: sessionId, thread_id: sessionId } } }
      : {}),
  };
  let result;
  try {
    result = await request(3, 'tools/call', params);
  } catch (error) {
    result = { error: error instanceof Error ? error.message : String(error) };
  }
  process.stdout.write(`result ${JSON.stringify(result).replaceAll(/\s+/gu, ' ').slice(0, 300)}\n> `);
};

export const runFakeHost = (host) => {
  const args = process.argv.slice(2);
  if (args[0] === 'plugin') {
    void handleHostCommand(host, args).catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
    return;
  }
  const prompt = args.join(' ');
  const sessionId = `${host}-session-${randomUUID()}`;
  let active;
  const keepAlive = setInterval(() => undefined, 2_147_483_647);
  const stop = () => {
    clearInterval(keepAlive);
    active?.kill('SIGTERM');
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.stdout.write(`Fake ${host === 'claude' ? 'Claude Code' : 'Codex'} host\n> `);
  const start = async (input) => {
    if (input !== '') process.stdout.write(`${input}\n`);
    const install = await findInstall(host);
    await runSessionStart(host, install, sessionId);
    await callFirstTool(host, install, sessionId, (child) => { active = child; });
  };
  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (line.trim() === 'exit') stop();
  });
  void start(prompt).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
};
