import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { normalizeProject } from '../src/config/normalize.ts';
import { validateModel, validateSource } from '../src/config/validate.ts';
import {
  pathTokens,
  type AgentBundleConfig,
  type AgentBundleMcpServer,
  type NormalizationTargetRegistry,
} from '../src/core/types.ts';
import type { LoadedConfig } from '../src/config/load.ts';

const registry: NormalizationTargetRegistry = {
  defaultTargetNames: () => ['portable'],
  has: (name) => ['portable', 'codex', 'claude'].includes(name),
  supports: () => true,
};

const loadedProject = (root: string, config: AgentBundleConfig): LoadedConfig => ({
  config,
  configPath: join(root, 'agent-bundle.config.ts'),
  context: {
    command: 'build',
    mode: 'production',
    projectRoot: root,
    selectedTargets: [],
  },
});

it('normalizes local, prebuilt, HTTP, and SSE MCP server declarations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-'));
  try {
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'answer.ts'), 'export const answer = 42;\n');
    await writeFile(
      join(root, 'src', 'local server.ts'),
      'import { answer } from "./answer.ts";\nconsole.error(answer);\n',
    );
    const servers = Object.create(null) as Record<string, AgentBundleMcpServer>;
    Object.assign(servers, {
      'local server': {
        args: ['--author-flag', pathTokens.pluginData],
        entry: './src/local server.ts',
        env: { WORKSPACE: pathTokens.workspaceRoot },
        targets: ['claude', 'portable', 'claude'],
      },
      prebuilt: {
        args: ['serve'],
        command: 'example-server',
        cwd: './tools',
        env: { MODE: 'test' },
      },
      'remote-http': {
        headers: { Authorization: 'Bearer literal' },
        transport: 'streamable-http',
        url: 'https://mcp.example.test/http',
      },
      'remote-sse': {
        headers: { 'X-Mode': 'events' },
        transport: 'sse',
        url: 'https://mcp.example.test/sse',
      },
    });
    Object.defineProperty(servers, '__proto__', {
      enumerable: true,
      value: { command: 'prototype-safe' },
    });

    const model = await normalizeProject(
      loadedProject(root, {
        mcp: { servers },
        plugin: { name: 'mcp-fixture', version: '1.0.0' },
        targets: ['portable', 'codex', 'claude'],
      }),
      { skills: [] },
      registry,
    );

    expect(model.mcpServers).toEqual([
      {
        command: 'prototype-safe',
        id: 'mcp:__proto__',
        name: '__proto__',
        provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
        targets: ['claude', 'codex', 'portable'],
        transport: 'stdio',
      },
      {
        args: ['mcp/mcp-local-server-f45eb99f.mjs', '--author-flag', pathTokens.pluginData],
        command: 'node',
        cwd: pathTokens.pluginRoot,
        env: { WORKSPACE: pathTokens.workspaceRoot },
        id: 'mcp:local server',
        name: 'local server',
        provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
        source: join(root, 'src', 'local server.ts'),
        targets: ['claude', 'portable'],
        transport: 'stdio',
      },
      {
        args: ['serve'],
        command: 'example-server',
        cwd: './tools',
        env: { MODE: 'test' },
        id: 'mcp:prebuilt',
        name: 'prebuilt',
        provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
        targets: ['claude', 'codex', 'portable'],
        transport: 'stdio',
      },
      {
        id: 'mcp:remote-http',
        headers: { Authorization: 'Bearer literal' },
        name: 'remote-http',
        provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
        targets: ['claude', 'codex', 'portable'],
        transport: 'streamable-http',
        url: 'https://mcp.example.test/http',
      },
      {
        headers: { 'X-Mode': 'events' },
        id: 'mcp:remote-sse',
        name: 'remote-sse',
        provenance: { kind: 'config', sourcePath: join(root, 'agent-bundle.config.ts') },
        targets: ['claude', 'codex', 'portable'],
        transport: 'sse',
        url: 'https://mcp.example.test/sse',
      },
    ]);
    expect(Object.isFrozen(model.mcpServers)).toBe(true);
    expect(Object.isFrozen(model.mcpServers[0])).toBe(true);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

it('keeps local MCP server identities and output aliases independent of the project root', async () => {
  const left = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-left-'));
  const right = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-right-'));
  try {
    for (const root of [left, right]) {
      await mkdir(join(root, 'src'), { recursive: true });
      await writeFile(join(root, 'src', 'server.ts'), 'export {};\n');
    }
    const config: AgentBundleConfig = {
      mcp: { servers: { 'same server': { entry: './src/server.ts' } } },
      plugin: { name: 'mcp-fixture', version: '1.0.0' },
    };
    const [leftModel, rightModel] = await Promise.all([left, right].map((root) =>
      normalizeProject(loadedProject(root, config), { skills: [] }, registry)));

    expect(leftModel.mcpServers[0]).toMatchObject({
      args: ['mcp/mcp-same-server-bb8870fe.mjs'],
      id: 'mcp:same server',
      source: join(left, 'src', 'server.ts'),
    });
    expect(rightModel.mcpServers[0]).toMatchObject({
      args: ['mcp/mcp-same-server-bb8870fe.mjs'],
      id: 'mcp:same server',
      source: join(right, 'src', 'server.ts'),
    });
  } finally {
    await Promise.all([rm(left, { force: true, recursive: true }), rm(right, { force: true, recursive: true })]);
  }
});

it('reports source and model diagnostics before an MCP server can be compiled', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-mcp-invalid-'));
  try {
    const config = {
      mcp: {
        servers: {
          '': { command: 'ignored' },
          ambiguous: { command: 'server', entry: './missing.ts' },
          'bad command': { command: '' },
          'bad remote': { transport: 'streamable-http', url: 'not a URL' },
          'missing entry': { entry: './missing.ts' },
          'remote options': {
            args: ['not-supported'],
            transport: 'sse',
            url: 'https://mcp.example.test/events',
          },
          'unknown target': { command: 'server', targets: ['unknown'] },
        },
      },
      plugin: { name: 'mcp-fixture', version: '1.0.0' },
    } satisfies AgentBundleConfig;
    const loaded = loadedProject(root, config);

    expect(validateSource(loaded, { skills: [] }).map(({ code }) => code)).toEqual([
      'AB4302',
      'AB4304',
      'AB4313',
      'AB4316',
      'AB4307',
      'AB4318',
    ]);

    const normalized = await normalizeProject(
      loadedProject(root, {
        mcp: { servers: { unsafe: { command: 'server', targets: ['unknown'] } } },
        plugin: config.plugin,
      }),
      { skills: [] },
      registry,
    );
    expect(validateModel(normalized, registry)).toMatchObject([
      { code: 'AB4320', target: 'unknown' },
    ]);
    const unsafe = {
      ...normalized,
      mcpServers: [{
        ...normalized.mcpServers[0]!,
        args: ['../escaped.mjs'],
        source: join(root, 'src', 'server.ts'),
      }],
    };
    expect(validateModel(unsafe, registry)).toMatchObject([
      { code: 'AB4320', target: 'unknown' },
      { code: 'AB4321' },
    ]);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
