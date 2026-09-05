import { expect, it } from '@rstest/core';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseWebManifest,
  readWebManifest,
  type WebManifest,
} from '../src/web-host/manifest.ts';

const validWeb = (): WebManifest => ({
  apps: [{
    allow: ['call-tool'],
    app: 'catalog/details',
    args: [],
    entry: 'mcp/mcp-catalog-01234567.mjs',
    env: { CATALOG_TOKEN: 'agent-bundle:path:plugin-data/token' },
    input: { sku: '42' },
    name: 'details',
    resourceUri: 'ui://catalog/details',
    server: 'catalog',
    tool: 'open-details',
  }],
  open: 'never',
});

it('parses and round-trips a strict web manifest section', () => {
  expect(parseWebManifest(JSON.parse(JSON.stringify(validWeb())))).toEqual(validWeb());
});

it('rejects exact-key, consent-vocabulary, and ordering violations', () => {
  expect(() => parseWebManifest({ ...validWeb(), extra: true }))
    .toThrow('agent-bundle.manifest.json web section is invalid: root must have exactly the keys apps, open; found apps, open, extra.');
  expect(() => parseWebManifest({
    ...validWeb(),
    apps: [{ ...validWeb().apps[0], allow: ['camera'] }],
  })).toThrow(/App-initiated consent capability/u);
  expect(() => parseWebManifest({
    ...validWeb(),
    apps: [{ ...validWeb().apps[0], args: ['--flag', 1] }],
  })).toThrow('apps[0].args[1] must be a string.');
  expect(() => parseWebManifest({
    ...validWeb(),
    apps: [
      { ...validWeb().apps[0], app: 'z/app' },
      { ...validWeb().apps[0], app: 'a/app' },
    ],
  })).toThrow(/sorted by app/u);
});

it('reads the optional section and returns undefined when absent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-web-manifest-'));
  const path = join(root, 'agent-bundle.manifest.json');
  try {
    await writeFile(path, JSON.stringify({ producer: {}, web: validWeb() }));
    await expect(readWebManifest(path)).resolves.toEqual(validWeb());
    await writeFile(path, JSON.stringify({ producer: {} }));
    await expect(readWebManifest(path)).resolves.toBeUndefined();
    await writeFile(path, JSON.stringify({ web: { apps: [], open: 'sometimes' } }));
    await expect(readWebManifest(path)).rejects.toThrow(
      new RegExp(`Unable to read web section from ${path.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&')}: .*open must`, 'u'),
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
