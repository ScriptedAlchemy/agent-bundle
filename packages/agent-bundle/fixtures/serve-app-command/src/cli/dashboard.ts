import type { CliRouteConfig, CliRouteProps } from 'agent-bundle';
import { ServeAppCommandError, spawnServeApp } from 'agent-bundle/serve-app-command';
import { z } from 'zod';

export const config = {
  description: 'Open the status App in a browser, served from this checkout\'s built artifact.',
  exitCode: 'result',
} satisfies CliRouteConfig;

export const inputSchema = z.object({
  noOpen: z.boolean().optional(),
  port: z.number().int().min(0).max(65_535).optional(),
  /** Test seam: fetch the served page once, then stop the server and report. */
  probe: z.boolean().optional(),
}).strict();

export const resultSchema = z.object({
  exitCode: z.number().int(),
  message: z.string(),
  pid: z.number().int().nullable(),
  probeStatus: z.number().int().nullable(),
  url: z.string().nullable(),
}).strict();

export default async function dashboard({ input, signal }: CliRouteProps<typeof inputSchema>) {
  let served;
  try {
    served = await spawnServeApp({
      app: 'status/status',
      root: process.cwd(),
      artifact: 'artifact',
      tool: 'status',
      autoApprove: ['call-tool'],
      open: input.noOpen !== true,
      ...(input.port === undefined ? {} : { port: input.port }),
      signal,
    });
  } catch (error) {
    if (error instanceof ServeAppCommandError) {
      return { exitCode: 1, message: `${error.code}: ${error.message}`, pid: null, probeStatus: null, url: null };
    }
    throw error;
  }
  let probeStatus: number | null = null;
  if (input.probe === true) {
    probeStatus = (await fetch(served.url)).status;
    await served.close();
  }
  const exit = await served.closed;
  return {
    exitCode: exit.code ?? 1,
    message: exit.code === 0 ? 'dashboard closed' : `agent-bundle serve-app exited with ${exit.signal ?? exit.code}`,
    pid: served.pid,
    probeStatus,
    url: served.url,
  };
}
