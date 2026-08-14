import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from '@rstest/core';
import React from 'react';

import { RefreshStatus } from '../src/widget/App.js';

test('announces timeline refresh and errors in a visually hidden live region', () => {
  const refreshing = renderToStaticMarkup(<RefreshStatus refresh="refreshing" />);
  const error = renderToStaticMarkup(<RefreshStatus refresh="error" />);

  expect(refreshing).toContain('class="timeline__status"');
  expect(refreshing).toContain('role="status"');
  expect(refreshing).toContain('aria-live="polite"');
  expect(refreshing).toContain('Refreshing timeline.');
  expect(error).toContain('Unable to refresh timeline.');
});
