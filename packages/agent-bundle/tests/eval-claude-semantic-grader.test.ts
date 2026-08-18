import { expect, it } from '@rstest/core';

import {
  claudeSemanticGraderSchemaVersion,
  parseClaudeSemanticGraderResult,
  parseClaudeSemanticGraderStream,
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

it('requires one duplicate-free terminal success envelope instead of accepting the normalizer fallback', () => {
  const validResult = JSON.stringify({ detail: 'ok', outcome: 'pass', schemaVersion: claudeSemanticGraderSchemaVersion });
  const invalidResult = JSON.stringify({ detail: 'not valid', outcome: 'maybe', schemaVersion: claudeSemanticGraderSchemaVersion });
  const validEnvelope = JSON.stringify({ result: validResult, subtype: 'success', type: 'result' });
  const assistantOnly = JSON.stringify({
    message: { content: [{ text: validResult, type: 'text' }] },
    type: 'assistant',
  });
  const duplicateResult = `{"type":"result","subtype":"success","result":${JSON.stringify(invalidResult)},"result":${JSON.stringify(validResult)}}`;
  for (const raw of [
    assistantOnly,
    duplicateResult,
    `${JSON.stringify({ result: invalidResult, subtype: 'success', type: 'result' })}\n${validEnvelope}`,
    `${validEnvelope}\n${validEnvelope}`,
    `${validEnvelope}\n${JSON.stringify({ type: 'assistant' })}`,
  ]) {
    expect(parseClaudeSemanticGraderStream(`${raw}\n`)).toBeUndefined();
  }
  expect(parseClaudeSemanticGraderStream(`${validEnvelope}\n`)).toEqual({ detail: 'ok', outcome: 'pass' });
});
