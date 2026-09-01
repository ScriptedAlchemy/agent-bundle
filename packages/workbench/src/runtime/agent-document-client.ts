import { z } from 'zod';

import type { ForegroundRequestAuthority } from '../mcp/mcp-route-client.ts';

export type AgentDocumentJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AgentDocumentJsonValue[]
  | Readonly<{ readonly [key: string]: AgentDocumentJsonValue }>;

export interface AgentResultNode {
  readonly children: readonly AgentDocumentNode[];
  readonly kind: 'result';
  readonly metadata?: AgentDocumentJsonValue;
}

export type AgentDocumentNode =
  | AgentResultNode
  | Readonly<{ readonly kind: 'markdown'; readonly text: string }>
  | Readonly<{ readonly kind: 'text'; readonly text: string }>
  | Readonly<{ readonly kind: 'context'; readonly text: string }>
  | Readonly<{ readonly kind: 'json'; readonly value: AgentDocumentJsonValue }>
  | Readonly<{ readonly completed: number; readonly kind: 'progress'; readonly message?: string; readonly total?: number }>
  | Readonly<{ readonly data: string; readonly kind: 'image'; readonly mimeType: string }>
  | Readonly<{ readonly data: string; readonly kind: 'audio'; readonly mimeType: string }>
  | Readonly<{ readonly kind: 'resource'; readonly mimeType?: string; readonly name: string; readonly uri: string }>
  | Readonly<{ readonly code: string; readonly kind: 'error'; readonly message: string }>;

export interface AgentDocument {
  readonly root: AgentDocumentNode;
  readonly status: 'success' | 'represented-error' | 'failed';
  readonly value?: AgentDocumentJsonValue;
  readonly version: 1;
}

export interface AgentRenderError {
  readonly code: string;
  readonly data?: AgentDocumentJsonValue;
  readonly message: string;
}

export type AgentRenderEvent =
  | Readonly<{ readonly document: AgentDocument; readonly sequence: number; readonly type: 'shell' }>
  | Readonly<{ readonly completed: number; readonly message?: string; readonly sequence: number; readonly total?: number; readonly type: 'progress' }>
  | Readonly<{ readonly boundaryId: string; readonly document: AgentDocument; readonly sequence: number; readonly type: 'replace' }>
  | Readonly<{ readonly boundaryId?: string; readonly error: AgentRenderError; readonly sequence: number; readonly type: 'error' }>
  | Readonly<{ readonly document: AgentDocument; readonly sequence: number; readonly type: 'complete' }>;

export interface AgentDocumentClientOptions {
  readonly foreground: ForegroundRequestAuthority;
}

const nonemptyStringSchema = z.string().min(1);
const progressNumberSchema = z.number().finite().nonnegative();

const progressFieldsSchema = z.strictObject({
  completed: progressNumberSchema,
  message: nonemptyStringSchema.optional(),
  total: progressNumberSchema.optional(),
}).refine((progress) => progress.total === undefined || progress.completed <= progress.total);

const agentDocumentNodeSchema: z.ZodType<AgentDocumentNode> = z.lazy(() => z.discriminatedUnion('kind', [
  z.strictObject({
    children: z.array(agentDocumentNodeSchema),
    kind: z.literal('result'),
    metadata: z.json().optional(),
  }),
  z.strictObject({ kind: z.literal('markdown'), text: z.string() }),
  z.strictObject({ kind: z.literal('text'), text: z.string() }),
  z.strictObject({ kind: z.literal('context'), text: z.string() }),
  z.strictObject({ kind: z.literal('json'), value: z.json() }),
  progressFieldsSchema.extend({ kind: z.literal('progress') }),
  z.strictObject({ data: nonemptyStringSchema, kind: z.literal('image'), mimeType: nonemptyStringSchema }),
  z.strictObject({ data: nonemptyStringSchema, kind: z.literal('audio'), mimeType: nonemptyStringSchema }),
  z.strictObject({
    kind: z.literal('resource'),
    mimeType: nonemptyStringSchema.optional(),
    name: nonemptyStringSchema,
    uri: nonemptyStringSchema,
  }),
  z.strictObject({ code: nonemptyStringSchema, kind: z.literal('error'), message: z.string() }),
]));

const agentDocumentSchema: z.ZodType<AgentDocument> = z.strictObject({
  root: agentDocumentNodeSchema,
  status: z.enum(['success', 'represented-error', 'failed']),
  value: z.json().optional(),
  version: z.literal(1),
});

const sequenceSchema = z.number().int().nonnegative();
const renderErrorSchema: z.ZodType<AgentRenderError> = z.strictObject({
  code: nonemptyStringSchema,
  data: z.json().optional(),
  message: z.string(),
});

const agentRenderEventSchema: z.ZodType<AgentRenderEvent> = z.discriminatedUnion('type', [
  z.strictObject({ document: agentDocumentSchema, sequence: sequenceSchema, type: z.literal('shell') }),
  progressFieldsSchema.extend({ sequence: sequenceSchema, type: z.literal('progress') }),
  z.strictObject({
    boundaryId: nonemptyStringSchema,
    document: agentDocumentSchema,
    sequence: sequenceSchema,
    type: z.literal('replace'),
  }),
  z.strictObject({
    boundaryId: nonemptyStringSchema.optional(),
    error: renderErrorSchema,
    sequence: sequenceSchema,
    type: z.literal('error'),
  }),
  z.strictObject({ document: agentDocumentSchema, sequence: sequenceSchema, type: z.literal('complete') }),
]);

const eventsResponseSchema = z.strictObject({ events: z.array(agentRenderEventSchema) });
const diagnosticResponseSchema = z.strictObject({
  diagnostic: z.strictObject({
    code: z.string(),
    message: z.string(),
  }),
});

export class AgentDocumentClientError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'AgentDocumentClientError';
    this.code = code;
    this.status = status;
  }
}

export const decodeAgentDocumentEvents = (value: unknown): readonly AgentRenderEvent[] => {
  const result = eventsResponseSchema.safeParse(value);
  if (!result.success) {
    throw new AgentDocumentClientError('AB8209', 'Agent Document route returned an invalid response.');
  }
  return Object.freeze(result.data.events);
};

const opaqueRunId = (value: string): string => {
  if (
    value.length === 0 || value === '.' || value === '..' ||
    value.includes('/') || value.includes('\\') || value.includes('\0')
  ) {
    throw new AgentDocumentClientError('AB8209', 'Runtime run ID is not a valid opaque segment.');
  }
  return encodeURIComponent(value);
};

const responseError = (value: unknown, status: number): AgentDocumentClientError => {
  const decoded = diagnosticResponseSchema.safeParse(value);
  if (decoded.success) {
    return new AgentDocumentClientError(decoded.data.diagnostic.code, decoded.data.diagnostic.message, status);
  }
  return new AgentDocumentClientError('AB8209', `Agent Document request failed with HTTP ${String(status)}.`, status);
};

/** Reads the server-decoded Agent Document stream; Flight bytes never enter the browser. */
export class AgentDocumentClient {
  readonly #foreground: ForegroundRequestAuthority;

  constructor(options: AgentDocumentClientOptions) {
    this.#foreground = options.foreground;
  }

  async events(runId: string, signal?: AbortSignal): Promise<readonly AgentRenderEvent[]> {
    const response = await this.#foreground.protectedRequest(
      `/api/runtime/runs/${opaqueRunId(runId)}/document`,
      signal === undefined ? {} : { signal },
    );
    const body: unknown = await response.json().catch(() => undefined);
    if (!response.ok) throw responseError(body, response.status);
    return decodeAgentDocumentEvents(body);
  }
}
