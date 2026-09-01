import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from '@rstest/core';

import {
  AgentTestError,
  openPackedMcpServer,
  proofLevelLabel,
  removeProjectSource,
  type DeletedSourceReceipt,
} from '../src/test/index.ts';

describe('deleted-source artifact evidence', () => {
  it('removes conventional project source and returns a frozen relative receipt', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-deleted-source-'));
    try {
      await mkdir(join(projectRoot, 'src'));
      await Promise.all([
        writeFile(join(projectRoot, 'agent-bundle.config.ts'), 'export default {};\n'),
        writeFile(join(projectRoot, 'src', 'x.ts'), 'export const x = true;\n'),
      ]);

      const receipt = await removeProjectSource({ projectRoot });

      expect(receipt).toEqual({
        projectRoot,
        removed: ['agent-bundle.config.ts', 'src'],
      });
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(Object.isFrozen(receipt.removed)).toBe(true);
      await expect(access(join(projectRoot, 'agent-bundle.config.ts'))).rejects.toThrow();
      await expect(access(join(projectRoot, 'src'))).rejects.toThrow();
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it('refuses to mint evidence when no project source existed', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-deleted-source-empty-'));
    try {
      const error = await removeProjectSource({ projectRoot }).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(AgentTestError);
      expect((error as AgentTestError).code).toBe('deleted-source-unverified');
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });

  it('rejects a stale receipt before spawning the entry', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agent-bundle-deleted-source-stale-'));
    try {
      await mkdir(join(projectRoot, 'src'));
      const deletedSource: DeletedSourceReceipt = Object.freeze({
        projectRoot,
        removed: Object.freeze(['src']),
      });
      const error = await openPackedMcpServer({
        deletedSource,
        entry: join(projectRoot, 'does-not-exist.mjs'),
      }).catch((thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(AgentTestError);
      expect((error as AgentTestError).code).toBe('deleted-source-unverified');
      expect((error as AgentTestError).message).toContain(proofLevelLabel('packed-deleted-source'));
    } finally {
      await rm(projectRoot, { force: true, recursive: true });
    }
  });
});
