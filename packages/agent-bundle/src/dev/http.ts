import { Buffer } from 'node:buffer';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface RequestDiagnostic {
  readonly code: string;
  readonly message: string;
  readonly status: number;
}

export interface ReadBodyOptions {
  readonly code: string;
  readonly limit: number;
  readonly message: string;
}

export interface ResponseJsonOptions {
  readonly destroyIfEnded?: boolean;
  readonly status?: number;
}

export interface OpaqueSegmentOptions {
  readonly code: string;
  readonly maxLength?: number;
  readonly message: string;
  readonly rejectBlank?: boolean;
}

const defaultReadBody: ReadBodyOptions = Object.freeze({
  code: 'AB8010',
  limit: 64 * 1024,
  message: 'Request body exceeds 64 KiB.',
});

export const diagnostic = (code: string, message: string, status: number): RequestDiagnostic => ({
  code,
  message,
  status,
});

export const requestError = (
  value: RequestDiagnostic,
  extras?: object,
): RequestDiagnostic & Error => Object.assign(new Error(value.message), value, extras);

export const isRequestDiagnostic = (value: unknown): value is RequestDiagnostic =>
  typeof value === 'object' && value !== null &&
  typeof (value as Partial<RequestDiagnostic>).code === 'string' &&
  typeof (value as Partial<RequestDiagnostic>).message === 'string' &&
  typeof (value as Partial<RequestDiagnostic>).status === 'number';

export const responseDiagnostic = (response: ServerResponse, value: RequestDiagnostic): void => {
  if (response.headersSent || response.writableEnded) {
    response.destroy();
    return;
  }
  response.writeHead(value.status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ diagnostic: { code: value.code, message: value.message } }));
};

export const responseJson = (
  response: ServerResponse,
  body: unknown,
  options: ResponseJsonOptions = {},
): void => {
  if (options.destroyIfEnded === true && (response.headersSent || response.writableEnded)) {
    response.destroy();
    return;
  }
  response.writeHead(options.status ?? 200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
};

export const singleHeader = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

export const unquoteHeaderValue = (value: string): string | undefined => {
  if (/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(value)) return value;
  if (!/^"(?:[^"\\\r\n]|\\[\t !-~])*"$/u.test(value)) return undefined;
  return value.slice(1, -1).replace(/\\([\t !-~])/gu, '$1');
};

export const isJsonRequest = (request: IncomingMessage): boolean => {
  const contentType = singleHeader(request.headers['content-type']);
  if (contentType === undefined) return false;
  const parts = contentType.split(';').map((part) => part.trim());
  if (parts.shift()?.toLowerCase() !== 'application/json') return false;
  if (parts.length === 0) return true;
  if (parts.length !== 1) return false;
  const parameter = parts[0]!;
  const equals = parameter.indexOf('=');
  if (equals < 1 || parameter.slice(0, equals).trim().toLowerCase() !== 'charset') return false;
  return unquoteHeaderValue(parameter.slice(equals + 1).trim())?.toLowerCase() === 'utf-8';
};

export const readBody = async (
  request: IncomingMessage,
  options: ReadBodyOptions = defaultReadBody,
): Promise<string> => new Promise((resolvePromise, rejectPromise) => {
  let size = 0;
  let tooLarge = false;
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > options.limit) {
      tooLarge = true;
      return;
    }
    if (!tooLarge) chunks.push(chunk);
  });
  request.once('end', () => {
    if (tooLarge) {
      rejectPromise(requestError(diagnostic(options.code, options.message, 413)));
      return;
    }
    resolvePromise(Buffer.concat(chunks).toString('utf8'));
  });
  request.once('error', rejectPromise);
});

export const rawPathname = (requestTarget: string | undefined): string =>
  requestTarget?.split(/[?#]/u, 1)[0] ?? '';

export const decodedOpaqueSegment = (segment: string, options: OpaqueSegmentOptions): string => {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    throw requestError(diagnostic(options.code, options.message, 400));
  }
  if (
    decoded.length === 0 || decoded === '.' || decoded === '..' ||
    decoded.includes('/') || decoded.includes('\\') || decoded.includes('\0') ||
    (options.maxLength !== undefined && decoded.length > options.maxLength) ||
    (options.rejectBlank === true && decoded.trim().length === 0)
  ) {
    throw requestError(diagnostic(options.code, options.message, 400));
  }
  return decoded;
};

export const hasOnly = (value: Readonly<Record<string, unknown>>, fields: readonly string[]): boolean =>
  Object.keys(value).every((field) => fields.includes(field));

export const nonemptyString = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= 4_096 && !value.includes('\0');
