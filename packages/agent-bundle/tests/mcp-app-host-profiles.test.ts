import { expect, it } from '@rstest/core';
import { runInNewContext } from 'node:vm';

import { createDefaultRegistry } from '../src/adapters/registry.ts';
import { normalizeProject } from '../src/config/index.ts';
import type { NormalizedPlugin } from '../src/core/types.ts';
import {
  inspectMcpAppConfigExtensions,
  MCP_APP_PROFILE_DESCRIPTORS,
  resolveMcpAppHostProfile,
} from '../src/dev/mcp-app-host-profiles.ts';

const projectRoot = '/workspace/weather';

const standardContext = Object.freeze({
  availableDisplayModes: ['inline', 'fullscreen'] as const,
  containerDimensions: { height: 360, width: 520 },
  deviceCapabilities: { touch: false },
  displayMode: 'inline' as const,
  locale: 'en-US',
  platform: 'web',
  safeAreaInsets: { bottom: 4, left: 1, right: 2, top: 3 },
  styles: { variables: { '--color': '#fff' } },
  theme: 'dark' as const,
  timeZone: 'UTC',
  toolInfo: { name: 'show-weather' },
  userAgent: 'host-test/1.0',
});

const resource = Object.freeze({
  mimeType: 'text/html;profile=mcp-app',
  uri: 'ui://weather/forecast.html',
});

const apps = (value: ReturnType<typeof resolveMcpAppHostProfile>) => {
  if (value.kind !== 'apps') throw new Error('expected an Apps host profile');
  return value;
};

const profileShape = (value: ReturnType<typeof resolveMcpAppHostProfile>) => {
  const resolved = apps(value);
  return {
    bootstrap: resolved.bootstrap,
    descriptor: resolved.descriptor,
    metadata: resolved.metadata,
    permissions: resolved.permissions,
    warnings: resolved.warnings,
  };
};

const descriptors = createDefaultRegistry().configExtensions();

const configuredExtensions = (keys: readonly ('claude' | 'codex')[]): NormalizedPlugin['extensions'] =>
  Object.freeze(Object.fromEntries(keys.map((key) => [key, Object.freeze({
    id: `extension:${key}`,
    key,
    provenance: Object.freeze({ kind: 'config' as const, sourcePath: `${projectRoot}/agent-bundle.config.ts` }),
    target: key,
    value: Object.freeze({ nativeHooks: 'do-not-leak', privatePath: '/private/adapter-owned-value' }),
  })])));

const config = (extensions: NormalizedPlugin['extensions']) => Object.freeze({
  descriptors,
  extensions,
  projectRoot,
  sourceRevision: 'project-r42',
});

const normalizedExtensions = async (extensions: Readonly<Record<string, unknown>>) =>
  (await normalizeProject({
    config: {
      ...extensions,
      plugin: { name: 'host-profile-normalized-config', version: '1.0.0' },
    },
    configPath: `${projectRoot}/agent-bundle.config.ts`,
    context: {
      command: 'build',
      mode: 'production',
      projectRoot,
      selectedTargets: [],
    },
  }, { skills: [] }, createDefaultRegistry())).extensions;

it('publishes frozen, versioned simulated descriptors and a fixed profile matrix', () => {
  const cases = [
    ['portable', undefined, 'none', undefined],
    ['chatgpt', undefined, 'chatgpt-widget-state-v1', undefined],
    ['claude', { publicMcpUrl: 'https://mcp.weather.example/v1' }, 'none', '5b1bc18b3cdb31bee3b9a12490be07ec.claudemcpcontent.com'],
  ] as const;

  for (const [profile, claude, bootstrapKind, expectedDomain] of cases) {
    const resolution = apps(resolveMcpAppHostProfile({ claude, host: standardContext, profile, resource }));
    expect(resolution.descriptor).toBe(MCP_APP_PROFILE_DESCRIPTORS[profile]);
    expect(resolution.descriptor.evidence).toBe('simulated');
    expect(resolution.descriptor.claimsRealHostParity).toBe(false);
    expect(resolution.descriptor.label.includes('Simulation')).toBe(profile !== 'portable');
    expect(resolution.bootstrap.kind).toBe(bootstrapKind);
    expect(resolution.metadata.claudeDomain?.expectedDomain).toBe(expectedDomain);
  }

  expect(Object.isFrozen(MCP_APP_PROFILE_DESCRIPTORS)).toBe(true);
  expect(Object.isFrozen(MCP_APP_PROFILE_DESCRIPTORS.chatgpt)).toBe(true);
});

it('uses a fixed dormant ChatGPT bootstrap without creating vendor globals', () => {
  const first = apps(resolveMcpAppHostProfile({ host: standardContext, profile: 'chatgpt', resource }));
  const second = apps(resolveMcpAppHostProfile({
    chatgpt: { windowOpenAi: { widgetState: { injected: true } } },
    host: { ...standardContext, userAgent: 'unrelated-host-agent/99' },
    profile: 'chatgpt',
    resource,
    toolMetadata: { 'openai/widgetDescription': 'raw metadata cannot activate the simulation' },
  }));

  expect(first.bootstrap).toEqual(second.bootstrap);
  expect(first.bootstrap).toMatchObject({ kind: 'chatgpt-widget-state-v1', script: expect.any(String) });
  expect(first.bootstrap.script).toContain('agent-bundle:mcp-app:chatgpt-widget-state-v1');
  expect(first.bootstrap.script).not.toContain('window.claude');
  expect(first.bootstrap.script).not.toContain('window.openai =');
  expect(first.metadata.extensions.openai).toEqual({});
  expect(second.metadata.extensions.openai).toEqual({ 'openai/widgetDescription': 'raw metadata cannot activate the simulation' });
});

it('activates the fixed ChatGPT bootstrap only over its closed binding channel and rolls back rejected persistence', () => {
  const bootstrap = apps(resolveMcpAppHostProfile({ host: standardContext, profile: 'chatgpt', resource })).bootstrap.script;
  if (bootstrap === undefined) throw new Error('expected ChatGPT bootstrap script');
  const listeners: ((event: unknown) => void)[] = [];
  const outbound: { readonly message: unknown; readonly targetOrigin: string }[] = [];
  const parent = Object.freeze({
    postMessage(message: unknown, targetOrigin: string): void {
      outbound.push(Object.freeze({ message, targetOrigin }));
    },
  });
  const sandbox: Record<string, unknown> = {
    addEventListener(type: string, listener: (event: unknown) => void): void {
      if (type === 'message') listeners.push(listener);
    },
    parent,
  };
  sandbox.globalThis = sandbox;
  runInNewContext(bootstrap, sandbox);

  expect(Object.hasOwn(sandbox, 'openai')).toBe(false);
  const deliver = (data: unknown, isTrusted = true): void => {
    for (const listener of listeners) {
      listener(Object.freeze({ data, isTrusted, origin: 'https://host.example', source: parent }));
    }
  };
  const activation = Object.freeze({
    bindingId: 'binding-7',
    capability: 'closed-capability-7',
    initialState: Object.freeze({ day: 'monday' }),
    type: 'agent-bundle:mcp-app:chatgpt-widget-state-v1/activate',
  });
  deliver(activation, false);
  expect(Object.hasOwn(sandbox, 'openai')).toBe(false);
  deliver(activation);

  const openai = sandbox.openai as {
    readonly widgetState: unknown;
    readonly setWidgetState: (next: unknown) => void;
  };
  expect(openai.widgetState).toEqual({ day: 'monday' });
  const hostile = { text: '</script><script>globalThis.compromised = true</script>' };
  expect(openai.setWidgetState(hostile)).toBeUndefined();
  hostile.text = 'mutated-after-set';
  expect(openai.widgetState).toEqual({ text: '</script><script>globalThis.compromised = true</script>' });
  expect(sandbox.compromised).toBeUndefined();
  expect(outbound).toHaveLength(1);
  expect(outbound[0]).toMatchObject({
    message: {
      bindingId: 'binding-7',
      capability: 'closed-capability-7',
      state: { text: '</script><script>globalThis.compromised = true</script>' },
      type: 'agent-bundle:mcp-app:chatgpt-widget-state-v1/persist',
    },
    targetOrigin: 'https://host.example',
  });

  const request = outbound[0]!.message as { readonly requestId: string | number };
  deliver(Object.freeze({
    accepted: false,
    bindingId: 'binding-7',
    capability: 'closed-capability-7',
    requestId: request.requestId,
    type: 'agent-bundle:mcp-app:chatgpt-widget-state-v1/persisted',
  }));
  expect(openai.widgetState).toEqual({ day: 'monday' });
  expect(outbound).toHaveLength(2);
  expect(outbound[1]).toMatchObject({
    message: {
      bindingId: 'binding-7',
      code: 'widget-state-persistence-rejected',
      type: 'agent-bundle:mcp-app:chatgpt-widget-state-v1/diagnostic',
    },
    targetOrigin: 'https://host.example',
  });
});

it('ignores unauthenticated persisted replies and recomputes overlapping optimistic widget states', () => {
  const launch = () => {
    const bootstrap = apps(resolveMcpAppHostProfile({ host: standardContext, profile: 'chatgpt', resource })).bootstrap.script;
    if (bootstrap === undefined) throw new Error('expected ChatGPT bootstrap script');
    const listeners: ((event: unknown) => void)[] = [];
    const outbound: { readonly message: Record<string, unknown>; readonly targetOrigin: string }[] = [];
    const parent = Object.freeze({
      postMessage(message: Record<string, unknown>, targetOrigin: string): void {
        outbound.push(Object.freeze({ message, targetOrigin }));
      },
    });
    const sandbox: Record<string, unknown> = {
      addEventListener(type: string, listener: (event: unknown) => void): void {
        if (type === 'message') listeners.push(listener);
      },
      parent,
    };
    sandbox.globalThis = sandbox;
    runInNewContext(bootstrap, sandbox);
    const deliver = (
      data: Record<string, unknown>,
      options: { isTrusted?: boolean; origin?: string; source?: unknown } = {},
    ): void => {
      for (const listener of listeners) {
        listener(Object.freeze({
          data,
          isTrusted: options.isTrusted ?? true,
          origin: options.origin ?? 'https://host.example',
          source: options.source ?? parent,
        }));
      }
    };
    deliver(Object.freeze({
      bindingId: 'binding-race',
      capability: 'closed-capability-race',
      initialState: Object.freeze({ phase: 'base' }),
      type: 'agent-bundle:mcp-app:chatgpt-widget-state-v1/activate',
    }));
    const openai = sandbox.openai as {
      readonly widgetState: unknown;
      readonly setWidgetState: (next: unknown) => void;
    };
    const update = (state: Record<string, unknown>): Record<string, unknown> => {
      openai.setWidgetState(state);
      return outbound.at(-1)!.message;
    };
    const reply = (
      request: Record<string, unknown>,
      accepted: boolean,
      options: { bindingId?: string; capability?: string; isTrusted?: boolean; origin?: string; source?: unknown } = {},
    ): void => {
      deliver(Object.freeze({
        accepted,
        bindingId: options.bindingId ?? 'binding-race',
        capability: options.capability ?? 'closed-capability-race',
        requestId: request.requestId,
        type: 'agent-bundle:mcp-app:chatgpt-widget-state-v1/persisted',
      }), options);
    };
    return { openai, outbound, parent, reply, update };
  };

  const provenance = launch();
  const request = provenance.update({ phase: 'pending' });
  for (const options of [
    { origin: 'https://wrong.example' },
    { source: Object.freeze({}) },
    { bindingId: 'wrong-binding' },
    { capability: 'wrong-capability' },
    { isTrusted: false },
  ]) {
    provenance.reply(request, false, options);
    expect(provenance.openai.widgetState).toEqual({ phase: 'pending' });
    expect(provenance.outbound).toHaveLength(1);
  }
  provenance.reply(request, false);
  expect(provenance.openai.widgetState).toEqual({ phase: 'base' });
  expect(provenance.outbound).toHaveLength(2);

  const rejectFirst = launch();
  const aFirst = rejectFirst.update({ phase: 'A' });
  const bFirst = rejectFirst.update({ phase: 'B' });
  rejectFirst.reply(aFirst, false);
  expect(rejectFirst.openai.widgetState).toEqual({ phase: 'B' });
  rejectFirst.reply(bFirst, false);
  expect(rejectFirst.openai.widgetState).toEqual({ phase: 'base' });

  const rejectSecond = launch();
  const aSecond = rejectSecond.update({ phase: 'A' });
  const bSecond = rejectSecond.update({ phase: 'B' });
  rejectSecond.reply(bSecond, false);
  expect(rejectSecond.openai.widgetState).toEqual({ phase: 'A' });
  rejectSecond.reply(aSecond, false);
  expect(rejectSecond.openai.widgetState).toEqual({ phase: 'base' });

  const staleReject = launch();
  const staleA = staleReject.update({ phase: 'A' });
  const staleB = staleReject.update({ phase: 'B' });
  staleReject.reply(staleB, true);
  expect(staleReject.openai.widgetState).toEqual({ phase: 'B' });
  staleReject.reply(staleA, false);
  expect(staleReject.openai.widgetState).toEqual({ phase: 'B' });
  expect(staleReject.outbound.filter(({ message }) => message.type === 'agent-bundle:mcp-app:chatgpt-widget-state-v1/diagnostic')).toHaveLength(1);
});

it('keeps profile behavior independent of user agent and registered config presence', () => {
  const withoutConfig = resolveMcpAppHostProfile({ host: standardContext, profile: 'chatgpt', resource });
  const withCodexConfig = resolveMcpAppHostProfile({
    configExtensions: config(configuredExtensions(['codex'])),
    host: { ...standardContext, userAgent: 'Claude Desktop compatibility test' },
    profile: 'chatgpt',
    resource,
  });
  expect(profileShape(withCodexConfig)).toEqual(profileShape(withoutConfig));

  const claude = { publicMcpUrl: 'https://mcp.weather.example/v1' };
  const withoutClaudeConfig = resolveMcpAppHostProfile({ claude, host: standardContext, profile: 'claude', resource });
  const withClaudeConfig = resolveMcpAppHostProfile({
    claude,
    configExtensions: config(configuredExtensions(['claude'])),
    host: standardContext,
    profile: 'claude',
    resource,
  });
  const plain = apps(withoutClaudeConfig);
  const configured = apps(withClaudeConfig);
  expect(configured.hostContext).toEqual(plain.hostContext);
  expect(configured.metadata).toEqual(plain.metadata);
  expect(configured.permissions).toEqual(plain.permissions);
  expect(configured.bootstrap).toEqual(plain.bootstrap);
});

it('derives Claude domain from the canonical complete public MCP URL only inside metadata', () => {
  const canonical = apps(resolveMcpAppHostProfile({
    claude: { publicMcpUrl: 'https://mcp.weather.example:443/v1?forecast=today' },
    host: standardContext,
    profile: 'claude',
    resource: {
      ...resource,
      metadata: { ui: { domain: 'declared.weather.example' } },
    },
  }));
  const sameCanonicalUrl = apps(resolveMcpAppHostProfile({
    claude: { publicMcpUrl: 'https://mcp.weather.example/v1?forecast=today' },
    host: standardContext,
    profile: 'claude',
    resource,
  }));
  const differentPath = apps(resolveMcpAppHostProfile({
    claude: { publicMcpUrl: 'https://mcp.weather.example/v2?forecast=today' },
    host: standardContext,
    profile: 'claude',
    resource,
  }));

  expect(canonical.metadata.claudeDomain).toEqual({
    declaredDomain: 'declared.weather.example',
    expectedDomain: '16d6f2ce55158df412c9709030c3823c.claudemcpcontent.com',
    provenance: 'sha256-canonical-full-mcp-url',
  });
  expect(canonical.warnings).toContain('Declared MCP App ui.domain does not match the derived Claude domain.');
  expect(canonical.metadata.claudeDomain?.expectedDomain).toBe(sameCanonicalUrl.metadata.claudeDomain?.expectedDomain);
  expect(canonical.metadata.claudeDomain?.expectedDomain).not.toBe(differentPath.metadata.claudeDomain?.expectedDomain);
  expect(JSON.stringify(canonical.hostContext)).not.toContain('claudemcpcontent.com');
  expect(JSON.stringify(canonical.hostContext)).not.toContain('declared.weather.example');
});

it('warns and omits the Claude overlay for malformed, private, local, credentialed, or fragment URLs', () => {
  for (const publicMcpUrl of [
    'http://mcp.weather.example/v1',
    'https://localhost/v1',
    'https://127.0.0.1/v1',
    'https://user:password@mcp.weather.example/v1',
    'https://mcp.weather.example/v1#fragment',
    'not a URL',
  ]) {
    const resolution = apps(resolveMcpAppHostProfile({
      claude: { publicMcpUrl },
      host: standardContext,
      profile: 'claude',
      resource,
    }));
    expect(resolution.metadata.claudeDomain).toBeUndefined();
    expect(resolution.warnings).toContain('Claude simulation requires a canonical public HTTPS MCP URL.');
  }
});

it('keeps special-purpose IP ranges out of the Claude public-URL overlay', () => {
  for (const publicMcpUrl of [
    'https://100.64.0.1/v1/mcp',
    'https://169.254.1.1/v1/mcp',
    'https://192.0.2.1/v1/mcp',
    'https://198.18.1.1/v1/mcp',
    'https://[::1]/v1/mcp',
    'https://[::ffff:c0a8:101]/v1/mcp',
    'https://[fe80::1]/v1/mcp',
    'https://[fc00::1]/v1/mcp',
    'https://[ff02::1]/v1/mcp',
    'https://[2001:db8::1]/v1/mcp',
    'https://[100:0:0:1::1]/mcp',
    'https://[3fff::1]/mcp',
  ]) {
    const resolution = apps(resolveMcpAppHostProfile({
      claude: { publicMcpUrl }, host: standardContext, profile: 'claude', resource,
    }));
    expect(resolution.metadata.claudeDomain).toBeUndefined();
  }

  const global = apps(resolveMcpAppHostProfile({
    claude: { publicMcpUrl: 'https://[2606:4700:4700::1111]/v1/mcp' },
    host: standardContext,
    profile: 'claude',
    resource,
  }));
  expect(global.metadata.claudeDomain?.expectedDomain).toBe('c3470553c91881a4d8ff703680224ea5.claudemcpcontent.com');
});

it('retains raw vendor metadata for inspection without allowing it to validate an invalid resource', () => {
  const valid = apps(resolveMcpAppHostProfile({
    host: standardContext,
    profile: 'portable',
    resource,
    toolMetadata: {
      'claude/preferredDomain': 'untrusted.example',
      'openai/outputTemplate': 'ui://legacy/template.html',
    },
  }));
  const invalid = resolveMcpAppHostProfile({
    host: standardContext,
    profile: 'portable',
    resource: { mimeType: 'text/html', uri: 'ui://weather/forecast.html' },
    toolMetadata: { 'openai/outputTemplate': 'ui://legacy/template.html' },
  });

  expect(valid.metadata.extensions).toEqual({
    claude: { 'claude/preferredDomain': 'untrusted.example' },
    openai: { 'openai/outputTemplate': 'ui://legacy/template.html' },
  });
  expect(invalid).toMatchObject({ kind: 'fallback', reason: 'apps-resource-invalid' });
});

it('projects only sorted frozen registered config identities and redacts adapter-owned values', () => {
  const inspection = inspectMcpAppConfigExtensions(config(configuredExtensions(['codex', 'claude'])));

  expect(inspection).toEqual({
    entries: [
      { configured: true, id: 'extension:claude', key: 'claude', provenance: { kind: 'config', sourcePath: 'agent-bundle.config.ts' }, target: 'claude' },
      { configured: true, id: 'extension:codex', key: 'codex', provenance: { kind: 'config', sourcePath: 'agent-bundle.config.ts' }, target: 'codex' },
    ],
    sourceRevision: 'project-r42',
  });
  expect(Object.isFrozen(inspection)).toBe(true);
  expect(Object.isFrozen(inspection.entries)).toBe(true);
  expect(Object.isFrozen(inspection.entries[0]!)).toBe(true);
  expect(JSON.stringify(inspection)).not.toContain('nativeHooks');
  expect(JSON.stringify(inspection)).not.toContain('private/adapter-owned-value');
  expect(JSON.stringify(inspection)).not.toContain(projectRoot);
});

it('accepts the normalizer’s deeply frozen null-prototype extension containers', async () => {
  const empty = await normalizedExtensions({});
  const configured = await normalizedExtensions({ claude: {}, codex: {} });

  expect(Object.getPrototypeOf(empty)).toBeNull();
  expect(Object.isFrozen(empty)).toBe(true);
  expect(inspectMcpAppConfigExtensions(config(empty)).entries).toEqual([]);
  expect(Object.getPrototypeOf(configured)).toBeNull();
  expect(Object.isFrozen(configured)).toBe(true);
  expect(inspectMcpAppConfigExtensions(config(configured)).entries.map((entry) => entry.key)).toEqual(['claude', 'codex']);
});

it('keeps empty configuration inert and rejects forged, unregistered, duplicate, or mismatched extension records', () => {
  const empty = inspectMcpAppConfigExtensions(config(Object.freeze({})));
  expect(empty.entries).toEqual([]);
  expect(Object.isFrozen(empty.entries)).toBe(true);

  const forged = Object.freeze({
    openai: Object.freeze({
      id: 'extension:openai', key: 'openai', provenance: Object.freeze({ kind: 'config' as const, sourcePath: `${projectRoot}/agent-bundle.config.ts` }), target: 'openai', value: { secret: true },
    }),
  }) as NormalizedPlugin['extensions'];
  expect(() => inspectMcpAppConfigExtensions(config(forged))).toThrow('not registered');

  const mismatched = Object.freeze({
    claude: Object.freeze({
      id: 'extension:wrong', key: 'claude', provenance: Object.freeze({ kind: 'config' as const, sourcePath: `${projectRoot}/agent-bundle.config.ts` }), target: 'claude', value: undefined,
    }),
  }) as NormalizedPlugin['extensions'];
  expect(() => inspectMcpAppConfigExtensions(config(mismatched))).toThrow('does not match');

  expect(() => inspectMcpAppConfigExtensions({
    ...config(Object.freeze({})),
    descriptors: Object.freeze([{ key: 'claude', target: 'claude' }, { key: 'claude', target: 'claude' }]),
  })).toThrow('duplicate');
});

it('redacts out-of-root config provenance and preserves immutable host context snapshots', () => {
  const inspection = inspectMcpAppConfigExtensions({
    ...config(configuredExtensions(['claude'])),
    extensions: Object.freeze({
      claude: Object.freeze({
        id: 'extension:claude', key: 'claude', provenance: Object.freeze({ kind: 'config' as const, sourcePath: '/outside/agent-bundle.config.ts' }), target: 'claude', value: undefined,
      }),
    }),
  });
  const host = {
    ...standardContext,
    deviceCapabilities: { screen: { width: 520 }, touch: false },
    styles: { variables: { '--color': '#fff' } },
  };
  const resolution = apps(resolveMcpAppHostProfile({ host, profile: 'portable', resource }));

  host.deviceCapabilities.screen = { width: 1 };
  host.styles.variables['--color'] = '#000';

  expect(inspection.entries[0]?.provenance.sourcePath).toBe('<external-config>');
  expect(resolution.hostContext.deviceCapabilities).toEqual({ screen: { width: 520 }, touch: false });
  expect(resolution.hostContext.styles).toEqual({ variables: { '--color': '#fff' } });
  expect(Object.isFrozen(resolution.hostContext.deviceCapabilities.screen)).toBe(true);
});

it('returns a structured frozen fallback and never grants wildcard capabilities', () => {
  const unavailable = resolveMcpAppHostProfile({ host: standardContext, profile: 'portable', resource: { available: false } });
  const unsafe = resolveMcpAppHostProfile({
    consentedCapabilities: ['camera'],
    declaredCapabilities: ['camera:*'],
    host: standardContext,
    profile: 'portable',
    resource,
  });

  expect(unavailable).toMatchObject({ kind: 'fallback', permissions: {}, reason: 'apps-resource-unavailable' });
  expect(unsafe).toMatchObject({
    kind: 'fallback',
    permissions: {},
    reason: 'unsafe-capability-declaration',
    warnings: ['Wildcard MCP App capability declarations are rejected.'],
  });
  expect(Object.isFrozen(unavailable)).toBe(true);
  expect(Object.isFrozen(unavailable.configExtensions.entries)).toBe(true);
});

it('grants only capabilities that are both declared and explicitly consented', () => {
  const resolution = apps(resolveMcpAppHostProfile({
    consentedCapabilities: ['camera', 'microphone'],
    declaredCapabilities: ['camera', 'geolocation'],
    host: standardContext,
    profile: 'portable',
    resource,
  }));

  expect(resolution.permissions).toEqual({ camera: {} });
  expect(Object.isFrozen(resolution.permissions)).toBe(true);
  expect(Object.isFrozen(resolution.permissions.camera)).toBe(true);
});
