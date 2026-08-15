import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

import { createFromReadableStream } from 'react-server-dom-rspack/client.node';
import type { ReactNode } from 'react';

import type { RenderRequest } from '../runtime/contracts.js';
import { redactInspectionDiagnostics } from '../dev/inspection-security.js';

export const maximumFlightRenderBytes = 4 * 1024 * 1024;
export const maximumFlightRenderStderrBytes = 256 * 1024;

const defaultTerminationGraceMs = 100;

export interface FlightRenderResult {
  readonly flight: Uint8Array;
  readonly node: ReactNode;
}

export interface FlightRenderOptions {
  readonly maximumFlightBytes?: number;
  readonly maximumStderrBytes?: number;
  readonly signal?: AbortSignal;
  readonly terminationGraceMs?: number;
}

const positiveSafeInteger = (value: number, name: string): number => {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer`);
  return value;
};

const workerFailure = (message: string, diagnostics: string): Error =>
  new Error(`${message}${diagnostics.length === 0 ? '' : `: ${diagnostics}`}`);

export const requestFlightRenderWithFlight = async (
  request: RenderRequest,
  options: FlightRenderOptions = {},
): Promise<FlightRenderResult> => {
  const maximumFlightBytes = positiveSafeInteger(options.maximumFlightBytes ?? maximumFlightRenderBytes, 'maximumFlightBytes');
  const maximumStderrBytes = positiveSafeInteger(options.maximumStderrBytes ?? maximumFlightRenderStderrBytes, 'maximumStderrBytes');
  const terminationGraceMs = positiveSafeInteger(options.terminationGraceMs ?? defaultTerminationGraceMs, 'terminationGraceMs');

  return new Promise<FlightRenderResult>((resolveRender, rejectRender) => {
    const currentDirectory = dirname(fileURLToPath(import.meta.url));
    const workerPath = join(currentDirectory, '../rsc/index.js');
    const child = spawn(process.execPath, [workerPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = child.stdout;
    const stderr = child.stderr;
    const flight: Buffer[] = [];
    const diagnostics: Buffer[] = [];
    let flightBytes = 0;
    let stderrBytes = 0;
    let termination: Error | undefined;
    let terminationGrace: ReturnType<typeof setTimeout> | undefined;
    let closed = false;

    const cleanup = (): void => {
      if (terminationGrace !== undefined) clearTimeout(terminationGrace);
      options.signal?.removeEventListener('abort', abort);
    };

    const terminate = (error: Error): void => {
      if (termination !== undefined || closed) return;
      termination = error;
      child.stdin.destroy();
      child.kill('SIGTERM');
      terminationGrace = setTimeout(() => {
        if (!closed) child.kill('SIGKILL');
      }, terminationGraceMs);
    };

    const abort = (): void => terminate(new Error('RSC worker render was aborted.'));

    if (stdout === null || stderr === null) {
      terminate(new Error('RSC worker streams are unavailable.'));
    } else {
      stdout.on('data', (chunk: Buffer | string) => {
        if (termination !== undefined) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        flightBytes += buffer.byteLength;
        if (flightBytes > maximumFlightBytes) {
          terminate(new Error(`RSC worker Flight exceeded ${maximumFlightBytes} bytes.`));
          return;
        }
        flight.push(buffer);
      });
      stdout.once('error', () => terminate(new Error('RSC worker Flight stream failed.')));
      stderr.on('data', (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const retained = Math.min(buffer.byteLength, Math.max(0, maximumStderrBytes - stderrBytes));
        if (retained > 0) diagnostics.push(buffer.subarray(0, retained));
        stderrBytes += buffer.byteLength;
        if (stderrBytes > maximumStderrBytes) {
          terminate(new Error(`RSC worker stderr exceeded ${maximumStderrBytes} bytes.`));
        }
      });
      stderr.once('error', () => terminate(new Error('RSC worker stderr stream failed.')));
    }

    child.stdin.once('error', () => terminate(new Error('RSC worker request stream failed.')));
    child.once('error', () => terminate(new Error('RSC worker could not be started.')));
    child.once('close', (code) => {
      closed = true;
      cleanup();
      const output = redactInspectionDiagnostics(Buffer.concat(diagnostics).toString('utf8'));
      if (termination !== undefined) {
        rejectRender(workerFailure(termination.message, output));
        return;
      }
      if (code !== 0) {
        rejectRender(workerFailure(`RSC worker exited with code ${String(code)}`, output));
        return;
      }
      void (async () => {
        try {
          const rawFlight = Buffer.concat(flight);
          const node = await createFromReadableStream<ReactNode>(
            Readable.toWeb(Readable.from([rawFlight])) as ReadableStream<Uint8Array>,
          );
          resolveRender(Object.freeze({ flight: rawFlight, node }));
        } catch {
          rejectRender(new Error('RSC worker emitted invalid Flight data.'));
        }
      })();
    });

    options.signal?.addEventListener('abort', abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    try {
      child.stdin.end(JSON.stringify(request));
    } catch {
      terminate(new Error('RSC worker request could not be encoded.'));
    }
  });
};

export const requestFlightRender = async (request: RenderRequest): Promise<ReactNode> =>
  (await requestFlightRenderWithFlight(request)).node;
