import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test } from '@rstest/core';

const readme = async (): Promise<string> => readFile(join(process.cwd(), 'README.md'), 'utf8');

test('keeps the Hook JSX author example executable', async () => {
  const source = await readme();
  const afterFileEdit = source.match(/export function AfterFileEdit\(\) \{[\s\S]*?\n}\n```/);

  expect(afterFileEdit?.[0]).toContain('<Hook.Result>\n      <Hook.AdditionalContext>');
  expect(afterFileEdit?.[0]).toContain('</Hook.AdditionalContext>\n    </Hook.Result>');
});

test('documents the native Codex matcher and evidence boundary truthfully', async () => {
  const source = await readme();

  expect(source).toContain('`apply_patch` hook');
  expect(source).toContain('`dist/runtime/agent-runtime.manifest.json`');
  expect(source).toContain('Claude fully proves hook→MCP/RSC shared behavior');
  expect(source).toContain('native PostToolUse/shared state is unproven under pinned `codex exec --ephemeral`');
  expect(source).not.toContain('A non-authenticated session is reported as an environment limitation');
});
