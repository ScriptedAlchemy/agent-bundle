import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { createFromReadableStream } from 'react-server-dom-rspack/client.node';
import type { ReactNode } from 'react';

import type { RenderRequest } from '../runtime/contracts.js';

export const maximumFlightRenderBytes = 4 * 1024 * 1024;

export interface FlightRenderResult {
  readonly flight: Uint8Array;
  readonly node: ReactNode;
}

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

const collectFlight = (
  child: ReturnType<typeof spawn>,
  stream: Readable,
  maximumBytes: number,
): Promise<Uint8Array> =>
  new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    let settled = false;
    stream.on('data', (chunk: Buffer | string) => {
      if (settled) return;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.byteLength;
      if (bytes > maximumBytes) {
        settled = true;
        child.kill();
        reject(new Error(`RSC worker Flight exceeded ${maximumBytes} bytes`));
        return;
      }
      chunks.push(buffer);
    });
    stream.once('error', (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    stream.once('end', () => {
      if (!settled) {
        settled = true;
        resolve(Buffer.concat(chunks));
      }
    });
  });

export const requestFlightRenderWithFlight = async (
  request: RenderRequest,
  options: Readonly<{ maximumFlightBytes?: number }> = {},
): Promise<FlightRenderResult> => {
  const maximumFlightBytes = options.maximumFlightBytes ?? maximumFlightRenderBytes;
  if (!Number.isSafeInteger(maximumFlightBytes) || maximumFlightBytes < 1) {
    throw new RangeError('maximumFlightBytes must be a positive safe integer');
  }

  const currentDirectory = dirname(fileURLToPath(import.meta.url));
  const workerPath = join(currentDirectory, '../rsc/index.js');
  const child = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout = child.stdout;
  if (stdout === null) throw new Error('RSC worker stdout is unavailable');
  const stderr = collectStderr(child.stderr);
  const exited = waitForExit(child);
  const flight = collectFlight(child, stdout, maximumFlightBytes);

  child.stdin.end(JSON.stringify(request));

  const [flightResult, exitResult, stderrResult] = await Promise.allSettled([flight, exited, stderr]);
  if (flightResult.status === 'rejected') throw flightResult.reason;
  if (exitResult.status === 'rejected') throw exitResult.reason;
  if (stderrResult.status === 'rejected') throw stderrResult.reason;

  const exitCode = exitResult.value;
  const diagnostics = stderrResult.value;
  if (exitCode !== 0) {
    throw new Error(`RSC worker exited with code ${String(exitCode)}: ${diagnostics}`);
  }

  const rawFlight = flightResult.value;
  const node = await createFromReadableStream<ReactNode>(
    Readable.toWeb(Readable.from([rawFlight])) as ReadableStream<Uint8Array>,
  );

  return Object.freeze({ flight: rawFlight, node });
};

export const requestFlightRender = async (request: RenderRequest): Promise<ReactNode> =>
  (await requestFlightRenderWithFlight(request)).node;
