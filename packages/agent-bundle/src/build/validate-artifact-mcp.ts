import { dirname, posix, resolve, win32 } from 'node:path';

import type { TargetRegistry } from '../adapters/registry.ts';
import { DiagnosticError, type Diagnostic } from '../core/diagnostics.ts';
import { parseJsonWithoutDuplicateKeys } from '../core/strict-json.ts';
import { classifyMcpArtifactArgument } from '../services/mcp-artifact-reference.ts';
import { resolveMcpPathTokens } from '../services/mcp-path-tokens.ts';
import { readTargetMcpServers, type ModernMcpServer } from '../services/mcp-runtime.ts';
import { artifactDiagnostic as diagnostic, artifactDiagnosticRecoveries } from './artifact-diagnostics.ts';
import { readFileString, runWithPlatform } from '../effect/platform.ts';
import { isDirectOutputLayoutPath, matchesManifestFile } from './artifact-layout.ts';
import type { ValidatedArtifactMcpServerEvidence } from './artifact-validation-types.ts';
import type { ArtifactFile, ManifestFile } from './emit.ts';
import type { ArtifactManifest, ArtifactManifestMcpServer } from './manifest.ts';

const mcpArtifactPathApi = process.platform === 'win32'
  ? Object.freeze({
    isAbsolute: win32.isAbsolute,
    normalize: win32.normalize,
    relative: win32.relative,
    resolve: win32.resolve,
    sep: '\\' as const,
  })
  : Object.freeze({
    isAbsolute: posix.isAbsolute,
    normalize: posix.normalize,
    relative: posix.relative,
    resolve: posix.resolve,
    sep: '/' as const,
  });

const isTargetContainedCwd = (artifactRoot: string, targetRoot: string, value: string): boolean => {
  const localPath = mcpArtifactPathApi.sep === '/'
    ? value.replaceAll('\\', '/')
    : value.replaceAll('/', '\\');
  return value === '.' || value === './' || value === '.\\' ||
    (mcpArtifactPathApi.isAbsolute(localPath) && mcpArtifactPathApi.resolve(localPath) === targetRoot) ||
    classifyMcpArtifactArgument({
      path: mcpArtifactPathApi,
      roots: { artifactRoot, targetRoot },
      value,
    }).status === 'artifact-local';
};

interface McpReferenceOccurrence {
  readonly field: 'argument' | 'command';
  readonly server: string;
}

const recordMcpReference = (
  references: Map<string, McpReferenceOccurrence[]>,
  path: string,
  occurrence: McpReferenceOccurrence,
): void => {
  const occurrences = references.get(path);
  if (occurrences !== undefined) occurrences.push(occurrence);
};

const validateMcpArtifactReference = (options: {
  readonly artifactRoot: string;
  readonly directExecutable: boolean;
  readonly field: 'argument' | 'command';
  readonly files: ReadonlyMap<string, ArtifactFile>;
  readonly manifestFiles: ReadonlyMap<string, ManifestFile>;
  readonly manifestPath: string;
  readonly target: string;
  readonly targetRoot: string;
  readonly value: string;
}): readonly Diagnostic[] => {
  const reference = classifyMcpArtifactArgument({
    path: mcpArtifactPathApi,
    roots: { artifactRoot: options.artifactRoot, targetRoot: options.targetRoot },
    value: options.value,
  });
  if (reference.status === 'external') return Object.freeze([]);
  if (reference.status === 'escaped') {
    return Object.freeze([diagnostic(
      'AB6017',
      `MCP ${options.field} ${JSON.stringify(options.value)} escapes target ${JSON.stringify(options.target)}.`,
      options.manifestPath,
      options.target,
    )]);
  }

  const path = reference.path;
  const file = options.files.get(path);
  const manifestFile = options.manifestFiles.get(path);
  const diagnostics: Diagnostic[] = [];
  if (file === undefined || manifestFile === undefined || !matchesManifestFile(file, manifestFile)) {
    if (options.field === 'argument' && file === undefined && manifestFile !== undefined) {
      diagnostics.push(diagnostic(
        'AB6007',
        `MCP manifest references missing generated server ${JSON.stringify(options.value)}.`,
        options.manifestPath,
      ));
    } else {
      diagnostics.push(diagnostic(
        'AB6017',
        `MCP ${options.field} ${JSON.stringify(options.value)} references missing or unmanifested artifact file ${JSON.stringify(path)}.`,
        options.manifestPath,
        options.target,
      ));
    }
  } else if (options.directExecutable && (manifestFile.mode === undefined || (manifestFile.mode & 0o111) === 0)) {
    diagnostics.push(diagnostic(
      'AB6017',
      `MCP command ${JSON.stringify(options.value)} references non-executable artifact file ${JSON.stringify(path)}.`,
      options.manifestPath,
      options.target,
    ));
  }

  return Object.freeze(diagnostics);
};

/**
 * A host document's server starts the bytes the manifest's launch record of
 * the same name names, in the record's order: the first artifact-local path
 * the document's command and arguments name is the record's entry (Node's
 * script operand), and the record's `artifact` arguments follow it in order.
 * Otherwise `mcp run` (host document) and `<plugin> web` (manifest record)
 * would launch different files under one server name. The document may
 * reference more — an adapter's flags, an author's bare relative argument that
 * is a `literal` in the record — and each such reference is validated on its
 * own above. A document server the record starts but the document reaches
 * over another transport is the same disagreement.
 */
const validateLaunchAgreement = (options: {
  readonly declared: ArtifactManifestMcpServer | undefined;
  readonly kind: ModernMcpServer['kind'];
  readonly launchPaths: readonly string[];
  readonly manifestPath: string;
  readonly server: string;
  readonly target: string;
}): readonly Diagnostic[] => {
  const launch = options.declared?.launch;
  if (launch === undefined) return Object.freeze([]);
  const disagreement = (detail: string): readonly Diagnostic[] => Object.freeze([diagnostic(
    'AB6017',
    `MCP server ${JSON.stringify(options.server)} in target ${JSON.stringify(options.target)} ${detail}`,
    options.manifestPath,
    options.target,
  )]);
  if (options.kind !== 'stdio') {
    return disagreement(`is a ${options.kind} server in the target document, but its manifest launch record starts it over stdio.`);
  }
  const [first, ...following] = options.launchPaths;
  if (first !== launch.entry) {
    return disagreement(
      `starts ${first === undefined ? 'no artifact file' : JSON.stringify(first)} in the target document, ` +
        `but its manifest launch record starts ${JSON.stringify(launch.entry)}.`,
    );
  }
  let cursor = 0;
  for (const argument of launch.args) {
    if (argument.kind !== 'artifact') continue;
    const index = following.indexOf(argument.path, cursor);
    if (index === -1) {
      return disagreement(
        `does not pass ${JSON.stringify(argument.path)} after ${JSON.stringify(launch.entry)} in the order of its manifest ` +
          `launch record; the target document names ${JSON.stringify(options.launchPaths)}.`,
      );
    }
    cursor = index + 1;
  }
  return Object.freeze([]);
};

const validateDeclaredServersPresent = (options: {
  readonly documentServers: ReadonlySet<string>;
  readonly manifestPath: string;
  readonly servers: readonly ArtifactManifestMcpServer[];
  readonly target: string;
}): readonly Diagnostic[] => Object.freeze(options.servers
  .filter((server) => server.launch !== undefined && server.hosts.includes(options.target) && !options.documentServers.has(server.name))
  .map((server) => diagnostic(
    'AB6017',
    `MCP server ${JSON.stringify(server.name)} is declared for target ${JSON.stringify(options.target)} with a launch record, ` +
      'but the target document names no such server.',
    options.manifestPath,
    options.target,
  )));

/**
 * Every selected host's MCP document lives in the one composite root and
 * names the shared compiled entries (`mcp/<server>.mjs`) the host's servers
 * reach (#555). Within one document each entry is referenced once; across the
 * selection every compiled entry is referenced by at least one document, since
 * an entry only exists because a selected host's server declared it.
 */
export const validateMcpCoherence = async (options: {
  readonly artifactRoot: string;
  readonly files: readonly ArtifactFile[];
  readonly manifest: ArtifactManifest;
  readonly registry: TargetRegistry;
  readonly mcpServers: ValidatedArtifactMcpServerEvidence[];
}): Promise<readonly Diagnostic[]> => {
  const diagnostics: Diagnostic[] = [];
  const files = new Map(options.files.map((file) => [file.path, file]));
  const manifestFiles = new Map(options.manifest.files.map((file) => [file.path, file]));
  const artifactRoot = resolve(options.artifactRoot);
  // The plugin root every host installs is the artifact root itself.
  const targetRoot = artifactRoot;
  const compiledEntries = new Set<string>();
  const referencedAnywhere = new Set<string>();

  for (const projection of options.manifest.projections) {
    const target = { name: projection.host };
    if (!options.registry.has(target.name) || !options.registry.supports(target.name, 'mcp')) continue;
    const runtime = options.registry.mcpRuntime(target.name);
    if (runtime === undefined) continue;
    const manifestPath = runtime.manifestPath;
    const pointer = projection.documents.mcp;
    if ((pointer !== undefined || files.has(manifestPath)) && pointer !== manifestPath) {
      diagnostics.push(diagnostic(
        'AB6017',
        `projections[${JSON.stringify(target.name)}].documents.mcp ${pointer === undefined ? 'is absent' : `is ${JSON.stringify(pointer)}`}, ` +
          `but the target's MCP manifest is ${JSON.stringify(manifestPath)}.`,
        manifestPath,
        target.name,
      ));
    }
    const mcpLayout = options.registry.artifactLayout(target.name).mcpEntries;
    const referenceCounts = new Map<string, McpReferenceOccurrence[]>();
    const mcpEntries = options.files.filter((file) => isDirectOutputLayoutPath(file.path, mcpLayout));
    for (const file of mcpEntries) {
      referenceCounts.set(file.path, []);
      compiledEntries.add(file.path);
    }

    const manifestFile = files.get(manifestPath);
    if (manifestFile !== undefined) {
      let document: unknown;
      try {
        document = parseJsonWithoutDuplicateKeys(await runWithPlatform(readFileString(resolve(artifactRoot, manifestPath))));
      } catch {
        diagnostics.push(diagnostic(
          'AB6017',
          `MCP manifest for target ${JSON.stringify(target.name)} is not valid strict JSON.`,
          manifestPath,
          target.name,
        ));
        document = undefined;
      }
      if (document !== undefined) {
        const servers = readTargetMcpServers(runtime, document);
        if (servers.status === 'invalid') {
          diagnostics.push(diagnostic(
            'AB6017',
            `MCP manifest for target ${JSON.stringify(target.name)} does not contain only modern supported servers.`,
            manifestPath,
            target.name,
          ));
        } else {
          diagnostics.push(...validateDeclaredServersPresent({
            documentServers: new Set(servers.servers.map((entry) => entry.name)),
            manifestPath,
            servers: options.manifest.executables.mcpServers,
            target: target.name,
          }));
          for (const entry of servers.servers) {
            let server = entry.server;
            try {
              server = resolveMcpPathTokens({
                roots: {
                  pluginData: targetRoot,
                  pluginRoot: targetRoot,
                  workspaceRoot: dirname(artifactRoot),
                },
                runtime,
                server,
                target: target.name,
              });
            } catch (error) {
              if (error instanceof DiagnosticError) {
                diagnostics.push(...error.diagnostics.map((entry) => diagnostic(
                  entry.code,
                  entry.message,
                  manifestPath,
                  target.name,
                  artifactDiagnosticRecoveries.AB6017,
                )));
              } else {
                diagnostics.push(diagnostic(
                  'AB6017',
                  `MCP server ${JSON.stringify(entry.name)} could not resolve target runtime values.`,
                  manifestPath,
                  target.name,
                ));
              }
              continue;
            }
            const declared = options.manifest.executables.mcpServers.find((row) => row.name === entry.name);
            const launchPaths: string[] = [];
            if (server.kind !== 'stdio') {
              diagnostics.push(...validateLaunchAgreement({
                declared,
                kind: server.kind,
                launchPaths,
                manifestPath,
                server: entry.name,
                target: target.name,
              }));
              options.mcpServers.push(Object.freeze({
                entryPaths: Object.freeze([]),
                kind: server.kind,
                manifestPath,
                name: entry.name,
                target: target.name,
              }));
              continue;
            }

            if (server.cwd !== undefined) {
              if (!isTargetContainedCwd(artifactRoot, targetRoot, server.cwd)) {
                diagnostics.push(diagnostic(
                  'AB6017',
                  `MCP cwd ${JSON.stringify(server.cwd)} escapes target ${JSON.stringify(target.name)}.`,
                  manifestPath,
                  target.name,
                ));
              }
            }

            if (!server.command.includes('${')) {
              diagnostics.push(...validateMcpArtifactReference({
                artifactRoot,
                directExecutable: true,
                field: 'command',
                files,
                manifestFiles,
                manifestPath,
                target: target.name,
                targetRoot,
                value: server.command,
              }));
              const commandReference = classifyMcpArtifactArgument({
                path: mcpArtifactPathApi,
                roots: { artifactRoot, targetRoot },
                value: server.command,
              });
              if (commandReference.status === 'artifact-local') {
                recordMcpReference(referenceCounts, commandReference.path, { field: 'command', server: entry.name });
                referencedAnywhere.add(commandReference.path);
                launchPaths.push(commandReference.path);
              }
            }

            for (const argument of server.args) {
              diagnostics.push(...validateMcpArtifactReference({
                artifactRoot,
                directExecutable: false,
                field: 'argument',
                files,
                manifestFiles,
                manifestPath,
                target: target.name,
                targetRoot,
                value: argument,
              }));
              const argumentReference = classifyMcpArtifactArgument({
                path: mcpArtifactPathApi,
                roots: { artifactRoot, targetRoot },
                value: argument,
              });
              if (argumentReference.status === 'artifact-local') {
                recordMcpReference(referenceCounts, argumentReference.path, { field: 'argument', server: entry.name });
                referencedAnywhere.add(argumentReference.path);
                launchPaths.push(argumentReference.path);
              }
            }
            diagnostics.push(...validateLaunchAgreement({
              declared,
              kind: server.kind,
              launchPaths,
              manifestPath,
              server: entry.name,
              target: target.name,
            }));
            options.mcpServers.push(Object.freeze({
              entryPaths: Object.freeze([...new Set(launchPaths)].sort((left, right) => left.localeCompare(right))),
              kind: server.kind,
              manifestPath,
              name: entry.name,
              target: target.name,
            }));
          }
        }
      }
    }

    for (const [path, occurrences] of referenceCounts) {
      if (occurrences.length <= 1) continue;
      diagnostics.push(diagnostic(
        'AB6017',
        `Compiler MCP entry ${JSON.stringify(path)} is referenced ${occurrences.length} times in target ${JSON.stringify(target.name)}.`,
        path,
        target.name,
      ));
    }
  }

  for (const path of [...compiledEntries].sort((left, right) => left.localeCompare(right))) {
    if (referencedAnywhere.has(path)) continue;
    if (path.endsWith('-flight.mjs')) {
      const mainPath = path.slice(0, -'-flight.mjs'.length) + '.mjs';
      if (referencedAnywhere.has(mainPath)) {
        const mainSource = await runWithPlatform(readFileString(resolve(artifactRoot, mainPath)));
        if (mainSource.includes(`./${posix.basename(path)}`)) continue;
      }
    }
    diagnostics.push(diagnostic(
      'AB6017',
      `Compiler MCP entry ${JSON.stringify(path)} is not referenced by a server of any selected target.`,
      path,
    ));
  }
  return Object.freeze(diagnostics);
};
