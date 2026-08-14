import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { createFromReadableStream } from 'react-server-dom-rspack/client.node';
import type { ReactNode } from 'react';

import type { RenderRequest } from '../runtime/contracts.js';

const collectStderr = (stream: Readable): Promise<string> =>
  new Promise((resolve, reject) => {
    let output = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      output += chunk;
    });
    stream.on('error', reject);
    stream.on('end', () => resolve(output));
  });

const waitForExit = (child: ReturnType<typeof spawn>): Promise<number | null> =>
  new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

export const requestFlightRender = async (request: RenderRequest): Promise<ReactNode> => {
  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const workerPath = join(currentDirectory, '../rsc/index.js');
  const child = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stderr = collectStderr(child.stderr);
  const exited = waitForExit(child);

  child.stdin.end(JSON.stringify(request));

  let decoded: ReactNode | undefined;
  let decodeError: unknown;
  try {
    decoded = await createFromReadableStream<ReactNode>(
      Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    );
  } catch (error) {
    decodeError = error;
  }

  const [exitCode, diagnostics] = await Promise.all([exited, stderr]);
  if (exitCode !== 0) {
    throw new Error(`RSC worker exited with code ${String(exitCode)}: ${diagnostics}`);
  }

  if (decodeError !== undefined) {
    throw decodeError;
  }

  return decoded as ReactNode;
};
