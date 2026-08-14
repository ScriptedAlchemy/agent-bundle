import { expect, test } from '@rstest/core';
import React from 'react';

import { Mcp } from '../src/runtime/elements.js';
import { lowerMcpResult } from '../src/runtime/lower-mcp.js';

test('lowers every supported MCP result block in authored order', () => {
  const result = lowerMcpResult(
    <Mcp.Result structuredContent={{ stateVersion: 2 }} isError={false}>
      <Mcp.Text>two edits</Mcp.Text>
      <Mcp.Image data="iVBORw0KGgo=" mimeType="image/png" />
      <Mcp.Audio data="UklGRg==" mimeType="audio/wav" />
      <Mcp.ResourceLink uri="file:///demo.txt" name="demo.txt" mimeType="text/plain" />
      <Mcp.EmbeddedResource uri="runtime://snapshot" mimeType="application/json">
        {'{"stateVersion":2}'}
      </Mcp.EmbeddedResource>
    </Mcp.Result>,
  );

  expect(result).toEqual({
    content: [
      { type: 'text', text: 'two edits' },
      { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
      { type: 'audio', data: 'UklGRg==', mimeType: 'audio/wav' },
      {
        type: 'resource_link',
        uri: 'file:///demo.txt',
        name: 'demo.txt',
        mimeType: 'text/plain',
      },
      {
        type: 'resource',
        resource: {
          uri: 'runtime://snapshot',
          mimeType: 'application/json',
          text: '{"stateVersion":2}',
        },
      },
    ],
    structuredContent: { stateVersion: 2 },
    isError: false,
  });
});

test('rejects malformed or nested MCP protocol result trees', () => {
  expect(() =>
    lowerMcpResult(
      <Mcp.Result>
        {<Mcp.Image data="" mimeType="image/png" />}
      </Mcp.Result>,
    ),
  ).toThrow('mcp-image requires non-empty data and mimeType');

  expect(() =>
    lowerMcpResult(
      <Mcp.Result>
        {<Mcp.Audio data="UklGRg==" mimeType="" />}
      </Mcp.Result>,
    ),
  ).toThrow('mcp-audio requires non-empty data and mimeType');

  expect(() =>
    lowerMcpResult(
      <Mcp.Result>
        {<Mcp.EmbeddedResource uri="runtime://snapshot" mimeType="application/json" text="{}" blob="e30=" />}
      </Mcp.Result>,
    ),
  ).toThrow('mcp-embedded-resource accepts exactly one text or blob value');

  expect(() =>
    lowerMcpResult(
      <Mcp.Result>
        <Mcp.EmbeddedResource uri="runtime://snapshot" mimeType="application/json" text="{}">
          {'{}'}
        </Mcp.EmbeddedResource>
      </Mcp.Result>,
    ),
  ).toThrow('mcp-embedded-resource accepts exactly one text or blob value');

  expect(() =>
    lowerMcpResult(
      <Mcp.Result>
        <Mcp.Result>
          <Mcp.Text>nested</Mcp.Text>
        </Mcp.Result>
      </Mcp.Result>,
    ),
  ).toThrow('mcp-result may not be nested');

  expect(() =>
    lowerMcpResult(
      <Mcp.Result structuredContent={{ value: BigInt(1) }}>
        <Mcp.Text>invalid</Mcp.Text>
      </Mcp.Result>,
    ),
  ).toThrow('mcp-result structuredContent must be JSON-serializable');
});

test('rejects non-JSON structured content instead of normalizing it', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const sparse = new Array<unknown>(2);
  sparse[1] = 'present';

  for (const value of [
    undefined,
    () => undefined,
    Symbol('value'),
    Number.NaN,
    Number.POSITIVE_INFINITY,
    new Date('2026-08-14T00:00:00.000Z'),
    new Map(),
    sparse,
    [undefined],
    cyclic,
  ]) {
    expect(() =>
      lowerMcpResult(
        <Mcp.Result structuredContent={{ value }}>
          <Mcp.Text>invalid</Mcp.Text>
        </Mcp.Result>,
      ),
    ).toThrow('mcp-result structuredContent must be JSON-serializable');
  }
});

test('clones recursively valid JSON records for structured content', () => {
  const input = Object.assign(Object.create(null), {
    nested: { array: [null, false, 2.5, 'value'] },
    stateVersion: 2,
  });

  const result = lowerMcpResult(
    <Mcp.Result structuredContent={input}>
      <Mcp.Text>valid</Mcp.Text>
    </Mcp.Result>,
  );

  expect(result.structuredContent).toEqual({
    nested: { array: [null, false, 2.5, 'value'] },
    stateVersion: 2,
  });
  expect(result.structuredContent).not.toBe(input);
});

test('preserves an own __proto__ key in valid structured content', () => {
  const input = Object.create(null) as Record<string, unknown>;
  Object.defineProperty(input, '__proto__', {
    enumerable: true,
    value: { value: 'preserved' },
  });

  const result = lowerMcpResult(
    <Mcp.Result structuredContent={input}>
      <Mcp.Text>valid</Mcp.Text>
    </Mcp.Result>,
  );

  expect(Object.getOwnPropertyDescriptor(result.structuredContent as object, '__proto__')?.value).toEqual({
    value: 'preserved',
  });
});
