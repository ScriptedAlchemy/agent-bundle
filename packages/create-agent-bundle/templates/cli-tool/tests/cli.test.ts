import { describe, expect, it } from '@rstest/core';

import { runCli } from '../src/cli.js';
import { greet } from '../src/index.js';

describe('my-agent-plugin', () => {
  it('greets a name and exits zero', () => {
    const lines: string[] = [];
    expect(runCli(['World'], (line) => lines.push(line))).toBe(0);
    expect(lines).toEqual(['Hello, World!\n']);
  });

  it('prints usage and exits 2 without arguments', () => {
    const lines: string[] = [];
    expect(runCli([], (line) => lines.push(line))).toBe(2);
    expect(lines[0]).toContain('Usage:');
  });

  it('rejects blank names in the library export', () => {
    expect(() => greet('   ')).toThrow('A name is required.');
  });
});
