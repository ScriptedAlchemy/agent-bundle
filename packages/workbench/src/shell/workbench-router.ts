/**
 * History-API router over {@link WorkbenchLocation}. The shell owns exactly one
 * router; it reads the current location from `window.location`, writes it with
 * `pushState`/`replaceState`, and re-parses on `popstate` so the browser's
 * Back/Forward buttons move the shell. The window is injected so the router is
 * unit-testable against a fake; no module-level `window` access.
 */
import {
  formatWorkbenchLocation,
  parseWorkbenchLocation,
  sameWorkbenchLocation,
  type WorkbenchLocation,
} from './workbench-location.ts';

/** The slice of `Window` the router touches. */
export interface WorkbenchRouterWindow {
  readonly history: Pick<History, 'pushState' | 'replaceState'>;
  readonly location: Pick<Location, 'pathname' | 'search'>;
  addEventListener(type: 'popstate', listener: () => void): void;
  removeEventListener(type: 'popstate', listener: () => void): void;
}

export interface WorkbenchNavigateOptions {
  /** Replace the current history entry instead of pushing a new one. */
  readonly replace?: boolean;
}

export type WorkbenchRouterListener = (location: WorkbenchLocation) => void;

export interface WorkbenchRouter {
  /** The location the URL currently names. */
  current(): WorkbenchLocation;
  /** Stops listening to `popstate`; navigation after disposal still updates the URL but notifies nobody. */
  dispose(): void;
  /** The `href` a link to `location` should carry, so middle-click and copy-link work. */
  href(location: WorkbenchLocation): string;
  /**
   * Moves to `location`. Navigating to the location already shown replaces
   * rather than pushes, so repeated clicks on the active nav item do not pile
   * up history entries.
   */
  navigate(location: WorkbenchLocation, options?: WorkbenchNavigateOptions): void;
  /** Fires after every change, including `popstate`; returns the unsubscribe. */
  subscribe(listener: WorkbenchRouterListener): () => void;
}

export const createWorkbenchRouter = (window: WorkbenchRouterWindow): WorkbenchRouter => {
  const listeners = new Set<WorkbenchRouterListener>();
  let current = parseWorkbenchLocation(window.location.pathname, window.location.search);
  let disposed = false;

  const notify = (): void => {
    for (const listener of listeners) listener(current);
  };

  const onPopState = (): void => {
    const next = parseWorkbenchLocation(window.location.pathname, window.location.search);
    if (sameWorkbenchLocation(next, current)) return;
    current = next;
    notify();
  };
  window.addEventListener('popstate', onPopState);

  const router: WorkbenchRouter = {
    current: () => current,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('popstate', onPopState);
      listeners.clear();
    },
    href: formatWorkbenchLocation,
    navigate: (location, options) => {
      const url = formatWorkbenchLocation(location);
      const unchanged = sameWorkbenchLocation(location, current);
      const shownUrl = `${window.location.pathname}${window.location.search}`;
      if (options?.replace === true || unchanged) {
        if (url !== shownUrl) window.history.replaceState(null, '', url);
      } else {
        window.history.pushState(null, '', url);
      }
      if (unchanged) return;
      current = location;
      notify();
    },
    subscribe: (listener) => {
      if (disposed) return () => undefined;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return Object.freeze(router);
};
