import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from '@rstest/core';

import { ScriptPlaygroundService } from '../src/dev/playground/script-playground-service.ts';

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

const deferred = <Value,>() => {
  let resolvePromise!: (value: Value) => void;
  const promise = new Promise<Value>((resolve) => { resolvePromise = resolve; });
  return Object.freeze({ promise, resolve: resolvePromise });
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

it('preserves a successful script result when workspace release fails', async () => {
  const emitted = await temporaryScript("process.stdout.write('completed');\n");
  const workspace = await mkdtemp(join(tmpdir(), 'agent-bundle-script-workspace-release-success-'));
  try {
    const service = new ScriptPlaygroundService({
      createWorkspace: async () => Object.freeze({
        close: async () => { throw new Error('workspace release failed'); },
        path: workspace,
      }),
      releaseEpochReference: async () => { throw new Error('epoch release failed'); },
      resolveScript: async () => Object.freeze({
        interpreter: Object.freeze({ args: Object.freeze([]), command: process.execPath }), name: 'review', path: emitted.path,
      }),
    });

    await expect(service.run({
      epochId: 'epoch-server-owned', scriptId: 'script:review', target: 'codex',
    } as unknown as Parameters<typeof service.run>[0])).resolves.toMatchObject({
      cleanupFailures: [
        { code: 'workspace-release-failed' },
        { code: 'epoch-release-failed' },
      ],
      exitCode: 0,
      stdout: 'completed',
    });
  } finally {
    await Promise.allSettled([emitted.close(), rm(workspace, { force: true, recursive: true })]);
  }
});

it('preserves timeout and cancellation identity when workspace release fails', async () => {
  const emitted = await temporaryScript('setInterval(() => undefined, 1_000);\n');
  const workspace = await mkdtemp(join(tmpdir(), 'agent-bundle-script-workspace-release-failure-'));
  const createWorkspace = async () => Object.freeze({
    close: async () => { throw new Error('workspace release failed'); },
    path: workspace,
  });
  try {
    const timeoutService = new ScriptPlaygroundService({
      createWorkspace,
      releaseEpochReference: async () => { throw new Error('epoch release failed'); },
      resolveScript: async () => Object.freeze({
        interpreter: Object.freeze({ args: Object.freeze([]), command: process.execPath }), name: 'review', path: emitted.path,
      }),
      timeoutMs: 100,
    });
    await expect(timeoutService.run({
      epochId: 'epoch-server-owned', scriptId: 'script:review', target: 'codex',
    } as unknown as Parameters<typeof timeoutService.run>[0])).rejects.toMatchObject({
      cleanupFailures: [
        { code: 'workspace-release-failed' },
        { code: 'epoch-release-failed' },
      ],
      code: 'timeout',
    });

    const cancellationService = new ScriptPlaygroundService({
      createWorkspace,
      releaseEpochReference: async () => { throw new Error('epoch release failed'); },
      resolveScript: async () => Object.freeze({
        interpreter: Object.freeze({ args: Object.freeze([]), command: process.execPath }), name: 'review', path: emitted.path,
      }),
    });
    const controller = new AbortController();
    const cancelled = cancellationService.run({
      epochId: 'epoch-server-owned', scriptId: 'script:review', signal: controller.signal, target: 'codex',
    } as unknown as Parameters<typeof cancellationService.run>[0]);
    await expect(Promise.race([
      cancelled.then(() => 'settled' as const, () => 'settled' as const),
      new Promise<'running'>((resolvePromise) => { setTimeout(() => resolvePromise('running'), 25); }),
    ])).resolves.toBe('running');
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({
      cleanupFailures: [
        { code: 'workspace-release-failed' },
        { code: 'epoch-release-failed' },
      ],
      name: 'AbortError',
    });
  } finally {
    await Promise.allSettled([emitted.close(), rm(workspace, { force: true, recursive: true })]);
  }
}, 10_000);

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
    } as unknown as Parameters<typeof service.run>[0])).rejects.toMatchObject({
      code: 'output-limit',
      message: 'Script execution output exceeded the configured limit.',
      stderr: '',
      stdout: 'x'.repeat(128),
    });
  } finally { await emitted.close(); }
}, 10_000);

it('terminates a script that exceeds its server-owned timeout with partial evidence', async () => {
  const emitted = await temporaryScript("process.stdout.write('before timeout'); process.stderr.write('timeout stderr'); setInterval(() => undefined, 1_000);\n");
  try {
    const service = new ScriptPlaygroundService({
      resolveScript: async () => Object.freeze({
        interpreter: Object.freeze({ args: Object.freeze([]), command: process.execPath }), name: 'review', path: emitted.path,
      }),
      timeoutMs: 250,
    });
    await expect(service.run({
      epochId: 'epoch-server-owned', scriptId: 'script:review', target: 'codex',
    } as unknown as Parameters<typeof service.run>[0])).rejects.toMatchObject({
      code: 'timeout',
      message: 'Script execution timed out.',
      stderr: 'timeout stderr',
      stdout: 'before timeout',
    });
  } finally { await emitted.close(); }
}, 10_000);

it('does not settle cancellation until its final process-tree cleanup attempt completes', async () => {
  const emitted = await temporaryScript('setInterval(() => undefined, 1_000);\n');
  const finalCleanup = deferred<void>();
  const finalCleanupStarted = deferred<void>();
  try {
    const service = new ScriptPlaygroundService({
      processTree: Object.freeze({
        terminate: async (child: ChildProcess, signal: NodeJS.Signals) => {
          if (signal === 'SIGTERM') {
            child.kill(signal);
            return true;
          }
          finalCleanupStarted.resolve();
          await finalCleanup.promise;
          return true;
        },
        waitForExit: async () => true,
      }),
      resolveScript: async () => Object.freeze({
        interpreter: Object.freeze({ args: Object.freeze([]), command: process.execPath }), name: 'review', path: emitted.path,
      }),
    } as unknown as ConstructorParameters<typeof ScriptPlaygroundService>[0]);
    const controller = new AbortController();
    const running = service.run({
      epochId: 'epoch-server-owned', scriptId: 'script:review', signal: controller.signal, target: 'codex',
    } as unknown as Parameters<typeof service.run>[0]);
    await expect(Promise.race([
      running.then(() => 'settled' as const, () => 'settled' as const),
      new Promise<'running'>((resolvePromise) => { setTimeout(() => resolvePromise('running'), 25); }),
    ])).resolves.toBe('running');
    controller.abort();

    await expect(Promise.race([
      finalCleanupStarted.promise.then(() => 'cleanup' as const),
      running.then(() => 'settled' as const, () => 'settled' as const),
    ])).resolves.toBe('cleanup');
    await new Promise<void>((resolvePromise) => { setTimeout(resolvePromise, 300); });
    await expect(Promise.race([
      running.then(() => 'settled' as const, () => 'settled' as const),
      new Promise<'pending'>((resolvePromise) => { setTimeout(() => resolvePromise('pending'), 25); }),
    ])).resolves.toBe('pending');
    finalCleanup.resolve();
    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
  } finally {
    finalCleanup.resolve();
    await emitted.close();
  }
}, 10_000);

it('reports a stable cleanup failure when Windows taskkill cannot finish', async () => {
  const emitted = await temporaryScript('setInterval(() => undefined, 1_000);\n');
  let taskkillCalls = 0;
  try {
    const service = new ScriptPlaygroundService({
      platform: 'win32',
      resolveScript: async () => Object.freeze({
        interpreter: Object.freeze({ args: Object.freeze([]), command: process.execPath }), name: 'review', path: emitted.path,
      }),
      taskkill: () => {
        taskkillCalls += 1;
        const command = new EventEmitter() as ChildProcess;
        setImmediate(() => { command.emit('close', 1); });
        return command;
      },
      timeoutMs: 25,
    } as unknown as ConstructorParameters<typeof ScriptPlaygroundService>[0]);

    await expect(service.run({
      epochId: 'epoch-server-owned', scriptId: 'script:review', target: 'codex',
    } as unknown as Parameters<typeof service.run>[0])).rejects.toMatchObject({
      code: 'cleanup-failed',
      message: 'Script process tree cleanup could not be confirmed.',
    });
    expect(taskkillCalls).toBeGreaterThan(0);
  } finally { await emitted.close(); }
}, 10_000);

it('accepts an already-absent final Windows taskkill after successful TERM cleanup', async () => {
  const emitted = await temporaryScript('setInterval(() => undefined, 1_000);\n');
  let taskkillCalls = 0;
  try {
    const service = new ScriptPlaygroundService({
      platform: 'win32',
      resolveScript: async () => Object.freeze({
        interpreter: Object.freeze({ args: Object.freeze([]), command: process.execPath }), name: 'review', path: emitted.path,
      }),
      taskkill: (arguments_) => {
        taskkillCalls += 1;
        if (taskkillCalls === 1) process.kill(Number(arguments_[1]), 'SIGTERM');
        const command = new EventEmitter() as ChildProcess;
        setImmediate(() => { command.emit('close', taskkillCalls === 1 ? 0 : 1); });
        return command;
      },
      timeoutMs: 25,
    });

    await expect(service.run({
      epochId: 'epoch-server-owned', scriptId: 'script:review', target: 'codex',
    } as unknown as Parameters<typeof service.run>[0])).rejects.toMatchObject({ code: 'timeout' });
    expect(taskkillCalls).toBe(2);
  } finally { await emitted.close(); }
}, 10_000);

it('accepts forced Windows cleanup after a failed TERM taskkill', async () => {
  const emitted = await temporaryScript('setInterval(() => undefined, 1_000);\n');
  let taskkillCalls = 0;
  try {
    const service = new ScriptPlaygroundService({
      platform: 'win32',
      resolveScript: async () => Object.freeze({
        interpreter: Object.freeze({ args: Object.freeze([]), command: process.execPath }), name: 'review', path: emitted.path,
      }),
      taskkill: () => {
        taskkillCalls += 1;
        const command = new EventEmitter() as ChildProcess;
        setImmediate(() => { command.emit('close', taskkillCalls === 1 ? 1 : 0); });
        return command;
      },
      timeoutMs: 25,
    });

    await expect(service.run({
      epochId: 'epoch-server-owned', scriptId: 'script:review', target: 'codex',
    } as unknown as Parameters<typeof service.run>[0])).rejects.toMatchObject({ code: 'timeout' });
    expect(taskkillCalls).toBe(2);
  } finally { await emitted.close(); }
}, 10_000);

it('bounds a stalled Windows taskkill attempt as a stable cleanup failure', async () => {
  const emitted = await temporaryScript('setInterval(() => undefined, 1_000);\n');
  try {
    const service = new ScriptPlaygroundService({
      platform: 'win32',
      resolveScript: async () => Object.freeze({
        interpreter: Object.freeze({ args: Object.freeze([]), command: process.execPath }), name: 'review', path: emitted.path,
      }),
      taskkill: () => new EventEmitter() as ChildProcess,
      timeoutMs: 25,
    });

    await expect(service.run({
      epochId: 'epoch-server-owned', scriptId: 'script:review', target: 'codex',
    } as unknown as Parameters<typeof service.run>[0])).rejects.toMatchObject({
      code: 'cleanup-failed',
      message: 'Script process tree cleanup could not be confirmed.',
    });
  } finally { await emitted.close(); }
}, 10_000);

it('reports a stable interpreter-unavailable failure without exposing a command path', async () => {
  const service = new ScriptPlaygroundService({
    resolveScript: async () => Object.freeze({
      interpreter: Object.freeze({ args: Object.freeze([]), command: join(tmpdir(), 'agent-bundle-missing-script-interpreter') }),
      name: 'review',
      path: join(tmpdir(), 'agent-bundle-unreached-script.mjs'),
    }),
  });

  await expect(service.run({
    epochId: 'epoch-server-owned', scriptId: 'script:review', target: 'codex',
  } as unknown as Parameters<typeof service.run>[0])).rejects.toMatchObject({
    code: 'interpreter-unavailable',
    message: 'Script interpreter is not available.',
    stderr: '',
    stdout: '',
  });
});

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
    expect(() => process.kill(descendant, 0)).toThrow();
  } finally {
    await Promise.allSettled([emitted.close(), rm(root, { force: true, recursive: true }), rm(workspace, { force: true, recursive: true })]);
  }
}, 10_000);

it('keeps SIGKILL process-group cleanup alive after the direct child closes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-script-playground-stubborn-tree-'));
  const pidPath = join(root, 'descendant.pid');
  const readyPath = join(root, 'descendant-ready');
  const descendantProgram = "require('node:fs').writeFileSync(" + JSON.stringify(readyPath) + ", 'ready'); process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1_000);";
  const emitted = await temporaryScript([
    "import { spawn } from 'node:child_process';",
    "import { writeFile } from 'node:fs/promises';",
    'const descendant = spawn(process.execPath, [\'--eval\', ' + JSON.stringify(descendantProgram) + '], { stdio: \'ignore\' });',
    'await writeFile(' + JSON.stringify(pidPath) + ', String(descendant.pid));',
    'setInterval(() => undefined, 1_000);',
    '',
  ].join('\n'));
  let descendant: number | undefined;
  try {
    const service = new ScriptPlaygroundService({
      resolveScript: async () => Object.freeze({
        interpreter: Object.freeze({ args: Object.freeze([]), command: process.execPath }), name: 'review', path: emitted.path,
      }),
    });
    const controller = new AbortController();
    const running = service.run({
      epochId: 'epoch-server-owned', scriptId: 'script:review', signal: controller.signal, target: 'codex',
    } as unknown as Parameters<typeof service.run>[0]);
    await eventually(async () => { await readFile(pidPath); });
    descendant = Number(await readFile(pidPath, 'utf8'));
    await eventually(async () => { await readFile(readyPath); });
    controller.abort();

    await expect(running).rejects.toMatchObject({ name: 'AbortError' });
    expect(() => process.kill(descendant!, 0)).toThrow();
  } finally {
    if (descendant !== undefined) {
      try { process.kill(descendant, 'SIGKILL'); }
      catch { /* The cleanup contract already terminated it. */ }
    }
    await Promise.allSettled([emitted.close(), rm(root, { force: true, recursive: true })]);
  }
}, 10_000);

const assertStubbornDescendantIsGoneAtSettlement = async (
  trigger: 'output-limit' | 'timeout',
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'agent-bundle-script-playground-stubborn-tree-'));
  const pidPath = join(root, 'descendant.pid');
  const readyPath = join(root, 'descendant-ready');
  const descendantProgram = "require('node:fs').writeFileSync(" + JSON.stringify(readyPath) + ", 'ready'); process.on('SIGTERM', () => undefined); setInterval(() => undefined, 1_000);";
  const emitted = await temporaryScript([
    "import { spawn } from 'node:child_process';",
    "import { readFile, writeFile } from 'node:fs/promises';",
    'const descendant = spawn(process.execPath, [\'--eval\', ' + JSON.stringify(descendantProgram) + '], { stdio: \'ignore\' });',
    'await writeFile(' + JSON.stringify(pidPath) + ', String(descendant.pid));',
    'while (true) { try { await readFile(' + JSON.stringify(readyPath) + '); break; } catch { await new Promise((resolvePromise) => setTimeout(resolvePromise, 1)); } }',
    trigger === 'output-limit' ? "process.stdout.write('x'.repeat(512));" : 'setInterval(() => undefined, 1_000);',
    trigger === 'output-limit' ? 'setInterval(() => undefined, 1_000);' : '',
    '',
  ].join('\n'));
  let descendant: number | undefined;
  try {
    const service = new ScriptPlaygroundService({
      ...(trigger === 'output-limit' ? { outputLimit: 128 } : { timeoutMs: 100 }),
      resolveScript: async () => Object.freeze({
        interpreter: Object.freeze({ args: Object.freeze([]), command: process.execPath }), name: 'review', path: emitted.path,
      }),
    });
    const running = service.run({
      epochId: 'epoch-server-owned', scriptId: 'script:review', target: 'codex',
    } as unknown as Parameters<typeof service.run>[0]);
    await eventually(async () => { await readFile(pidPath); });
    descendant = Number(await readFile(pidPath, 'utf8'));
    await eventually(async () => { await readFile(readyPath); });

    await expect(running).rejects.toMatchObject({ code: trigger });
    expect(() => process.kill(descendant!, 0)).toThrow();
  } finally {
    if (descendant !== undefined) {
      try { process.kill(descendant, 'SIGKILL'); }
      catch { /* The cleanup contract already terminated it. */ }
    }
    await Promise.allSettled([emitted.close(), rm(root, { force: true, recursive: true })]);
  }
};

it('drains a TERM-ignoring descendant before timeout settlement', async () => {
  await assertStubbornDescendantIsGoneAtSettlement('timeout');
}, 10_000);

it('drains a TERM-ignoring descendant before output-limit settlement', async () => {
  await assertStubbornDescendantIsGoneAtSettlement('output-limit');
}, 10_000);
