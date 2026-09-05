const marker = Symbol.for('agent-bundle.runtime-rebundle-fixture');

Reflect.set(globalThis, marker, true);

export const assertPrivateSiblingLoaded = (): void => {
  if (Reflect.get(globalThis, marker) !== true) {
    throw new Error('Synthetic runtime sibling did not execute.');
  }
};
