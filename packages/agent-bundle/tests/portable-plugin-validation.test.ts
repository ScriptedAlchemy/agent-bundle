import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from '@rstest/core';

import {
  validatePortablePlugin,
  validatePortablePluginFiles,
} from '../src/host-contracts/portable-plugin-validation.ts';

const pluginSchema = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const mcpSchema = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const writeJson = async (path: string, value: unknown): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
};

const writeText = async (path: string, value: string): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, value);
};

const conformantBundle = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-portable-validation-'));
  roots.push(root);
  await writeJson(join(root, 'plugin.json'), {
    $schema: pluginSchema,
    author: { name: 'Example Team' },
    description: 'Conformant fixture',
    extensions: { 'com.example.client': { setting: true } },
    keywords: ['fixture'],
    license: 'MIT',
    name: 'conformant-fixture',
    version: '1.0.0',
  });
  await writeJson(join(root, 'mcp.json'), {
    $schema: mcpSchema,
    mcpServers: {
      bundled: {
        args: ['${PLUGIN_ROOT}/mcp/server.mjs'],
        command: './bin/launch',
        cwd: '${PLUGIN_ROOT}',
        env: { CACHE: '${PLUGIN_DATA}/cache' },
        type: 'stdio',
      },
      loopback: { type: 'streamable-http', url: 'http://localhost:8787/mcp' },
      remote: {
        headers: { 'X-Tenant': 'public' },
        type: 'streamable-http',
        url: 'https://mcp.example.test/mcp',
      },
      tool: { command: 'node', type: 'stdio' },
    },
  });
  await writeText(join(root, 'bin', 'launch'), '#!/bin/sh\nexit 0\n');
  await writeText(join(root, 'mcp', 'server.mjs'), 'export {};\n');
  await writeText(join(root, 'skills', 'summarize', 'SKILL.md'), '---\nname: summarize\ndescription: Summarize.\n---\nSummarize.\n');
  return root;
};

const codes = (diagnostics: readonly { readonly code: string }[]): string[] =>
  diagnostics.map((diagnostic) => diagnostic.code);

const messages = (diagnostics: readonly { readonly message: string }[]): string[] =>
  diagnostics.map((diagnostic) => diagnostic.message);

it('passes a conformant Agent Plugins 1.0.0 bundle and reports the pinned provenance transparently', async () => {
  const root = await conformantBundle();
  const report = await validatePortablePlugin({ pluginDirectory: root, target: 'portable' });

  expect(await validatePortablePluginFiles({ pluginDirectory: root, target: 'portable' })).toEqual([]);
  expect(report).toMatchObject({
    host: 'portable',
    specificationVersion: '1.0.0',
    status: 'passed',
    target: 'portable',
  });
  expect(report.diagnostics).toEqual([expect.objectContaining({
    code: 'AB6038',
    message: expect.stringContaining('agentplugins/agent-plugins-spec@ff8ab5e39'),
    severity: 'info',
    target: 'portable',
  })]);
  expect(report.diagnostics[0]?.message).toContain('re-verified 2026-09-03');
});

it('requires the root plugin.json and rejects documents the pinned schemas refuse', async () => {
  const root = await conformantBundle();
  await rm(join(root, 'plugin.json'));
  const missing = await validatePortablePluginFiles({ pluginDirectory: root, target: 'portable' });
  expect(missing).toEqual([expect.objectContaining({
    code: 'AB6035',
    message: 'plugin.json is required at the plugin root (Agent Plugins 1.0.0 §4.1).',
    severity: 'error',
  })]);

  await writeJson(join(root, 'plugin.json'), {
    $schema: pluginSchema,
    author: { name: 'Example', twitter: '@example' },
    name: 'Not-Lowercase',
    unknownTopLevel: true,
  });
  await writeJson(join(root, 'mcp.json'), {
    $schema: mcpSchema,
    mcpServers: { reserved: { command: 'node', env: { PLUGIN_ROOT: '/tmp' }, type: 'stdio' } },
  });
  const rejected = await validatePortablePluginFiles({ pluginDirectory: root, target: 'portable' });
  expect(new Set(codes(rejected))).toEqual(new Set(['AB6035']));
  expect(messages(rejected)).toEqual(expect.arrayContaining([
    expect.stringMatching(/^plugin\.json\/name: must match pattern/u),
    expect.stringMatching(/^plugin\.json\/author: must NOT have additional properties/u),
    expect.stringMatching(/^plugin\.json\/: must NOT have additional properties/u),
    expect.stringMatching(/^mcp\.json\/mcpServers\/reserved\/env/u),
  ]));

  await writeText(join(root, 'plugin.json'), '{ not json');
  expect(messages(await validatePortablePluginFiles({ pluginDirectory: root, target: 'portable' })))
    .toEqual(expect.arrayContaining(['plugin.json is not valid JSON.']));
});

it('reports an Agent Plugins version disagreement between plugin.json and mcp.json (§10.1)', async () => {
  const root = await conformantBundle();
  await writeJson(join(root, 'mcp.json'), {
    $schema: 'https://agent-plugins.org/schemas/1.1.0/mcp.schema.json',
    mcpServers: {},
  });
  const diagnostics = await validatePortablePluginFiles({ pluginDirectory: root, target: 'portable' });

  // The pinned 1.0.0 schema also rejects the foreign identifier (AB6035); the
  // normative disagreement is still named so the repair is unambiguous.
  expect(codes(diagnostics)).toEqual(['AB6035', 'AB6036']);
  expect(messages(diagnostics)[1]).toBe(
    'mcp.json declares Agent Plugins 1.1.0 while plugin.json declares 1.0.0; the versions must agree (Agent Plugins 1.0.0 §10.1).',
  );
});

it('applies the normative text where the schemas are silent: commands, cwd, URLs, headers, env keys', async () => {
  const root = await conformantBundle();
  await writeJson(join(root, 'mcp.json'), {
    $schema: mcpSchema,
    mcpServers: {
      anchorCommand: { command: './../anchor/server', type: 'stdio' },
      anchorCwd: { command: 'node', cwd: '${PLUGIN_ROOT}/../anchor', type: 'stdio' },
      backslashCommand: { command: './bin\\..\\..\\outside', type: 'stdio' },
      backslashCwd: { command: 'node', cwd: './safe\\..\\..\\outside', type: 'stdio' },
      escapingCommand: { command: './../outside', type: 'stdio' },
      escapingCwd: { command: 'node', cwd: '${PLUGIN_ROOT}/../elsewhere', type: 'stdio' },
      escapingData: { command: 'node', cwd: '${PLUGIN_DATA}/../elsewhere', type: 'stdio' },
      fragment: { type: 'streamable-http', url: 'https://mcp.example.test/mcp#section' },
      headers: {
        headers: { 'Bad Header': 'x', 'X-Tenant': 'a', 'x-tenant': 'b', 'X-Token': '${PLUGIN_ROOT}' },
        type: 'streamable-http',
        url: 'https://mcp.example.test/mcp',
      },
      driveRelativeCommand: { command: 'C:server', type: 'stdio' },
      missingBundled: { command: './bin/absent', type: 'stdio' },
      pathCommand: { command: 'bin/server', type: 'stdio' },
      placeholderCommand: { command: '${PLUGIN_ROOT}/bin/launch', type: 'stdio' },
      placeholderEnvKey: { command: 'node', env: { '${PLUGIN_ROOT}': 'x' }, type: 'stdio' },
      placeholderUrl: { type: 'sse', url: 'https://${PLUGIN_ROOT}/mcp' },
      plainHttp: { type: 'streamable-http', url: 'http://mcp.example.test/mcp' },
      relativeUrl: { type: 'streamable-http', url: '/mcp' },
      userInfo: { type: 'streamable-http', url: 'https://user:secret@mcp.example.test/mcp' },
    },
  });
  const diagnostics = await validatePortablePluginFiles({ pluginDirectory: root, target: 'portable' });

  expect(new Set(codes(diagnostics))).toEqual(new Set(['AB6036']));
  expect(messages(diagnostics)).toEqual([
    'mcp.json/mcpServers/anchorCommand/command "./../anchor/server" escapes the plugin root (Agent Plugins 1.0.0 §4.1).',
    'mcp.json/mcpServers/anchorCwd/cwd "${PLUGIN_ROOT}/../anchor" escapes its plugin root after resolution (Agent Plugins 1.0.0 §7.2.1).',
    'mcp.json/mcpServers/backslashCommand/command "./bin\\\\..\\\\..\\\\outside" escapes the plugin root (Agent Plugins 1.0.0 §4.1).',
    'mcp.json/mcpServers/backslashCwd/cwd "./safe\\\\..\\\\..\\\\outside" must use forward-slash separators without backslashes or NUL so every consuming platform resolves it identically (Agent Plugins 1.0.0 §4.1).',
    'mcp.json/mcpServers/escapingCommand/command "./../outside" escapes the plugin root (Agent Plugins 1.0.0 §4.1).',
    'mcp.json/mcpServers/escapingCwd/cwd "${PLUGIN_ROOT}/../elsewhere" escapes its plugin root after resolution (Agent Plugins 1.0.0 §7.2.1).',
    'mcp.json/mcpServers/escapingData/cwd "${PLUGIN_DATA}/../elsewhere" escapes its plugin data directory after resolution (Agent Plugins 1.0.0 §7.2.1).',
    'mcp.json/mcpServers/fragment/url must not contain a fragment (Agent Plugins 1.0.0 §7.2.1).',
    'mcp.json/mcpServers/headers/headers/Bad Header is not a valid HTTP header field name (Agent Plugins 1.0.0 §7.2.1).',
    'mcp.json/mcpServers/headers/headers/x-tenant repeats header "X-Tenant" under different casing; header names are case-insensitive (Agent Plugins 1.0.0 §7.2.1).',
    'mcp.json/mcpServers/headers/headers/X-Token contains an Agent Plugins placeholder, but clients never expand placeholders in headers (Agent Plugins 1.0.0 §7.2.1).',
    'mcp.json/mcpServers/driveRelativeCommand/command "C:server" is neither a bare executable name nor a plugin-relative ./ path (Agent Plugins 1.0.0 §7.2.1).',
    'mcp.json/mcpServers/missingBundled/command "./bin/absent" does not resolve to a bundled regular file (Agent Plugins 1.0.0 §7.2.1).',
    'mcp.json/mcpServers/pathCommand/command "bin/server" is neither a bare executable name nor a plugin-relative ./ path (Agent Plugins 1.0.0 §7.2.1).',
    'mcp.json/mcpServers/placeholderCommand/command contains an Agent Plugins placeholder, but clients never expand placeholders in command (Agent Plugins 1.0.0 §7.2.1).',
    'mcp.json/mcpServers/placeholderEnvKey/env key "${PLUGIN_ROOT}" contains an Agent Plugins placeholder, but expansion never applies to env keys (Agent Plugins 1.0.0 §9.2).',
    'mcp.json/mcpServers/placeholderUrl/url contains an Agent Plugins placeholder, but clients never expand placeholders in url (Agent Plugins 1.0.0 §7.2.1).',
    'mcp.json/mcpServers/plainHttp/url uses plain HTTP against non-loopback host "mcp.example.test"; non-loopback endpoints must use HTTPS (Agent Plugins 1.0.0 §7.2.1).',
    'mcp.json/mcpServers/relativeUrl/url must be an absolute HTTP or HTTPS URL (Agent Plugins 1.0.0 §7.2.1).',
    'mcp.json/mcpServers/userInfo/url must not contain user information (Agent Plugins 1.0.0 §7.2.1).',
  ]);
});

it('rejects every forbidden control character in HTTP header values while permitting horizontal tab', async () => {
  const root = await conformantBundle();
  const invalidValues: Record<string, string> = {
    'X-Bell': 'a\u0007b',
    'X-Cr': 'a\rb',
    'X-Del': 'a\u007fb',
    'X-Lf': 'a\nb',
    'X-Nul': 'a\u0000b',
    'X-Soh': 'a\u0001b',
    'X-Unicode': 'a\u2014b',
    'X-Vt': 'a\u000bb',
  };
  await writeJson(join(root, 'mcp.json'), {
    $schema: mcpSchema,
    mcpServers: {
      invalid: { headers: invalidValues, type: 'streamable-http', url: 'https://mcp.example.test/mcp' },
      valid: {
        headers: { 'X-ObsText': 'caf\u00e9', 'X-Tab': 'a\tb', 'X-Visible': 'Bearer token-1 ~' },
        type: 'streamable-http',
        url: 'https://mcp.example.test/mcp',
      },
    },
  });
  const diagnostics = await validatePortablePluginFiles({ pluginDirectory: root, target: 'portable' });

  expect(new Set(codes(diagnostics))).toEqual(new Set(['AB6036']));
  expect(messages(diagnostics)).toEqual(Object.keys(invalidValues).map((name) =>
    `mcp.json/mcpServers/invalid/headers/${name} is not a valid HTTP header field value: only visible ASCII, space, horizontal tab and obs-text bytes are allowed (Agent Plugins 1.0.0 §7.2.1).`));
});

it('reports fixed component locations of the wrong filesystem kind and skill directories without SKILL.md', async () => {
  const root = await conformantBundle();
  await rm(join(root, 'skills'), { recursive: true });
  await writeText(join(root, 'skills'), 'not a directory');
  await rm(join(root, 'mcp.json'));
  await mkdir(join(root, 'mcp.json'));
  const wrongKinds = await validatePortablePluginFiles({ pluginDirectory: root, target: 'portable' });
  expect(messages(wrongKinds)).toEqual([
    'mcp.json is present but does not resolve to a regular file (Agent Plugins 1.0.0 §6.2).',
    'skills is present but does not resolve to a directory (Agent Plugins 1.0.0 §6.2).',
  ]);
  expect(codes(wrongKinds)).toEqual(['AB6036', 'AB6036']);

  await rm(join(root, 'skills'));
  await rm(join(root, 'mcp.json'), { recursive: true });
  await mkdir(join(root, 'skills', 'empty'), { recursive: true });
  await mkdir(join(root, 'skills', 'nested', 'SKILL.md'), { recursive: true });
  await writeText(join(root, 'skills', 'README.md'), 'stray file, ignored by clients\n');
  await writeText(join(root, 'skills', 'summarize', 'SKILL.md'), '---\nname: summarize\ndescription: d\n---\nBody.\n');
  const skills = await validatePortablePluginFiles({ pluginDirectory: root, target: 'portable' });
  expect(skills).toEqual([
    expect.objectContaining({
      code: 'AB6036',
      message: 'skills/empty has no regular SKILL.md file, so clients skip it (Agent Plugins 1.0.0 §7.1).',
    }),
    expect.objectContaining({
      code: 'AB6036',
      message: 'skills/nested has no regular SKILL.md file, so clients skip it (Agent Plugins 1.0.0 §7.1).',
    }),
  ]);
});

it('rejects symlinks whose real target escapes the plugin root while accepting contained links', async () => {
  const root = await conformantBundle();
  const outside = await mkdtemp(join(tmpdir(), 'agent-bundle-portable-outside-'));
  roots.push(outside);
  await writeText(join(outside, 'secret.md'), 'outside\n');
  await symlink(join(root, 'skills', 'summarize', 'SKILL.md'), join(root, 'skills', 'summarize', 'ALIAS.md'));
  await symlink(join(outside, 'secret.md'), join(root, 'skills', 'summarize', 'references.md'));
  await symlink(join(outside, 'missing.md'), join(root, 'dangling.md'));

  const diagnostics = await validatePortablePluginFiles({ pluginDirectory: root, target: 'portable' });
  expect(diagnostics).toEqual([
    expect.objectContaining({
      code: 'AB6037',
      message: 'dangling.md is a symlink whose real target cannot be resolved inside the plugin root (Agent Plugins 1.0.0 §4.1).',
      severity: 'error',
    }),
    expect.objectContaining({
      code: 'AB6037',
      message: 'skills/summarize/references.md is a symlink whose real target escapes the plugin root (Agent Plugins 1.0.0 §4.1).',
      severity: 'error',
    }),
  ]);
  const report = await validatePortablePlugin({ pluginDirectory: root, target: 'portable' });
  expect(report.status).toBe('failed');
  expect(report.diagnostics.every((diagnostic) => typeof diagnostic.recovery === 'string')).toBe(true);
});
