import { expect, it } from '@rstest/core';

import { playgroundJsonObject, playgroundJsonValue } from '../src/playground/playground-json.ts';

it('copies decoded JSON into frozen trace values', () => {
  const source = { list: [1, 'two', null, { deep: true }], name: 'hook' };
  const copied = playgroundJsonValue(source);

  expect(copied).toEqual(source);
  expect(Object.isFrozen(copied)).toBe(true);
  expect(Object.isFrozen((copied as { readonly list: readonly unknown[] }).list)).toBe(true);
  expect(copied).not.toBe(source);
});

it('drops undefined members so an optional field never becomes null', () => {
  expect(playgroundJsonObject({ nativeOutput: undefined, present: 1 })).toEqual({ present: 1 });
});

it('refuses values a durable trace cannot carry', () => {
  expect(() => playgroundJsonValue(Number.NaN)).toThrow(TypeError);
  expect(() => playgroundJsonValue(Number.POSITIVE_INFINITY)).toThrow(TypeError);
  expect(() => playgroundJsonValue(() => undefined)).toThrow(TypeError);
  expect(() => playgroundJsonValue(new Date())).toThrow(TypeError);
  expect(() => playgroundJsonObject([1, 2])).toThrow(TypeError);
});
