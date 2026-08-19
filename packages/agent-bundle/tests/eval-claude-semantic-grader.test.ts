import { expect, it } from '@rstest/core';

import {
  parseClaudeSemanticGraderResult,
  parseClaudeSemanticGraderStream,
} from '../src/eval/claude-semantic-grader.ts';

it('accepts only the exact semantic-grader result contract', () => {
  expect(parseClaudeSemanticGraderResult(JSON.stringify({
    detail: 'The workspace fulfills the requested change.',
    outcome: 'pass',
  }))).toEqual({
    detail: 'The workspace fulfills the requested change.',
    outcome: 'pass',
  });
});

it('rejects fences, duplicates, extras, malformed values, and trailing text from the semantic grader', () => {
  for (const value of [
    '```json\n{"outcome":"pass","detail":"ok"}\n```',
    '{"outcome":"pass","outcome":"pass","detail":"ok"}',
    '{"outcome":"pass","detail":"ok","extra":true}',
    '{"outcome":"maybe","detail":"ok"}',
    '{"outcome":"pass","detail":1}',
    '{"outcome":"pass","detail":"ok"} trailing',
  ]) {
    expect(parseClaudeSemanticGraderResult(value)).toBeUndefined();
  }
});

it('requires one duplicate-free terminal success envelope instead of accepting the normalizer fallback', () => {
  const validResult = JSON.stringify({ detail: 'ok', outcome: 'pass' });
  const invalidResult = JSON.stringify({ detail: 'not valid', outcome: 'maybe' });
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
