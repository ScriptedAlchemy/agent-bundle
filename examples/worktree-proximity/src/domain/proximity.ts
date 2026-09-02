import type { TopologyState } from '../state.js';

export interface ProximityIntent {
  readonly actorId: string;
  readonly dependencies: readonly string[];
  readonly paths: readonly string[];
}

export interface ProximityConflict {
  readonly actorId: string;
  readonly summary: string;
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
  snapshot: TopologyState,
  currentWorktree: string,
  intent: ProximityIntent,
): readonly ProximityConflict[] => {
  const currentPaths = new Set(intent.paths.map((path) => normalizePath(path, currentWorktree)).filter(Boolean));
  const currentDependencies = new Set(
    intent.dependencies.map(normalizeDependency).filter((dependency) => dependency !== ''),
  );
  const actors = new Map(snapshot.actors.map((actor) => [actor.id, actor]));
  const conflicts: ProximityConflict[] = [];

  for (const activity of snapshot.activities) {
    if (activity.actorId === intent.actorId) continue;
    const actor = actors.get(activity.actorId);
    if (
      actor === undefined
      || actor.status !== 'active'
      || actor.worktreeRoot === undefined
      || actor.worktreeRoot === currentWorktree
    ) {
      continue;
    }

    const sharedPath = activity.paths
      .map((path) => normalizePath(path, actor.worktreeRoot!))
      .find((path) => currentPaths.has(path));
    if (sharedPath !== undefined) {
      conflicts.push({
        actorId: actor.id,
        summary:
          `Worktrees ${currentWorktree} and ${actor.worktreeRoot} both intend to change path ${sharedPath}.`,
      });
    }

    const sharedDependency = activity.dependencies
      .map(normalizeDependency)
      .find((dependency) => currentDependencies.has(dependency));
    if (sharedDependency !== undefined) {
      conflicts.push({
        actorId: actor.id,
        summary:
          `Worktrees ${currentWorktree} and ${actor.worktreeRoot} both depend on ${sharedDependency}.`,
      });
    }
  }

  return conflicts;
};
