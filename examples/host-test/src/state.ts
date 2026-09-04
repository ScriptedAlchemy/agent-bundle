import { defineState } from '@agent-bundle/runtime/state';
import { z } from 'zod';

const text = z.string().max(4096);

/**
 * The bounded, durable summary of one capture. The complete raw record lives
 * in the plain NDJSON log; the kernel keeps enough to correlate and to prove
 * durability across processes without exceeding the state byte budget.
 */
export const CaptureSummarySchema = z.object({
  event: text.optional(),
  host: text,
  ids: z.record(z.string().max(64), z.union([z.string().max(1024), z.boolean(), z.number(), z.null()])),
  invocationId: text,
  kind: z.enum(['event', 'mcp', 'cli']),
  nativeEvent: text.optional(),
  recordedAt: text,
  runtime: z.enum(['shared-runtime', 'standalone-hook', 'mcp-server', 'cli', 'script', 'unknown']),
  sequence: z.number().int().nonnegative(),
}).strict();

export const CapturesStateSchema = z.object({
  captures: z.array(CaptureSummarySchema),
  clearedAt: text.optional(),
  total: z.number().int().nonnegative(),
}).strict();

export type CaptureSummary = z.output<typeof CaptureSummarySchema>;
export type CapturesState = z.output<typeof CapturesStateSchema>;

export const captureEventSchemas = {
  captured: CaptureSummarySchema,
  cleared: z.object({ clearedAt: text }).strict(),
} as const;

export type CaptureEvents = typeof captureEventSchemas;

/** Keep the durable ring bounded so a long probing session never trips the state byte budget. */
export const CAPTURE_RING_SIZE = 400;

const initial: CapturesState = {
  captures: [],
  total: 0,
};

export const capturesStateDefinition = defineState({
  budgets: {
    maxStateBytes: 4 * 1_048_576,
  },
  events: captureEventSchemas,
  id: 'host-test/captures',
  initial,
  lifetime: 'workspace-durable',
  reduce: (state, event): CapturesState => {
    switch (event.name) {
      case 'captured': {
        const captures = [...state.captures, event.payload];
        return {
          ...state,
          captures: captures.length > CAPTURE_RING_SIZE
            ? captures.slice(captures.length - CAPTURE_RING_SIZE)
            : captures,
          total: state.total + 1,
        };
      }
      case 'cleared':
        return { captures: [], clearedAt: event.payload.clearedAt, total: 0 };
      default: {
        const unreachable: never = event;
        throw new Error(`Unhandled captures event ${String(unreachable)}`);
      }
    }
  },
  schema: CapturesStateSchema,
  version: 1,
});

export default defineState({
  ...capturesStateDefinition,
  id: 'host-test/captures',
  lifetime: 'workspace-durable',
});
