import type { ChildProcess } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, relative, isAbsolute } from 'node:path';
import { promisify } from 'node:util';

export const execFile = promisify((await import('node:child_process')).execFile);
export const workspaceRoot = process.cwd();
export const packageRoot = join(workspaceRoot, 'packages', 'agent-bundle');
const packedServerStartupBudget = 45_000;
let builtPackage: Promise<void> | undefined;

export const installedEnvironment = (): NodeJS.ProcessEnv => {
  const { NODE_PATH: _nodePath, ...environment } = process.env;
  return environment;
};

export const availablePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolvePromise, rejectPromise) => {
    server.once('error', rejectPromise);
    server.listen({ host: '127.0.0.1', port: 0 }, resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Expected a TCP address.');
  await new Promise<void>((resolvePromise, rejectPromise) => server.close((error) => {
    if (error === undefined) resolvePromise();
    else rejectPromise(error);
  }));
  return address.port;
};

export const buildPackage = (): Promise<void> => builtPackage ??= (async (): Promise<void> => {
  const { RSTEST: _rstest, ...environment } = process.env;
  await execFile('npm', ['run', 'build'], {
    cwd: workspaceRoot,
    env: { ...environment, NODE_ENV: 'production' },
  });
})();

export const awaitReady = async (origin: string, child: ChildProcess, output: () => string): Promise<void> => {
  const startedAt = Date.now();
  const diagnostics = (): string =>
    `after ${String(Date.now() - startedAt)}ms (PID ${String(child.pid ?? 'unknown')}): ${output()}`;
  while (Date.now() - startedAt < packedServerStartupBudget) {
    if (child.exitCode !== null) throw new Error(`The packed dev server exited before readiness ${diagnostics()}`);
    try {
      if ((await fetch(origin)).ok) return;
    } catch {
      // The fixed loopback port is not ready yet.
    }
    await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 50); });
  }
  throw new Error(`Timed out waiting for the packed dev server ${diagnostics()}`);
};

const childExitedWithin = (child: ChildProcess, timeoutMs: number): Promise<boolean> => {
  if (child.exitCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise, rejectPromise) => {
    const finish = (exited: boolean): void => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('error', onError);
      resolvePromise(exited);
    };
    const onExit = (): void => { finish(true); };
    const onError = (error: Error): void => {
      clearTimeout(timeout);
      child.off('exit', onExit);
      rejectPromise(error);
    };
    child.once('exit', onExit);
    child.once('error', onError);
    const timeout = setTimeout(() => { finish(false); }, timeoutMs);
    if (child.exitCode !== null) finish(true);
  });
};

export const closeChild = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null) return;
  const signalAndWait = async (signal: NodeJS.Signals): Promise<boolean> => {
    if (child.exitCode !== null) return true;
    if (!child.kill(signal)) {
      if (child.exitCode !== null) return true;
      throw new Error(`The packed dev server could not receive ${signal}.`);
    }
    return childExitedWithin(child, 5_000);
  };
  const closeFailures: unknown[] = [];
  try {
    if (await signalAndWait('SIGTERM')) return;
    closeFailures.push(new Error('The packed dev server did not exit after SIGTERM.'));
  } catch (error) {
    closeFailures.push(error);
  }
  let forceExited = false;
  try { forceExited = await signalAndWait('SIGKILL'); }
  catch (error) { closeFailures.push(error); }
  if (forceExited) throw new AggregateError(closeFailures, 'The packed dev server required SIGKILL after SIGTERM.');
  closeFailures.push(new Error('The packed dev server remained alive after SIGKILL.'));
  throw new AggregateError(closeFailures, 'The packed dev server could not be stopped.');
};

export const writeFakeClaude = async (root: string): Promise<string> => {
  const directory = join(root, '.packed-release-fake-claude');
  const executable = join(directory, 'claude');
  await mkdir(directory, { recursive: true });
  await Promise.all([
    // The packed dev server spawns the host on a clamped PATH, so resolve the exact
    // running Node binary instead of relying on a `node` living in /usr/bin or /bin.
    writeFile(executable, `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/claude.mjs" "$@"\n`),
    writeFile(join(directory, 'claude.mjs'), [
      "import { writeFileSync } from 'node:fs';",
      '',
      'const args = process.argv.slice(2);',
      "if (args[0] === '--version') { process.stdout.write('2.1.240 (Claude Code)\\n'); process.exit(0); }",
      "if (args[0] === 'auth' && args[1] === 'status') { process.stdout.write('{\"authMethod\":\"claude.ai\",\"loggedIn\":true,\"subscriptionType\":\"max\"}\\n'); process.exit(0); }",
      "const prompt = args.at(-1) ?? '';",
      "if (prompt.includes('Wait for packed native cancellation.')) setInterval(() => undefined, 1_000);",
      "writeFileSync('result.json', '{\"risk\":\"packed-native\"}\\n');",
      'process.stdout.write([',
      "  '{\"type\":\"system\",\"subtype\":\"init\",\"plugins\":[{\"name\":\"packed-release-fixture\"}],\"mcp_servers\":[{\"name\":\"fixture\"}]}',",
      "  '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"Skill\",\"input\":{\"skill\":\"packed-release-fixture:review\"}}]}}',",
      "  '{\"type\":\"assistant\",\"message\":{\"content\":[{\"type\":\"tool_use\",\"name\":\"mcp__fixture__show-dashboard\",\"input\":{}}]}}',",
      "  '{\"type\":\"system\",\"hook_event_name\":\"SessionStart\"}',",
      "  '{\"type\":\"result\",\"subtype\":\"success\",\"is_error\":false,\"duration_ms\":7,\"num_turns\":2,\"result\":\"Packed native fixture completed.\",\"usage\":{\"input_tokens\":4,\"output_tokens\":2}}',",
      "  '',",
      "].join('\\n'));",
      '',
    ].join('\n')),
  ]);
  await chmod(executable, 0o755);
  return directory;
};

export const record = (value: unknown, label: string): Record<string, unknown> => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`Expected ${label} to be an object: ${JSON.stringify(value)}`);
  return value as Record<string, unknown>;
};

export const string = (value: unknown, label: string): string => {
  if (typeof value !== 'string') throw new Error(`Expected ${label} to be a string.`);
  return value;
};

export const firstRecord = (value: unknown, label: string): Record<string, unknown> => {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`Expected ${label} to contain one entry.`);
  return record(value[0], `${label}[0]`);
};

export const isWithin = (parent: string, candidate: string): boolean => {
  const path = relative(parent, candidate);
  return path.length === 0 || (!isAbsolute(path) && !path.startsWith('..'));
};

export const descendantProcessIds = async (parentProcessId: number): Promise<readonly number[]> => {
  const { stdout } = await execFile('ps', ['-eo', 'pid=,ppid=']);
  const children = new Map<number, number[]>();
  for (const row of stdout.split('\n')) {
    const [processIdText, ancestorProcessIdText] = row.trim().split(/\s+/u);
    const processId = Number(processIdText);
    const ancestorProcessId = Number(ancestorProcessIdText);
    if (!Number.isInteger(processId) || !Number.isInteger(ancestorProcessId)) continue;
    const descendants = children.get(ancestorProcessId) ?? [];
    descendants.push(processId);
    children.set(ancestorProcessId, descendants);
  }
  const descendants = new Set<number>();
  const pending = [...(children.get(parentProcessId) ?? [])];
  while (pending.length > 0) {
    const processId = pending.pop();
    if (processId === undefined || descendants.has(processId)) continue;
    descendants.add(processId);
    pending.push(...(children.get(processId) ?? []));
  }
  return [...descendants];
};
