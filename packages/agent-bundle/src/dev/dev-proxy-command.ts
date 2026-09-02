import { lstat, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import type { InstallHost } from '../install/install.ts';

interface AgentBundlePackage {
  readonly bin?: unknown;
  readonly name?: unknown;
}

const packageRootFor = async (modulePath: string): Promise<Readonly<{
  readonly document: AgentBundlePackage;
  readonly root: string;
}>> => {
  let directory = dirname(modulePath);
  for (;;) {
    const packagePath = join(directory, 'package.json');
    try {
      const document = JSON.parse(await readFile(packagePath, 'utf8')) as AgentBundlePackage;
      if (document.name === 'agent-bundle') return Object.freeze({ document, root: directory });
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error('Cannot locate the installed agent-bundle package root.');
    }
    directory = parent;
  }
};

const binPath = (document: AgentBundlePackage): string | undefined => {
  if (typeof document.bin === 'string') return document.bin;
  if (
    typeof document.bin === 'object' &&
    document.bin !== null &&
    !Array.isArray(document.bin) &&
    typeof (document.bin as Record<string, unknown>)['agent-bundle'] === 'string'
  ) {
    return (document.bin as Record<string, string>)['agent-bundle'];
  }
  return undefined;
};

const resolveAgentBundleCliEntry = async (): Promise<string> => {
  const { document, root } = await packageRootFor(fileURLToPath(import.meta.url));
  const declaredBin = binPath(document);
  if (declaredBin === undefined) {
    throw new Error(`agent-bundle package at ${JSON.stringify(root)} does not declare its CLI bin entry.`);
  }
  const entry = resolve(root, declaredBin);
  const metadata = await lstat(entry).catch(() => undefined);
  if (metadata === undefined || !metadata.isFile()) {
    throw new Error(`agent-bundle CLI entry ${JSON.stringify(entry)} does not exist as a regular file.`);
  }
  return entry;
};

/** The single stage-1 integration seam for host-facing development MCP commands. */
export const devProxyServerCommand = async (
  projectRoot: string,
  serverName: string,
  host: InstallHost,
): Promise<Readonly<{
  readonly args: readonly string[];
  readonly command: string;
}>> => Object.freeze({
  args: Object.freeze([
    await resolveAgentBundleCliEntry(),
    'dev',
    'proxy',
    '--root',
    projectRoot,
    '--server',
    serverName,
    '--target',
    host,
  ]),
  command: process.execPath,
});
