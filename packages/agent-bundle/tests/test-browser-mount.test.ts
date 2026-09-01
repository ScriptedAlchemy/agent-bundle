import { afterEach, describe, expect, it } from '@rstest/core';

import {
  AGENT_BROWSER_TEST_REGISTRY_SYMBOL_KEY,
  AGENT_BROWSER_TEST_REGISTRY_VERSION,
  BROWSER_APP_PROOF_LEVEL,
} from '../src/test/browser-registry.ts';
import { mountBrowserApp } from '../src/test/browser.ts';

const registrySymbol = Symbol.for(AGENT_BROWSER_TEST_REGISTRY_SYMBOL_KEY);
const queuedHostMessageLimitBytes = 1_048_576;

interface TestIframe {
  contentDocument: null;
  contentWindow: null;
  referrerPolicy: string;
  remove(): void;
  setAttribute(name: string, value: string): void;
  srcdoc: string;
}

interface TestDocument {
  body: { append(node: TestIframe): void };
  createElement(tagName: string): TestIframe;
}

interface TestWindow {
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

type MutableRealm = {
  [registrySymbol]?: unknown;
  document?: TestDocument;
  window?: TestWindow;
};

const realmOf = (): MutableRealm => globalThis as unknown as MutableRealm;

const installRegistry = (): (() => void) => {
  const realm = realmOf();
  const previous = realm[registrySymbol];
  realm[registrySymbol] = {
    apps: {
      panel: {
        html: '<!DOCTYPE html><html><body></body></html>',
        name: 'panel',
        output: '/tmp/panel.html',
        proofLevel: BROWSER_APP_PROOF_LEVEL,
        resourceUri: 'ui://test/panel',
        serverIds: ['mcp:test'],
        target: 'portable',
      },
    },
    version: AGENT_BROWSER_TEST_REGISTRY_VERSION,
  };
  return () => {
    if (previous === undefined) delete realm[registrySymbol];
    else realm[registrySymbol] = previous;
  };
};

const installBrowserGlobals = (): (() => void) => {
  const realm = realmOf();
  const previous = { document: realm.document, window: realm.window };
  const iframe: TestIframe = {
    contentDocument: null,
    contentWindow: null,
    referrerPolicy: '',
    remove() {},
    setAttribute() {},
    srcdoc: '',
  };
  realm.document = {
    body: { append() {} },
    createElement: (tagName: string) => {
      if (tagName !== 'iframe') throw new Error(`unexpected element: ${tagName}`);
      return iframe;
    },
  };
  realm.window = {
    addEventListener() {},
    removeEventListener() {},
  };
  return () => {
    if (previous.document === undefined) delete realm.document;
    else realm.document = previous.document;
    if (previous.window === undefined) delete realm.window;
    else realm.window = previous.window;
  };
};

const restoreFns: Array<() => void> = [];

afterEach(() => {
  while (restoreFns.length > 0) restoreFns.pop()?.();
});

describe('mountBrowserApp', () => {
  it('force-closes the bridge when the initial tool result publication is rejected', async () => {
    restoreFns.push(installRegistry(), installBrowserGlobals());
    const closes: string[] = [];

    await expect(mountBrowserApp('panel', {
      operations: {
        callTool: async () => ({ content: [{ text: 'unused', type: 'text' }] }),
        closeBinding: async (bindingId) => {
          closes.push(bindingId);
          return true;
        },
        readResource: async () => ({ contents: [] }),
      },
      toolResult: {
        content: [{ text: 'x'.repeat(queuedHostMessageLimitBytes), type: 'text' }],
      },
    })).rejects.toThrow('The initial MCP App tool result was rejected.');

    expect(closes).toHaveLength(1);
  });
});
