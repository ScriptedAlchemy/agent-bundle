import { expect, it } from '@rstest/core';

import { isHostSessionId } from '../src/contracts/host-sessions.ts';
import { hostMcpProxyRequestInit, HOST_MCP_DEV_PID_HEADER, HOST_MCP_DEV_SESSION_HEADER } from '../src/dev/host-mcp-proxy.ts';
import { HOST_MCP_DEV_SESSION_CODE, hostDevProcessId, hostDevSessionId } from '../src/dev/host-mcp-routes.ts';
import { isRequestDiagnostic } from '../src/dev/http.ts';

const hostSessionId = 'hs_0123456789abcdef';

it('accepts only hs_ + 16 lowercase characters as a host-session id', () => {
  expect(isHostSessionId(hostSessionId)).toBe(true);
  expect(isHostSessionId('hs_abcdefghijklmnop')).toBe(true);
  expect(isHostSessionId('hs_ABCDEFGHIJKLMNOP')).toBe(false);
  expect(isHostSessionId('hs_short')).toBe(false);
  expect(isHostSessionId('session-1')).toBe(false);
});

it('reads a valid x-agent-bundle-dev-session header and rejects a malformed value with AB8266', () => {
  expect(hostDevSessionId({})).toBeUndefined();
  expect(hostDevSessionId({ [HOST_MCP_DEV_SESSION_HEADER]: hostSessionId })).toBe(hostSessionId);
  let caught: unknown;
  try {
    hostDevSessionId({ [HOST_MCP_DEV_SESSION_HEADER]: 'hs_nope' });
  } catch (error) {
    caught = error;
  }
  expect(isRequestDiagnostic(caught)).toBe(true);
  expect(caught).toMatchObject({ code: HOST_MCP_DEV_SESSION_CODE, status: 400 });
});

it('always names the proxy pid and adds the session header only for a valid AGENT_BUNDLE_DEV_SESSION', () => {
  expect(hostMcpProxyRequestInit({}, 4242)).toEqual({ requestInit: { headers: { [HOST_MCP_DEV_PID_HEADER]: '4242' } } });
  expect(hostMcpProxyRequestInit({ AGENT_BUNDLE_DEV_SESSION: 'hs_nope' }, 4242)).toEqual({
    requestInit: { headers: { [HOST_MCP_DEV_PID_HEADER]: '4242' } },
  });
  expect(hostMcpProxyRequestInit({ AGENT_BUNDLE_DEV_SESSION: hostSessionId }, 4242)).toEqual({
    requestInit: { headers: { [HOST_MCP_DEV_PID_HEADER]: '4242', [HOST_MCP_DEV_SESSION_HEADER]: hostSessionId } },
  });
});

it('reads x-agent-bundle-dev-pid as a process id and rejects anything else with AB8266', () => {
  expect(hostDevProcessId({})).toBeUndefined();
  expect(hostDevProcessId({ [HOST_MCP_DEV_PID_HEADER]: '4242' })).toBe(4242);
  for (const value of ['0', '-1', '12a', '01']) {
    let caught: unknown;
    try {
      hostDevProcessId({ [HOST_MCP_DEV_PID_HEADER]: value });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: HOST_MCP_DEV_SESSION_CODE, status: 400 });
  }
});
