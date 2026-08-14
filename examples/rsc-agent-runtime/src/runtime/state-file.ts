import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import type { EditEvent, RuntimeKernel, RuntimeSnapshot } from './contracts.js';

export interface FileRuntimeKernelOptions {
  stateFile: string;
  now?: () => Date;
  createId?: () => string;
}

const isEditEvent = (value: unknown): value is EditEvent => {
  if (value === null || typeof value !== 'object') {
    return false;
  }

  const event = value as Record<string, unknown>;
  return (
    typeof event.eventId === 'string' &&
    (event.host === 'claude' || event.host === 'codex') &&
    typeof event.sessionId === 'string' &&
    typeof event.toolName === 'string' &&
    typeof event.path === 'string' &&
    typeof event.recordedAt === 'string'
  );
};

const validateLimit = (limit: number | undefined): void => {
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) {
    throw new RangeError('limit must be an integer from 1 through 50');
  }
};

const readCompleteEvents = async (stateFile: string): Promise<EditEvent[]> => {
  let contents: string;

  try {
    contents = await readFile(stateFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }

    throw error;
  }

  const lines = contents.split('\n');
  lines.pop();

  return lines.flatMap((line) => {
    if (line.length === 0) {
      return [];
    }

    try {
      const event: unknown = JSON.parse(line);
      return isEditEvent(event) ? [event] : [];
    } catch {
      return [];
    }
  });
};

export const createFileRuntimeKernel = (options: FileRuntimeKernelOptions): RuntimeKernel => {
  const now = options.now ?? (() => new Date());
  const createId = options.createId ?? randomUUID;

  const readSnapshot = async ({ limit }: { limit?: number } = {}): Promise<RuntimeSnapshot> => {
    validateLimit(limit);

    const edits = await readCompleteEvents(options.stateFile);
    return {
      edits: limit === undefined ? edits : edits.slice(-limit),
      stateVersion: edits.length,
    };
  };

  return {
    async recordEdit(input) {
      const event: EditEvent = {
        ...input,
        eventId: createId(),
        recordedAt: now().toISOString(),
      };

      await mkdir(dirname(options.stateFile), { recursive: true });
      await appendFile(options.stateFile, `${JSON.stringify(event)}\n`, 'utf8');

      return readSnapshot();
    },
    readSnapshot,
  };
};
