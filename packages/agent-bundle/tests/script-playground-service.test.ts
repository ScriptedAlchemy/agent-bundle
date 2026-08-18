import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { ScriptPlaygroundService } from '../src/dev/script-playground-service.ts';

const temporaryScript = async (source: string): Promise<Readonly<{ readonly close: () => Promise<void>; readonly path: string }>> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-script-playground-test-'));
  const path = join(root, 'review.mjs');
  await writeFile(path, source);
  return Object.freeze({ close: () => rm(root, { force: true, recursive: true }), path });
};

const eventually = async (assertion: () => Promise<void> | void): Promise<void> => {
  let failure: unknown;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      failure = error;
      await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 10); });
    }
  }
  throw failure;
};

it('runs a server-resolved emitted script with stdout, stderr, and a nonzero exit', async () => {
  const emitted = await temporaryScript([
    "process.stdout.write('review stdout\\n');",
    "process.stderr.write('review stderr\\n');",
    'process.exitCode = 17;',
    '',
  ].join('\n'));
  try {
    const service = new ScriptPlaygroundService({
      resolveScript: async () => Object.freeze({
        interpreter: Object.freeze({ args: Object.freeze([]), command: process.execPath }),
        name: 'review',
        path: emitted.path,
      }),
    });

    await expect(service.run({
      epochId: 'epoch-server-owned',
      scriptId: 'script:review',
      target: 'codex',
    } as unknown as Parameters<typeof service.run>[0])).resolves.toEqual({
      exitCode: 17,
      script: 'review',
      stderr: 'review stderr\n',
      stdout: 'review stdout\n',
    });
  } finally {
    await emitted.close();
  }
});

it('uses a fresh server-owned workspace and deletes it only after the child exits', async () => {
  const emitted = await temporaryScript("process.stdout.write(`${process.cwd()}|${process.env.HOME}\\n`);\n");
  const workspace = await mkdtemp(join(tmpdir(), 'agent-bundle-script-workspace-test-'));
  let closed = false;
  try {
    const service = new ScriptPlaygroundService({
      createWorkspace: async () => Object.freeze({
        close: async () => { closed = true; await rm(workspace, { force: true, recursive: true }); },
        path: workspace,
      }),
      resolveScript: async () => Object.freeze({
        interpreter: Object.freeze({ args: Object.freeze([]), command: process.execPath }),
        name: 'review',
        path: emitted.path,
      }),
    });

    await expect(service.run({
      epochId: 'epoch-server-owned', scriptId: 'script:review', target: 'codex',
    } as unknown as Parameters<typeof service.run>[0])).resolves.toMatchObject({
      exitCode: 0,
      stdout: `${workspace}|${workspace}\n`,
    });
    expect(closed).toBe(true);
    await expect(readFile(workspace)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await Promise.allSettled([emitted.close(), rm(workspace, { force: true, recursive: true })]);
  }
});

it('terminates a script after the combined stdout and stderr cap is exceeded', async () => {
  const emitted = await temporaryScript("process.stdout.write('x'.repeat(512));\nsetInterval(() => undefined, 1_000);\n");
  try {
    const service = new ScriptPlaygroundService({
      outputLimit: 128,
      resolveScript: async () => Object.freeze({
        interpreter: Object.freeze({ args: Object.freeze([]), command: process.execPath }), name: 'review', path: emitted.path,
      }),
    });
    await expect(service.run({
      epochId: 'epoch-server-owned', scriptId: 'script:review', target: 'codex',
    } as unknown as Parameters<typeof service.run>[0])).rejects.toThrow('Script execution output exceeded the configured limit.');
  } finally { await emitted.close(); }
}, 10_000);

it('terminates a script that exceeds its server-owned timeout', async () => {
  const emitted = await temporaryScript('setInterval(() => undefined, 1_000);\n');
  try {
    const service = new ScriptPlaygroundService({
      resolveScript: async () => Object.freeze({
        interpreter: Object.freeze({ args: Object.freeze([]), command: process.execPath }), name: 'review', path: emitted.path,
      }),
      timeoutMs: 25,
    });
    await expect(service.run({
      epochId: 'epoch-server-owned', scriptId: 'script:review', target: 'codex',
    } as unknown as Parameters<typeof service.run>[0])).rejects.toThrow('Script execution timed out.');
  } finally { await emitted.close(); }
}, 10_000);

it('cancels and drains the emitted script process group before its workspace is released', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-script-playground-tree-'));
  const pidPath = join(root, 'descendant.pid');
  const emitted = await temporaryScript([
    "import { spawn } from 'node:child_process';",
    "import { writeFile } from 'node:fs/promises';",
    `const descendant = spawn(process.execPath, ['--eval', 'setInterval(() => undefined, 1_000)'], { stdio: 'ignore' });`,
    `await writeFile(${JSON.stringify(pidPath)}, String(descendant.pid));`,
    'setInterval(() => undefined, 1_000);',
    '',
  ].join('\n'));
  const workspace = await mkdtemp(join(tmpdir(), 'agent-bundle-script-workspace-tree-'));
  let workspaceClosed = false;
  try {
    const service = new ScriptPlaygroundService({
      createWorkspace: async () => Object.freeze({
        close: async () => { workspaceClosed = true; await rm(workspace, { force: true, recursive: true }); }, path: workspace,
      }),
      resolveScript: async () => Object.freeze({
        interpreter: Object.freeze({ args: Object.freeze([]), command: process.execPath }), name: 'review', path: emitted.path,
      }),
    });
    const controller = new AbortController();
    const running = service.run({
      epochId: 'epoch-server-owned', scriptId: 'script:review', signal: controller.signal, target: 'codex',
    } as unknown as Parameters<typeof service.run>[0]);
    await expect(Promise.race([
      running.then(() => 'settled' as const),
      new Promise<'running'>((resolvePromise) => { setTimeout(() => resolvePromise('running'), 25); }),
    ])).resolves.toBe('running');
    await eventually(async () => { await readFile(pidPath); });
    const descendant = Number(await readFile(pidPath, 'utf8'));
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(workspaceClosed).toBe(true);
    await eventually(() => expect(() => process.kill(descendant, 0)).toThrow());
  } finally {
    await Promise.allSettled([emitted.close(), rm(root, { force: true, recursive: true }), rm(workspace, { force: true, recursive: true })]);
  }
}, 10_000);
