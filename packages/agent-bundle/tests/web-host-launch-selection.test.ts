import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import {
  selectWebLaunch,
  WebLaunchSelectionError,
  type SelectWebLaunchOptions,
} from '../src/dev/web-host-launch-selection.ts';

const registry = createDefaultRegistry();
const roots: string[] = [];

const artifactRoot = async (): Promise<string> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agent-bundle-web-select-')));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const writeManifest = async (root: string, relativePath: string, servers: Readonly<Record<string, unknown>>): Promise<void> => {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ mcpServers: servers }));
};

const claudeServer = (overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
  args: ['${CLAUDE_PLUGIN_ROOT}/mcp/mcp-status.mjs'],
  command: 'node',
  env: { AGENT_BUNDLE_PLUGIN_ROOT: '${CLAUDE_PLUGIN_ROOT}' },
  type: 'stdio',
  ...overrides,
});

const portableServer = (overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
  args: ['${PLUGIN_ROOT}/mcp/mcp-status.mjs'],
  command: 'node',
  env: { AGENT_BUNDLE_PLUGIN_ROOT: '${PLUGIN_ROOT}' },
  type: 'stdio',
  ...overrides,
});

const codexServer = (overrides: Readonly<Record<string, unknown>> = {}): Readonly<Record<string, unknown>> => ({
  args: ['./mcp/mcp-status.mjs'],
  command: 'node',
  cwd: './',
  env: { AGENT_BUNDLE_PLUGIN_ROOT: './' },
  type: 'stdio',
  ...overrides,
});

const select = (root: string, overrides: Partial<SelectWebLaunchOptions> = {}) => selectWebLaunch({
  artifactRoot: root,
  declaredTargets: ['claude'],
  registry,
  serverName: 'status',
  workspaceRoot: root,
  ...overrides,
});

const failure = async (root: string, overrides: Partial<SelectWebLaunchOptions>): Promise<WebLaunchSelectionError> => {
  const outcome = await select(root, overrides).then(() => undefined, (error: unknown) => error);
  expect(outcome).toBeInstanceOf(WebLaunchSelectionError);
  if (!(outcome instanceof WebLaunchSelectionError)) throw outcome;
  return outcome;
};

describe('selectWebLaunch', () => {
  it('resolves a Claude-only artifact without any portable projection or mcp.json', async () => {
    const root = await artifactRoot();
    await writeManifest(root, '.mcp.json', { status: claudeServer() });
    const selection = await select(root);
    expect(selection.target).toBe('claude');
    expect(selection.sharedTargets).toEqual(['claude']);
  });

  it('resolves a Codex-only artifact without any portable projection or mcp.json', async () => {
    const root = await artifactRoot();
    await writeManifest(root, '.codex-plugin/mcp.json', { status: codexServer() });
    const selection = await select(root, { declaredTargets: ['codex'] });
    expect(selection.target).toBe('codex');
    expect(selection.sharedTargets).toEqual(['codex']);
  });

  it('needs no explicit target when two projections share one normalized launch', async () => {
    const root = await artifactRoot();
    await writeManifest(root, '.mcp.json', { status: claudeServer() });
    await writeManifest(root, 'mcp.json', { status: portableServer() });
    const selection = await select(root, { declaredTargets: ['claude', 'portable'] });
    expect(selection.target).toBe('claude');
    expect(selection.sharedTargets).toEqual(['claude', 'portable']);
  });

  it('selects identically when the hosts are declared in reversed order', async () => {
    const root = await artifactRoot();
    await writeManifest(root, '.mcp.json', { status: claudeServer() });
    await writeManifest(root, 'mcp.json', { status: portableServer() });
    const forward = await select(root, { declaredTargets: ['claude', 'portable'] });
    const reversed = await select(root, { declaredTargets: ['portable', 'claude'] });
    expect(reversed).toEqual(forward);
  });

  it("normalizes Codex's ./-relative anchors against the same roots as token interpolation", async () => {
    const root = await artifactRoot();
    await writeManifest(root, '.mcp.json', { status: claudeServer() });
    await writeManifest(root, '.codex-plugin/mcp.json', { status: codexServer() });
    const selection = await select(root, { declaredTargets: ['claude', 'codex'] });
    expect(selection.sharedTargets).toEqual(['claude', 'codex']);
  });

  it('requires an explicit target when projections differ in one execution-relevant field', async () => {
    const root = await artifactRoot();
    await writeManifest(root, '.mcp.json', { status: claudeServer() });
    await writeManifest(root, 'mcp.json', {
      status: portableServer({ env: { AGENT_BUNDLE_PLUGIN_ROOT: '${PLUGIN_ROOT}', STATUS_MODE: 'portable-only' } }),
    });
    const error = await failure(root, { declaredTargets: ['claude', 'portable'] });
    expect(error.code).toBe('launch-ambiguous');
    expect(error.candidates).toEqual(['claude', 'portable']);
    expect(error.message).toContain('?target=');
    expect(error.message).toContain('claude');
    expect(error.message).toContain('portable');
  });

  it('honors an explicit target among materially different launches', async () => {
    const root = await artifactRoot();
    await writeManifest(root, '.mcp.json', { status: claudeServer() });
    await writeManifest(root, 'mcp.json', {
      status: portableServer({ env: { AGENT_BUNDLE_PLUGIN_ROOT: '${PLUGIN_ROOT}', STATUS_MODE: 'portable-only' } }),
    });
    const selection = await select(root, { declaredTargets: ['claude', 'portable'], requestedTarget: 'portable' });
    expect(selection.target).toBe('portable');
    expect(selection.sharedTargets).toEqual(['portable']);
  });

  it('refuses an explicit target that no declared projection launches, never falling back', async () => {
    const root = await artifactRoot();
    await writeManifest(root, '.mcp.json', { status: claudeServer() });
    const error = await failure(root, { declaredTargets: ['claude'], requestedTarget: 'portable' });
    expect(error.code).toBe('target-not-launchable');
    expect(error.message).toContain('"portable"');
    expect(error.message).toContain('claude');
  });

  it('refuses an explicit target whose projection does not declare the server', async () => {
    const root = await artifactRoot();
    await writeManifest(root, '.mcp.json', { status: claudeServer() });
    await writeManifest(root, 'mcp.json', { other: portableServer() });
    const error = await failure(root, { declaredTargets: ['claude', 'portable'], requestedTarget: 'portable' });
    expect(error.code).toBe('target-not-launchable');
  });

  it('reports a missing launch binding instead of synthesizing a portable one', async () => {
    const root = await artifactRoot();
    await writeManifest(root, '.mcp.json', { other: claudeServer() });
    const error = await failure(root, { declaredTargets: ['claude'] });
    expect(error.code).toBe('launch-missing');
    expect(error.message).toContain('"status"');
  });

  it('gives distinct launch identities to materially different launches and one to shared launches', async () => {
    const root = await artifactRoot();
    await writeManifest(root, '.mcp.json', { status: claudeServer() });
    await writeManifest(root, 'mcp.json', {
      status: portableServer({ args: ['${PLUGIN_ROOT}/mcp/mcp-status.mjs', '--verbose'] }),
    });
    const claude = await select(root, { declaredTargets: ['claude', 'portable'], requestedTarget: 'claude' });
    const portable = await select(root, { declaredTargets: ['claude', 'portable'], requestedTarget: 'portable' });
    expect(claude.launchId).not.toBe(portable.launchId);
    await writeManifest(root, 'mcp.json', { status: portableServer() });
    const aligned = await select(root, { declaredTargets: ['claude', 'portable'], requestedTarget: 'portable' });
    expect(aligned.launchId).toBe(claude.launchId);
  });
});
