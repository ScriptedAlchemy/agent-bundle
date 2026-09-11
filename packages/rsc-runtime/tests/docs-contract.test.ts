import { expect, it } from '@rstest/core';
import { createElement } from 'react';
import { Mcp, lowerMcpResult } from '../src/index.js';

it('rejects the multi-child `Mcp.Text` the documented template literal avoids', () => {
    expect(() => lowerMcpResult(createElement(
      Mcp.Result,
      null,
      createElement(Mcp.Text, null, 'Runtime is ', 'ready', '.'),
    ))).toThrow('mcp-text requires one text child');
  });
