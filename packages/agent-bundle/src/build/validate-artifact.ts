import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, posix, resolve } from 'node:path';
import { spawn } from 'node:child_process';

import type { Diagnostic } from '../core/diagnostics.ts';
import {
  listArtifactFiles,
  type ArtifactFile,
  type ArtifactManifest,
  type ManifestFile,
} from './emit.ts';

const manifestName = 'agent-bundle.manifest.json';

const diagnostic = (code: string, message: string, generatedPath?: string): Diagnostic => ({
  code,
  generatedPath,
  message,
  severity: 'error',
});

const isSafeArtifactPath = (path: string): boolean =>
  path.length > 0 &&
  !isAbsolute(path) &&
  path === posix.normalize(path) &&
  path !== '..' &&
  !path.startsWith('../');

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
  (right.mode === undefined || left.mode === right.mode) &&
  left.path === right.path &&
  left.sha256 === right.sha256;

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

const parseManifest = (value: string): ArtifactManifest | undefined => {
  try {
    const parsed = JSON.parse(value) as Partial<ArtifactManifest>;
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.targets) ||
      !Array.isArray(parsed.files) ||
      !parsed.targets.every((target) => typeof target === 'string') ||
      !parsed.files.every(
        (file) =>
          typeof file === 'object' &&
          file !== null &&
          typeof (file as ManifestFile).bytes === 'number' &&
          ((file as ManifestFile).mode === undefined ||
            (typeof (file as ManifestFile).mode === 'number' &&
              Number.isInteger((file as ManifestFile).mode) &&
              (file as ManifestFile).mode! >= 0 &&
              (file as ManifestFile).mode! <= 0o777)) &&
          typeof (file as ManifestFile).path === 'string' &&
          typeof (file as ManifestFile).sha256 === 'string',
      )
    ) {
      return undefined;
    }
    return parsed as ArtifactManifest;
  } catch {
    return undefined;
  }
};

export const validateArtifact = async (context: {
  readonly artifactRoot: string;
}): Promise<readonly Diagnostic[]> => {
  const manifestPath = resolve(context.artifactRoot, manifestName);
  let manifest: ArtifactManifest | undefined;
  try {
    manifest = parseManifest(await readFile(manifestPath, 'utf8'));
  } catch {
    return [diagnostic('AB6000', 'Artifact manifest is missing or cannot be read.', manifestName)];
  }
  if (manifest === undefined) {
    return [diagnostic('AB6001', 'Artifact manifest is not valid JSON with the required shape.', manifestName)];
  }

  const diagnostics: Diagnostic[] = [];
  const manifestPaths = new Set<string>();
  for (const file of manifest.files) {
    if (!isSafeArtifactPath(file.path) || file.path === manifestName) {
      diagnostics.push(diagnostic('AB6002', `Manifest contains an unsafe file path ${JSON.stringify(file.path)}.`, file.path));
      continue;
    }
    if (manifestPaths.has(file.path)) {
      diagnostics.push(diagnostic('AB6003', `Manifest lists ${JSON.stringify(file.path)} more than once.`, file.path));
    }
    manifestPaths.add(file.path);
  }

  const actualFiles = (await listArtifactFiles(context.artifactRoot)).filter(
    (file) => file.path !== manifestName,
  );
  if (
    actualFiles.length !== manifest.files.length ||
    actualFiles.some((file, index) => !sameFile(file, manifest.files[index]!))
  ) {
    diagnostics.push(diagnostic('AB6004', 'Artifact files do not match the manifest.', manifestName));
  }

  for (const file of actualFiles.filter((entry) => entry.path.endsWith('.json'))) {
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

  for (const file of actualFiles.filter((entry) => /\.(?:[cm]?js)$/u.test(entry.path))) {
    const syntaxError = await checkJavaScriptSyntax(resolve(context.artifactRoot, file.path));
    if (syntaxError !== undefined) {
      diagnostics.push(diagnostic('AB6005', `Generated JavaScript has invalid syntax: ${syntaxError}`, file.path));
    }
  }

  return Object.freeze(diagnostics);
};
