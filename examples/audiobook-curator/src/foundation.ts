import { open, mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';

export const audioExtensions = Object.freeze(new Set([
  '.aac', '.aax', '.aaxc', '.aif', '.aiff', '.flac', '.m4a', '.m4b',
  '.mp3', '.ogg', '.opus', '.wav', '.wma',
]));

export const audibleHosts = Object.freeze({
  au: 'api.audible.com.au',
  ca: 'api.audible.ca',
  de: 'api.audible.de',
  es: 'api.audible.es',
  fr: 'api.audible.fr',
  in: 'api.audible.in',
  it: 'api.audible.it',
  jp: 'api.audible.co.jp',
  uk: 'api.audible.co.uk',
  us: 'api.audible.com',
} as const);

export class CuratorError extends Error {}

export const utcNow = (): string => new Date().toISOString();

const naturalCollator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

export const naturalCompare = (left: string, right: string): number => naturalCollator.compare(left, right);

export const safeFilename = (input: string): string => {
  const withoutApostrophes = input.normalize('NFKC').replaceAll(/[’']/gu, '');
  const withoutControlCharacters = [...withoutApostrophes]
    .map((character) => character.codePointAt(0)! <= 0x1f ? ' - ' : character)
    .join('');
  const safe = withoutControlCharacters
    .replaceAll(/[\\/:*?"<>|]/gu, ' - ')
    .replaceAll(/\s+/gu, ' ')
    .replaceAll(/^[ .-]+|[ .-]+$/gu, '');
  return safe === '' ? 'Untitled Audiobook' : safe;
};

export const normalizedIdentity = (input: string): string => {
  const normalized = input
    .normalize('NFKD')
    .replaceAll(/\p{M}/gu, '')
    .toLowerCase()
    .replaceAll(/[’']s\b/gu, 's')
    .replaceAll('&', ' and ')
    .replaceAll(/[^a-z0-9]+/gu, ' ')
    .trim();
  return normalized.split(/\s+/u).filter((word) => !['a', 'an', 'the'].includes(word)).join(' ');
};

const assertFiniteJson = (value: unknown, ancestors: Set<object>): void => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new CuratorError('Receipt contains a non-finite number.');
    return;
  }
  if (typeof value !== 'object') throw new CuratorError('Receipt contains a non-JSON value.');
  if (ancestors.has(value)) throw new CuratorError('Receipt contains a cycle.');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      for (const item of value) assertFiniteJson(item, ancestors);
      return;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new CuratorError('Receipt contains a non-plain object.');
    }
    for (const [key, item] of Object.entries(value)) {
      if (key.length > 256) throw new CuratorError('Receipt contains an oversized key.');
      assertFiniteJson(item, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
};

export const protectReceiptPath = (path: string, protectedPaths: readonly (string | undefined)[] = []): string => {
  const target = resolve(path);
  if (audioExtensions.has(extname(target).toLowerCase())) {
    throw new CuratorError(`Refusing to write JSON over an audio path: ${target}`);
  }
  for (const protectedPath of protectedPaths) {
    if (protectedPath !== undefined && target === resolve(protectedPath)) {
      throw new CuratorError(`JSON output collides with an input or media target: ${target}`);
    }
  }
  return target;
};

export const writeReceipt = async (
  path: string,
  value: unknown,
  protectedPaths: readonly (string | undefined)[] = [],
): Promise<string> => {
  const target = protectReceiptPath(path, protectedPaths);
  assertFiniteJson(value, new Set());
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, '.audiobook-curator-receipt-'));
  const staged = join(staging, 'receipt.json');
  try {
    await writeFile(staged, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    const file = await open(staged, 'r');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(staged, target);
    const directory = await open(parent, 'r');
    try {
      await directory.sync();
    } catch (error) {
      if (!['EACCES', 'EINVAL'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    } finally {
      await directory.close();
    }
    return target;
  } finally {
    await rm(staging, { force: true, recursive: true });
  }
};

export const readJson = async (path: string): Promise<unknown> => {
  const file = await open(resolve(path), 'r');
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 16 * 1024 * 1024) {
      throw new CuratorError('JSON input must be one regular file no larger than 16 MiB.');
    }
    const bytes = Buffer.alloc(metadata.size + 1);
    const result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead !== metadata.size) throw new CuratorError('JSON input changed while it was read.');
    const value = JSON.parse(bytes.subarray(0, result.bytesRead).toString('utf8')) as unknown;
    assertFiniteJson(value, new Set());
    return value;
  } finally {
    await file.close();
  }
};
