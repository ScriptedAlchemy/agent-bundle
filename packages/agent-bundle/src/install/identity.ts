import { lstat } from 'node:fs/promises';
import { join } from 'node:path';

import { readArtifactManifest } from '../build/manifest-file.ts';
import type { ArtifactManifestProjectionDocuments } from '../build/manifest.ts';
import { DiagnosticError } from '../core/diagnostics.ts';
import { isErrno } from '../core/errors.ts';

export type BundleIdentityHost = 'claude' | 'codex' | 'cursor';

export interface PluginIdentity {
  readonly bundleRoot: string;
  readonly documents: ArtifactManifestProjectionDocuments;
  readonly host: BundleIdentityHost;
  readonly marketplace?: string;
  readonly plugin: string;
  readonly version: string;
}

export const failure = (
  code: string,
  message: string,
  target: BundleIdentityHost,
): DiagnosticError => new DiagnosticError([{
  code,
  message,
  severity: 'error',
  target,
}]);

const missingPluginDocument = async (
  bundleRoot: string,
  path: string,
  host: BundleIdentityHost,
): Promise<void> => {
  try {
    const metadata = await lstat(join(bundleRoot, path));
    if (metadata.isFile()) return;
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  throw failure(
    'AB7001',
    `agent-bundle.manifest.json points ${host} at ${path}, which is missing from ${bundleRoot}.`,
    host,
  );
};

/** Reads install identity and host-document pointers from the authoritative artifact manifest. */
export const readBundleIdentity = async (
  from: string,
  host: BundleIdentityHost,
): Promise<PluginIdentity> => {
  const result = await readArtifactManifest(from);
  switch (result.status) {
    case 'missing':
      throw failure(
        'AB7001',
        `No agent-bundle.manifest.json in ${result.root}: build the composite root first (agent-bundle build), then point --from at its root.`,
        host,
      );
    case 'invalid':
      throw failure(
        'AB7001',
        `agent-bundle.manifest.json in ${result.root} is not a valid canonical artifact manifest: ${result.detail}`,
        host,
      );
    case 'ok': {
      const projection = result.manifest.projections.find((candidate) => candidate.host === host);
      if (projection === undefined) {
        const projections = result.manifest.projections.map((candidate) => candidate.host).join(', ');
        throw failure(
          'AB7001',
          `The artifact at ${result.root} was built for projections [${projections}]; ${host} is not among them. ` +
            `Rebuild with --target ${host} (or add it to targets in agent-bundle.config.ts).`,
          host,
        );
      }
      const pluginDocument = projection.documents.plugin;
      if (pluginDocument === undefined) {
        throw failure('AB7001', `The ${host} projection at ${result.root} has no host plugin manifest.`, host);
      }
      const marketplace = projection.marketplace?.name;
      if (host !== 'cursor' && marketplace === undefined) {
        throw failure('AB7001', `${host} bundle has no marketplace identity.`, host);
      }
      const plugin = result.manifest.application.name;
      if (
        host === 'cursor' &&
        (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(plugin) || plugin.length > 64)
      ) {
        throw failure('AB7001', `Cursor plugin name ${JSON.stringify(plugin)} is not a safe local plugin name.`, host);
      }
      await missingPluginDocument(result.root, pluginDocument, host);
      return Object.freeze({
        bundleRoot: result.root,
        documents: projection.documents,
        host,
        ...(marketplace === undefined ? {} : { marketplace }),
        plugin,
        version: result.manifest.application.version,
      });
    }
    default: {
      const exhaustive: never = result;
      throw new TypeError(`Unknown artifact manifest read result ${String(exhaustive)}.`);
    }
  }
};
