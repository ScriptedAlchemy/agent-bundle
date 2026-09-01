import { Agent } from '@agent-bundle/runtime';
import { expect, it } from '@rstest/core';
import { createElement } from 'react';

import {
  createCanonicalEventProps,
  projectEventDocument,
  renderStandaloneEventRoute,
} from '../src/events/project.ts';

it('resolves nested Server Components in explicit standalone event routes', async () => {
  const NestedContext = async () => createElement(Agent.Context, null, 'standalone');
  const Route = async () => createElement(
    Agent.Result,
    null,
    createElement(NestedContext),
  );
  const controller = new AbortController();
  const props = createCanonicalEventProps(
    'tool/after',
    { hook_event_name: 'PostToolUse', tool_name: 'Write' },
    'claude',
    'PostToolUse',
    '2.1.250',
    controller.signal,
  );

  const document = await renderStandaloneEventRoute(Route, props);
  expect(projectEventDocument(document, 'tool/after', 'claude', 'PostToolUse')).toEqual({
    hookSpecificOutput: {
      additionalContext: 'standalone',
      hookEventName: 'PostToolUse',
    },
  });
});
