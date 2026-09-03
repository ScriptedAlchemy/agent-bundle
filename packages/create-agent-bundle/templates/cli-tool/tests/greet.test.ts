import { describe, expect, it } from '@rstest/core';

import { greet } from '../src/index.js';

describe('my-agent-plugin library', () => {
  it('greets a trimmed name', () => {
    expect(greet('  World ')).toEqual({ message: 'Hello, World!', name: 'World' });
  });

  it('rejects blank names', () => {
    expect(() => greet('   ')).toThrow('A name is required.');
  });
});
