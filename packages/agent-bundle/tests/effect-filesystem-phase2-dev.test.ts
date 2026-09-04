import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Effect, FileSystem, Layer, Option } from 'effect';
import { afterEach, describe, expect, it } from '@rstest/core';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { McpSession } from '../src/dev/mcp-session/mcp-session.ts';
import { createDevPlatformRuntime, platformRunOf } from '../src/dev/platform-run.ts';
import type { DevPlatformRuntime } from '../src/dev/platform-runtime.ts';
import { ScriptPlaygroundService } from '../src/dev/playground/script-playground-service.ts';
import { createWorkbenchAssetSource } from '../src/dev/workbench-assets.ts';
import { platformLayer, runWithPlatform } from '../src/effect/platform.ts';
import { mcpCatalogStub, stdioTransportStub } from './support/mcp-client-stub.ts';

/**
 * Phase-2 FileSystem adoption, dev-server slice: every dev service takes a
 * `platformRuntime` handle (the dev server passes its one session runtime) and
 * the ordinary reads, temp directories, and removals run through its edge.
 * These tests pin the seam with `FileSystem.layerNoop` runtimes and the OS
 * semantics with real directories.
 */
const roots: string[] = [];
const scratch = async (prefix: string): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

const runtimes: DevPlatformRuntime[] = [];

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.close()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

/**
 * A session runtime whose `FileSystem` is the given stub; every other platform
 * service is real (`Context.mergeAll` keeps the later layer's service).
 */
const noopRuntime = (fileSystem: Layer.Layer<FileSystem.FileSystem>): DevPlatformRuntime => {
  const runtime = createDevPlatformRuntime(Layer.mergeAll(platformLayer, fileSystem));
  runtimes.push(runtime);
  return runtime;
};

const fileInfo = (size: number): FileSystem.File.Info => ({
  atime: Option.none(),
  birthtime: Option.none(),
  blksize: Option.none(),
  blocks: Option.none(),
  dev: 0,
  gid: Option.none(),
  ino: Option.none(),
  mode: 0o100644,
  mtime: Option.none(),
  nlink: Option.none(),
  rdev: Option.none(),
  size: FileSystem.Size(size),
  type: 'File',
  uid: Option.none(),
});

describe('workbench assets over the session runtime', () => {
  it('resolves the root once and reads a contained asset through the given runner', async () => {
    const calls: string[] = [];
    const body = Buffer.from('body { color: red }');
    const run = noopRuntime(FileSystem.layerNoop({
      readFile: (path) => Effect.sync(() => {
        calls.push(`readFile ${path}`);
        return new Uint8Array(body);
      }),
      realPath: (path) => Effect.sync(() => {
        calls.push(`realPath ${path}`);
        return path;
      }),
      stat: (path) => Effect.sync(() => {
        calls.push(`stat ${path}`);
        return fileInfo(body.byteLength);
      }),
    }));
    const assets = createWorkbenchAssetSource({ root: '/srv/workbench', platformRuntime: run });
    const first = await assets.read('styles/app.css');
    expect(first).toEqual({ body, contentType: 'text/css; charset=utf-8' });
    expect(await assets.read('styles/app.css')).toBe(first);
    expect(await assets.read('../escape.css')).toBeUndefined();
    expect(calls).toEqual([
      'realPath /srv/workbench',
      'realPath /srv/workbench/styles/app.css',
      'stat /srv/workbench/styles/app.css',
      'readFile /srv/workbench/styles/app.css',
    ]);
  });

  it('treats a missing root or asset as a miss, exactly like the former ENOENT catch', async () => {
    const root = await scratch('agent-bundle-fs-phase2-assets-');
    await writeFile(join(root, 'index.html'), '<!doctype html>');
    const assets = createWorkbenchAssetSource({ root });
    expect(await assets.read('missing.js')).toBeUndefined();
    expect((await assets.read('index.html'))?.body).toEqual(Buffer.from('<!doctype html>'));
    const missingRoot = createWorkbenchAssetSource({ root: join(root, 'absent') });
    expect(await missingRoot.read('index.html')).toBeUndefined();
  });
});

describe('script playground workspace lease', () => {
  const temporaryScript = async (source: string): Promise<string> => {
    const root = await scratch('agent-bundle-fs-phase2-script-');
    const path = join(root, 'review.mjs');
    await writeFile(path, source);
    return path;
  };
  const request = { epochId: 'epoch-server-owned', scriptId: 'script:review', target: 'codex' } as unknown as Parameters<ScriptPlaygroundService['run']>[0];

  it('creates the workspace and removes it through the runner as separate steps', async () => {
    const script = await temporaryScript('process.stdout.write(process.cwd());\n');
    const workspace = await scratch('agent-bundle-fs-phase2-workspace-');
    const calls: string[] = [];
    const run = noopRuntime(FileSystem.layerNoop({
      makeTempDirectory: (options) => Effect.sync(() => {
        calls.push(`makeTempDirectory ${options?.directory ?? ''} ${options?.prefix ?? ''}`);
        return workspace;
      }),
      remove: (path, options) => Effect.sync(() => {
        calls.push(`remove ${path} ${String(options?.recursive)} ${String(options?.force)}`);
      }),
    }));
    const service = new ScriptPlaygroundService({
      resolveScript: async () => Object.freeze({
        interpreter: Object.freeze({ args: Object.freeze([]), command: process.execPath }),
        name: 'review',
        path: script,
      }),
      platformRuntime: run,
    });
    await expect(service.run(request)).resolves.toMatchObject({ exitCode: 0, stdout: workspace });
    expect(calls).toEqual([
      `makeTempDirectory ${tmpdir()} agent-bundle-playground-script-`,
      `remove ${workspace} true true`,
    ]);
  });

  it('reports a failed workspace removal in the result instead of replacing the script outcome', async () => {
    const script = await temporaryScript('process.stdout.write("ok");\n');
    const workspace = await scratch('agent-bundle-fs-phase2-workspace-');
    const run = noopRuntime(FileSystem.layerNoop({
      makeTempDirectory: () => Effect.succeed(workspace),
      remove: () => Effect.die(new Error('workspace removal failed')),
    }));
    const service = new ScriptPlaygroundService({
      resolveScript: async () => Object.freeze({
        interpreter: Object.freeze({ args: Object.freeze([]), command: process.execPath }),
        name: 'review',
        path: script,
      }),
      platformRuntime: run,
    });
    await expect(service.run(request)).resolves.toMatchObject({
      cleanupFailures: [{ code: 'workspace-release-failed' }],
      exitCode: 0,
      stdout: 'ok',
    });
  });

  it('removes a real workspace on the default runner', async () => {
    const script = await temporaryScript('process.stdout.write(process.cwd());\n');
    const service = new ScriptPlaygroundService({
      resolveScript: async () => Object.freeze({
        interpreter: Object.freeze({ args: Object.freeze([]), command: process.execPath }),
        name: 'review',
        path: script,
      }),
    });
    const result = await service.run(request);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.startsWith(join(tmpdir(), 'agent-bundle-playground-script-'))).toBe(true);
    await expect(access(result.stdout)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('MCP session plugin-data release', () => {
  const sessionFor = (pluginData: string, releasePluginData?: () => Promise<void>): McpSession => new McpSession({
    binding: { epochId: 'epoch-release', serverName: 'fixture', target: 'portable' },
    createClient: () => ({
      callTool: async () => ({ content: [] }),
      close: async () => undefined,
      connect: async () => undefined,
      ...mcpCatalogStub(),
    }),
    createStdioTransport: () => stdioTransportStub() as never,
    createStreamableHttpTransport: () => ({}) as never,
    epochReference: { close: async () => undefined, root: '/tmp/agent-bundle-fs-phase2-epoch' } as never,
    id: 'session-release',
    onClose: () => undefined,
    pluginData,
    ...(releasePluginData === undefined ? {} : { releasePluginData }),
    resolved: {
      runtime: createDefaultRegistry().mcpRuntime('portable')!,
      server: { args: [], command: 'node', kind: 'stdio' },
      target: 'portable',
      targetRoot: '/tmp/agent-bundle-fs-phase2-epoch/portable',
    },
    workspaceRoot: '/tmp/agent-bundle-fs-phase2-workspace',
  });

  it('removes the directory on close by default, through the platform layer', async () => {
    const pluginData = await scratch('agent-bundle-fs-phase2-plugin-data-');
    const session = sessionFor(pluginData);
    await session.close();
    await expect(access(pluginData)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('runs the service-owned release exactly once and reports its failure from close', async () => {
    let releases = 0;
    const failure = new Error('scope close failed');
    const session = sessionFor('/tmp/agent-bundle-fs-phase2-unowned', async () => {
      releases += 1;
      throw failure;
    });
    await expect(session.close()).rejects.toBe(failure);
    await expect(session.close()).rejects.toBe(failure);
    expect(releases).toBe(1);
  });
});

describe('platformRunOf', () => {
  it('resolves a session runtime to its edge and rejects a foreign handle', async () => {
    const runtime = noopRuntime(FileSystem.layerNoop({ readFileString: () => Effect.succeed('stubbed') }));
    await expect(platformRunOf(runtime)(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString('/any')))).resolves.toBe('stubbed');
    expect(platformRunOf(undefined)).toBe(runWithPlatform);
    expect(() => platformRunOf({ close: async () => undefined })).toThrow(TypeError);
  });

  it('unwraps PlatformError to the Node cause on the session runtime, like runWithPlatform', async () => {
    const root = await scratch('agent-bundle-fs-phase2-errno-');
    const runtime = createDevPlatformRuntime();
    runtimes.push(runtime);
    await expect(platformRunOf(runtime)(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(join(root, 'absent')))))
      .rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('runWithPlatform stays the default edge', () => {
  it('reads through the shared layer when no runtime is given', async () => {
    const root = await scratch('agent-bundle-fs-phase2-default-');
    await writeFile(join(root, 'a.txt'), 'a');
    const text = await runWithPlatform(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(join(root, 'a.txt'))));
    expect(text).toBe(await readFile(join(root, 'a.txt'), 'utf8'));
  });
});
