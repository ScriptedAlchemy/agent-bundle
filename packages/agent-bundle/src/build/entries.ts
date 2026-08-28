import { readFile, stat } from 'node:fs/promises';
import { extname, relative, resolve } from 'node:path';

import type { TargetHookEntry } from '../adapters/types.ts';
import type { NormalizedMcpServer, NormalizedScript } from '../core/types.ts';
import { mcpEntryAliasPattern } from '../config/normalize.ts';
import { stableJson } from '../core/digest.ts';
import { emitPlanEntries, resolveArtifactDestination } from './emit.ts';
import type { CompiledMcpApp } from './mcp-apps.ts';
import type { ArtifactOutputKind } from './provenance.ts';
import { buildWithRslib } from './rslib.ts';

export interface CompiledEntry {
  readonly name: string;
  readonly output: string;
  readonly outputKind: ArtifactOutputKind;
  readonly source: string;
  readonly sourceInputs: readonly string[];
}

interface PlannedScriptEntry extends CompiledEntry {
  readonly mode: NormalizedScript['mode'];
}

export interface CompiledHookEntry extends CompiledEntry {
  readonly event: TargetHookEntry['event'];
  readonly id: string;
  /** False when this wrapper is a host-document variant excluded from the canonical hook index. */
  readonly indexed?: false;
  readonly target: string;
  /** Native hook timeout in seconds. Omit it to use the host default. */
  readonly timeout?: number;
}

export interface CompiledMcpEntry extends CompiledEntry {
  readonly id: string;
  readonly target: string;
}

const outputName = (script: NormalizedScript): string =>
  script.mode === 'bundle' ? `${script.name}.mjs` : `${script.name}${extname(script.source).toLowerCase()}`;

export const planCompiledEntries = (
  entries: readonly NormalizedScript[],
  options: { readonly cwd: string; readonly outDir: string },
): readonly PlannedScriptEntry[] => {
  const names = new Set<string>();
  return Object.freeze(entries.map((script) => {
    const filename = outputName(script);
    if (script.name.length === 0 || names.has(filename)) {
      throw new Error(`Duplicate compiled script destination ${JSON.stringify(`scripts/${filename}`)}.`);
    }
    names.add(filename);
    return {
      mode: script.mode,
      name: script.name,
      output: resolveArtifactDestination(
        resolve(options.outDir, 'scripts'),
        filename,
      ),
      outputKind: script.mode === 'copy' ? 'copy' as const : 'bundle' as const,
      source: script.source,
      sourceInputs: Object.freeze([script.provenance.sourcePath, script.source]),
    };
  }).map((entry) => Object.freeze(entry)));
};

export const compileEntries = async (
  entries: readonly NormalizedScript[],
  options: { readonly cwd: string; readonly outDir: string },
): Promise<readonly CompiledEntry[]> => {
  const compiled = planCompiledEntries(entries, options);
  const bundled = compiled.filter((entry) => entry.mode === 'bundle');
  const evidence = await buildWithRslib({
    cwd: options.cwd,
    entries: bundled.map(({ name, source, sourceInputs }) => ({
      name,
      outputRelativePath: `scripts/${name}.mjs`,
      source,
      sourceInputs,
    })),
    outputRoot: options.outDir,
  });
  await emitPlanEntries({
    entries: await Promise.all(compiled
      .filter((entry) => entry.mode === 'copy')
      .map(async (entry) => ({
        bytes: (await stat(entry.source)).size,
        kind: 'copy' as const,
        relativePath: relative(options.outDir, entry.output).replaceAll('\\', '/'),
        source: entry.source,
        sourceInputs: entry.sourceInputs,
      }))),
    root: options.outDir,
  });

  const evidenceByPath = new Map(evidence.map((entry) => [entry.path, entry.sourceInputs]));
  return Object.freeze(compiled.map((entry) => Object.freeze({
    ...entry,
    sourceInputs: entry.mode === 'bundle'
      ? evidenceByPath.get(`scripts/${entry.name}.mjs`) ?? (() => { throw new Error(`Missing bundled script evidence for ${JSON.stringify(entry.name)}.`); })()
      : entry.sourceInputs,
  })));
};

const localMcpOutputName = (server: NormalizedMcpServer): string => {
  const output = server.args?.[0];
  const match = typeof output === 'string'
    ? mcpEntryAliasPattern.exec(output)
    : undefined;
  if (server.source === undefined || match?.[1] === undefined) {
    throw new Error(`MCP server ${JSON.stringify(server.name)} has an unsafe local output alias.`);
  }
  return match[1];
};

export const planCompiledMcpEntries = (
  servers: readonly NormalizedMcpServer[],
  options: { readonly outDir: string; readonly target: string },
): readonly CompiledMcpEntry[] => {
  const names = new Set<string>();
  return Object.freeze(servers
    .filter((server) => server.source !== undefined && server.targets.includes(options.target))
    .map((server) => {
      const outputName = localMcpOutputName(server);
      const name = outputName.slice(0, -extname(outputName).length);
      if (names.has(name)) {
        throw new Error(`Duplicate compiled MCP destination ${JSON.stringify(`mcp/${outputName}`)}.`);
      }
      names.add(name);
      return Object.freeze({
        id: server.id,
        name,
        output: resolveArtifactDestination(resolve(options.outDir, 'mcp'), outputName),
        outputKind: 'bundle',
        source: server.source!,
        sourceInputs: Object.freeze([server.provenance.sourcePath, server.source!]),
        target: options.target,
      });
    }));
};

export const compileMcpEntries = async (
  servers: readonly NormalizedMcpServer[],
  options: {
    readonly apps?: readonly CompiledMcpApp[];
    readonly cwd: string;
    readonly outDir: string;
    readonly target: string;
  },
): Promise<readonly CompiledMcpEntry[]> => {
  const compiled = planCompiledMcpEntries(servers, options);
  const virtualSources = await Promise.all(compiled.map(async (entry) => {
    const records = await Promise.all((options.apps ?? [])
      .filter((app) => app.serverId === entry.id)
      .map(async (app) => ({
        ...(app._meta === undefined ? {} : { _meta: app._meta }),
        html: await readFile(app.output, 'utf8'),
        mimeType: app.mimeType,
        name: app.name,
        resourceUri: app.resourceUri,
      })));
    return [
      `const mcpApps = Object.freeze(${stableJson(records)});`,
      'export { mcpApps };',
      'export default mcpApps;',
      '',
    ].join('\n');
  }));
  const evidence = await buildWithRslib({
    cwd: options.cwd,
    entries: compiled.map(({ id, name, source, sourceInputs }, index) => ({
      name,
      outputRelativePath: `mcp/${name}.mjs`,
      source,
      sourceInputs: Object.freeze([
        ...sourceInputs,
        ...(options.apps ?? [])
          .filter((app) => app.serverId === id)
          .flatMap((app) => app.sourceInputs),
      ]),
      virtualModules: [{
        name: 'agent-bundle/mcp-apps',
        source: virtualSources[index]!,
      }],
    })),
    outputRoot: options.outDir,
  });
  const evidenceByPath = new Map(evidence.map((entry) => [entry.path, entry.sourceInputs]));
  return Object.freeze(compiled.map((entry) => Object.freeze({
    ...entry,
    sourceInputs: evidenceByPath.get(`mcp/${entry.name}.mjs`) ?? (() => { throw new Error(`Missing bundled MCP evidence for ${JSON.stringify(entry.name)}.`); })(),
  })));
};

export const planCompiledHooks = (
  entries: readonly TargetHookEntry[],
  options: { readonly outDir: string },
): readonly CompiledHookEntry[] => Object.freeze(entries.map((entry) => Object.freeze({
  event: entry.event,
  id: entry.hook.id,
  ...(entry.indexed === false ? { indexed: false as const } : {}),
  name: entry.hook.name,
  output: resolveArtifactDestination(options.outDir, entry.relativePath),
  outputKind: 'bundle',
  source: entry.hook.source,
  sourceInputs: Object.freeze([entry.hook.provenance.sourcePath, entry.hook.source]),
  target: entry.target,
  ...(entry.hook.timeout === undefined ? {} : { timeout: entry.hook.timeout }),
})));

export const compileHooks = async (
  entries: readonly TargetHookEntry[],
  options: { readonly cwd: string; readonly outDir: string },
): Promise<readonly CompiledHookEntry[]> => {
  const compiled = planCompiledHooks(entries, options);
  const evidence = await buildWithRslib({
    cwd: options.cwd,
    entries: compiled.map((entry, index) => ({
      // One hook can compile into several host wrappers (for example a shared
      // Claude/Codex wrapper plus a Cursor-codec wrapper), so the bundler
      // library id derives from the unique output path, not the hook name.
      name: entries[index]!.relativePath.replaceAll('/', '-').replace(/\.mjs$/u, ''),
      outputRelativePath: entries[index]!.relativePath,
      source: entry.source,
      sourceInputs: entry.sourceInputs,
      virtualSource: entries[index]!.virtualSource,
    })),
    outputRoot: options.outDir,
  });
  const evidenceByPath = new Map(evidence.map((entry) => [entry.path, entry.sourceInputs]));
  return Object.freeze(compiled.map((entry, index) => Object.freeze({
    ...entry,
    sourceInputs: evidenceByPath.get(entries[index]!.relativePath) ?? (() => { throw new Error(`Missing bundled hook evidence for ${JSON.stringify(entry.name)}.`); })(),
  })));
};
