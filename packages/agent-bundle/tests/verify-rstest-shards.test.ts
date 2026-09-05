import { expect, it } from '@rstest/core';

import { parseRstestFileList, partitionReport } from '../../../scripts/verify-rstest-shards.mjs';

const pool = [
  'packages/agent-bundle/tests/api.test.ts',
  'packages/agent-bundle/tests/build.test.ts',
  'packages/agent-bundle/tests/cli.test.ts',
  'packages/rsc-runtime/tests/state-packaging.test.ts',
  'packages/workbench/tests/overview.e2e.test.ts',
  'packages/workbench/tests/workbench-dev-command.test.ts',
] as const;

const [api, build, cli, statePackaging, overview, devCommand] = pool;

it('accepts shards that partition the pool exactly', () => {
  const report = partitionReport({
    all: pool,
    shards: [[api, build, cli], [statePackaging, overview, devCommand]],
  });
  expect(report).toEqual({
    duplicated: [],
    empty: [],
    extra: [],
    missing: [],
    ok: true,
    shards: [
      { count: 3, first: api, index: 1, last: cli },
      { count: 3, first: statePackaging, index: 2, last: devCommand },
    ],
    total: 6,
  });
  // Shard order and pool order do not matter; membership does.
  expect(partitionReport({
    all: [...pool].reverse(),
    shards: [[overview, statePackaging], [devCommand], [cli, api, build]],
  }).ok).toBe(true);
});

it('reports a pool file that no shard lists as missing', () => {
  const report = partitionReport({
    all: pool,
    shards: [[api, build, cli], [statePackaging, devCommand]],
  });
  expect(report.ok).toBe(false);
  expect(report.missing).toEqual([overview]);
  expect(report.duplicated).toEqual([]);
  expect(report.extra).toEqual([]);
  expect(report.empty).toEqual([]);
});

it('reports a file listed by two shards as duplicated', () => {
  const report = partitionReport({
    all: pool,
    shards: [[api, build, cli, statePackaging], [statePackaging, overview, devCommand]],
  });
  expect(report.ok).toBe(false);
  expect(report.duplicated).toEqual([statePackaging]);
  expect(report.missing).toEqual([]);
  expect(report.extra).toEqual([]);

  // Listed twice by the same shard counts too.
  expect(partitionReport({
    all: pool,
    shards: [[api, api, build, cli], [statePackaging, overview, devCommand]],
  }).duplicated).toEqual([api]);
});

it('reports an empty shard by its 1-based index', () => {
  const report = partitionReport({
    all: pool,
    shards: [[api, build, cli, statePackaging, overview, devCommand], []],
  });
  expect(report.ok).toBe(false);
  expect(report.empty).toEqual([2]);
  expect(report.shards[1]).toEqual({ count: 0, first: undefined, index: 2, last: undefined });
  expect(report.missing).toEqual([]);
  expect(report.duplicated).toEqual([]);
});

it('reports a shard file outside the pool as extra and an empty pool as not ok', () => {
  const stray = 'examples/mcp-app/tests/stray.test.ts';
  const report = partitionReport({
    all: pool,
    shards: [[api, build, cli], [statePackaging, overview, devCommand, stray]],
  });
  expect(report.ok).toBe(false);
  expect(report.extra).toEqual([stray]);
  expect(report.missing).toEqual([]);
  expect(report.duplicated).toEqual([]);

  expect(partitionReport({ all: [], shards: [[], []] })).toMatchObject({ empty: [1, 2], ok: false, total: 0 });
});

it('keeps only the test paths from rstest list output', () => {
  const stdout = [
    '',
    '\u001B[32mRunning shard 1 of 2 (2 of 4 test files)\u001B[39m',
    '',
    `${api}`,
    `${build}  `,
    '',
  ].join('\n');
  expect(parseRstestFileList(stdout)).toEqual([api, build]);
  expect(parseRstestFileList(`\n${api}\n${build}\n`)).toEqual([api, build]);
  expect(parseRstestFileList('')).toEqual([]);
});
