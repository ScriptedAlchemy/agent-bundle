import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import {
  ScriptPlaygroundService,
  type ResolvedPlaygroundScript,
} from '../src/dev/script-playground-service.ts';

const script: ResolvedPlaygroundScript = Object.freeze({
  interpreter: Object.freeze({ args: Object.freeze([]), command: process.execPath }),
  name: 'review.mjs',
  path: '/validated/epoch/codex/scripts/review.mjs',
});

it('runs only a manifest-resolved script in a leased server workspace with a sanitized environment', async () => {
  const calls: unknown[] = [];
  let released = 0;
  const service = new ScriptPlaygroundService({
    createWorkspace: async () => Object.freeze({
      close: async () => { released += 1; },
      path: '/server-owned/workspace',
    }),
    execute: async (options) => {
      calls.push(options);
      return Object.freeze({ exitCode: 0, stderr: '', stdout: 'reviewed\n' });
    },
    resolveScript: async (request) => {
      calls.push(request);
      return script;
    },
  });

  await expect(service.run({ epochId: 'epoch-server-owned', script: 'review.mjs', target: 'codex' })).resolves.toEqual({
    exitCode: 0,
    script: 'review.mjs',
    stderr: '',
    stdout: 'reviewed\n',
  });
  expect(calls).toEqual([
    { epochId: 'epoch-server-owned', script: 'review.mjs', target: 'codex' },
    expect.objectContaining({
      args: ['/validated/epoch/codex/scripts/review.mjs'],
      command: process.execPath,
      cwd: '/server-owned/workspace',
      env: expect.objectContaining({ HOME: '/server-owned/workspace', PATH: expect.any(String) }),
      signal: undefined,
    }),
  ]);
  expect(released).toBe(1);
});

it('uses the caller AbortSignal for the real process and releases its workspace after cancellation', async () => {
  let released = 0;
  let observed: AbortSignal | undefined;
  let entered!: () => void;
  const enteredExecution = new Promise<void>((resolvePromise) => { entered = resolvePromise; });
  const service = new ScriptPlaygroundService({
    createWorkspace: async () => Object.freeze({
      close: async () => { released += 1; },
      path: '/server-owned/workspace',
    }),
    execute: async ({ signal }) => {
      observed = signal;
      entered();
      return new Promise((_, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }));
    },
    resolveScript: async () => script,
  });
  const controller = new AbortController();
  const running = service.run({ epochId: 'epoch-server-owned', script: 'review.mjs', signal: controller.signal, target: 'codex' });
  await enteredExecution;
  controller.abort(new Error('cancelled by run'));

  await expect(running).rejects.toThrow('cancelled by run');
  expect(observed).toBe(controller.signal);
  expect(released).toBe(1);
});

it('drains a daemonized descendant before its workspace lease is released', async () => {
  if (process.platform === 'win32') return;
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-script-tree-'));
  const scriptPath = join(root, 'daemon.sh');
  const pidPath = join(root, 'daemon.pid');
  const workspace = join(root, 'workspace');
  let released = 0;
  try {
    await mkdir(workspace);
    await writeFile(scriptPath, `sleep 30 & echo $! > ${JSON.stringify(pidPath)}\nexit 0\n`);
    const service = new ScriptPlaygroundService({
      createWorkspace: async () => Object.freeze({
        close: async () => {
          released += 1;
          const pid = Number((await readFile(pidPath, 'utf8')).trim());
          expect(() => process.kill(pid, 0)).toThrow();
        },
        path: workspace,
      }),
      resolveScript: async () => Object.freeze({ interpreter: Object.freeze({ args: Object.freeze([]), command: '/bin/sh' }), name: 'daemon.sh', path: scriptPath }),
    });
    await expect(service.run({ epochId: 'epoch-server-owned', script: 'daemon.sh', target: 'codex' })).resolves.toMatchObject({ exitCode: 0 });
    expect(released).toBe(1);
  } finally { await rm(root, { force: true, recursive: true }); }
});
