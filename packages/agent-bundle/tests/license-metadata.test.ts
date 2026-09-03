import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

const workspaceRoot = process.cwd();
const projectLicense = 'Apache-2.0';
/** SHA-256 of https://www.apache.org/licenses/LICENSE-2.0.txt (canonical text; .gitattributes pins LF endings). */
const canonicalApache2Sha256 = 'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';
const publishablePackages = ['agent-bundle', 'rsc-runtime', 'create-agent-bundle'] as const;

interface Manifest {
  readonly files?: readonly string[];
  readonly license?: string;
  readonly name?: string;
  readonly private?: boolean;
}

const readManifest = async (path: string): Promise<Manifest> => JSON.parse(await readFile(path, 'utf8')) as Manifest;

const workspaceManifestPaths = async (): Promise<readonly string[]> => {
  const groups = await Promise.all(['packages', 'examples'].map(async (group) => {
    const entries = await readdir(join(workspaceRoot, group), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => join(workspaceRoot, group, entry.name, 'package.json'));
  }));
  return [join(workspaceRoot, 'package.json'), ...groups.flat()];
};

it('ships the canonical Apache License 2.0 text and a NOTICE naming the copyright holder', async () => {
  const license = await readFile(join(workspaceRoot, 'LICENSE'));
  const notice = await readFile(join(workspaceRoot, 'NOTICE'), 'utf8');

  expect(createHash('sha256').update(license).digest('hex')).toBe(canonicalApache2Sha256);
  expect(notice.startsWith('agent-bundle\nCopyright 2026 ')).toBe(true);
  expect(notice).toContain('THIRD_PARTY_NOTICES');
  expect(notice).toContain('src/mcp/APP-RENDERER-LICENSE');
});

it('declares Apache-2.0 on every first-party workspace package', async () => {
  const manifests = await Promise.all((await workspaceManifestPaths()).map(readManifest));

  expect(manifests.length).toBeGreaterThanOrEqual(1 + 4 + 6);
  for (const manifest of manifests) {
    expect(manifest.license, `${String(manifest.name)} must declare "license": "${projectLicense}"`).toBe(projectLicense);
  }
});

it('lists LICENSE and NOTICE in every publishable package files allowlist', async () => {
  for (const directory of publishablePackages) {
    const manifest = await readManifest(join(workspaceRoot, 'packages', directory, 'package.json'));
    expect(manifest.private).toBeUndefined();
    expect(manifest.files).toEqual(expect.arrayContaining(['LICENSE', 'NOTICE']));
  }
});

it('leaves scaffolded projects free to choose their own license', async () => {
  const templatesRoot = join(workspaceRoot, 'packages', 'create-agent-bundle', 'templates');
  const templates = (await readdir(templatesRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory());

  expect(templates.length).toBeGreaterThan(0);
  for (const template of templates) {
    const manifest = await readManifest(join(templatesRoot, template.name, 'package_json'));
    expect(manifest.license, `template ${template.name} must not impose a license`).toBeUndefined();
  }
});
