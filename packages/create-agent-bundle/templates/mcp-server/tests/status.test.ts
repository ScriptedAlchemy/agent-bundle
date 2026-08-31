import { expect, it } from '@rstest/core';

import { reportStatus } from '../src/status.js';

it('reports a known service as healthy', () => {
  expect(reportStatus('docs')).toEqual({ service: 'docs', status: 'healthy', summary: 'docs is ready.' });
});

it('reports an unknown service without inventing readiness', () => {
  expect(reportStatus('billing')).toMatchObject({ status: 'unknown' });
});
