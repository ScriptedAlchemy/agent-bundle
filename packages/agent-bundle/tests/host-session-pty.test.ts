import { expect, it } from '@rstest/core';

import { loadPtyAdapter } from '../src/dev/sessions/pty.ts';

it('runs input, resize, output, and termination through a real PTY', { timeout: 15_000 }, async () => {
  const process = loadPtyAdapter(import.meta.dirname).spawn(
    '/bin/sh',
    ['-c', 'echo ready; stty size; read line; echo got:$line; sleep 30'],
    {
      cols: 80,
      cwd: import.meta.dirname,
      env: { ...globalThis.process.env, TERM: 'xterm-256color' },
      name: 'xterm-256color',
      rows: 24,
    },
  );
  let output = '';
  process.onData((data) => { output += data; });
  const exited = Promise.withResolvers<void>();
  process.onExit(() => exited.resolve());

  await expect.poll(() => output).toContain('ready');
  expect(output).toMatch(/24\s+80/u);
  process.resize(100, 30);
  process.write('hello\n');
  await expect.poll(() => output).toContain('got:hello');
  process.kill('SIGTERM');
  await exited.promise;
});
