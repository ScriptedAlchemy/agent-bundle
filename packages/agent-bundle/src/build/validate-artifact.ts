import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import type { Diagnostic } from '../core/diagnostics.ts';
import {
  artifactManifestName,
  listArtifactFiles,
  type ArtifactFile,
  type ManifestFile,
} from './emit.ts';
import { parseArtifactManifest, type ArtifactManifestV2 } from './manifest.ts';

const epochStagingMarkerName = '.agent-bundle-epoch-stage.json';

export interface ValidateArtifactOptions {
  /** Enables the one store-owned epoch staging marker after its exact schema validates. */
  readonly allowEpochStagingMarker?: true;
  readonly artifactRoot: string;
}

const diagnostic = (code: string, message: string, generatedPath?: string): Diagnostic => ({
  code,
  generatedPath,
  message,
  severity: 'error',
});

const checkJavaScriptSyntax = async (path: string): Promise<string | undefined> =>
  new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['--check', path], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill();
    }, 5_000);
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', (error) => {
      clearTimeout(timeout);
      resolvePromise(error.message);
    });
    child.once('close', (code) => {
      clearTimeout(timeout);
      resolvePromise(code === 0 ? undefined : stderr.trim() || 'Node rejected generated JavaScript.');
    });
  });

const sameFile = (left: ArtifactFile, right: ManifestFile): boolean =>
  left.bytes === right.bytes &&
  (right.mode === undefined ? (left.mode & 0o111) === 0 : left.mode === right.mode) &&
  left.path === right.path &&
  left.sha256 === right.sha256;

const matchesManifestFileTable = (
  files: readonly ArtifactFile[],
  manifestFiles: readonly ManifestFile[],
): boolean => {
  if (files.length !== manifestFiles.length) return false;
  const manifestFilesByPath = new Map(manifestFiles.map((file) => [file.path, file]));
  return files.every((file) => {
    const manifestFile = manifestFilesByPath.get(file.path);
    return manifestFile !== undefined && sameFile(file, manifestFile);
  });
};

const localMcpArgument = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const relative = value.replace(/^\.\//, '');
  return /^mcp\/mcp-[a-z0-9-]+-[a-f\d]{8}\.mjs$/u.test(relative) ? relative : undefined;
};

const localMcpPaths = (document: unknown): readonly string[] => {
  if (typeof document !== 'object' || document === null || Array.isArray(document)) return [];
  const servers = (document as { readonly mcpServers?: unknown }).mcpServers;
  if (typeof servers !== 'object' || servers === null || Array.isArray(servers)) return [];
  return Object.values(servers).flatMap((server) => {
    if (typeof server !== 'object' || server === null || Array.isArray(server)) return [];
    const args = (server as { readonly args?: unknown }).args;
    return Array.isArray(args) ? [localMcpArgument(args[0])].filter((path): path is string => path !== undefined) : [];
  });
};

const isEpochStagingMarker = (value: string): boolean => {
  try {
    const marker: unknown = JSON.parse(value);
    if (typeof marker !== 'object' || marker === null || Array.isArray(marker)) return false;
    if (!('token' in marker) || !('version' in marker)) return false;
    const entries = Object.entries(marker);
    return entries.length === 2 &&
      marker.version === 1 &&
      typeof marker.token === 'string' &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(marker.token);
  } catch {
    return false;
  }
};

const artifactFiles = async (context: ValidateArtifactOptions): Promise<readonly ArtifactFile[]> => {
  let allowedEpochStagingMarker = false;
  if (context.allowEpochStagingMarker === true) {
    try {
      allowedEpochStagingMarker = isEpochStagingMarker(
        await readFile(resolve(context.artifactRoot, epochStagingMarkerName), 'utf8'),
      );
    } catch {
      allowedEpochStagingMarker = false;
    }
  }
  return (await listArtifactFiles(context.artifactRoot)).filter(
    (file) => file.path !== artifactManifestName &&
      !(allowedEpochStagingMarker && file.path === epochStagingMarkerName),
  );
};

export const validateArtifactFiles = async (
  context: ValidateArtifactOptions,
): Promise<readonly Diagnostic[]> => {
  const files = await artifactFiles(context);
  const diagnostics: Diagnostic[] = [];

  for (const file of files.filter((entry) => entry.path.endsWith('.json'))) {
    try {
      const document = JSON.parse(await readFile(resolve(context.artifactRoot, file.path), 'utf8')) as unknown;
      for (const mcpPath of localMcpPaths(document)) {
        try {
          await readFile(resolve(context.artifactRoot, dirname(file.path), mcpPath));
        } catch {
          diagnostics.push(diagnostic(
            'AB6007',
            `MCP manifest references missing generated server ${JSON.stringify(mcpPath)}.`,
            file.path,
          ));
        }
      }
    } catch {
      diagnostics.push(diagnostic('AB6006', 'Generated JSON cannot be parsed.', file.path));
    }
  }

  for (const file of files.filter((entry) => /\.(?:[cm]?js)$/u.test(entry.path))) {
    const syntaxError = await checkJavaScriptSyntax(resolve(context.artifactRoot, file.path));
    if (syntaxError !== undefined) {
      diagnostics.push(diagnostic('AB6005', `Generated JavaScript has invalid syntax: ${syntaxError}`, file.path));
    }
  }

  return Object.freeze(diagnostics);
};

export const validateArtifact = async (context: ValidateArtifactOptions): Promise<readonly Diagnostic[]> => {
  const manifestPath = resolve(context.artifactRoot, artifactManifestName);
  let manifest: ArtifactManifestV2;
  try {
    manifest = parseArtifactManifest(await readFile(manifestPath, 'utf8'));
  } catch {
    try {
      await readFile(manifestPath, 'utf8');
    } catch {
      return [diagnostic('AB6000', 'Artifact manifest is missing or cannot be read.', artifactManifestName)];
    }
    return [diagnostic('AB6001', 'Artifact manifest is not a strict canonical v2 manifest.', artifactManifestName)];
  }

  const actualFiles = await artifactFiles(context);
  const diagnostics: Diagnostic[] = [];
  if (!matchesManifestFileTable(actualFiles, manifest.files)) {
    diagnostics.push(diagnostic('AB6004', 'Artifact files do not match the manifest.', artifactManifestName));
  }
  diagnostics.push(...await validateArtifactFiles(context));
  return Object.freeze(diagnostics);
};
