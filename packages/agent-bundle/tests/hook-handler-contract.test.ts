import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from '@rstest/core';

import {
  createNativeEventStarter,
  cursorHookWrapperSource,
  nativeHookWrapperSource,
  type TargetHookWrapper,
} from '../src/adapters/hook-contract.ts';
import {
  hookEventFields,
  hookHandlerEventNames,
  hookResultContract,
  type HookEvent,
  type HookEventFields,
  type HookHandler,
  type HookHandlerEventName,
  type HookResult,
} from '../src/adapters/hook-handler.ts';
import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { canonicalHookEvents } from '../src/core/types.ts';
import type { CanonicalAgentEvent } from '../src/routes/public.ts';

type Host = 'claude' | 'codex' | 'cursor';

interface WrapperInternals {
  readonly decodeNative: (native: Record<string, unknown>) => Record<string, unknown>;
  readonly validateNativeInput: (native: Record<string, unknown>) => void;
  readonly validateResult: (result: unknown) => unknown;
}

const hosts: readonly Host[] = ['claude', 'codex', 'cursor'];

const agentEventFor: Readonly<Record<HookHandlerEventName, CanonicalAgentEvent>> = {
  afterTool: 'tool/after',
  agentStart: 'agent/start',
  agentStop: 'agent/stop',
  beforeTool: 'tool/before',
  sessionStart: 'session/start',
  stop: 'stop',
};

const wrapperEntry = (host: Host, event: HookHandlerEventName, nativeEvent: string): TargetHookWrapper => ({
  event,
  hook: {
    event,
    id: `hook:${event}:contract:00000000`,
    name: 'contract',
    provenance: { kind: 'config', sourcePath: '/project/agent-bundle.config.ts' },
    source: '/project/src/hooks/contract.ts',
    targets: [host],
    tools: [],
  },
  nativeEvent,
  relativePath: `hooks/${event}.mjs`,
  target: host,
});

/**
 * The generated wrapper is a self-executing module over a handler import.
 * Its validators are what the contract is held to, so the source is loaded
 * with the handler import and the `import.meta.main` block removed and the
 * validators exported instead. Nothing else about the wrapper changes.
 */
const wrapperInternalsSource = (host: Host, entry: TargetHookWrapper): string => {
  const source = host === 'cursor'
    ? cursorHookWrapperSource(entry)
    : nativeHookWrapperSource(entry, host === 'claude' ? 'Claude' : 'Codex');
  const mainIndex = source.indexOf('if (import.meta.main) {');
  expect(mainIndex).toBeGreaterThan(0);
  const body = source
    .slice(0, mainIndex)
    .split('\n')
    .filter((line) => !line.startsWith('import * as handlerModule from '))
    .join('\n');
  const decoder = host === 'cursor' ? 'decodeCursorNative' : 'decodeNative';
  return `${body}\nexport { ${decoder} as decodeNative, validateNativeInput, validateResult };\n`;
};

const nativeEventNames = (host: Host): Readonly<Partial<Record<HookHandlerEventName, string>>> =>
  createDefaultRegistry().hookContract(host)?.eventNames ?? {};

let root: string;
const internals = new Map<string, WrapperInternals>();

const wrapperFor = (host: Host, event: HookHandlerEventName): WrapperInternals | undefined =>
  internals.get(`${host}:${event}`);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'agent-bundle-hook-handler-contract-'));
  for (const host of hosts) {
    for (const [event, nativeEvent] of Object.entries(nativeEventNames(host)) as [HookHandlerEventName, string][]) {
      const file = join(root, `${host}-${event}.mjs`);
      await writeFile(file, wrapperInternalsSource(host, wrapperEntry(host, event, nativeEvent)));
      internals.set(`${host}:${event}`, await import(pathToFileURL(file).href) as WrapperInternals);
    }
  }
});

afterAll(async () => {
  await rm(root, { force: true, recursive: true });
});

/** Every result object shape over the four admitted keys: 4 outcomes × 2 × 2 × 2. */
const resultShapes = (): readonly Record<string, unknown>[] => {
  const shapes: Record<string, unknown>[] = [];
  for (const outcome of [undefined, 'continue', 'deny', 'stop']) {
    for (const reason of [undefined, 'because']) {
      for (const additionalContext of [undefined, 'context']) {
        for (const updatedInput of [undefined, {}]) {
          shapes.push(Object.fromEntries(
            Object.entries({ additionalContext, outcome, reason, updatedInput }).filter(([, value]) => value !== undefined),
          ));
        }
      }
    }
  }
  return shapes;
};

/** The runtime twin of `HookResult<E>`: what the portable contract admits for one event. */
const admittedByContract = (event: HookHandlerEventName, shape: Record<string, unknown>): boolean => {
  const rule = hookResultContract[event];
  const outcome = shape['outcome'] ?? 'continue';
  if (outcome === 'stop') return false;
  if (outcome === 'deny' && !rule.deny) return false;
  if ((shape['reason'] !== undefined) !== (outcome === 'deny')) return false;
  if (shape['additionalContext'] !== undefined && !rule.additionalContext) return false;
  if (shape['updatedInput'] !== undefined && (!rule.updatedInput || outcome === 'deny')) return false;
  return true;
};

const accepts = (wrapper: WrapperInternals, shape: Record<string, unknown>): boolean => {
  try {
    wrapper.validateResult(shape);
    return true;
  } catch {
    return false;
  }
};

/**
 * Where one host's wrapper validator is more permissive than the portable
 * contract. These are host features (or fields a host validates but has no
 * output channel for), not contract members: a handler typed `HookResult<E>`
 * must run unchanged, with the same effect, on every host, so the type
 * excludes them. Any other divergence between the table and a wrapper fails
 * below.
 */
const beforeToolContextShapes = [
  '{"additionalContext":"context"}',
  '{"additionalContext":"context","outcome":"continue"}',
  '{"additionalContext":"context","outcome":"deny","reason":"because"}',
  '{"additionalContext":"context","updatedInput":{}}',
  '{"additionalContext":"context","outcome":"continue","updatedInput":{}}',
];
const hostLeniencies: ReadonlySet<string> = new Set([
  // Every validator accepts `additionalContext` on a before-tool result, but
  // Cursor's preToolUse output carries only a permission or an input rewrite,
  // so the field is delivered on Claude and Codex alone.
  ...hosts.flatMap((host) => beforeToolContextShapes.map((shape) => `${host}:beforeTool:${shape}`)),
  // Claude and Codex project `additionalContext` on SubagentStart; Cursor has no channel for it.
  'claude:agentStart:{"additionalContext":"context"}',
  'claude:agentStart:{"additionalContext":"context","outcome":"continue"}',
  'codex:agentStart:{"additionalContext":"context"}',
  'codex:agentStart:{"additionalContext":"context","outcome":"continue"}',
  // Claude carries `additionalContext` on SubagentStop; Codex and Cursor reject it.
  'claude:agentStop:{"additionalContext":"context"}',
  'claude:agentStop:{"additionalContext":"context","outcome":"continue"}',
  'claude:agentStop:{"additionalContext":"context","outcome":"deny","reason":"because"}',
  // Cursor's subagentStart accepts a denial (`permission: "deny"`); Claude and Codex do not.
  'cursor:agentStart:{"outcome":"deny","reason":"because"}',
]);

describe('the typed hook handler contract agrees with the generated wrappers (#488)', () => {
  it('covers exactly the canonical events some host maps to a plain hook, in both tables', () => {
    const mapped = new Set<string>();
    for (const host of hosts) for (const event of Object.keys(nativeEventNames(host))) mapped.add(event);
    expect([...hookHandlerEventNames].sort()).toEqual([...mapped].sort());
    for (const event of hookHandlerEventNames) expect(canonicalHookEvents).toContain(event);
    // `workspaceOpen` is canonical but served by an event route on every host, so it has no handler contract.
    expect(canonicalHookEvents).toContain('workspaceOpen');
    expect(hookHandlerEventNames).not.toContain('workspaceOpen');
    expect(Object.keys(hookResultContract).sort()).toEqual([...hookHandlerEventNames].sort());
    expect(Object.keys(hookEventFields).sort()).toEqual([...hookHandlerEventNames].sort());
    // A field is either required or optional, never both, and the lists are sorted for stable diffs.
    for (const event of hookHandlerEventNames) {
      const { optional, required } = hookEventFields[event];
      expect([...optional]).toEqual([...optional].sort());
      expect([...required]).toEqual([...required].sort());
      expect(optional.filter((field) => (required as readonly string[]).includes(field))).toEqual([]);
    }
  });

  it('admits exactly what every host wrapper accepts, apart from the documented host leniencies', () => {
    const accepted: string[] = [];
    const rejected: string[] = [];
    let compared = 0;
    for (const host of hosts) {
      for (const event of hookHandlerEventNames) {
        const wrapper = wrapperFor(host, event);
        if (wrapper === undefined) continue;
        for (const shape of resultShapes()) {
          compared += 1;
          const key = `${host}:${event}:${JSON.stringify(shape)}`;
          const admitted = admittedByContract(event, shape);
          const runtime = accepts(wrapper, shape);
          // Soundness: everything the type admits, every host's wrapper accepts.
          if (admitted && !runtime) rejected.push(key);
          // Tightness: what the type excludes, the wrapper rejects too — or it is a listed host leniency.
          if (!admitted && runtime) accepted.push(key);
        }
      }
    }
    expect(compared).toBe(3 * 6 * 32);
    expect(rejected).toEqual([]);
    expect(new Set(accepted)).toEqual(hostLeniencies);
  });

  it('decodes every host fixture into the field set the payload types declare', () => {
    let compared = 0;
    for (const host of hosts) {
      for (const [event, nativeEvent] of Object.entries(nativeEventNames(host)) as [HookHandlerEventName, string][]) {
        const wrapper = wrapperFor(host, event)!;
        // The starter carries what the shared event-route envelope validator
        // needs; the config-hook wrapper additionally requires Cursor's stop status.
        const native = {
          ...createNativeEventStarter(host, agentEventFor[event], nativeEvent),
          ...(host === 'cursor' && event === 'stop' ? { status: 'completed' } : {}),
        };
        expect(() => wrapper.validateNativeInput(native), `${host} ${event}`).not.toThrow();
        const decoded = wrapper.decodeNative(native);
        const present = Object.keys(decoded).filter((key) => decoded[key] !== undefined).sort();
        const { optional, required } = hookEventFields[event];
        const declared: readonly string[] = [...optional, ...required];
        expect(present.filter((key) => !declared.includes(key)), `${host} ${event} decodes undeclared fields`).toEqual([]);
        expect(required.filter((key) => !present.includes(key)), `${host} ${event} lacks required fields`).toEqual([]);
        expect(typeof decoded['sessionId']).toBe('string');
        compared += 1;
      }
    }
    expect(compared).toBe(3 * 6);
  });
});

// ---------------------------------------------------------------------------
// Compile-time agreement, checked by `pnpm typecheck`. `HookEvent<E>`'s keys
// are exactly the runtime field table's, with the same required/optional split;
// the handler type accepts every legal result and rejects each illegal one.

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type RequiredKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? never : K }[keyof T];
type OptionalKeys<T> = { [K in keyof T]-?: object extends Pick<T, K> ? K : never }[keyof T];

type PayloadKeysAgree = {
  [E in HookHandlerEventName]: Equal<RequiredKeys<HookEvent<E>>, HookEventFields[E]['required'][number]>
    & Equal<OptionalKeys<HookEvent<E>>, HookEventFields[E]['optional'][number]>;
};
const payloadKeysAgree: { [E in HookHandlerEventName]: true } = {
  afterTool: true,
  agentStart: true,
  agentStop: true,
  beforeTool: true,
  sessionStart: true,
  stop: true,
} satisfies PayloadKeysAgree;

const legalHandlers = {
  afterToolContext: ((event) => ({ additionalContext: `${event.toolName} finished` })) satisfies HookHandler<'afterTool'>,
  agentStopDeny: (() => ({ outcome: 'deny', reason: 'keep going' })) satisfies HookHandler<'agentStop'>,
  beforeToolDeny: ((event) => ({ outcome: 'deny', reason: `${event.toolName} is not allowed` })) satisfies HookHandler<'beforeTool'>,
  beforeToolRewrite: ((event) => ({ updatedInput: { dryRun: true, tool: event.toolName } })) satisfies HookHandler<'beforeTool'>,
  sessionStartAsync: (async (event, context) => ({ additionalContext: `${context.target}: ${event.sessionId}`, outcome: 'continue' })) satisfies HookHandler<'sessionStart'>,
  sessionStartVoid: (() => undefined) satisfies HookHandler<'sessionStart'>,
  stopDeny: ((event) => (event.stopHookActive ? undefined : { outcome: 'deny', reason: 'one more pass' })) satisfies HookHandler<'stop'>,
};

const illegalResults = {
  // @ts-expect-error — sessionStart cannot deny.
  sessionStartDeny: { outcome: 'deny', reason: 'x' } satisfies HookResult<'sessionStart'>,
  // @ts-expect-error — no event admits `stop`.
  beforeToolStop: { outcome: 'stop' } satisfies HookResult<'beforeTool'>,
  // @ts-expect-error — `reason` is legal only beside `deny`.
  continueWithReason: { outcome: 'continue', reason: 'x' } satisfies HookResult<'beforeTool'>,
  // @ts-expect-error — a denial needs a reason.
  denyWithoutReason: { outcome: 'deny' } satisfies HookResult<'beforeTool'>,
  // @ts-expect-error — `updatedInput` is never legal while denying.
  denyWithUpdatedInput: { outcome: 'deny', reason: 'x', updatedInput: {} } satisfies HookResult<'beforeTool'>,
  // @ts-expect-error — stop carries no additionalContext.
  stopWithContext: { additionalContext: 'x' } satisfies HookResult<'stop'>,
  // @ts-expect-error — only beforeTool may replace input.
  sessionStartUpdatedInput: { updatedInput: {} } satisfies HookResult<'sessionStart'>,
  // @ts-expect-error — agentStart has no portable additionalContext channel.
  agentStartContext: { additionalContext: 'x' } satisfies HookResult<'agentStart'>,
  // @ts-expect-error — Cursor's preToolUse output has no context channel, so beforeTool context is not portable.
  beforeToolContext: { additionalContext: 'x' } satisfies HookResult<'beforeTool'>,
  // @ts-expect-error — workspaceOpen is not a config hook event on any host.
  workspaceOpenHandler: (() => undefined) satisfies HookHandler<'workspaceOpen'>,
};

it('keeps the compile-time checks referenced', () => {
  expect(Object.keys(payloadKeysAgree)).toHaveLength(hookHandlerEventNames.length);
  expect(Object.keys(legalHandlers)).toHaveLength(7);
  expect(Object.keys(illegalResults)).toHaveLength(10);
});
