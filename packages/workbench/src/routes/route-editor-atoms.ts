import { Atom } from 'effect/unstable/reactivity';

import type { RouteEditorState } from './routes-model.ts';

/**
 * Digest plus compiled route id isolates editor state across manifests. The
 * undefined sentinel lets provider-less SSR derive schema defaults locally.
 */
export const routeEditorKey = (digest: string, routeId: string): string => `${digest}\u0000${routeId}`;

export const routeEditorStateAtom = Atom.family(
  (key: string) => Atom.make<RouteEditorState | undefined>(undefined),
);
