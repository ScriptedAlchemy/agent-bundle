import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { createDefaultRegistry, TargetRegistry } from '../src/adapters/registry.ts';
import {
  hostMcpRuntime,
  hostRootDirectory,
  readArtifactRootContracts,
  readArtifactTargets,
} from '../src/build/artifact-root.ts';
import { writeFixtureManifest } from './support/manifest.ts';

const registry = createDefaultRegistry();

it('reads the targets a root declares and yields nothing where there is no manifest', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-artifact-root-'));
  try {
    // A host's namespaced view (portable/ beside other hosts) and a plain
    // plugin directory carry no manifest: callers fall back to the host's
    // conventional layout instead of failing.
    expect(await readArtifactTargets(root)).toBeUndefined();
    expect(await readArtifactRootContracts(root, registry)).toBeUndefined();
    expect(hostRootDirectory(root, undefined, 'codex')).toBe(root);
    expect(hostMcpRuntime(undefined, registry, 'codex')?.manifestPath).toBe('.mcp.json');

    await writeFixtureManifest({ artifactRoot: root, targets: ['claude', 'codex', 'portable'] });
    expect(await readArtifactTargets(root)).toEqual(['claude', 'codex', 'portable']);
    const contracts = await readArtifactRootContracts(root, registry);
    expect(contracts?.name).toBe('claude+codex+portable');
    // Root hosts read the root itself; the portable view is its own directory.
    expect(hostRootDirectory(root, contracts, 'claude')).toBe(root);
    expect(hostRootDirectory(root, contracts, 'portable')).toBe(join(root, 'portable'));
    // Codex beside Claude Code reads its relocated document, root-relative.
    expect(hostMcpRuntime(contracts, registry, 'codex')?.manifestPath).toBe('.codex-plugin/mcp.json');
    expect(hostMcpRuntime(contracts, registry, 'claude')?.manifestPath).toBe('.mcp.json');
    expect(hostMcpRuntime(contracts, registry, 'portable')?.manifestPath).toBe('portable/mcp.json');

    // A registry that knows none of the manifest's targets yields no contracts.
    expect(await readArtifactRootContracts(root, new TargetRegistry())).toBeUndefined();
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
