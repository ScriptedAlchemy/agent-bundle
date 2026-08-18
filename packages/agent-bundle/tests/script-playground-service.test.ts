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
    executor: async (options) => {
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
    executor: async ({ signal }) => {
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

it('refuses script execution without an explicit contained executor', async () => {
  const service = new ScriptPlaygroundService({ resolveScript: async () => script });
  await expect(service.run({ epochId: 'epoch-server-owned', script: 'review.mjs', target: 'codex' })).rejects.toThrow('contained executor');
});
