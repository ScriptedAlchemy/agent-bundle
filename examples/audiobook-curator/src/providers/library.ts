import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface LibraryContext {
  readonly tooling: {
    readonly ffmpeg: {
      readonly available: boolean;
      readonly version?: string;
    };
    readonly ffprobe: {
      readonly available: boolean;
      readonly version?: string;
    };
  };
  readonly stages: readonly string[];
  readonly probedAt: string;
}

interface ProviderContext {
  readonly invocation: unknown;
  readonly signal: AbortSignal;
}

interface ToolProbe {
  readonly available: boolean;
  readonly version?: string;
}

const execFileAsync = promisify(execFile);

const probeTool = async (tool: 'ffmpeg' | 'ffprobe', signal: AbortSignal): Promise<ToolProbe> => {
  try {
    const result = await execFileAsync(tool, ['-version'], { encoding: 'utf8', signal });
    const version = result.stdout.trim().split(/\r?\n/u)[0];
    return version === undefined || version === ''
      ? { available: true }
      : { available: true, version };
  } catch {
    return { available: false };
  }
};

export default async function libraryProvider(
  { signal }: ProviderContext,
): Promise<LibraryContext> {
  const [ffmpeg, ffprobe] = await Promise.all([
    probeTool('ffmpeg', signal),
    probeTool('ffprobe', signal),
  ]);

  return {
    probedAt: new Date().toISOString(),
    stages: ['discover', 'identify', 'curate', 'verify'],
    tooling: { ffmpeg, ffprobe },
  };
}
