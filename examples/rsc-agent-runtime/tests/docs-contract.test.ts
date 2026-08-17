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

test('requires attached native evidence before documenting Claude or Codex observations', async () => {
  const source = await readme();

  expect(source).toContain('`apply_patch` hook');
  expect(source).toContain('`dist/runtime/agent-runtime.manifest.json`');
  expect(source).toContain('value-free hook launch probe');
  expect(source).toContain('native PostToolUse/shared state remains unproven under `exec --ephemeral`');
  expect(source).toContain('Claude Code: unavailable/not run in this repository snapshot');
  expect(source).toContain('Codex CLI: unavailable/not run in this repository snapshot');
  expect(source).toMatch(/No attached tracked\s+schema-v2 native-evidence artifact exists in this repository snapshot/u);
  expect(source).toMatch(/profiles are local compatibility simulations, and deterministic evaluator tests are not native certification/u);
  expect(source).toContain('npm run eval:hosts -w @agent-bundle/rsc-agent-runtime-demo -- --host claude');
  expect(source).toContain('npm run eval:hosts -w @agent-bundle/rsc-agent-runtime-demo -- --host codex');
  expect(source).toContain('schema-v2 JSON evidence document');
  expect(source).toContain('MCP App iframe evidence is unavailable from either terminal CLI');
  expect(source).not.toContain('Claude fully proves hook→MCP/RSC shared behavior');
  expect(source).not.toContain('A non-authenticated session is reported as an environment limitation');
});
