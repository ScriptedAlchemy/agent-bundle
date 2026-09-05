const marker = 'AGENT_BUNDLE_RUNTIME_REBUNDLE_FIXTURE_EXECUTED';

process.env[marker] = '1';

export const assertPrivateSiblingLoaded = (): void => {
  if (process.env[marker] !== '1') {
    throw new Error('Synthetic runtime sibling did not execute.');
  }
};
