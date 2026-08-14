import { expect, test } from '@rstest/core';

import { allowsOrigin, resolveHttpSecurityConfig } from '../src/mcp/http-security.js';

test('uses loopback defaults and only admits absent or same-origin browser requests', () => {
  const config = resolveHttpSecurityConfig({});

  expect(config.allowedHosts).toEqual(['127.0.0.1', 'localhost', '[::1]']);
  expect(config.allowedOrigins).toEqual([]);
  expect(allowsOrigin(config, '127.0.0.1:4312', undefined)).toBe(true);
  expect(allowsOrigin(config, '127.0.0.1:4312', 'http://127.0.0.1:4312')).toBe(true);
  expect(allowsOrigin(config, '127.0.0.1:4312', 'https://attacker.example')).toBe(false);
});

test('requires explicit public host and origin allowlists for a tunnel', () => {
  const config = resolveHttpSecurityConfig({
    AGENT_RUNTIME_ALLOWED_HOSTS: 'tunnel.example',
    AGENT_RUNTIME_ALLOWED_ORIGINS: 'https://tunnel.example',
  });

  expect(config.allowedHosts).toEqual(['127.0.0.1', 'localhost', '[::1]', 'tunnel.example']);
  expect(config.allowedOrigins).toEqual(['https://tunnel.example']);
  expect(allowsOrigin(config, 'tunnel.example', 'https://tunnel.example')).toBe(true);
  expect(allowsOrigin(config, 'tunnel.example', 'https://attacker.example')).toBe(false);
});
