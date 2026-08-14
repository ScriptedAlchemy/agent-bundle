import { expect, it } from '@rstest/core';

import { resolveMcpAppHostProfile } from '../src/dev/mcp-app-host-profiles.ts';

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

it('creates an immutable portable standard context without selecting legacy OpenAI metadata', () => {
  const resolution = resolveMcpAppHostProfile({
    host: standardContext,
    profile: 'portable',
    resource: {
      mimeType: 'text/html;profile=mcp-app',
      uri: 'ui://weather/forecast.html',
    },
    toolMetadata: { 'openai/outputTemplate': 'ui://legacy/template.html' },
  });

  expect(resolution).toMatchObject({
    hostContext: standardContext,
    kind: 'apps',
    permissions: {},
    profile: 'portable',
    resourceUri: 'ui://weather/forecast.html',
  });
  expect('extensions' in resolution).toBe(false);
  expect(JSON.stringify(resolution)).not.toContain('openai/outputTemplate');
  expect(Object.isFrozen(resolution)).toBe(true);
  if (resolution.kind === 'apps') {
    expect(Object.isFrozen(resolution.hostContext)).toBe(true);
    expect(Object.isFrozen(resolution.hostContext.styles)).toBe(true);
    expect(Object.isFrozen(resolution.hostContext.styles.variables)).toBe(true);
  }
});

it('adds ChatGPT widget state only when the window.openai feature is supplied', () => {
  const widgetState = { selectedDay: '2026-08-14' };
  const resolution = resolveMcpAppHostProfile({
    chatgpt: { windowOpenAi: { widgetState } },
    host: { ...standardContext, userAgent: 'Claude Desktop compatibility test' },
    profile: 'chatgpt',
    resource: { mimeType: 'text/html;profile=mcp-app', uri: 'ui://weather/forecast.html' },
  });

  widgetState.selectedDay = 'mutated-after-resolution';

  expect(resolution.kind).toBe('apps');
  if (resolution.kind === 'apps') {
    expect(resolution.extensions).toEqual({ windowOpenAi: { widgetState: { selectedDay: '2026-08-14' } } });
    expect(Object.isFrozen(resolution.extensions)).toBe(true);
    expect(Object.isFrozen(resolution.extensions?.windowOpenAi)).toBe(true);
    expect(JSON.stringify(resolution)).not.toContain('openai/widget');
  }
});

it('computes the Claude Apps domain from an exact canonical public HTTPS MCP URL', () => {
  const resolution = resolveMcpAppHostProfile({
    claude: { publicMcpUrl: 'https://mcp.example.com/v1/mcp' },
    host: standardContext,
    profile: 'claude',
    resource: { mimeType: 'text/html;profile=mcp-app', uri: 'ui://weather/forecast.html' },
  });

  expect(resolution.kind).toBe('apps');
  if (resolution.kind === 'apps') {
    expect(resolution.extensions?.claude?.domain).toBe('6881888a0d5873fdb447c2edb4faa4b7.claudemcpcontent.com');
    expect(Object.isFrozen(resolution.extensions?.claude)).toBe(true);
  }
});

it('returns an immutable structured fallback when the Apps resource is unavailable', () => {
  const resolution = resolveMcpAppHostProfile({
    host: standardContext,
    profile: 'portable',
    resource: { available: false },
  });

  expect(resolution).toMatchObject({
    kind: 'fallback',
    permissions: {},
    reason: 'apps-resource-unavailable',
    warnings: [],
  });
  expect(Object.isFrozen(resolution)).toBe(true);
  expect(Object.isFrozen(resolution.permissions)).toBe(true);
  expect(Object.isFrozen(resolution.warnings)).toBe(true);
});

it('returns a structured fallback when the Apps resource is not an MCP App HTML resource', () => {
  const resolution = resolveMcpAppHostProfile({
    host: standardContext,
    profile: 'portable',
    resource: { mimeType: 'text/html', uri: 'ui://weather/forecast.html' },
  });

  expect(resolution).toMatchObject({ kind: 'fallback', reason: 'apps-resource-invalid' });
});

it('grants only capabilities that are both declared and explicitly consented', () => {
  const resolution = resolveMcpAppHostProfile({
    consentedCapabilities: ['camera', 'microphone'],
    declaredCapabilities: ['camera', 'geolocation'],
    host: standardContext,
    profile: 'portable',
    resource: { mimeType: 'text/html;profile=mcp-app', uri: 'ui://weather/forecast.html' },
  });

  expect(resolution).toMatchObject({ kind: 'apps', permissions: { camera: {} } });
  expect(Object.isFrozen(resolution.permissions)).toBe(true);
  expect(Object.isFrozen(resolution.permissions.camera)).toBe(true);
});

it('rejects wildcard capability declarations with a conservative fallback warning', () => {
  const resolution = resolveMcpAppHostProfile({
    consentedCapabilities: ['camera'],
    declaredCapabilities: ['*'],
    host: standardContext,
    profile: 'portable',
    resource: { mimeType: 'text/html;profile=mcp-app', uri: 'ui://weather/forecast.html' },
  });

  expect(resolution).toMatchObject({
    kind: 'fallback',
    reason: 'unsafe-capability-declaration',
    warnings: ['Wildcard MCP App capability declarations are rejected.'],
  });
});

it('rejects wildcard capability patterns with the same conservative fallback', () => {
  const resolution = resolveMcpAppHostProfile({
    consentedCapabilities: ['camera'],
    declaredCapabilities: ['camera:*'],
    host: standardContext,
    profile: 'portable',
    resource: { mimeType: 'text/html;profile=mcp-app', uri: 'ui://weather/forecast.html' },
  });

  expect(resolution).toMatchObject({
    kind: 'fallback',
    reason: 'unsafe-capability-declaration',
    warnings: ['Wildcard MCP App capability declarations are rejected.'],
  });
});

it('keeps the Claude profile standard-only when no public MCP URL is supplied', () => {
  const resolution = resolveMcpAppHostProfile({
    host: standardContext,
    profile: 'claude',
    resource: { mimeType: 'text/html;profile=mcp-app', uri: 'ui://weather/forecast.html' },
  });

  expect(resolution).toMatchObject({ kind: 'apps', profile: 'claude' });
  if (resolution.kind === 'apps') expect(resolution.extensions).toBeUndefined();
});

it('omits the Claude domain for noncanonical or nonpublic MCP URLs', () => {
  for (const publicMcpUrl of [
    'http://mcp.example.com/v1/mcp',
    'https://localhost/v1/mcp',
    'https://localhost./v1/mcp',
    'https://foo.localhost./v1/mcp',
    'https://127.0.0.1/v1/mcp',
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
    'https://mcp.example.com:443/v1/mcp',
  ]) {
    const resolution = resolveMcpAppHostProfile({
      claude: { publicMcpUrl },
      host: standardContext,
      profile: 'claude',
      resource: { mimeType: 'text/html;profile=mcp-app', uri: 'ui://weather/forecast.html' },
    });

    expect(resolution.kind).toBe('apps');
    if (resolution.kind === 'apps') expect(resolution.extensions).toBeUndefined();
  }
});

it('computes a Claude domain for a canonical public IPv6 MCP URL', () => {
  const resolution = resolveMcpAppHostProfile({
    claude: { publicMcpUrl: 'https://[2606:4700:4700::1111]/v1/mcp' },
    host: standardContext,
    profile: 'claude',
    resource: { mimeType: 'text/html;profile=mcp-app', uri: 'ui://weather/forecast.html' },
  });

  expect(resolution).toMatchObject({
    kind: 'apps',
    profile: 'claude',
  });
  if (resolution.kind === 'apps') {
    expect(resolution.extensions?.claude?.domain).toBe('c3470553c91881a4d8ff703680224ea5.claudemcpcontent.com');
  }
});

it('does not retain caller-owned nested standard context data', () => {
  const host = {
    ...standardContext,
    deviceCapabilities: { screen: { width: 520 }, touch: false },
    styles: { variables: { '--color': '#fff' } },
  };
  const resolution = resolveMcpAppHostProfile({
    host,
    profile: 'portable',
    resource: { mimeType: 'text/html;profile=mcp-app', uri: 'ui://weather/forecast.html' },
  });

  host.deviceCapabilities.screen = { width: 1 };
  host.styles.variables['--color'] = '#000';

  if (resolution.kind !== 'apps') throw new Error('expected an Apps host profile');
  expect(resolution.hostContext.deviceCapabilities).toEqual({ screen: { width: 520 }, touch: false });
  expect(resolution.hostContext.styles).toEqual({ variables: { '--color': '#fff' } });
  expect(Object.isFrozen(resolution.hostContext.deviceCapabilities.screen)).toBe(true);
});
