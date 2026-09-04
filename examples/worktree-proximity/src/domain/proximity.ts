import type { IntentState } from '../state.js';

export interface ProximityIntent {
  readonly actorId: string;
  readonly dependencies: readonly string[];
  readonly paths: readonly string[];
}

export interface ProximityConflict {
  readonly actorId: string;
  readonly summary: string;
  readonly worktreeRoot: string;
}

export interface ProximityOptions {
  /**
   * The conversations the runtime's lineage registry lists as alive around
   * the current request (itself and `lineage.tree.siblings`). When given, an
   * intent held by a host-identified actor outside that set is stale — its
   * agent stopped — and is ignored; derived `worktree:<root>` actors are not
   * conversations and are never filtered. When absent, every recorded intent
   * counts: an unknown tree is not an empty one.
   */
  readonly liveConversations?: ReadonlySet<string>;
}

const normalizeSegments = (value: string): string => {
  const segments: string[] = [];
  for (const segment of value.replaceAll('\\', '/').split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..' && segments.length > 0 && segments.at(-1) !== '..') {
      segments.pop();
    } else {
      segments.push(segment);
    }
  }
  return segments.join('/');
};

const normalizePath = (value: string, worktreeRoot: string): string => {
  const path = value.replaceAll('\\', '/');
  const root = worktreeRoot.replaceAll('\\', '/').replace(/\/+$/u, '');
  const relative = path === root
    ? '.'
    : path.startsWith(`${root}/`)
      ? path.slice(root.length + 1)
      : path;
  return normalizeSegments(relative);
};

const normalizeDependency = (value: string): string => value.trim().toLowerCase();

export const findProximity = (
  snapshot: IntentState,
  currentWorktree: string,
  intent: ProximityIntent,
  options: ProximityOptions = {},
): readonly ProximityConflict[] => {
  const currentPaths = new Set(intent.paths.map((path) => normalizePath(path, currentWorktree)).filter(Boolean));
  const currentDependencies = new Set(
    intent.dependencies.map(normalizeDependency).filter((dependency) => dependency !== ''),
  );
  const bindings = new Map(snapshot.bindings.map((binding) => [binding.actorId, binding]));
  const conflicts: ProximityConflict[] = [];

  for (const activity of snapshot.activities) {
    if (activity.actorId === intent.actorId) continue;
    const binding = bindings.get(activity.actorId);
    if (binding === undefined || binding.worktreeRoot === currentWorktree) continue;
    if (
      options.liveConversations !== undefined
      && binding.provenance.actorId !== 'derived'
      && !options.liveConversations.has(binding.actorId)
    ) {
      continue;
    }

    const sharedPath = activity.paths
      .map((path) => normalizePath(path, binding.worktreeRoot))
      .find((path) => currentPaths.has(path));
    if (sharedPath !== undefined) {
      conflicts.push({
        actorId: binding.actorId,
        summary:
          `Worktrees ${currentWorktree} and ${binding.worktreeRoot} both intend to change path ${sharedPath}.`,
        worktreeRoot: binding.worktreeRoot,
      });
    }

    const sharedDependency = activity.dependencies
      .map(normalizeDependency)
      .find((dependency) => currentDependencies.has(dependency));
    if (sharedDependency !== undefined) {
      conflicts.push({
        actorId: binding.actorId,
        summary:
          `Worktrees ${currentWorktree} and ${binding.worktreeRoot} both depend on ${sharedDependency}.`,
        worktreeRoot: binding.worktreeRoot,
      });
    }
  }

  return conflicts;
};
