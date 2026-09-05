import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { describe, expect, it } from '@rstest/core';

import type { RouteInvocation } from '../../agent-bundle/src/contracts/invocations.ts';
import {
  eventFixturesFor,
  eventHostTarget,
  eventRequestFor,
  EventRouteWorkspace,
  lifecycleForLeaf,
} from '../src/application/event-route-workspace.tsx';
import { idleInvocationState } from '../src/application/invocation-model.ts';
import type { RouteInvocationController } from '../src/application/workspace-contracts.ts';
import type { Lifecycle } from '../src/lifecycles/lifecycle-client.ts';
import { clients, eventLeaf, invocation, summaryOf } from './support/workspace-fixtures.ts';

const noop = (): void => undefined;

const lifecycle: Lifecycle = {
  diagnostics: [],
  event: 'tool/before',
  routeId: 'event:tool/before',
  routePath: 'src/events/tool/before.tsx',
  targets: [
    { fixture: { label: 'PreToolUse', native: { hook_event_name: 'PreToolUse', tool_name: 'Bash' } }, hostContractRevision: 'claude-1', nativeEvent: 'PreToolUse', target: 'claude' },
    { hostContractRevision: 'codex-1', nativeEvent: 'tool.before', target: 'codex' },
  ],
};

const hostInvocation: RouteInvocation = {
  ...invocation,
  event: {
    canonical: { tool: { name: 'Bash' } },
    event: 'tool/before',
    host: 'claude',
    native: { hook_event_name: 'PreToolUse', tool_name: 'Bash' },
  },
  id: 'inv-event',
  input: { tool: { name: 'Bash' } },
  kind: 'event-route',
  projection: {
    hosts: [{ diagnostics: [], host: 'claude', native: { decision: 'allow' } }],
  },
  routeId: 'event:tool/before',
};

const controller = (state: RouteInvocationController['state']): RouteInvocationController => ({
  backendKind: 'dev-server',
  history: [summaryOf(hostInvocation), summaryOf(invocation)],
  load: noop,
  run: noop,
  state,
});

describe('event fixtures', () => {
  it('finds the lifecycle for the leaf and one native fixture per host that serves one', () => {
    expect(lifecycleForLeaf([lifecycle], eventLeaf)).toBe(lifecycle);
    expect(lifecycleForLeaf([{ ...lifecycle, routeId: 'event:other' }], { ...eventLeaf, routeId: 'event:missing' })?.event).toBe('tool/before');
    expect(eventHostTarget(lifecycle, 'codex')?.nativeEvent).toBe('tool.before');
    expect(eventHostTarget(lifecycle, 'cursor')).toBeUndefined();

    const fixtures = eventFixturesFor(lifecycle);
    expect(fixtures).toEqual([{
      host: 'claude',
      id: 'claude:PreToolUse',
      input: { hook_event_name: 'PreToolUse', tool_name: 'Bash' },
      label: 'PreToolUse · Claude',
    }]);
    expect(eventFixturesFor(undefined)).toEqual([]);
  });

  it('attaches the host while submitting the editor payload directly', () => {
    const native = { hook_event_name: 'PreToolUse', tool_name: 'Bash' };
    expect(eventRequestFor('canonical', { input: { tool: {} } })).toEqual({ input: { tool: {} } });
    expect(eventRequestFor('claude', { input: native })).toEqual({ event: { host: 'claude' }, input: native });
    expect(eventRequestFor('claude', { input: { ...native, tool_name: 'Edit' } })).toEqual({
      event: { host: 'claude' },
      input: { ...native, tool_name: 'Edit' },
    });
  });
});

describe('EventRouteWorkspace', () => {
  it('leads with the host selector, keeps Rendered as the default result, and appends the codec tabs', () => {
    const markup = renderToStaticMarkup(createElement(EventRouteWorkspace, {
      clients: clients(),
      controller: controller(idleInvocationState),
      leaf: eventLeaf,
      onNavigate: noop,
    }));

    expect(markup).toContain('aria-label="Event host"');
    expect(markup).toContain('aria-pressed="true" data-testid="event-host-canonical"');
    expect(markup).toContain('aria-pressed="false" data-testid="event-host-claude" disabled=""');
    expect(markup).toContain('Loading host fixtures…');
    expect(markup).toContain('data-testid="result-tab-rendered"');
    expect(markup).toContain('Canonical → host mapping');
    expect(markup).toContain('Native in / out');
    expect(markup).toContain('Canonical result');
    expect(markup).toContain('>Replay</button>');
    expect(markup).toContain('data-testid="route-run"');
  });

  it('shows the native payload in, the host response out, and the canonical result for a host invocation', () => {
    const render = (tab: string): string => renderToStaticMarkup(createElement(EventRouteWorkspace, {
      clients: clients(),
      controller: controller({ invocation: hostInvocation, phase: 'succeeded' }),
      leaf: eventLeaf,
      onNavigate: noop,
      tab,
    }));

    const native = render('native');
    expect(native).toContain('Native in');
    expect(native).toContain('&quot;hook_event_name&quot;: &quot;PreToolUse&quot;');
    expect(native).toContain('&quot;decision&quot;: &quot;allow&quot;');

    const mapping = render('mapping');
    expect(mapping).toContain('tool/before');
    expect(mapping).toContain('Claude');
    expect(mapping).toContain('Canonical payload the route received');

    const canonical = render('canonical');
    expect(canonical).toContain('Document status');
    expect(canonical).toContain('&quot;candidates&quot;: 8');

    const replay = render('replay');
    expect(replay).toContain('Replay receipt');
    expect(replay).toContain('Observed host runs of this route');
    expect(replay).toContain('inv-event');
    expect(replay).not.toContain('>inv-1<');
  });
});
