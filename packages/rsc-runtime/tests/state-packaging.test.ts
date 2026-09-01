import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { describe, expect, it } from '@rstest/core';
import { z } from 'zod';

/**
 * Packaged-tree boundaries for the optional state kernel (#98): stateless
 * consumers who import the package root (or `./plugin`) must receive none of
 * the kernel or storage code, volatile-state consumers must never load
 * `node:sqlite`, and the sqlite entry must share the state entry's runtime
 * so error identity holds across subpaths. Runs against the prebuilt dist
 * (the integration pool builds it up front).
 */

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const distFile = async (...segments: string[]): Promise<string> =>
  readFile(join(packageRoot, 'dist', ...segments), 'utf8');

describe.sequential('state kernel packaging boundaries', () => {
  it('keeps every kernel and storage identifier out of the root and plugin entries', async () => {
    for (const entry of ['index.js', 'plugin.js']) {
      const source = await distFile(entry);
      for (const identifier of ['node:sqlite', 'defineState', 'AgentStateError', 'DatabaseSync', 'agent_state_journal', 'from "effect"', 'Effect.runPromise']) {
        expect(source, `${entry} must not contain ${identifier}`).not.toContain(identifier);
      }
    }
  });

  it('keeps node:sqlite out of the volatile state entry', async () => {
    const source = await distFile('state.js');
    expect(source).toContain('defineState');
    expect(source).not.toContain('node:sqlite');
    expect(source).not.toContain('DatabaseSync');
  });

  it('gives the sqlite entry its own subpath that shares the state runtime', async () => {
    const source = await distFile('state', 'sqlite.js');
    expect(source).toContain('node:sqlite');
    expect(source).toContain('from "../state.js"');
    const packageJson = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, { import: string; types: string }>;
    };
    expect(Object.keys(packageJson.exports)).toEqual(['.', './plugin', './flight/server', './state', './state/sqlite']);
    for (const subpath of Object.keys(packageJson.exports)) {
      const target = packageJson.exports[subpath]!;
      await expect(distFile(...target.import.replace('./dist/', '').split('/'))).resolves.toBeTruthy();
      await expect(distFile(...target.types.replace('./dist/', '').split('/'))).resolves.toBeTruthy();
    }
  });

  it('throws one shared AgentStateError identity across the state and sqlite entries', async () => {
    const stateEntry = (await import(pathToFileURL(join(packageRoot, 'dist', 'state.js')).href)) as
      typeof import('../src/state/index.js');
    const sqliteEntry = (await import(pathToFileURL(join(packageRoot, 'dist', 'state', 'sqlite.js')).href)) as
      typeof import('../src/state/sqlite.js');
    const definition = stateEntry.defineState({
      events: { noted: z.object({ value: z.string() }).strict() },
      id: 'state-packaging/identity',
      initial: { notes: [] as readonly string[] },
      lifetime: 'process',
      reduce: (state, event) => ({ notes: [...state.notes, event.payload.value] }),
      schema: z.object({ notes: z.array(z.string()) }).strict(),
    });
    // The sqlite driver rejects a volatile definition; the error must be an
    // instance of the state entry's AgentStateError class, proving one
    // shared kernel runtime rather than a duplicated bundle.
    try {
      await sqliteEntry.createSqliteStateDriver({ root: packageRoot }).open(definition);
      throw new Error('expected a lifetime-mismatch rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(stateEntry.AgentStateError);
      expect((error as { code: string }).code).toBe('lifetime-mismatch');
    }
  });
});
