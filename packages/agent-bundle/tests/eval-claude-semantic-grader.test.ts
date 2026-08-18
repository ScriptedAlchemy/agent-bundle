import { expect, it } from '@rstest/core';

import {
  claudeSemanticGraderSchemaVersion,
  parseClaudeSemanticGraderResult,
} from '../src/eval/claude-semantic-grader.ts';

it('accepts only the exact versioned semantic-grader result schema', () => {
  expect(parseClaudeSemanticGraderResult(JSON.stringify({
    detail: 'The workspace fulfills the requested change.',
    outcome: 'pass',
    schemaVersion: claudeSemanticGraderSchemaVersion,
  }))).toEqual({
    detail: 'The workspace fulfills the requested change.',
    outcome: 'pass',
  });
});

it('rejects fences, duplicates, extras, malformed values, and trailing text from the semantic grader', () => {
  for (const value of [
    '```json\n{"schemaVersion":1,"outcome":"pass","detail":"ok"}\n```',
    '{"schemaVersion":1,"schemaVersion":1,"outcome":"pass","detail":"ok"}',
    '{"schemaVersion":1,"outcome":"pass","detail":"ok","extra":true}',
    '{"schemaVersion":1,"outcome":"maybe","detail":"ok"}',
    '{"schemaVersion":2,"outcome":"pass","detail":"ok"}',
    '{"schemaVersion":1,"outcome":"pass","detail":1}',
    '{"schemaVersion":1,"outcome":"pass","detail":"ok"} trailing',
  ]) {
    expect(parseClaudeSemanticGraderResult(value)).toBeUndefined();
  }
});
