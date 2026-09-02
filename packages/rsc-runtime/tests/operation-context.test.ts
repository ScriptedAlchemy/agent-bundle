import { describe, expect, it } from '@rstest/core';
import { createElement } from 'react';
import { z } from 'zod';

import type { AgentRequestContext } from '../src/index.js';
import {
  agent,
  available,
  defineOperation,
  defineRscApplication,
  runAgentRequest,
  runRscCli,
} from '../src/index.js';

const signal = new AbortController().signal;

const requestProbe = defineOperation({
  execute: async (_input, context) => {
    const direct = await agent();
    return {
      actor: context.request?.actor,
      host: context.request?.host,
      sameHandle: context.request === direct,
      session: context.request?.session,
      workspace: context.request?.workspace,
    };
  },
  id: 'request-probe',
  inputSchema: z.object({}).strict(),
  render: () => createElement('mcp-result'),
  resultSchema: z.object({
    actor: z.unknown(),
    host: z.unknown(),
    sameHandle: z.boolean(),
    session: z.unknown(),
    workspace: z.unknown(),
  }).strict(),
});

describe('defineOperation request context', () => {
  it('passes the current request handle and injected identity axes to the handler', async () => {
    const result = await runAgentRequest({
      actor: available({ id: 'actor-1' }, 'receipt'),
      host: available({ name: 'cursor' }, 'native'),
      invocation: { kind: 'tool' },
      session: available({ sessionId: 'session-1' }, 'native'),
      workspace: available({ root: '/tmp/project' }, 'derived'),
    }, async () => requestProbe.execute({}, { signal }));

    expect(result).toEqual({
      actor: { source: 'receipt', state: 'available', value: { id: 'actor-1' } },
      host: { source: 'native', state: 'available', value: { name: 'cursor' } },
      sameHandle: true,
      session: { source: 'native', state: 'available', value: { sessionId: 'session-1' } },
      workspace: { source: 'derived', state: 'available', value: { root: '/tmp/project' } },
    });
  });

  it('omits request outside an invocation and lets a supplied request win over storage', async () => {
    let outside: AgentRequestContext | undefined;
    const outsideProbe = defineOperation({
      execute: async (_input, context) => {
        outside = context.request;
        return { ok: true };
      },
      id: 'outside-probe',
      inputSchema: z.object({}).strict(),
      render: () => createElement('mcp-result'),
      resultSchema: z.object({ ok: z.literal(true) }).strict(),
    });

    await outsideProbe.execute({}, { signal });
    expect(outside).toBeUndefined();

    await runAgentRequest({
      host: available({ name: 'outer' }, 'native'),
      invocation: { id: 'outer', kind: 'tool' },
    }, async () => {
      const supplied = await agent();
      let observed: AgentRequestContext | undefined;
      const suppliedProbe = defineOperation({
        execute: async (_input, context) => {
          observed = context.request;
          return { ok: true };
        },
        id: 'supplied-probe',
        inputSchema: z.object({}).strict(),
        render: () => createElement('mcp-result'),
        resultSchema: z.object({ ok: z.literal(true) }).strict(),
      });
      await runAgentRequest({
        host: available({ name: 'inner' }, 'native'),
        invocation: { id: 'inner', kind: 'tool' },
      }, async () => suppliedProbe.execute({}, { request: supplied, signal }));
      expect(observed).toBe(supplied);
      expect(observed?.host).toEqual({ source: 'native', state: 'available', value: { name: 'outer' } });
    });
  });

  it('keeps single-argument handlers source-compatible', async () => {
    const singleArgument = defineOperation({
      execute: async (input: { readonly value: number }) => ({ doubled: input.value * 2 }),
      id: 'single-argument',
      inputSchema: z.object({ value: z.number() }).strict(),
      render: () => createElement('mcp-result'),
      resultSchema: z.object({ doubled: z.number() }).strict(),
    });

    await expect(singleArgument.execute({ value: 3 }, { signal })).resolves.toEqual({ doubled: 6 });
  });

  it('exposes derived CLI workspace and an unavailable host through the second argument', async () => {
    let observed: {
      readonly host: unknown;
      readonly workspace: unknown;
    } | undefined;
    const cliProbe = defineOperation({
      cli: {
        name: 'context',
        parse: () => ({}),
        summary: 'Read request context.',
        usage: 'context',
      },
      execute: async (_input, context) => {
        observed = {
          host: context.request?.host,
          workspace: context.request?.workspace,
        };
        return { ok: true };
      },
      id: 'cli-context',
      inputSchema: z.object({}).strict(),
      render: () => createElement('mcp-result'),
      resultSchema: z.object({ ok: z.literal(true) }).strict(),
    });
    const application = defineRscApplication({
      name: 'cli-context',
      operations: [cliProbe],
      version: '1.0.0',
    });

    await runRscCli(application, ['context'], { write: () => undefined });

    expect(observed?.workspace).toEqual({
      source: 'derived',
      state: 'available',
      value: { root: process.cwd() },
    });
    expect(observed?.host).toEqual({ reason: 'unsupported-surface', state: 'unavailable' });
  });
});
